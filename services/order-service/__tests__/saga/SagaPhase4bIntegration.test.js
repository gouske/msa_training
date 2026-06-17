/**
 * Phase 4b 통합 시나리오 — memory-server(실 Mongo CAS) + 가짜 브로커.
 * 타임아웃→보상 / 보상실패→COMPENSATION_FAILED / 크래시 후 복구 / happy·보상 회귀 / 동시 재시도.
 */
const mem = require('../helpers/mongoMemory');
const MongoSagaRepository = require('../../src/infrastructure/persistence/MongoSagaRepository');
const MongoInventoryRepository = require('../../src/infrastructure/persistence/MongoInventoryRepository');
const InventoryModel = require('../../models/Inventory');
const { SagaOrchestrator } = require('../../src/saga/SagaOrchestrator');
const { OutboxRelayWorker } = require('../../src/infrastructure/messaging/OutboxRelayWorker');
const { TimeoutSweepWorker } = require('../../src/infrastructure/messaging/TimeoutSweepWorker');
const { SagaState } = require('../../src/saga/SagaState');
const { MSG, STEP } = require('../../src/saga/sagaContracts');

const PAST = new Date('2020-01-01T00:00:00.000Z');
const NOW = new Date('2026-06-17T12:00:00.000Z');

// 가짜 브로커 — 발행된 메시지를 모은다.
const makeFakePublisher = () => {
    const sent = [];
    return { sent, publish: async (queue, message) => { sent.push({ queue, message }); } };
};
// 가짜 orderRepo — 상태 전이만 추적(주문 상태 규칙은 다른 테스트가 커버).
const makeOrderRepo = () => {
    const statuses = [];
    return { statuses, save: async () => 'order-1', updateStatus: async (id, s) => { statuses.push(s); } };
};

