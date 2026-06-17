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
const { STEP_TIMEOUT_MS, MAX_COMPENSATE_ATTEMPTS } = require('./sagaConfig');

class SagaOrchestrator {
    /**
     * @param {object} deps
     * @param {{save:Function, updateStatus:Function}} deps.orderRepository
     * @param {{reserve:Function, release:Function}} deps.inventoryRepository
     * @param {{save:Function, findBySagaId:Function, compareAndAdvance:Function, retryCompensation:Function}} deps.sagaRepository
     * @param {boolean} [deps.pointsEnabled=true]
     * @param {() => Date} [deps.now] 테스트 주입용 시계
     * @param {number} [deps.stepTimeoutMs] STARTED T1 deadline 계산용(정지-전진 감지)
     * @param {number} [deps.maxCompensateAttempts] 보상 재시도 상한
     */
    constructor({ orderRepository, inventoryRepository, sagaRepository, pointsEnabled = true, now = () => new Date(), stepTimeoutMs = STEP_TIMEOUT_MS, maxCompensateAttempts = MAX_COMPENSATE_ATTEMPTS }) {
        this._orderRepo = orderRepository;
        this._inventoryRepo = inventoryRepository;
        this._sagaRepo = sagaRepository;
        this._pointsEnabled = pointsEnabled;
        this._now = now;
        this._stepTimeoutMs = stepTimeoutMs;
        this._maxCompensateAttempts = maxCompensateAttempts;
    }

    /** 주문 시작: 주문 저장 → Saga 생성(STARTED + T1 deadline) → 재고 예약(멱등) → INVENTORY_RESERVED + CHARGE outbox */
    async startOrder({ userEmail, itemId, quantity, price, correlationId = '' }) {
        const item = new OrderItem(itemId, new Money(price), quantity);
        const order = Order.create(userEmail, item);
        const orderId = await this._orderRepo.save(order);
        const amount = order.totalAmount().amount;
        const sagaId = randomUUID();

        // Saga 생성 (STARTED). T1 deadline 을 무장해 reserve↔advance 갭 크래시(정지-전진)를 스윕이 감지하게 한다.
        const saga = {
            sagaId, orderId, state: SagaState.STARTED, currentStep: STEP.INVENTORY, correlationId,
            deadline: new Date(this._now().getTime() + this._stepTimeoutMs),
            steps: [
                { name: STEP.INVENTORY, status: 'PENDING', payload: { itemId, quantity } },
                { name: STEP.PAYMENT,   status: 'PENDING', payload: { orderId, amount } },
                { name: STEP.POINTS,    status: 'PENDING', payload: { userEmail, amount } },
            ],
            outbox: [],
        };
        await this._sagaRepo.save(saga);

        return this._reserveAndAdvance(saga);
    }

