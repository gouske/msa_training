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
});
