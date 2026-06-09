/**
 * SagaOrchestrator — 오케스트레이션 기반 Saga 조율자
 *
 * 역할:
 *   - 주문이라는 "긴 트랜잭션"을 여러 로컬 트랜잭션의 순차 실행으로 진행합니다.
 *   - 로컬 단계(재고)는 직접 처리하고, 원격 단계(결제·포인트)는 command 를 발행합니다.
 *   - 원격 단계의 결과(reply)는 handleReply() 로 들어와 상태머신을 전이합니다.
 *   - 실패 시 이미 완료한 단계를 역순으로 보상(의미적 취소)합니다.
 *
 * Phase 1 범위: 실제 RabbitMQ 연결 없이 commandPublisher 인터페이스에만 의존합니다.
 */
const { randomUUID } = require('crypto');
const Order = require('../domain/Order');
const OrderItem = require('../domain/OrderItem');
const Money = require('../domain/Money');
const { SagaState, assertTransition } = require('./SagaState');
const { QUEUE, MSG, STEP } = require('./sagaContracts');

class SagaOrchestrator {
    /**
     * @param {object} deps
     * @param {{save:Function, updateStatus:Function}} deps.orderRepository
     * @param {{reserve:Function, release:Function}} deps.inventoryRepository
     * @param {{save:Function, findBySagaId:Function}} deps.sagaRepository
     * @param {{publish:Function}} deps.commandPublisher
     * @param {boolean} [deps.pointsEnabled=true] 포인트 단계 활성화 여부
     */
    constructor({ orderRepository, inventoryRepository, sagaRepository, commandPublisher, pointsEnabled = true }) {
        this._orderRepo = orderRepository;
        this._inventoryRepo = inventoryRepository;
        this._sagaRepo = sagaRepository;
        this._publisher = commandPublisher;
        // 포인트(auth) participant 가 준비되기 전(Phase 2)에는 false 로 주입해
        // 결제 성공 시 포인트 단계를 건너뛰고 주문을 바로 확정한다. (Phase 3에서 true)
        this._pointsEnabled = pointsEnabled;
    }

    /**
     * 주문 시작: 주문 저장 → Saga 생성 → 재고 예약(로컬) → 결제 command 발행
     * @returns {{orderId:string, sagaId:string, status:'PENDING'|'FAILED'}}
     */
    async startOrder({ userEmail, itemId, quantity, price, correlationId = '' }) {
        // 1. 주문 도메인 생성 + 저장 (PENDING)
        const item = new OrderItem(itemId, new Money(price), quantity);
        const order = Order.create(userEmail, item);
        const orderId = await this._orderRepo.save(order);
        const amount = order.totalAmount().amount;

        // 2. Saga 생성 (STARTED)
        const sagaId = randomUUID();
        let saga = {
            sagaId,
            orderId,
            state: SagaState.STARTED,
            currentStep: STEP.INVENTORY,
            correlationId,
            steps: [
                { name: STEP.INVENTORY, status: 'PENDING', payload: { itemId, quantity } },
                { name: STEP.PAYMENT,   status: 'PENDING', payload: { orderId, amount } },
                { name: STEP.POINTS,    status: 'PENDING', payload: { userEmail, amount } },
            ],
        };
        await this._sagaRepo.save(saga);

        // 3. T1 재고 예약 (로컬 트랜잭션 — 원자적 조건부 차감)
        const reserved = await this._inventoryRepo.reserve(itemId, quantity);
        if (!reserved) {
            // 재고 부족 → 아직 아무것도 안 했으므로 보상 불필요, 즉시 실패
            saga = this._markStep(saga, STEP.INVENTORY, 'FAILED');
            saga = this._transition(saga, SagaState.FAILED);
            await this._sagaRepo.save(saga);
            await this._orderRepo.updateStatus(orderId, 'FAILED');
            return { orderId, sagaId, status: 'FAILED' };
        }

        // 재고 예약 성공 → INVENTORY_RESERVED
        saga = this._markStep(saga, STEP.INVENTORY, 'DONE');
        saga = this._transition(saga, SagaState.INVENTORY_RESERVED);
        saga = { ...saga, currentStep: STEP.PAYMENT };
        await this._sagaRepo.save(saga);

        // 4. T2 결제 승인 command 발행 (원격)
        await this._publisher.publish(QUEUE.PAYMENT_COMMAND, {
            sagaId,
            type: MSG.CHARGE,
            stepName: STEP.PAYMENT,
            payload: { orderId, amount },
            correlationId,
        });

        return { orderId, sagaId, status: 'PENDING' };
    }

    /**
     * 원격 참여자의 reply 를 받아 상태머신을 전이한다.
     * @param {{sagaId:string, type:string, stepName?:string, payload?:object}} reply
     */
    async handleReply(reply) {
        const saga = await this._sagaRepo.findBySagaId(reply.sagaId);
        if (!saga) return; // 알 수 없는 saga — 무시

        switch (reply.type) {
            case MSG.PAYMENT_SUCCEEDED: return this._onPaymentSucceeded(saga, reply);
            case MSG.POINTS_SUCCEEDED:  return this._onPointsSucceeded(saga, reply);
            case MSG.PAYMENT_FAILED:    return this._onPaymentFailed(saga, reply);
            case MSG.POINTS_FAILED:     return this._onPointsFailed(saga, reply);
            case MSG.REFUND_SUCCEEDED:  return this._onRefundSucceeded(saga, reply);
            default: return; // 알 수 없는 타입 — 무시
        }
    }

