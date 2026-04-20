/**
 * [테스트] Order Service HTTP 라우터 테스트
 *
 * 학습 포인트:
 *   1. 팩토리 함수(createOrderRouter)에 mock service를 주입하여 HTTP 계층만 격리 테스트합니다
 *   2. 비즈니스 로직(OrderService)은 mock으로 대체 — 라우터가 올바른 응답을 반환하는지만 검증합니다
 *   3. error.code → HTTP 상태 코드 변환이 올바른지 확인합니다
 *
 * [제18강 변경사항 — DDD 리팩터링]
 *   이전: createTestApp()에서 라우트 로직을 직접 작성 + jest.mock('../models/Order') 사용
 *   이후: createOrderRouter({ orderService, internalApiKey })로 실제 라우터를 가져와 mock service를 주입
 *   이유: 라우터 로직이 중복 없이 실제 코드를 테스트합니다
 *
 * 실행: npm test
 */

const request = require('supertest');
const express = require('express');

const { createOrderRouter } = require('../src/interfaces/routes/orderRoutes');
const { OrderServiceError } = require('../src/application/OrderService');

// 테스트에서 사용할 내부 API 키
const TEST_INTERNAL_KEY = 'test-internal-key-2026';

// ----------------------------------------------------------
// mock OrderService 생성 헬퍼
// ----------------------------------------------------------
function createMockOrderService() {
    return {
        createOrder: jest.fn(),
        processPaymentCallback: jest.fn(),
    };
}

// ----------------------------------------------------------
// 테스트용 Express 앱 생성 헬퍼
// createOrderRouter에 mock service를 주입합니다
// ----------------------------------------------------------
function createTestApp(mockOrderService) {
    const app = express();
    app.use(express.json());
    const router = createOrderRouter({
        orderService: mockOrderService,
        internalApiKey: TEST_INTERNAL_KEY,
    });
    app.use('/api/order', router);
    return app;
}

// 각 테스트 전 mock 초기화
let mockOrderService;
beforeEach(() => {
    mockOrderService = createMockOrderService();
});

// ==========================================================
// POST /api/order — 주문 생성 테스트
// ==========================================================

describe('POST /api/order (주문 생성)', () => {

    test('X-User-Email 헤더가 있으면 orderService.createOrder()를 호출하고 202 Accepted를 반환한다', async () => {
        // GIVEN: 주문 생성 성공
        mockOrderService.createOrder.mockResolvedValue({
            orderId: 'mock-order-id-123',
            status: 'PENDING',
        });

        // WHEN
        const res = await request(createTestApp(mockOrderService))
            .post('/api/order')
            .set('X-User-Email', 'buyer@test.com')
            .send({ itemId: 'ITEM-001', quantity: 2, price: 15000 });

        // THEN
        expect(res.status).toBe(202);
        expect(res.body.status).toBe('PENDING');
        expect(res.body.orderId).toBe('mock-order-id-123');
        // [제20강 / Issue #8] 5번째 인수: 헤더가 없으면 normalizeCorrelationId 가
        // 서버에서 새 UUID 를 발급한다 (부정 입력 방어 + 추적 가능성 유지).
        expect(mockOrderService.createOrder).toHaveBeenCalledWith(
            'buyer@test.com', 'ITEM-001', 2, 15000,
            expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
        );
    });

    test('X-Correlation-ID 헤더가 있으면 createOrder에 correlationId가 전달된다', async () => {
        // GIVEN
        mockOrderService.createOrder.mockResolvedValue({ orderId: 'order-xyz', status: 'PENDING' });

        // WHEN: X-Correlation-ID 헤더를 포함하여 요청
        const res = await request(createTestApp(mockOrderService))
            .post('/api/order')
            .set('X-User-Email', 'buyer@test.com')
            .set('X-Correlation-ID', 'trace-abc-123')
            .send({ itemId: 'ITEM-001', quantity: 1, price: 5000 });

        // THEN: correlationId가 서비스로 전달됨
        expect(res.status).toBe(202);
        expect(mockOrderService.createOrder).toHaveBeenCalledWith(
            'buyer@test.com', 'ITEM-001', 1, 5000, 'trace-abc-123'
        );
    });

    test('X-User-Email 헤더 없이 요청하면 401을 반환한다 (Gateway 미통과)', async () => {
        // WHEN: 헤더 없이 직접 접근
        const res = await request(createTestApp(mockOrderService))
            .post('/api/order')
            .send({ itemId: 'ITEM-001', quantity: 1, price: 10000 });

        // THEN: service는 호출되지 않고 401 반환
        expect(res.status).toBe(401);
        expect(res.body.message).toContain('X-User-Email 헤더 누락');
        expect(mockOrderService.createOrder).not.toHaveBeenCalled();
    });

    test('서비스 처리 중 예외가 발생하면 500을 반환한다', async () => {
        // GIVEN: DB 연결 오류 등 예상치 못한 에러
        mockOrderService.createOrder.mockRejectedValue(new Error('DB connection failed'));

        const res = await request(createTestApp(mockOrderService))
            .post('/api/order')
            .set('X-User-Email', 'buyer@test.com')
            .send({ itemId: 'ITEM-001', quantity: 1, price: 10000 });

        expect(res.status).toBe(500);
    });
});

// ==========================================================
// POST /api/order/callback — 결제 결과 콜백 테스트
// ==========================================================

