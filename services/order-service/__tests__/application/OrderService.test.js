/**
 * [TDD - RED] OrderService 애플리케이션 서비스 테스트
 *
 * 학습 포인트:
 *   - 애플리케이션 서비스는 의존성(Repository, MessagePublisher)을 주입받습니다
 *   - 테스트에서 의존성을 jest.fn()으로 대체하여 비즈니스 로직만 검증합니다
 *   - 에러 케이스에서 error.code로 에러 유형을 구분합니다
 */

const { OrderService, OrderServiceError } = require('../../src/application/OrderService');

describe('OrderService (애플리케이션 서비스)', () => {

    // 각 테스트마다 새로운 mock 의존성을 생성합니다
    let mockRepo;
    let mockPublisher;
    let orderService;

    beforeEach(() => {
        // Repository mock: 저장소 접근을 가짜로 대체
        mockRepo = {
            save: jest.fn(),
            findById: jest.fn(),
            updateStatus: jest.fn(),
        };
        // MessagePublisher mock: 메시지 발행을 가짜로 대체
        mockPublisher = {
            publish: jest.fn().mockResolvedValue(undefined),
        };
        orderService = new OrderService(mockRepo, mockPublisher);
    });

    // ==========================================================
    // createOrder() — 주문 생성 유스케이스
    // ==========================================================

    describe('createOrder()', () => {

        test('주문을 저장하고 결제 메시지를 발행한 후 orderId와 PENDING 상태를 반환한다', async () => {
            // GIVEN: 저장 성공 시 orderId 반환
            mockRepo.save.mockResolvedValue('saved-order-id');

            // WHEN: 주문 생성 요청
            const result = await orderService.createOrder('buyer@test.com', 'ITEM-001', 2, 5000);

            // THEN: 저장소에 저장됨
            expect(mockRepo.save).toHaveBeenCalledTimes(1);

            // THEN: 메시지가 올바른 형식으로 발행됨
            expect(mockPublisher.publish).toHaveBeenCalledWith({
                orderId: 'saved-order-id',
                amount: 10000, // 5000 × 2
                userEmail: 'buyer@test.com',
            });

            // THEN: orderId와 PENDING 상태 반환
            expect(result).toEqual({ orderId: 'saved-order-id', status: 'PENDING' });
        });
    });

    // ==========================================================
    // processPaymentCallback() — 결제 콜백 처리 유스케이스
    // ==========================================================

    describe('processPaymentCallback()', () => {

        test('COMPLETED 콜백이면 updateStatus를 SUCCESS로 호출한다', async () => {
            // GIVEN
            mockRepo.updateStatus.mockResolvedValue({ status: 'SUCCESS' });

            // WHEN
            const result = await orderService.processPaymentCallback('order-id', 'COMPLETED');

            // THEN
            expect(mockRepo.updateStatus).toHaveBeenCalledWith('order-id', 'SUCCESS');
            expect(result).toEqual({ status: 'SUCCESS' });
        });

        test('FAILED 콜백이면 updateStatus를 FAILED로 호출한다', async () => {
            // GIVEN
            mockRepo.updateStatus.mockResolvedValue({ status: 'FAILED' });

            // WHEN
            const result = await orderService.processPaymentCallback('order-id', 'FAILED');

            // THEN
            expect(mockRepo.updateStatus).toHaveBeenCalledWith('order-id', 'FAILED');
            expect(result).toEqual({ status: 'FAILED' });
        });

        test('유효하지 않은 paymentStatus이면 INVALID_PAYMENT_STATUS 에러를 던진다', async () => {
            await expect(
                orderService.processPaymentCallback('order-id', 'UNKNOWN')
            ).rejects.toMatchObject({ code: 'INVALID_PAYMENT_STATUS' });
        });

        test('OrderServiceError 인스턴스를 던진다', async () => {
            await expect(
                orderService.processPaymentCallback('order-id', 'UNKNOWN')
            ).rejects.toBeInstanceOf(OrderServiceError);
        });

        test('updateStatus가 null이고 주문이 없으면 ORDER_NOT_FOUND 에러를 던진다', async () => {
            // GIVEN: PENDING 조건 불일치(null) + 주문 자체 없음
            mockRepo.updateStatus.mockResolvedValue(null);
            mockRepo.findById.mockResolvedValue(null);

            // WHEN & THEN
            await expect(
                orderService.processPaymentCallback('nonexistent-id', 'COMPLETED')
            ).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
        });

        test('updateStatus가 null이고 주문이 이미 처리된 상태이면 ORDER_ALREADY_PROCESSED 에러를 던진다', async () => {
            // GIVEN: PENDING 조건 불일치(null) + 이미 SUCCESS 상태
            mockRepo.updateStatus.mockResolvedValue(null);
            mockRepo.findById.mockResolvedValue({ id: 'order-done', status: 'SUCCESS' });

            // WHEN & THEN
            await expect(
                orderService.processPaymentCallback('order-done', 'COMPLETED')
            ).rejects.toMatchObject({
                code: 'ORDER_ALREADY_PROCESSED',
                data: { currentStatus: 'SUCCESS' },
            });
        });
    });
});