    /** 결제 성공: INVENTORY_RESERVED → PAYMENT_CHARGED, 포인트 활성 여부에 따라 command/완료 분기 */
    async _onPaymentSucceeded(saga, reply) {
        if (saga.state !== SagaState.INVENTORY_RESERVED) return; // 멱등 가드(중복/순서뒤바뀜 무시)

        let next = this._markStep(saga, STEP.PAYMENT, 'DONE', reply.payload);
        next = this._transition(next, SagaState.PAYMENT_CHARGED);
        next = { ...next, currentStep: STEP.POINTS };
        await this._sagaRepo.save(next);

        if (!this._pointsEnabled) {
            // [Phase 2] 포인트 participant 미가동 — 결제 성공 시 바로 주문 확정(COMPLETED).
            // 포인트 단계를 건너뛰므로 POINTS_EARNED 를 거치지 않고 COMPLETED 로 직접 전이한다.
            await this._orderRepo.updateStatus(saga.orderId, 'SUCCESS');
            next = this._transition(next, SagaState.COMPLETED);
            await this._sagaRepo.save(next);
            return;
        }

        const pointsPayload = saga.steps.find((s) => s.name === STEP.POINTS).payload;
        await this._publisher.publish(QUEUE.POINTS_COMMAND, {
            sagaId: saga.sagaId,
            type: MSG.EARN,
            stepName: STEP.POINTS,
            payload: pointsPayload,
            correlationId: saga.correlationId,
        });
    }

    /** 포인트 성공: PAYMENT_CHARGED → POINTS_EARNED → 주문 확정 → COMPLETED */
    async _onPointsSucceeded(saga) {
        if (saga.state !== SagaState.PAYMENT_CHARGED) return; // 멱등 가드

        let next = this._markStep(saga, STEP.POINTS, 'DONE');
        next = this._transition(next, SagaState.POINTS_EARNED);
        await this._sagaRepo.save(next);

        // T4 주문 확정 (로컬)
        await this._orderRepo.updateStatus(saga.orderId, 'SUCCESS');
        next = this._transition(next, SagaState.COMPLETED);
        await this._sagaRepo.save(next);
    }

    /** 결제 실패: INVENTORY_RESERVED → COMPENSATING → 재고 복원(C1) → FAILED */
    async _onPaymentFailed(saga) {
        if (saga.state !== SagaState.INVENTORY_RESERVED) return; // 멱등 가드

        let next = this._markStep(saga, STEP.PAYMENT, 'FAILED');
        next = this._transition(next, SagaState.COMPENSATING);
        await this._sagaRepo.save(next);

        // C1 재고 복원 (로컬) — 예약했던 수량을 그대로 되돌린다
        const inv = saga.steps.find((s) => s.name === STEP.INVENTORY).payload;
        await this._inventoryRepo.release(inv.itemId, inv.quantity);
        next = this._markStep(next, STEP.INVENTORY, 'COMPENSATED');

        await this._orderRepo.updateStatus(saga.orderId, 'FAILED');
        next = this._transition(next, SagaState.FAILED);
        await this._sagaRepo.save(next);
    }

    /** 포인트 실패: PAYMENT_CHARGED → COMPENSATING → 환불 command(C2) 발행 */
    async _onPointsFailed(saga) {
        if (saga.state !== SagaState.PAYMENT_CHARGED) return; // 멱등 가드

        let next = this._markStep(saga, STEP.POINTS, 'FAILED');
        next = this._transition(next, SagaState.COMPENSATING);
        next = { ...next, currentStep: STEP.PAYMENT }; // 보상 진행 단계 표시
        await this._sagaRepo.save(next);

        // C2 결제 환불 command — 결제 단계에 보관해 둔 paymentId 로 "무엇을 환불할지" 식별
        const paymentStep = saga.steps.find((s) => s.name === STEP.PAYMENT);
        const paymentId = paymentStep.replyData && paymentStep.replyData.paymentId;
        await this._publisher.publish(QUEUE.PAYMENT_COMMAND, {
            sagaId: saga.sagaId,
            type: MSG.REFUND,
            stepName: STEP.PAYMENT,
            payload: { paymentId, orderId: saga.orderId },
            correlationId: saga.correlationId,
        });
    }

    /** 환불 성공: COMPENSATING 중 결제 보상 완료 → 재고 복원(C1) → FAILED */
    async _onRefundSucceeded(saga) {
        if (saga.state !== SagaState.COMPENSATING) return; // 멱등 가드

        let next = this._markStep(saga, STEP.PAYMENT, 'COMPENSATED');
        await this._sagaRepo.save(next);

        // C1 재고 복원 (로컬)
        const inv = saga.steps.find((s) => s.name === STEP.INVENTORY).payload;
        await this._inventoryRepo.release(inv.itemId, inv.quantity);
        next = this._markStep(next, STEP.INVENTORY, 'COMPENSATED');

        await this._orderRepo.updateStatus(saga.orderId, 'FAILED');
        next = this._transition(next, SagaState.FAILED);
        await this._sagaRepo.save(next);
    }

    // ── private helpers ──────────────────────────────────────

    /** steps 배열에서 한 단계의 status(및 replyData)를 갱신한 새 saga 를 반환 (불변) */
    _markStep(saga, stepName, status, replyData) {
        return {
            ...saga,
            steps: saga.steps.map((s) =>
                s.name === stepName
                    ? { ...s, status, ...(replyData ? { replyData } : {}) }
                    : s,
            ),
        };
    }

    /** 전이 규칙을 검증한 뒤 state 를 바꾼 새 saga 를 반환 (불변) */
    _transition(saga, toState) {
        assertTransition(saga.state, toState);
        return { ...saga, state: toState };
    }
}

module.exports = { SagaOrchestrator };