describe('POST /api/order/callback (결제 결과 콜백)', () => {
    const VALID_KEY = TEST_INTERNAL_KEY;

    test('X-Internal-Key 없이 호출하면 403을 반환한다', async () => {
        const res = await request(createTestApp(mockOrderService))
            .post('/api/order/callback')
            .send({ orderId: 'order-abc', paymentStatus: 'COMPLETED' });

        expect(res.status).toBe(403);
        expect(res.body.message).toContain('내부 서비스 인증 실패');
        expect(mockOrderService.processPaymentCallback).not.toHaveBeenCalled();
    });

    test('잘못된 X-Internal-Key로 호출하면 403을 반환한다', async () => {
        const res = await request(createTestApp(mockOrderService))
            .post('/api/order/callback')
            .set('X-Internal-Key', 'wrong-key')
            .send({ orderId: 'order-abc', paymentStatus: 'COMPLETED' });

        expect(res.status).toBe(403);
    });

    test('올바른 키 + COMPLETED 콜백이면 200을 반환한다', async () => {
        // GIVEN
        mockOrderService.processPaymentCallback.mockResolvedValue({ status: 'SUCCESS' });

        // WHEN
        const res = await request(createTestApp(mockOrderService))
            .post('/api/order/callback')
            .set('X-Internal-Key', VALID_KEY)
            .send({ orderId: 'order-abc', paymentStatus: 'COMPLETED' });

        // THEN
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('SUCCESS');
        expect(mockOrderService.processPaymentCallback).toHaveBeenCalledWith('order-abc', 'COMPLETED');
    });

    test('올바른 키 + FAILED 콜백이면 200을 반환한다', async () => {
        mockOrderService.processPaymentCallback.mockResolvedValue({ status: 'FAILED' });

        const res = await request(createTestApp(mockOrderService))
            .post('/api/order/callback')
            .set('X-Internal-Key', VALID_KEY)
            .send({ orderId: 'order-def', paymentStatus: 'FAILED' });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('FAILED');
    });

    test('유효하지 않은 paymentStatus이면 서비스 에러 INVALID_PAYMENT_STATUS → 400을 반환한다', async () => {
        // GIVEN: 서비스가 INVALID_PAYMENT_STATUS 에러를 던짐
        mockOrderService.processPaymentCallback.mockRejectedValue(
            new OrderServiceError('INVALID_PAYMENT_STATUS', '유효하지 않은 결제 상태: UNKNOWN')
        );

        const res = await request(createTestApp(mockOrderService))
            .post('/api/order/callback')
            .set('X-Internal-Key', VALID_KEY)
            .send({ orderId: 'order-abc', paymentStatus: 'UNKNOWN' });

        expect(res.status).toBe(400);
        expect(res.body.message).toContain('유효하지 않은 결제 상태');
    });

    test('존재하지 않는 주문이면 ORDER_NOT_FOUND → 404를 반환한다', async () => {
        mockOrderService.processPaymentCallback.mockRejectedValue(
            new OrderServiceError('ORDER_NOT_FOUND', '주문을 찾을 수 없습니다: nonexistent-id')
        );

        const res = await request(createTestApp(mockOrderService))
            .post('/api/order/callback')
            .set('X-Internal-Key', VALID_KEY)
            .send({ orderId: 'nonexistent-id', paymentStatus: 'COMPLETED' });

        expect(res.status).toBe(404);
        expect(res.body.message).toContain('주문을 찾을 수 없습니다');
    });

    test('이미 처리된 주문이면 ORDER_ALREADY_PROCESSED → 409를 반환한다 (멱등성)', async () => {
        mockOrderService.processPaymentCallback.mockRejectedValue(
            new OrderServiceError(
                'ORDER_ALREADY_PROCESSED',
                '이미 처리된 주문입니다. 현재 상태: SUCCESS',
                { currentStatus: 'SUCCESS' }
            )
        );

        const res = await request(createTestApp(mockOrderService))
            .post('/api/order/callback')
            .set('X-Internal-Key', VALID_KEY)
            .send({ orderId: 'order-done', paymentStatus: 'COMPLETED' });

        expect(res.status).toBe(409);
        expect(res.body.message).toContain('이미 처리된 주문');
        expect(res.body.currentStatus).toBe('SUCCESS');
    });

    test('이미 FAILED인 주문에 COMPLETED 콜백하면 409를 반환한다 (역전 방지)', async () => {
        mockOrderService.processPaymentCallback.mockRejectedValue(
            new OrderServiceError(
                'ORDER_ALREADY_PROCESSED',
                '이미 처리된 주문입니다. 현재 상태: FAILED',
                { currentStatus: 'FAILED' }
            )
        );

        const res = await request(createTestApp(mockOrderService))
            .post('/api/order/callback')
            .set('X-Internal-Key', VALID_KEY)
            .send({ orderId: 'order-failed', paymentStatus: 'COMPLETED' });

        expect(res.status).toBe(409);
        expect(res.body.currentStatus).toBe('FAILED');
    });
});

// ==========================================================
// GET /api/order/health — 헬스 체크 테스트
// ==========================================================

describe('GET /api/order/health (헬스 체크)', () => {

    test('서비스 상태 OK를 반환한다', async () => {
        const res = await request(createTestApp(mockOrderService))
            .get('/api/order/health');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('OK');
    });
});
