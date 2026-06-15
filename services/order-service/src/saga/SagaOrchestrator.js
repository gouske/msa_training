/**
 * SagaOrchestrator — 오케스트레이션 기반 Saga 조율자 (Phase 4a)
 *
 * Phase 4a 변경:
 *   - 모든 상태 전이를 sagaRepository.compareAndAdvance(단일-도큐먼트 CAS)로 수행한다.
 *     전이에 성공한(non-null) 처리자만 부수효과를 수행 → 동시 consumer 가 같은 reply 를
 *     읽어도 보상이 중복되지 않는다(L3). CAS 의 null 반환이 멱등 가드를 대체한다.
 *   - 원격 단계 command 는 inline 발행하지 않고 outbox 에 적재한다 → OutboxRelayWorker 가
 *     재시도 발행한다. 상태 전이와 발행 의도를 한 번에 원자 커밋해 정지(L1/L2)를 막는다(§17).
 *   - 재고 reserve/release 는 sagaId 멱등키로 호출한다.
 */
const { randomUUID } = require('crypto');
const Order = require('../domain/Order');
const OrderItem = require('../domain/OrderItem');
const Money = require('../domain/Money');
const { SagaState } = require('./SagaState');
const { QUEUE, MSG, STEP } = require('./sagaContracts');

class SagaOrchestrator {
    /**
     * @param {object} deps
     * @param {{save:Function, updateStatus:Function}} deps.orderRepository
     * @param {{reserve:Function, release:Function}} deps.inventoryRepository
     * @param {{save:Function, findBySagaId:Function, compareAndAdvance:Function}} deps.sagaRepository
     * @param {boolean} [deps.pointsEnabled=true]
     */
    constructor({ orderRepository, inventoryRepository, sagaRepository, pointsEnabled = true }) {
        this._orderRepo = orderRepository;
        this._inventoryRepo = inventoryRepository;
        this._sagaRepo = sagaRepository;
        this._pointsEnabled = pointsEnabled;
    }

    /** 주문 시작: 주문 저장 → Saga 생성 → 재고 예약(멱등) → INVENTORY_RESERVED + CHARGE outbox 적재 */
    async startOrder({ userEmail, itemId, quantity, price, correlationId = '' }) {
        const item = new OrderItem(itemId, new Money(price), quantity);
        const order = Order.create(userEmail, item);
        const orderId = await this._orderRepo.save(order);
        const amount = order.totalAmount().amount;
        const sagaId = randomUUID();

        // Saga 생성 (STARTED). CHARGE 는 재고 예약 성공 후 INVENTORY_RESERVED 전이와 함께 원자 적재한다.
        const saga = {
            sagaId, orderId, state: SagaState.STARTED, currentStep: STEP.INVENTORY, correlationId,
            steps: [
                { name: STEP.INVENTORY, status: 'PENDING', payload: { itemId, quantity } },
                { name: STEP.PAYMENT,   status: 'PENDING', payload: { orderId, amount } },
                { name: STEP.POINTS,    status: 'PENDING', payload: { userEmail, amount } },
            ],
            outbox: [],
        };
        await this._sagaRepo.save(saga);

        // T1 재고 예약 (멱등키)
        const reserved = await this._inventoryRepo.reserve(itemId, quantity, sagaId);
        if (!reserved) {
            await this._sagaRepo.compareAndAdvance(sagaId, {
                from: SagaState.STARTED, to: SagaState.FAILED,
                steps: [{ name: STEP.INVENTORY, status: 'FAILED' }],
            });
            await this._orderRepo.updateStatus(orderId, 'FAILED');
            return { orderId, sagaId, status: 'FAILED' };
        }

        // 재고 예약 성공 → INVENTORY_RESERVED + CHARGE command outbox 적재(원자적)
        await this._sagaRepo.compareAndAdvance(sagaId, {
            from: SagaState.STARTED, to: SagaState.INVENTORY_RESERVED, currentStep: STEP.PAYMENT,
            steps: [{ name: STEP.INVENTORY, status: 'DONE' }],
            outbox: [{
                queue: QUEUE.PAYMENT_COMMAND,
                message: { sagaId, type: MSG.CHARGE, stepName: STEP.PAYMENT, payload: { orderId, amount }, correlationId },
            }],
        });

        return { orderId, sagaId, status: 'PENDING' };
    }

    /** 원격 참여자의 reply 를 받아 상태머신을 전이한다. */
    async handleReply(reply) {
        const saga = await this._sagaRepo.findBySagaId(reply.sagaId);
        if (!saga) return; // 알 수 없는 saga — 무시

        switch (reply.type) {
            case MSG.PAYMENT_SUCCEEDED: return this._onPaymentSucceeded(saga, reply);
            case MSG.POINTS_SUCCEEDED:  return this._onPointsSucceeded(saga);
            case MSG.PAYMENT_FAILED:    return this._onPaymentFailed(saga);
            case MSG.POINTS_FAILED:     return this._onPointsFailed(saga);
            case MSG.REFUND_SUCCEEDED:  return this._onRefundSucceeded(saga);
            default: return; // 알 수 없는 타입 — 무시
        }
    }

