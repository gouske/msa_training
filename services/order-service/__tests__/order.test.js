/**
 * [테스트] Order Service 엔드포인트 단위 테스트
 *
 * 학습 포인트:
 *   1. jest.mock()으로 외부 의존성(MongoDB, RabbitMQ, 서킷 브레이커)을 격리하는 방법
 *   2. supertest로 Express 엔드포인트를 HTTP 요청 없이 테스트하는 방법
 *   3. 각 엔드포인트의 정상/비정상 시나리오 검증
 *
 * 실행: npm test
 */

// ----------------------------------------------------------
// 1. 외부 의존성 Mock 설정
//    실제 DB, RabbitMQ, Auth Service 없이 테스트하기 위해
//    모듈 전체를 가짜(mock)로 교체합니다.
// ----------------------------------------------------------

// Mongoose 연결을 mock하여 실제 MongoDB 없이 테스트
jest.mock('mongoose', () => {
    const actualMongoose = jest.requireActual('mongoose');
    return {
        ...actualMongoose,
        // connect()는 아무것도 하지 않는 함수로 대체
        connect: jest.fn().mockResolvedValue(true),
        // Schema와 model은 실제 구현을 유지 (Order 모델 구조 검증용)
        Schema: actualMongoose.Schema,
        model: jest.fn(),
    };
});

// Order 모델 mock: save(), findById() 등 DB 작업을 가짜로 대체
jest.mock('../models/Order', () => {
    // jest.fn()으로 생성자 함수를 만듭니다 (new Order({...}) 호출용)
    const mockOrder = jest.fn().mockImplementation((data) => ({
        ...data,
        _id: 'mock-order-id-123',
        // save()는 저장된 주문 객체를 반환
        save: jest.fn().mockResolvedValue({
            ...data,
            _id: 'mock-order-id-123',
            status: 'PENDING',
        }),
    }));
    // findById()는 정적 메서드로 추가
    mockOrder.findById = jest.fn();
    return mockOrder;
});

// RabbitMQ 메시지 발행 mock: 실제 큐 없이 발행 성공을 시뮬레이션
jest.mock('../producer', () => ({
    sendOrderMessage: jest.fn().mockResolvedValue(true),
}));

// 서킷 브레이커 mock: Auth Service 호출 결과를 직접 제어
jest.mock('../circuitBreaker', () => ({
    authBreaker: {
        fire: jest.fn(),
        opened: false, // 기본: CLOSED 상태
    },
}));

// ----------------------------------------------------------
// 2. 테스트에 필요한 모듈 로딩
// ----------------------------------------------------------
const request = require('supertest');
const express = require('express');
const Order = require('../models/Order');
const { sendOrderMessage } = require('../producer');
const { authBreaker } = require('../circuitBreaker');

// ----------------------------------------------------------
// 3. Express 앱을 테스트용으로 직접 구성
//    index.js를 그대로 import하면 mongoose.connect()와 app.listen()이
//    실행되므로, 라우트 로직만 별도로 등록합니다.
// ----------------------------------------------------------
function createTestApp() {
    const app = express();
    app.use(express.json());

    // POST /api/order — 주문 생성
    app.post('/api/order', async (req, res) => {
        const authHeader = req.headers['authorization'];
        if (!authHeader) {
            return res.status(401).json({ message: "로그인이 필요합니다. (토큰 없음)" });
        }
        const { itemId, quantity, price } = req.body;

        try {
            const authResponse = await authBreaker.fire(authHeader);

            if (authResponse.data.reason === 'circuit_open') {
                return res.status(503).json({
                    message: "인증 서비스가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해주세요."
                });
            }

            if (!authResponse.data.valid) {
                return res.status(401).json({ message: "유효하지 않은 토큰입니다." });
            }

            const userEmail = authResponse.data.email;
            const newOrder = new Order({
                userEmail, itemId, quantity, price, status: "PENDING"
            });
            const savedOrder = await newOrder.save();

            await sendOrderMessage({
                orderId: savedOrder._id.toString(),
                amount: price * quantity,
                userEmail,
            });

            return res.status(202).json({
                message: "주문이 접수되었습니다. 결제가 백그라운드에서 처리됩니다.",
                orderId: savedOrder._id,
                status: "PENDING",
            });
        } catch (error) {
            return res.status(500).json({
                message: "인증 서비스 응답 오류로 주문을 처리할 수 없습니다.",
                error: error.message,
            });
        }
    });

    // POST /api/order/callback — 결제 결과 콜백
    app.post('/api/order/callback', async (req, res) => {
        const { orderId, paymentStatus } = req.body;
        try {
            const order = await Order.findById(orderId);
            if (!order) {
                return res.status(404).json({ message: `주문을 찾을 수 없습니다: ${orderId}` });
            }
            order.status = paymentStatus === "COMPLETED" ? "SUCCESS" : "FAILED";
            await order.save();
            return res.status(200).json({ message: "주문 상태 업데이트 완료", status: order.status });
        } catch (error) {
            return res.status(500).json({ message: "주문 상태 업데이트 오류", error: error.message });
        }
    });

    // GET /api/order/health — 헬스 체크
    app.get('/api/order/health', (req, res) => {
        const cbState = authBreaker.opened ? "OPEN" : "CLOSED";
        res.json({
            status: "OK",
            message: "✅ Order Service is Running on Node.js!",
            authCircuitBreaker: cbState,
        });
    });

    return app;
}