    /**
     * 재고 예약(멱등) → INVENTORY_RESERVED 전이 + CHARGE outbox 적재. 재고 진짜 부족이면 FAILED.
     * startOrder 와 타임아웃 스윕의 STARTED 정지-전진 재구동이 공유한다(DRY). saga 는 STARTED 상태의 평범한 객체.
     */
    async _reserveAndAdvance(saga) {
        const { sagaId, orderId } = saga;
        const invStep = saga.steps.find((s) => s.name === STEP.INVENTORY);
        const { itemId, quantity } = invStep.payload;
        const amount = saga.steps.find((s) => s.name === STEP.PAYMENT).payload.amount;
        const correlationId = saga.correlationId || '';

        const reserved = await this._inventoryRepo.reserve(itemId, quantity, sagaId);
        if (!reserved) {
            await this._sagaRepo.compareAndAdvance(sagaId, {
                from: SagaState.STARTED, to: SagaState.FAILED,
                steps: [{ name: STEP.INVENTORY, status: 'FAILED' }],
            });
            await this._orderRepo.updateStatus(orderId, 'FAILED');
            return { orderId, sagaId, status: 'FAILED' };
        }

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
            case MSG.REFUND_FAILED:     return this._onRefundFailed(saga);
            default: return; // 알 수 없는 타입 — 무시
        }
    }

    /**
     * [Phase 4b] 타임아웃 스윕이 deadline 초과 saga 를 넘겨준다. 상태별로 분기하되,
     * 타임아웃 보상은 기존 실패 핸들러를 그대로 재사용한다(상태머신은 트리거 출처에 무관 — DRY).
     * @param {object} saga deadline 초과로 스윕이 읽어온 평범한 객체
     */
    async handleTimeout(saga) {
        switch (saga.state) {
            case SagaState.STARTED:            return this._reserveAndAdvance(saga);       // 정지-전진(L1)
            case SagaState.INVENTORY_RESERVED: return this._onPaymentFailed(saga);         // 결제 reply 무응답 → C1 only
            case SagaState.PAYMENT_CHARGED:    return this._onPointsFailed(saga);          // 포인트 reply 무응답 → C2 환불
            case SagaState.COMPENSATING:       return this._retryOrEscalateCompensation(saga); // [Task 10 에서 구현]
            default:                           return; // 종결/그 외 — 무시
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

    /** 환불 성공: COMPENSATING 중일 때만 재고 복원(C1) → FAILED. 잘못된/지연/중복 reply 는 무시. */
    async _onRefundSucceeded(saga) {
        // 진입 가드 [Codex high] — 보상 중(COMPENSATING)이 아니면 부수효과를 절대 수행하지 않는다.
        // 이미 COMPLETED/FAILED 인 saga 에 지연·중복·오라우팅된 REFUND_SUCCEEDED 가 와도
        // release/updateStatus 가 실행돼 성공 주문이 FAILED 로 오염되거나 재고가 부풀려지는 것을 막는다.
        // (COMPENSATING → COMPLETED 전이는 상태머신에 없으므로, COMPENSATING 이면 release 가 항상 정당하다.)
        if (saga.state !== SagaState.COMPENSATING) return;

        const inv = saga.steps.find((s) => s.name === STEP.INVENTORY).payload;
        // release 는 멱등(releasedSagas)이라 종결 CAS 전에 안전하게 실행 — 크래시 시 COMPENSATING 잔류로 복구 가능.
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

    /** 환불 실패(REFUND_FAILED): 보상 재시도 또는 상한 도달 시 에스컬레이션. 스윕의 COMPENSATING 분기와 공용. */
    async _onRefundFailed(saga) {
        return this._retryOrEscalateCompensation(saga);
    }

    /**
     * [Phase 4b] COMPENSATING 보상(환불)을 재시도하거나, 상한 도달 시 COMPENSATION_FAILED 로 에스컬레이션.
     * - 재시도: compensateAttempts 를 CAS 토큰으로 써서 동시 호출(중복 REFUND_FAILED + 스윕)에도 한 번만 재적재.
     * - 에스컬레이션: 상한 도달 → COMPENSATION_FAILED + 운영자 개입 에러 로그(설계 §17.12.3·§17.12.5 ②).
     * REFUND_FAILED reply 핸들러와 타임아웃 스윕의 COMPENSATING 분기가 공유한다.
     */
    async _retryOrEscalateCompensation(saga) {
        if (saga.state !== SagaState.COMPENSATING) return; // 보상 중이 아니면 아무 것도 안 함(지연/오라우팅 방어)

        const payStep = saga.steps.find((s) => s.name === STEP.PAYMENT);
        const attempts = payStep.compensateAttempts || 0;
        const paymentId = payStep.replyData && payStep.replyData.paymentId;

        if (attempts + 1 >= this._maxCompensateAttempts) {
            // 더 못 푼다 — 영구 마커(COMPENSATION_FAILED) + 운영자 개입 로그. 승자만 로그(중복 방지).
            const escalated = await this._sagaRepo.compareAndAdvance(saga.sagaId, {
                from: SagaState.COMPENSATING, to: SagaState.COMPENSATION_FAILED,
                steps: [{ name: STEP.PAYMENT, status: 'FAILED' }],
            });
            if (escalated) {
                console.error(`🚨 보상(환불) ${this._maxCompensateAttempts}회 실패 — 운영자 개입 필요 ` +
                    `sagaId=${saga.sagaId} orderId=${saga.orderId} paymentId=${paymentId} attempts=${attempts + 1}`);
            }
            return;
        }

        // 재시도 — attempts==현재값일 때만 +1 하며 REFUND 재적재(동시 호출 중 하나만 성공).
        await this._sagaRepo.retryCompensation(saga.sagaId, {
            stepName: STEP.PAYMENT,
            expectedAttempts: attempts,
            outbox: [{
                queue: QUEUE.PAYMENT_COMMAND,
                message: { sagaId: saga.sagaId, type: MSG.REFUND, stepName: STEP.PAYMENT, payload: { paymentId, orderId: saga.orderId }, correlationId: saga.correlationId },
            }],
        });
    }
}

module.exports = { SagaOrchestrator };
