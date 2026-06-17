const { SagaOrchestrator } = require('../../src/saga/SagaOrchestrator');
const { SagaState } = require('../../src/saga/SagaState');
const { QUEUE, MSG, STEP } = require('../../src/saga/sagaContracts');

describe('SagaOrchestrator (Phase 4a — CAS + outbox)', () => {
    let mockOrderRepo, mockInventoryRepo, mockSagaRepo, orchestrator;

    beforeEach(() => {
        mockOrderRepo = { save: jest.fn(), updateStatus: jest.fn(), findById: jest.fn() };
        mockInventoryRepo = { reserve: jest.fn(), release: jest.fn().mockResolvedValue(undefined) };
        mockSagaRepo = {
            save: jest.fn().mockResolvedValue(undefined),
            findBySagaId: jest.fn(),
            // 기본: 전이 성공(truthy 반환). CAS 패배 테스트는 mockResolvedValueOnce(null) 사용.
            compareAndAdvance: jest.fn().mockResolvedValue({ ok: true }),
        };
        orchestrator = new SagaOrchestrator({
            orderRepository: mockOrderRepo,
            inventoryRepository: mockInventoryRepo,
            sagaRepository: mockSagaRepo,
        });
    });

    /** n번째 compareAndAdvance 호출의 (sagaId, opts) */
    const advanceCall = (n = 0) => mockSagaRepo.compareAndAdvance.mock.calls[n];

    describe('startOrder()', () => {
        test('재고 예약 성공 시 INVENTORY_RESERVED 로 전이하고 CHARGE 를 outbox 에 적재한다(직접 발행 안 함)', async () => {
            mockOrderRepo.save.mockResolvedValue('order-1');
            mockInventoryRepo.reserve.mockResolvedValue(true);

            const result = await orchestrator.startOrder({
                userEmail: 'buyer@test.com', itemId: 'ITEM-1', quantity: 2, price: 5000, correlationId: 'trace-1',
            });

            expect(mockInventoryRepo.reserve).toHaveBeenCalledWith('ITEM-1', 2, result.sagaId);
            const [sagaId, opts] = advanceCall(0);
            expect(sagaId).toBe(result.sagaId);
            expect(opts).toMatchObject({ from: SagaState.STARTED, to: SagaState.INVENTORY_RESERVED });
            expect(opts.outbox).toEqual([
                expect.objectContaining({
                    queue: QUEUE.PAYMENT_COMMAND,
                    message: expect.objectContaining({
                        type: MSG.CHARGE, stepName: STEP.PAYMENT, payload: { orderId: 'order-1', amount: 10000 },
                    }),
                }),
            ]);
            expect(result).toMatchObject({ orderId: 'order-1', status: 'PENDING' });
        });

        test('재고 부족 시 outbox 적재 없이 FAILED 로 종료한다', async () => {
            mockOrderRepo.save.mockResolvedValue('order-2');
            mockInventoryRepo.reserve.mockResolvedValue(false);

            const result = await orchestrator.startOrder({
                userEmail: 'buyer@test.com', itemId: 'ITEM-1', quantity: 99, price: 5000,
            });

            const [, opts] = advanceCall(0);
            expect(opts).toMatchObject({ from: SagaState.STARTED, to: SagaState.FAILED });
            expect(opts.outbox).toBeUndefined();
            expect(mockOrderRepo.updateStatus).toHaveBeenCalledWith('order-2', 'FAILED');
            expect(result.status).toBe('FAILED');
        });

        test('STARTED saga 저장 시 top-level deadline 을 now+stepTimeoutMs 로 무장한다(정지-전진 감지)', async () => {
            mockOrderRepo.save.mockResolvedValue('order-3');
            mockInventoryRepo.reserve.mockResolvedValue(true);
            const FIXED_NOW = new Date('2026-06-17T12:00:00.000Z');
            const o = new SagaOrchestrator({
                orderRepository: mockOrderRepo, inventoryRepository: mockInventoryRepo,
                sagaRepository: mockSagaRepo, now: () => FIXED_NOW, stepTimeoutMs: 15000,
            });

            await o.startOrder({ userEmail: 'b@test.com', itemId: 'ITEM-1', quantity: 1, price: 1000 });

            const savedSaga = mockSagaRepo.save.mock.calls[0][0];
            expect(savedSaga.state).toBe(SagaState.STARTED);
            expect(savedSaga.deadline).toEqual(new Date(FIXED_NOW.getTime() + 15000));
        });
    });

    const sagaFixture = (overrides = {}) => ({
        sagaId: 's1', orderId: 'order-1', state: SagaState.INVENTORY_RESERVED,
        currentStep: STEP.PAYMENT, correlationId: 'trace-1',
        steps: [
            { name: STEP.INVENTORY, status: 'DONE',    payload: { itemId: 'ITEM-1', quantity: 2 } },
            { name: STEP.PAYMENT,   status: 'PENDING', payload: { orderId: 'order-1', amount: 10000 } },
            { name: STEP.POINTS,    status: 'PENDING', payload: { userEmail: 'buyer@test.com', amount: 10000 } },
        ],
        ...overrides,
    });

    describe('handleReply() — 결제 성공', () => {
        test('PAYMENT_SUCCEEDED 면 PAYMENT_CHARGED 로 전이하고 EARN 을 outbox 에 적재한다', async () => {
            mockSagaRepo.findBySagaId.mockResolvedValue(sagaFixture());

            await orchestrator.handleReply({
                sagaId: 's1', type: MSG.PAYMENT_SUCCEEDED, stepName: STEP.PAYMENT, payload: { paymentId: 'PAY-1' },
            });

            const [sagaId, opts] = advanceCall(0);
            expect(sagaId).toBe('s1');
            expect(opts).toMatchObject({ from: SagaState.INVENTORY_RESERVED, to: SagaState.PAYMENT_CHARGED });
            expect(opts.steps).toEqual([
                expect.objectContaining({ name: STEP.PAYMENT, status: 'DONE', replyData: { paymentId: 'PAY-1' } }),
            ]);
            expect(opts.outbox[0]).toMatchObject({
                queue: QUEUE.POINTS_COMMAND,
                message: expect.objectContaining({ type: MSG.EARN, payload: { userEmail: 'buyer@test.com', amount: 10000 } }),
            });
        });

        test('CAS 패배(이미 전이됨)면 아무 부수효과도 하지 않는다(멱등)', async () => {
            mockSagaRepo.findBySagaId.mockResolvedValue(sagaFixture());
            mockSagaRepo.compareAndAdvance.mockResolvedValueOnce(null);

            await orchestrator.handleReply({ sagaId: 's1', type: MSG.PAYMENT_SUCCEEDED, payload: { paymentId: 'PAY-1' } });

            expect(mockSagaRepo.compareAndAdvance).toHaveBeenCalledTimes(1);
            expect(mockOrderRepo.updateStatus).not.toHaveBeenCalled();
        });

        test('알 수 없는 sagaId 면 아무 동작도 하지 않는다', async () => {
            mockSagaRepo.findBySagaId.mockResolvedValue(null);
            await orchestrator.handleReply({ sagaId: 'nope', type: MSG.PAYMENT_SUCCEEDED });
            expect(mockSagaRepo.compareAndAdvance).not.toHaveBeenCalled();
        });
    });

    describe('handleReply() — 포인트 성공 → 완료', () => {
        test('POINTS_SUCCEEDED 면 POINTS_EARNED→주문 SUCCESS→COMPLETED 로 종료한다', async () => {
            mockSagaRepo.findBySagaId.mockResolvedValue(sagaFixture({ state: SagaState.PAYMENT_CHARGED, currentStep: STEP.POINTS }));

            await orchestrator.handleReply({ sagaId: 's1', type: MSG.POINTS_SUCCEEDED });

            expect(advanceCall(0)[1]).toMatchObject({ from: SagaState.PAYMENT_CHARGED, to: SagaState.POINTS_EARNED });
            expect(mockOrderRepo.updateStatus).toHaveBeenCalledWith('order-1', 'SUCCESS');
            expect(advanceCall(1)[1]).toMatchObject({ from: SagaState.POINTS_EARNED, to: SagaState.COMPLETED });
        });
    });

    describe('handleReply() — 결제 실패 → 보상', () => {
        test('PAYMENT_FAILED 면 COMPENSATING→재고복원→FAILED 로 종료한다', async () => {
            mockSagaRepo.findBySagaId.mockResolvedValue(sagaFixture());

            await orchestrator.handleReply({ sagaId: 's1', type: MSG.PAYMENT_FAILED, stepName: STEP.PAYMENT });

            expect(advanceCall(0)[1]).toMatchObject({ from: SagaState.INVENTORY_RESERVED, to: SagaState.COMPENSATING });
            expect(mockInventoryRepo.release).toHaveBeenCalledWith('ITEM-1', 2, 's1');
            expect(mockOrderRepo.updateStatus).toHaveBeenCalledWith('order-1', 'FAILED');
            expect(advanceCall(1)[1]).toMatchObject({ from: SagaState.COMPENSATING, to: SagaState.FAILED });
        });

        test('진입 CAS 패배면 재고를 복원하지 않는다(중복 보상 방지 — L3)', async () => {
            mockSagaRepo.findBySagaId.mockResolvedValue(sagaFixture());
            mockSagaRepo.compareAndAdvance.mockResolvedValueOnce(null);

            await orchestrator.handleReply({ sagaId: 's1', type: MSG.PAYMENT_FAILED, stepName: STEP.PAYMENT });

            expect(mockInventoryRepo.release).not.toHaveBeenCalled();
        });
    });

    describe('handleReply() — 포인트 실패 → 2단계 보상', () => {
        const chargedSaga = (overrides = {}) => sagaFixture({
            state: SagaState.PAYMENT_CHARGED, currentStep: STEP.POINTS,
            steps: [
                { name: STEP.INVENTORY, status: 'DONE', payload: { itemId: 'ITEM-1', quantity: 2 } },
                { name: STEP.PAYMENT,   status: 'DONE', payload: { orderId: 'order-1', amount: 10000 }, replyData: { paymentId: 'PAY-1' } },
                { name: STEP.POINTS,    status: 'PENDING', payload: { userEmail: 'buyer@test.com', amount: 10000 } },
            ],
            ...overrides,
        });

        test('POINTS_FAILED 면 COMPENSATING 으로 전이하고 REFUND 를 outbox 에 적재한다', async () => {
            mockSagaRepo.findBySagaId.mockResolvedValue(chargedSaga());

            await orchestrator.handleReply({ sagaId: 's1', type: MSG.POINTS_FAILED, stepName: STEP.POINTS });

            const [, opts] = advanceCall(0);
            expect(opts).toMatchObject({ from: SagaState.PAYMENT_CHARGED, to: SagaState.COMPENSATING });
            expect(opts.outbox[0]).toMatchObject({
                queue: QUEUE.PAYMENT_COMMAND,
                message: expect.objectContaining({ type: MSG.REFUND, payload: { paymentId: 'PAY-1', orderId: 'order-1' } }),
            });
            expect(mockInventoryRepo.release).not.toHaveBeenCalled();
        });

        test('REFUND_SUCCEEDED 면 재고를 복원하고 FAILED 로 종료한다', async () => {
            mockSagaRepo.findBySagaId.mockResolvedValue(chargedSaga({ state: SagaState.COMPENSATING }));

            await orchestrator.handleReply({ sagaId: 's1', type: MSG.REFUND_SUCCEEDED, stepName: STEP.PAYMENT });

            expect(mockInventoryRepo.release).toHaveBeenCalledWith('ITEM-1', 2, 's1');
            expect(mockOrderRepo.updateStatus).toHaveBeenCalledWith('order-1', 'FAILED');
            expect(advanceCall(0)[1]).toMatchObject({ from: SagaState.COMPENSATING, to: SagaState.FAILED });
        });

        test('이미 COMPLETED 인 saga 에 REFUND_SUCCEEDED 가 와도 재고/주문을 건드리지 않는다 (지연·중복·오라우팅 reply 방어 — Codex high)', async () => {
            mockSagaRepo.findBySagaId.mockResolvedValue(chargedSaga({ state: SagaState.COMPLETED }));

            await orchestrator.handleReply({ sagaId: 's1', type: MSG.REFUND_SUCCEEDED, stepName: STEP.PAYMENT });

            // 보상 상태가 아니므로 어떤 부수효과도 일어나면 안 된다(재고 부풀림/성공주문 FAILED 오염 방지)
            expect(mockInventoryRepo.release).not.toHaveBeenCalled();
            expect(mockOrderRepo.updateStatus).not.toHaveBeenCalled();
            expect(mockSagaRepo.compareAndAdvance).not.toHaveBeenCalled();
        });
    });

    describe('handleReply() — 포인트 비활성(POINTS_ENABLED=false)', () => {
        test('PAYMENT_SUCCEEDED 면 outbox 적재 없이 주문 SUCCESS→COMPLETED 로 종료한다', async () => {
            const noPoints = new SagaOrchestrator({
                orderRepository: mockOrderRepo, inventoryRepository: mockInventoryRepo,
                sagaRepository: mockSagaRepo, pointsEnabled: false,
            });
            mockSagaRepo.findBySagaId.mockResolvedValue(sagaFixture());

            await noPoints.handleReply({ sagaId: 's1', type: MSG.PAYMENT_SUCCEEDED, payload: { paymentId: 'PAY-1' } });

            const [, opts] = advanceCall(0);
            expect(opts).toMatchObject({ from: SagaState.INVENTORY_RESERVED, to: SagaState.PAYMENT_CHARGED });
            expect(opts.outbox).toBeUndefined();
            expect(mockOrderRepo.updateStatus).toHaveBeenCalledWith('order-1', 'SUCCESS');
            expect(advanceCall(1)[1]).toMatchObject({ from: SagaState.PAYMENT_CHARGED, to: SagaState.COMPLETED });
        });
    });

    describe('handleTimeout() — 타임아웃 스윕 위임 (Phase 4b)', () => {
        test('STARTED 면 재고 예약 후 INVENTORY_RESERVED 로 재구동한다(정지-전진)', async () => {
            mockInventoryRepo.reserve.mockResolvedValue(true);
            const saga = {
                sagaId: 's1', orderId: 'order-1', state: SagaState.STARTED, correlationId: 'trace-1',
                steps: [
                    { name: STEP.INVENTORY, status: 'PENDING', payload: { itemId: 'ITEM-1', quantity: 2 } },
                    { name: STEP.PAYMENT,   status: 'PENDING', payload: { orderId: 'order-1', amount: 10000 } },
                    { name: STEP.POINTS,    status: 'PENDING', payload: { userEmail: 'b@test.com', amount: 10000 } },
                ],
            };

            await orchestrator.handleTimeout(saga);

            expect(mockInventoryRepo.reserve).toHaveBeenCalledWith('ITEM-1', 2, 's1');
            expect(advanceCall(0)[1]).toMatchObject({ from: SagaState.STARTED, to: SagaState.INVENTORY_RESERVED });
            expect(advanceCall(0)[1].outbox[0].message).toMatchObject({ type: MSG.CHARGE });
        });

        test('STARTED 인데 재고 진짜 부족이면 FAILED 로 종료한다', async () => {
            mockInventoryRepo.reserve.mockResolvedValue(false);
            const saga = {
                sagaId: 's1', orderId: 'order-1', state: SagaState.STARTED,
                steps: [
                    { name: STEP.INVENTORY, status: 'PENDING', payload: { itemId: 'ITEM-1', quantity: 99 } },
                    { name: STEP.PAYMENT,   status: 'PENDING', payload: { orderId: 'order-1', amount: 10000 } },
                ],
            };

            await orchestrator.handleTimeout(saga);

            expect(advanceCall(0)[1]).toMatchObject({ from: SagaState.STARTED, to: SagaState.FAILED });
            expect(mockOrderRepo.updateStatus).toHaveBeenCalledWith('order-1', 'FAILED');
        });

        test('INVENTORY_RESERVED 면 결제 실패 보상과 동일 경로(재고복원→FAILED)', async () => {
            mockSagaRepo.findBySagaId.mockResolvedValue(sagaFixture());
            const saga = sagaFixture();

            await orchestrator.handleTimeout(saga);

            expect(advanceCall(0)[1]).toMatchObject({ from: SagaState.INVENTORY_RESERVED, to: SagaState.COMPENSATING });
            expect(advanceCall(0)[1].outbox).toBeUndefined(); // 결제 미확정 → 환불 적재 없음(재고복원만, L4)
            expect(mockInventoryRepo.release).toHaveBeenCalledWith('ITEM-1', 2, 's1');
            expect(advanceCall(1)[1]).toMatchObject({ from: SagaState.COMPENSATING, to: SagaState.FAILED });
        });

        test('PAYMENT_CHARGED 면 포인트 실패 보상과 동일 경로(REFUND 적재)', async () => {
            const charged = sagaFixture({
                state: SagaState.PAYMENT_CHARGED, currentStep: STEP.POINTS,
                steps: [
                    { name: STEP.INVENTORY, status: 'DONE', payload: { itemId: 'ITEM-1', quantity: 2 } },
                    { name: STEP.PAYMENT,   status: 'DONE', payload: { orderId: 'order-1', amount: 10000 }, replyData: { paymentId: 'PAY-1' } },
                    { name: STEP.POINTS,    status: 'PENDING', payload: { userEmail: 'b@test.com', amount: 10000 } },
                ],
            });

            await orchestrator.handleTimeout(charged);

            expect(advanceCall(0)[1]).toMatchObject({ from: SagaState.PAYMENT_CHARGED, to: SagaState.COMPENSATING });
            expect(advanceCall(0)[1].outbox[0].message).toMatchObject({ type: MSG.REFUND, payload: { paymentId: 'PAY-1', orderId: 'order-1' } });
        });
    });

    describe('handleReply() — 환불 실패 복구 (Phase 4b)', () => {
        const compensatingSaga = (compensateAttempts = 0) => ({
            sagaId: 's1', orderId: 'order-1', state: SagaState.COMPENSATING, correlationId: 'trace-1',
            steps: [
                { name: STEP.INVENTORY, status: 'DONE', payload: { itemId: 'ITEM-1', quantity: 2 } },
                { name: STEP.PAYMENT,   status: 'DONE', payload: { orderId: 'order-1', amount: 10000 }, replyData: { paymentId: 'PAY-1' }, compensateAttempts },
                { name: STEP.POINTS,    status: 'FAILED', payload: { userEmail: 'b@test.com', amount: 10000 } },
            ],
        });

        beforeEach(() => {
            mockSagaRepo.retryCompensation = jest.fn().mockResolvedValue({ ok: true });
        });

        test('attempts 가 상한 미만이면 REFUND 를 재적재한다(attempts CAS)', async () => {
            mockSagaRepo.findBySagaId.mockResolvedValue(compensatingSaga(0));

            await orchestrator.handleReply({ sagaId: 's1', type: MSG.REFUND_FAILED, stepName: STEP.PAYMENT });

            expect(mockSagaRepo.retryCompensation).toHaveBeenCalledWith('s1', expect.objectContaining({
                stepName: STEP.PAYMENT, expectedAttempts: 0,
            }));
            const { outbox } = mockSagaRepo.retryCompensation.mock.calls[0][1];
            expect(outbox[0].message).toMatchObject({ type: MSG.REFUND, payload: { paymentId: 'PAY-1', orderId: 'order-1' } });
        });

        test('attempts+1 이 상한에 도달하면 COMPENSATION_FAILED 로 에스컬레이션 + 에러 로그', async () => {
            const o = new SagaOrchestrator({
                orderRepository: mockOrderRepo, inventoryRepository: mockInventoryRepo,
                sagaRepository: mockSagaRepo, maxCompensateAttempts: 2,
            });
            mockSagaRepo.findBySagaId.mockResolvedValue(compensatingSaga(1)); // 1+1=2 >= 2
            const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

            await o.handleReply({ sagaId: 's1', type: MSG.REFUND_FAILED, stepName: STEP.PAYMENT });

            expect(mockSagaRepo.retryCompensation).not.toHaveBeenCalled();
            expect(advanceCall(0)[1]).toMatchObject({ from: SagaState.COMPENSATING, to: SagaState.COMPENSATION_FAILED });
            expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('운영자 개입'));
            errSpy.mockRestore();
        });

        test('COMPENSATING 이 아니면 아무 것도 하지 않는다(가드)', async () => {
            mockSagaRepo.findBySagaId.mockResolvedValue({ ...compensatingSaga(0), state: SagaState.COMPLETED });

            await orchestrator.handleReply({ sagaId: 's1', type: MSG.REFUND_FAILED, stepName: STEP.PAYMENT });

            expect(mockSagaRepo.retryCompensation).not.toHaveBeenCalled();
            expect(mockSagaRepo.compareAndAdvance).not.toHaveBeenCalled();
        });
    });
});