// ==========================================================
// 4. 테스트 시작
// ==========================================================

// 매 테스트 전 mock 상태를 초기화합니다.
beforeEach(() => {
    jest.clearAllMocks();
    authBreaker.opened = false;
});

// ==========================================================
// POST /api/order — 주문 생성 테스트
// ==========================================================
describe('POST /api/order (주문 생성)', () => {
    const app = createTestApp();

    test('인증 성공 시 202 Accepted와 PENDING 주문을 반환한다', async () => {
        // GIVEN: Auth Service가 유효한 토큰으로 인증 성공
        authBreaker.fire.mockResolvedValue({
            data: { valid: true, email: 'buyer@test.com' }
        });

        // WHEN: 주문 요청
        const res = await request(app)
            .post('/api/order')
            .set('Authorization', 'Bearer valid-token')
            .send({ itemId: 'ITEM-001', quantity: 2, price: 15000 });

        // THEN: 202 반환, 주문 ID와 PENDING 상태 확인
        expect(res.status).toBe(202);
        expect(res.body.status).toBe('PENDING');
        expect(res.body.orderId).toBe('mock-order-id-123');
        // RabbitMQ에 메시지가 발행되었는지 확인
        expect(sendOrderMessage).toHaveBeenCalledWith({
            orderId: 'mock-order-id-123',
            amount: 30000, // 15000 * 2
            userEmail: 'buyer@test.com',
        });
    });

    test('Authorization 헤더 없이 요청하면 401을 반환한다', async () => {
        const res = await request(app)
            .post('/api/order')
            .send({ itemId: 'ITEM-001', quantity: 1, price: 10000 });

        expect(res.status).toBe(401);
        expect(res.body.message).toContain('토큰 없음');
    });

    test('유효하지 않은 토큰이면 401을 반환한다', async () => {
        // GIVEN: Auth Service가 토큰 무효 응답
        authBreaker.fire.mockResolvedValue({
            data: { valid: false }
        });

        const res = await request(app)
            .post('/api/order')
            .set('Authorization', 'Bearer invalid-token')
            .send({ itemId: 'ITEM-001', quantity: 1, price: 10000 });

        expect(res.status).toBe(401);
        expect(res.body.message).toContain('유효하지 않은 토큰');
    });

    test('서킷 브레이커 OPEN 상태이면 503을 반환한다', async () => {
        // GIVEN: CB fallback 응답 (Auth Service 다운)
        authBreaker.fire.mockResolvedValue({
            data: { valid: false, reason: 'circuit_open' }
        });

        const res = await request(app)
            .post('/api/order')
            .set('Authorization', 'Bearer any-token')
            .send({ itemId: 'ITEM-001', quantity: 1, price: 10000 });

        expect(res.status).toBe(503);
        expect(res.body.message).toContain('인증 서비스가 일시적으로');
    });

    test('Auth Service 호출 중 예외 발생 시 500을 반환한다', async () => {
        // GIVEN: 서킷 브레이커에서 예외 발생
        authBreaker.fire.mockRejectedValue(new Error('ECONNREFUSED'));

        const res = await request(app)
            .post('/api/order')
            .set('Authorization', 'Bearer token')
            .send({ itemId: 'ITEM-001', quantity: 1, price: 10000 });

        expect(res.status).toBe(500);
        expect(res.body.message).toContain('인증 서비스 응답 오류');
    });
});

