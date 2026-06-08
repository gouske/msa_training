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
     */
    constructor({ orderRepository, inventoryRepository, sagaRepository, commandPublisher }) {
        this._orderRepo = orderRepository;
        this._inventoryRepo = inventoryRepository;
        this._sagaRepo = sagaRepository;
        this._publisher = commandPublisher;
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