describe('Saga Phase 4b 통합 시나리오', () => {
    let sagaRepo, invRepo;

    beforeAll(mem.connect);
    afterEach(mem.clear);
    afterEach(() => { jest.restoreAllMocks(); });
    afterAll(mem.close);

    beforeEach(async () => {
        sagaRepo = new MongoSagaRepository();
        invRepo = new MongoInventoryRepository();
        await InventoryModel.create({ itemId: 'ITEM-1', available: 10, reservedSagas: [], releasedSagas: [] });
    });

    const makeOrchestrator = (extra = {}) => new SagaOrchestrator({
        orderRepository: makeOrderRepo(), inventoryRepository: invRepo, sagaRepository: sagaRepo,
        pointsEnabled: true, now: () => NOW, stepTimeoutMs: 15000, ...extra,
    });

    test('① 응답 대기 타임아웃 → 보상(재고복원→FAILED)', async () => {
        await invRepo.reserve('ITEM-1', 2, 's1'); // available 10→8
        await sagaRepo.save({
            sagaId: 's1', orderId: 'order-1', state: SagaState.INVENTORY_RESERVED, currentStep: STEP.PAYMENT,
            deadline: PAST,
            steps: [
                { name: STEP.INVENTORY, status: 'DONE', payload: { itemId: 'ITEM-1', quantity: 2 } },
                { name: STEP.PAYMENT,   status: 'PENDING', payload: { orderId: 'order-1', amount: 10000 } },
                { name: STEP.POINTS,    status: 'PENDING', payload: { userEmail: 'b@test.com', amount: 10000 } },
            ],
            outbox: [],
        });
        const orchestrator = makeOrchestrator();
        const sweep = new TimeoutSweepWorker({ sagaRepository: sagaRepo, orchestrator, now: () => NOW });

        await sweep.tick();

        const saga = await sagaRepo.findBySagaId('s1');
        expect(saga.state).toBe(SagaState.FAILED);
        const inv = await InventoryModel.findOne({ itemId: 'ITEM-1' }).lean();
        expect(inv.available).toBe(10); // 복원됨
        expect(inv.releasedSagas).toContain('s1');
    });

    test('② 보상 실패 누적 → COMPENSATION_FAILED', async () => {
        await sagaRepo.save({
            sagaId: 's1', orderId: 'order-1', state: SagaState.COMPENSATING, currentStep: STEP.PAYMENT, deadline: PAST,
            steps: [
                { name: STEP.INVENTORY, status: 'DONE', payload: { itemId: 'ITEM-1', quantity: 2 } },
                { name: STEP.PAYMENT,   status: 'DONE', payload: { orderId: 'order-1', amount: 10000 }, replyData: { paymentId: 'PAY-1' }, compensateAttempts: 0 },
                { name: STEP.POINTS,    status: 'FAILED', payload: { userEmail: 'b@test.com', amount: 10000 } },
            ],
            outbox: [],
        });
        const orchestrator = makeOrchestrator({ maxCompensateAttempts: 2 });
        jest.spyOn(console, 'error').mockImplementation(() => {});

        await orchestrator.handleReply({ sagaId: 's1', type: MSG.REFUND_FAILED, stepName: STEP.PAYMENT }); // attempts 0→1, 재적재
        await orchestrator.handleReply({ sagaId: 's1', type: MSG.REFUND_FAILED, stepName: STEP.PAYMENT }); // 1+1=2 → 에스컬레이션

        const saga = await sagaRepo.findBySagaId('s1');
        expect(saga.state).toBe(SagaState.COMPENSATION_FAILED);
    });

    test('③ 크래시 후 복구 — STARTED 정지-전진 재구동', async () => {
        await sagaRepo.save({
            sagaId: 's1', orderId: 'order-1', state: SagaState.STARTED, currentStep: STEP.INVENTORY, deadline: PAST,
            steps: [
                { name: STEP.INVENTORY, status: 'PENDING', payload: { itemId: 'ITEM-1', quantity: 2 } },
                { name: STEP.PAYMENT,   status: 'PENDING', payload: { orderId: 'order-1', amount: 10000 } },
                { name: STEP.POINTS,    status: 'PENDING', payload: { userEmail: 'b@test.com', amount: 10000 } },
            ],
            outbox: [],
        });
        const orchestrator = makeOrchestrator();
        const sweep = new TimeoutSweepWorker({ sagaRepository: sagaRepo, orchestrator, now: () => NOW });

        await sweep.tick();

        const saga = await sagaRepo.findBySagaId('s1');
        expect(saga.state).toBe(SagaState.INVENTORY_RESERVED);
        expect(saga.deadline).toBeNull(); // 전이로 비워짐(CHARGE SENT 전까지 스윕 제외)
        expect(saga.outbox.filter((e) => e.status === 'PENDING' && e.message.type === MSG.CHARGE)).toHaveLength(1);
        const inv = await InventoryModel.findOne({ itemId: 'ITEM-1' }).lean();
        expect(inv.available).toBe(8); // 예약됨
    });

    test('④ happy path 회귀 — 릴레이 발행 + reply 로 COMPLETED', async () => {
        const orderRepo = makeOrderRepo();
        const orchestrator = new SagaOrchestrator({
            orderRepository: orderRepo, inventoryRepository: invRepo, sagaRepository: sagaRepo,
            pointsEnabled: true, now: () => NOW, stepTimeoutMs: 15000,
        });
        const publisher = makeFakePublisher();
        const relay = new OutboxRelayWorker({ sagaRepository: sagaRepo, commandPublisher: publisher, stepTimeoutMs: 15000, now: () => NOW });

        const { sagaId } = await orchestrator.startOrder({ userEmail: 'b@test.com', itemId: 'ITEM-1', quantity: 2, price: 5000 });
        await relay.tick(); // CHARGE 발행 + deadline 무장
        await orchestrator.handleReply({ sagaId, type: MSG.PAYMENT_SUCCEEDED, stepName: STEP.PAYMENT, payload: { paymentId: 'PAY-1' } });
        await relay.tick(); // EARN 발행
        await orchestrator.handleReply({ sagaId, type: MSG.POINTS_SUCCEEDED, stepName: STEP.POINTS });

        const saga = await sagaRepo.findBySagaId(sagaId);
        expect(saga.state).toBe(SagaState.COMPLETED);
        expect(orderRepo.statuses).toContain('SUCCESS');
        expect(publisher.sent.map((m) => m.message.type)).toEqual([MSG.CHARGE, MSG.EARN]);
    });

    test('⑤ 보상 path 회귀 — 포인트 실패 → 환불 → FAILED', async () => {
        const orchestrator = makeOrchestrator();
        const publisher = makeFakePublisher();
        const relay = new OutboxRelayWorker({ sagaRepository: sagaRepo, commandPublisher: publisher, stepTimeoutMs: 15000, now: () => NOW });

        const { sagaId } = await orchestrator.startOrder({ userEmail: 'b@test.com', itemId: 'ITEM-1', quantity: 2, price: 5000 });
        await relay.tick();
        await orchestrator.handleReply({ sagaId, type: MSG.PAYMENT_SUCCEEDED, stepName: STEP.PAYMENT, payload: { paymentId: 'PAY-1' } });
        await relay.tick();
        await orchestrator.handleReply({ sagaId, type: MSG.POINTS_FAILED, stepName: STEP.POINTS }); // → COMPENSATING + REFUND 적재
        await relay.tick(); // REFUND 발행
        await orchestrator.handleReply({ sagaId, type: MSG.REFUND_SUCCEEDED, stepName: STEP.PAYMENT });

        const saga = await sagaRepo.findBySagaId(sagaId);
        expect(saga.state).toBe(SagaState.FAILED);
        const inv = await InventoryModel.findOne({ itemId: 'ITEM-1' }).lean();
        expect(inv.available).toBe(10); // 환불 후 재고 복원
        expect(publisher.sent.map((m) => m.message.type)).toEqual([MSG.CHARGE, MSG.EARN, MSG.REFUND]);
    });

    test('⑥ 동시 REFUND_FAILED + 스윕 → REFUND 단 1건만 재적재', async () => {
        await sagaRepo.save({
            sagaId: 's1', orderId: 'order-1', state: SagaState.COMPENSATING, currentStep: STEP.PAYMENT, deadline: PAST,
            steps: [
                { name: STEP.INVENTORY, status: 'DONE', payload: { itemId: 'ITEM-1', quantity: 2 } },
                { name: STEP.PAYMENT,   status: 'DONE', payload: { orderId: 'order-1', amount: 10000 }, replyData: { paymentId: 'PAY-1' }, compensateAttempts: 0 },
                { name: STEP.POINTS,    status: 'FAILED', payload: { userEmail: 'b@test.com', amount: 10000 } },
            ],
            outbox: [],
        });
        const orchestrator = makeOrchestrator({ maxCompensateAttempts: 5 });
        const sweep = new TimeoutSweepWorker({ sagaRepository: sagaRepo, orchestrator, now: () => NOW });

        await Promise.all([
            orchestrator.handleReply({ sagaId: 's1', type: MSG.REFUND_FAILED, stepName: STEP.PAYMENT }),
            sweep.tick(),
        ]);

        const saga = await sagaRepo.findBySagaId('s1');
        expect(saga.steps.find((s) => s.name === STEP.PAYMENT).compensateAttempts).toBe(1); // 단 1회 증가
        expect(saga.outbox.filter((e) => e.status === 'PENDING' && e.message.type === MSG.REFUND)).toHaveLength(1);
    });
});