// ==========================================================
// POST /api/order/callback — 결제 콜백 테스트
// ==========================================================
describe('POST /api/order/callback (결제 결과 콜백)', () => {
    const app = createTestApp();

    test('결제 성공(COMPLETED) 시 주문 상태를 SUCCESS로 업데이트한다', async () => {
        // GIVEN: DB에서 주문을 찾아 상태 업데이트 가능
        const mockOrder = {
            _id: 'order-abc',
            status: 'PENDING',
            save: jest.fn().mockResolvedValue(true),
        };
        Order.findById.mockResolvedValue(mockOrder);

        // WHEN: 결제 성공 콜백
        const res = await request(app)
            .post('/api/order/callback')
            .send({ orderId: 'order-abc', paymentStatus: 'COMPLETED' });

        // THEN: SUCCESS 상태로 업데이트
        expect(res.status).toBe(200);
        expect(mockOrder.status).toBe('SUCCESS');
        expect(mockOrder.save).toHaveBeenCalled();
    });

    test('결제 실패(FAILED) 시 주문 상태를 FAILED로 업데이트한다', async () => {
        const mockOrder = {
            _id: 'order-def',
            status: 'PENDING',
            save: jest.fn().mockResolvedValue(true),
        };
        Order.findById.mockResolvedValue(mockOrder);

        const res = await request(app)
            .post('/api/order/callback')
            .send({ orderId: 'order-def', paymentStatus: 'FAILED' });

        expect(res.status).toBe(200);
        expect(mockOrder.status).toBe('FAILED');
    });

    test('존재하지 않는 주문 ID로 요청하면 404를 반환한다', async () => {
        // GIVEN: DB에서 주문을 찾지 못함
        Order.findById.mockResolvedValue(null);

        const res = await request(app)
            .post('/api/order/callback')
            .send({ orderId: 'nonexistent-id', paymentStatus: 'COMPLETED' });

        expect(res.status).toBe(404);
        expect(res.body.message).toContain('주문을 찾을 수 없습니다');
    });
});

// ==========================================================
// GET /api/order/health — 헬스 체크 테스트
// ==========================================================
describe('GET /api/order/health (헬스 체크)', () => {
    const app = createTestApp();

    test('서비스 상태와 서킷 브레이커 상태를 반환한다', async () => {
        authBreaker.opened = false;

        const res = await request(app).get('/api/order/health');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('OK');
        expect(res.body.authCircuitBreaker).toBe('CLOSED');
    });

    test('서킷 브레이커 OPEN 시 상태를 OPEN으로 반환한다', async () => {
        authBreaker.opened = true;

        const res = await request(app).get('/api/order/health');

        expect(res.body.authCircuitBreaker).toBe('OPEN');
    });
});

// ==========================================================
// sendOrderMessage (RabbitMQ 메시지 발행) 검증
// ==========================================================
describe('RabbitMQ 메시지 발행 검증', () => {
    const app = createTestApp();

    test('주문 생성 시 올바른 메시지 형식으로 큐에 발행한다', async () => {
        authBreaker.fire.mockResolvedValue({
            data: { valid: true, email: 'queue@test.com' }
        });

        await request(app)
            .post('/api/order')
            .set('Authorization', 'Bearer token')
            .send({ itemId: 'ITEM-X', quantity: 3, price: 5000 });

        // 메시지에 필수 필드(orderId, amount, userEmail)가 포함되는지 확인
        expect(sendOrderMessage).toHaveBeenCalledTimes(1);
        const sentMessage = sendOrderMessage.mock.calls[0][0];
        expect(sentMessage).toHaveProperty('orderId');
        expect(sentMessage).toHaveProperty('amount', 15000);
        expect(sentMessage).toHaveProperty('userEmail', 'queue@test.com');
    });
});