    /** 결제 성공: INVENTORY_RESERVED → PAYMENT_CHARGED. 포인트 활성 시 EARN outbox, 비활성 시 즉시 완료. */
    async _onPaymentSucceeded(saga, reply) {
        if (this._pointsEnabled) {
            const pointsPayload = saga.steps.find((s) => s.name === STEP.POINTS).payload;
            await this._sagaRepo.compareAndAdvance(saga.sagaId, {
                from: SagaState.INVENTORY_RESERVED, to: SagaState.PAYMENT_CHARGED, currentStep: STEP.POINTS,
                steps: [{ name: STEP.PAYMENT, status: 'DONE', replyData: reply.payload }],
                outbox: [{
                    queue: QUEUE.POINTS_COMMAND,
                    message: { sagaId: saga.sagaId, type: MSG.EARN, stepName: STEP.POINTS, payload: pointsPayload, correlationId: saga.correlationId },
                }],
            });
            return; // CAS 성공/실패와 무관하게 추가 부수효과 없음(다음은 포인트 reply)
        }

        // 포인트 비활성: PAYMENT_CHARGED 로 전이(승자만 주문 확정 + COMPLETED)
        const advanced = await this._sagaRepo.compareAndAdvance(saga.sagaId, {
            from: SagaState.INVENTORY_RESERVED, to: SagaState.PAYMENT_CHARGED, currentStep: STEP.POINTS,
            steps: [{ name: STEP.PAYMENT, status: 'DONE', replyData: reply.payload }],
        });
        if (!advanced) return; // 경쟁 패배 — 다른 처리자가 처리
        await this._orderRepo.updateStatus(saga.orderId, 'SUCCESS');
        await this._sagaRepo.compareAndAdvance(saga.sagaId, { from: SagaState.PAYMENT_CHARGED, to: SagaState.COMPLETED });
    }

    /** 포인트 성공: PAYMENT_CHARGED → POINTS_EARNED → 주문 확정 → COMPLETED */
    async _onPointsSucceeded(saga) {
        const advanced = await this._sagaRepo.compareAndAdvance(saga.sagaId, {
            from: SagaState.PAYMENT_CHARGED, to: SagaState.POINTS_EARNED,
            steps: [{ name: STEP.POINTS, status: 'DONE' }],
        });
        if (!advanced) return;
        await this._orderRepo.updateStatus(saga.orderId, 'SUCCESS');
        await this._sagaRepo.compareAndAdvance(saga.sagaId, { from: SagaState.POINTS_EARNED, to: SagaState.COMPLETED });
    }

    /** 결제 실패: INVENTORY_RESERVED → COMPENSATING → 재고 복원(C1) → FAILED */
    async _onPaymentFailed(saga) {
        // 진입 CAS — 승자만 보상을 수행한다(동시 reply 중복 보상 차단)
        const advanced = await this._sagaRepo.compareAndAdvance(saga.sagaId, {
            from: SagaState.INVENTORY_RESERVED, to: SagaState.COMPENSATING,
            steps: [{ name: STEP.PAYMENT, status: 'FAILED' }],
        });
        if (!advanced) return;

        const inv = saga.steps.find((s) => s.name === STEP.INVENTORY).payload;
        await this._inventoryRepo.release(inv.itemId, inv.quantity, saga.sagaId); // 멱등
        await this._orderRepo.updateStatus(saga.orderId, 'FAILED');
        await this._sagaRepo.compareAndAdvance(saga.sagaId, {
            from: SagaState.COMPENSATING, to: SagaState.FAILED,
            steps: [{ name: STEP.INVENTORY, status: 'COMPENSATED' }],
        });
    }

    /** 포인트 실패: PAYMENT_CHARGED → COMPENSATING → 환불 command(C2) outbox 적재 */
    async _onPointsFailed(saga) {
        const paymentStep = saga.steps.find((s) => s.name === STEP.PAYMENT);
        const paymentId = paymentStep.replyData && paymentStep.replyData.paymentId;
        await this._sagaRepo.compareAndAdvance(saga.sagaId, {
            from: SagaState.PAYMENT_CHARGED, to: SagaState.COMPENSATING, currentStep: STEP.PAYMENT,
            steps: [{ name: STEP.POINTS, status: 'FAILED' }],
            outbox: [{
                queue: QUEUE.PAYMENT_COMMAND,
                message: { sagaId: saga.sagaId, type: MSG.REFUND, stepName: STEP.PAYMENT, payload: { paymentId, orderId: saga.orderId }, correlationId: saga.correlationId },
            }],
        });
        // 재고 복원은 환불 성공(REFUND_SUCCEEDED) reply 에서 수행한다.
    }

    /** 환불 성공: COMPENSATING 중 결제 보상 완료 → 재고 복원(C1) → FAILED */
    async _onRefundSucceeded(saga) {
        const inv = saga.steps.find((s) => s.name === STEP.INVENTORY).payload;
        // release 는 멱등(releasedSagas)이라 종결 CAS 전에 안전하게 실행 — 크래시해도 누수 없음.
        await this._inventoryRepo.release(inv.itemId, inv.quantity, saga.sagaId);
        await this._orderRepo.updateStatus(saga.orderId, 'FAILED');
        await this._sagaRepo.compareAndAdvance(saga.sagaId, {
            from: SagaState.COMPENSATING, to: SagaState.FAILED,
            steps: [
                { name: STEP.PAYMENT,   status: 'COMPENSATED' },
                { name: STEP.INVENTORY, status: 'COMPENSATED' },
            ],
        });
    }
}

module.exports = { SagaOrchestrator };
