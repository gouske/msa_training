const { SagaOrchestrator } = require('../../src/saga/SagaOrchestrator');
const { SagaState } = require('../../src/saga/SagaState');
const { QUEUE, MSG, STEP } = require('../../src/saga/sagaContracts');

describe('SagaOrchestrator', () => {
    let mockOrderRepo, mockInventoryRepo, mockSagaRepo, mockPublisher, orchestrator;

    beforeEach(() => {
        mockOrderRepo = { save: jest.fn(), updateStatus: jest.fn(), findById: jest.fn() };
        mockInventoryRepo = { reserve: jest.fn(), release: jest.fn().mockResolvedValue(undefined) };
        mockSagaRepo = { save: jest.fn().mockResolvedValue(undefined), findBySagaId: jest.fn() };
        mockPublisher = { publish: jest.fn().mockResolvedValue(undefined) };
        orchestrator = new SagaOrchestrator({
            orderRepository: mockOrderRepo,
            inventoryRepository: mockInventoryRepo,
            sagaRepository: mockSagaRepo,
            commandPublisher: mockPublisher,
        });
    });

    /** 마지막으로 sagaRepo.save 에 전달된 saga 객체 */
    const lastSavedSaga = () => mockSagaRepo.save.mock.calls.at(-1)[0];

    describe('startOrder()', () => {
        test('재고 예약 성공 시 INVENTORY_RESERVED 로 전이하고 결제 command 를 발행한다', async () => {
            mockOrderRepo.save.mockResolvedValue('order-1');
            mockInventoryRepo.reserve.mockResolvedValue(true);

            const result = await orchestrator.startOrder({
                userEmail: 'buyer@test.com', itemId: 'ITEM-1', quantity: 2, price: 5000,
            });

            // 재고 예약 호출
            expect(mockInventoryRepo.reserve).toHaveBeenCalledWith('ITEM-1', 2);
            // 결제 command 발행 (amount = 5000 × 2)
            expect(mockPublisher.publish).toHaveBeenCalledWith(
                QUEUE.PAYMENT_COMMAND,
                expect.objectContaining({
                    type: MSG.CHARGE,
                    stepName: STEP.PAYMENT,
                    payload: { orderId: 'order-1', amount: 10000 },
                }),
            );
            // 최종 저장 상태
            expect(lastSavedSaga().state).toBe(SagaState.INVENTORY_RESERVED);
            expect(result).toMatchObject({ orderId: 'order-1', status: 'PENDING' });
            expect(typeof result.sagaId).toBe('string');
        });

        test('재고 부족 시 결제 command 없이 FAILED 로 종료한다 (보상 불필요)', async () => {
            mockOrderRepo.save.mockResolvedValue('order-2');
            mockInventoryRepo.reserve.mockResolvedValue(false);

            const result = await orchestrator.startOrder({
                userEmail: 'buyer@test.com', itemId: 'ITEM-1', quantity: 99, price: 5000,
            });

            expect(mockPublisher.publish).not.toHaveBeenCalled();
            expect(mockOrderRepo.updateStatus).toHaveBeenCalledWith('order-2', 'FAILED');
            expect(lastSavedSaga().state).toBe(SagaState.FAILED);
            expect(result.status).toBe('FAILED');
        });
    });

    /** handleReply 테스트용 saga 픽스처 */
    const sagaFixture = (overrides = {}) => ({
        sagaId: 's1',
        orderId: 'order-1',
        state: SagaState.INVENTORY_RESERVED,
        currentStep: STEP.PAYMENT,
        correlationId: 'trace-1',
        steps: [
            { name: STEP.INVENTORY, status: 'DONE',    payload: { itemId: 'ITEM-1', quantity: 2 } },
            { name: STEP.PAYMENT,   status: 'PENDING', payload: { orderId: 'order-1', amount: 10000 } },
            { name: STEP.POINTS,    status: 'PENDING', payload: { userEmail: 'buyer@test.com', amount: 10000 } },
        ],
        ...overrides,
    });

    describe('handleReply() — 결제 성공', () => {
        test('PAYMENT_SUCCEEDED 면 PAYMENT_CHARGED 로 전이하고 포인트 command 를 발행한다', async () => {
            mockSagaRepo.findBySagaId.mockResolvedValue(sagaFixture());

            await orchestrator.handleReply({
                sagaId: 's1', type: MSG.PAYMENT_SUCCEEDED, stepName: STEP.PAYMENT,
                payload: { paymentId: 'PAY-1' },
            });

            // 포인트 적립 command 발행
            expect(mockPublisher.publish).toHaveBeenCalledWith(
                QUEUE.POINTS_COMMAND,
                expect.objectContaining({
                    type: MSG.EARN,
                    stepName: STEP.POINTS,
                    payload: { userEmail: 'buyer@test.com', amount: 10000 },
                }),
            );
            const saved = lastSavedSaga();
            expect(saved.state).toBe(SagaState.PAYMENT_CHARGED);
            // 결제 단계에 paymentId(replyData) 보관 — 나중에 환불 시 식별자로 사용
            expect(saved.steps.find((s) => s.name === STEP.PAYMENT).replyData).toEqual({ paymentId: 'PAY-1' });
        });

        test('알 수 없는 sagaId 면 아무 동작도 하지 않는다', async () => {
            mockSagaRepo.findBySagaId.mockResolvedValue(null);
            await orchestrator.handleReply({ sagaId: 'nope', type: MSG.PAYMENT_SUCCEEDED });
            expect(mockPublisher.publish).not.toHaveBeenCalled();
        });
    });
});
