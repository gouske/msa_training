/**
 * [테스트] Order Service 엔드포인트 단위 테스트
 *
 * 학습 포인트:
 *   1. jest.mock()으로 외부 의존성(MongoDB, RabbitMQ)을 격리하는 방법
 *   2. supertest로 Express 엔드포인트��� HTTP 요청 없이 테스트하는 방법
 *   3. 각 엔드포인트의 정상/비정상 시나리오 검증
 *
 * [제19강 변경사항]
 *   - 서킷 브레이커(circuitBreaker.js) mock 제거
 *     이전: jest.mock('../circuitBreaker', ...) + authBreaker.fire() mock
 *     이유: Gateway가 JWT를 중앙 검증하므로 Auth Service 호출이 불필요해졌습니다.
 *   - Authorization 헤더 대신 X-User-Email 헤더로 테스트
 *     이전: .set('Authorization', 'Bearer valid-token')
 *     이후: .set('X-User-Email', 'buyer@test.com')
 *     이유: Gateway가 JWT에서 이메일을 추출하여 X-User-Email 헤더에 넣어줍니다.
 *
 * 실행: npm test
 */

// ----------------------------------------------------------
// 1. 외부 의존성 Mock 설정
//    실제 DB, RabbitMQ 없이 테스트하기 위해
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
    // [핫픽스] findOneAndUpdate() — 원자적 조건부 업데이트용
    mockOrder.findOneAndUpdate = jest.fn();
    return mockOrder;
});

// RabbitMQ ��시지 발행 mock: 실제 큐 없이 발행 성공을 시뮬레이션
jest.mock('../producer', () => ({
    sendOrderMessage: jest.fn().mockResolvedValue(true),
}));

// [제19강 변경] 서킷 브레이커 mock 제거
// 이전 코드:
//   jest.mock('../circuitBreaker', () => ({
//       authBreaker: {
//           fire: jest.fn(),
//           opened: false,
//       },
//   }));
// 이유: Gateway가 JWT를 검증하므로 authBreaker가 더 이상 사용되지 않습니다.

// ----------------------------------------------------------
// 2. 테스트에 필요한 모듈 로딩
// ----------------------------------------------------------
const request = require('supertest');
const express = require('express');
const Order = require('../models/Order');
const { sendOrderMessage } = require('../producer');
// [제19강 변경] authBreaker import 제거
// 이전 코드: const { authBreaker } = require('../circuitBreaker');

// ----------------------------------------------------------
// 3. Express 앱을 테스트용으로 직접 구성
//    index.js를 그대로 import하면 mongoose.connect()와 app.listen()이
//    실행되므로, 라우트 로직만 별도로 등록합니다.
// ----------------------------------------------------------
function createTestApp() {
    const app = express();
    app.use(express.json());

    // POST /api/order — 주문 생성
    // [제19강 변경] authBreaker.fire() 호출 → X-User-Email 헤더 읽기로 교체
    app.post('/api/order', async (req, res) => {
        // [제19강 변경] Gateway가 주입한 X-User-Email 헤더에서 이메일을 읽습���다.
        // 이전 코드: const authHeader = req.headers['authorization'];
        //           const authResponse = await authBreaker.fire(authHeader);
        //           const userEmail = authResponse.data.email;
        const userEmail = req.headers['x-user-email'];

        // 방어적 검사: Gateway를 거치지 않고 직접 접근한 경우를 대비합니다.
        if (!userEmail) {
            return res.status(401).json({
                message: "인증 정보가 없습니다. Gateway를 통해 접근해주세요. (X-User-Email 헤더 누락)"
            });
        }

        const { itemId, quantity, price } = req.body;

        try {
            // [제19강 변경] Auth Service 호출 코드 전체 제거
            // 이전에는 여기서:
            //   1. authBreaker.fire(authHeader) — Auth Service 호출
            //   2. circuit_open 체크 — 서킷 브레이커 OPEN 상태 확인
            //   3. !authResponse.data.valid 체크 — 토큰 유효성 확인
            // 이 세 단계가 있었으나, Gateway가 모두 처리하므로 제거했습니다.

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
                message: "주문 처리 중 오류가 발생했습니다.",
                error: error.message,
            });
        }
    });

    // POST /api/order/callback — 결제 결과 콜백
    // [제20강 변경] 내부 API 키 검증 추가
    app.post('/api/order/callback', async (req, res) => {
        // [제20강 추가] 내부 API 키 검증
        const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'msa-training-internal-key-2026';
        const internalKey = req.headers['x-internal-key'];
        if (internalKey !== INTERNAL_API_KEY) {
            return res.status(403).json({
                message: "내부 서비스 인증 실패 (X-Internal-Key 불일치)"
            });
        }

        const { orderId, paymentStatus } = req.body;
        try {
            // paymentStatus 유효성 검증
            const allowedStatuses = ["COMPLETED", "FAILED"];
            if (!allowedStatuses.includes(paymentStatus)) {
                return res.status(400).json({
                    message: `유효하지 않은 결제 상태: ${paymentStatus}`
                });
            }

            const newStatus = paymentStatus === "COMPLETED" ? "SUCCESS" : "FAILED";

            // [핫픽스] 원자적 조건부 업데이트
            const updatedOrder = await Order.findOneAndUpdate(
                { _id: orderId, status: "PENDING" },
                { status: newStatus },
                { new: true }
            );

            if (!updatedOrder) {
                const existingOrder = await Order.findById(orderId);
                if (!existingOrder) {
                    return res.status(404).json({ message: `주문을 찾을 수 없습니다: ${orderId}` });
                }
                return res.status(409).json({
                    message: `이미 처리된 주문입니다. 현재 상태: ${existingOrder.status}`,
                    currentStatus: existingOrder.status
                });
            }

            return res.status(200).json({ message: "주문 상태 업데이트 완료", status: updatedOrder.status });
        } catch (error) {
            return res.status(500).json({ message: "주문 상태 업데이트 오류", error: error.message });
        }
    });

    // GET /api/order/health — 헬스 체크
    // [제19강 변경] 서킷 브레이커 상태 필드 제거
    // 이전 코드: const cbState = authBreaker.opened ? "OPEN" : "CLOSED";
    //           res.json({ ..., authCircuitBreaker: cbState });
    app.get('/api/order/health', (req, res) => {
        res.json({
            status: "OK",
            message: "✅ Order Service is Running on Node.js!",
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
    // [제19강 변경] authBreaker.opened 초기화 제거
    // 이전 코드: authBreaker.opened = false;
});

// ==========================================================
// POST /api/order — 주문 생성 테스트
// [제19강 변경] Authorization 헤더 → X-User-Email 헤더로 교체
// ==========================================================
describe('POST /api/order (주문 생성)', () => {
    const app = createTestApp();

    // [제19강 변경] 인증 방식 변경: Authorization Bearer → X-User-Email
    // 이전: .set('Authorization', 'Bearer valid-token') + authBreaker.fire mock
    // 이후: .set('X-User-Email', 'buyer@test.com') — Gateway가 JWT에서 추출한 이메일
    test('X-User-Email 헤더가 있으면 202 Accepted와 PENDING 주문을 반환한다', async () => {
        // WHEN: Gateway가 JWT를 검증하고 X-User-Email 헤더를 주입한 상태로 주문 요청
        const res = await request(app)
            .post('/api/order')
            .set('X-User-Email', 'buyer@test.com')
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

    // [제19강 변경] Authorization 헤더 검사 → X-User-Email 헤더 검사
    // 이전: '토큰 없음' 메시지 확인
    // 이후: 'X-User-Email 헤더 누락' 메시지 확인
    test('X-User-Email 헤더 없이 요청하면 401을 반환한다', async () => {
        // WHEN: 헤더 없이 직접 접근 (Gateway를 거치지 않은 경우)
        const res = await request(app)
            .post('/api/order')
            .send({ itemId: 'ITEM-001', quantity: 1, price: 10000 });

        // THEN: 401 반환
        expect(res.status).toBe(401);
        expect(res.body.message).toContain('X-User-Email 헤더 누락');
    });

    // [제19강 변경] 아래 3개의 테스트는 제거되었습니다:
    //
    // 1. "유효하지 않은 토큰이면 401을 반환한다"
    //    → Gateway가 유효하지 않은 토큰을 걸러내므로 Order Service까지 도달하지 않습니다.
    //
    // 2. "서킷 브레이커 OPEN 상태이면 503을 반환한다"
    //    → Auth Service를 직접 호출하지 않으므로 서킷 브레이커가 필요 없습니다.
    //
    // 3. "Auth Service 호출 중 예외 발생 시 500을 반환한다"
    //    → Auth Service를 호출하지 않으므로 연결 오류가 발생하지 않습니다.
});

// ==========================================================
// POST /api/order/callback — 결제 콜백 테스트
// [제20강 변경] 내부 API 키(X-Internal-Key) 검증 추가
// 이전: 누구나 호출 가능
// 이후: X-Internal-Key 헤더가 일치해야만 수락
// ==========================================================
describe('POST /api/order/callback (결제 결과 콜백)', () => {
    const app = createTestApp();

    // [제20강 추가] 내부 API 키 없이 호출하면 403을 반환한다
    test('X-Internal-Key 없이 호출하면 403을 반환한다', async () => {
        // WHEN: 내부 키 없이 콜백 호출 (외부 공격자 시나리오)
        const res = await request(app)
            .post('/api/order/callback')
            .send({ orderId: 'order-abc', paymentStatus: 'COMPLETED' });

        // THEN: 403 Forbidden (내부 키 불일치)
        expect(res.status).toBe(403);
        expect(res.body.message).toContain('내부 서비스 인증 실패');
    });

    // [제20강 추가] 잘못된 내부 API 키로 호출하면 403을 반환한다
    test('잘못된 X-Internal-Key로 호출하면 403을 반환한다', async () => {
        const res = await request(app)
            .post('/api/order/callback')
            .set('X-Internal-Key', 'wrong-key-value')
            .send({ orderId: 'order-abc', paymentStatus: 'COMPLETED' });

        expect(res.status).toBe(403);
    });

    // [핫픽스] findOneAndUpdate mock 기반 테스트로 교체
    test('올바른 내부 키 + 결제 성공(COMPLETED) 시 주문 상태를 SUCCESS로 업데이트한다', async () => {
        // GIVEN: findOneAndUpdate가 업데이트된 주문을 반환 (PENDING → SUCCESS)
        Order.findOneAndUpdate.mockResolvedValue({
            _id: 'order-abc',
            status: 'SUCCESS',
        });

        // WHEN: 올바른 내부 키와 함께 결제 성공 콜백
        const res = await request(app)
            .post('/api/order/callback')
            .set('X-Internal-Key', 'msa-training-internal-key-2026')
            .send({ orderId: 'order-abc', paymentStatus: 'COMPLETED' });

        // THEN: SUCCESS 상태로 업데이트
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('SUCCESS');
        // findOneAndUpdate가 조건부로 호출되었는지 확인
        expect(Order.findOneAndUpdate).toHaveBeenCalledWith(
            { _id: 'order-abc', status: 'PENDING' },
            { status: 'SUCCESS' },
            { new: true }
        );
    });

    test('올바른 내부 키 + 결제 실패(FAILED) 시 주문 상태를 FAILED로 업데이트한다', async () => {
        Order.findOneAndUpdate.mockResolvedValue({
            _id: 'order-def',
            status: 'FAILED',
        });

        const res = await request(app)
            .post('/api/order/callback')
            .set('X-Internal-Key', 'msa-training-internal-key-2026')
            .send({ orderId: 'order-def', paymentStatus: 'FAILED' });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('FAILED');
    });

    // [핫픽스] findOneAndUpdate 기반 상태 전이 테스트
    test('이미 SUCCESS인 주문에 콜백하면 409를 반환한다 (멱등성)', async () => {
        // GIVEN: findOneAndUpdate가 null 반환 (PENDING 조건 불일치)
        Order.findOneAndUpdate.mockResolvedValue(null);
        // findById로 현재 상태 확인 시 SUCCESS
        Order.findById.mockResolvedValue({ _id: 'order-done', status: 'SUCCESS' });

        // WHEN: 다시 콜백 호출 (중복 요청)
        const res = await request(app)
            .post('/api/order/callback')
            .set('X-Internal-Key', 'msa-training-internal-key-2026')
            .send({ orderId: 'order-done', paymentStatus: 'COMPLETED' });

        // THEN: 409 Conflict — 이미 처리된 주문
        expect(res.status).toBe(409);
        expect(res.body.message).toContain('이미 처리된 주문');
        expect(res.body.currentStatus).toBe('SUCCESS');
    });

    test('이미 FAILED인 주문에 SUCCESS 콜백하면 409를 반환한다 (역전 방지)', async () => {
        // GIVEN: findOneAndUpdate null (PENDING이 아님) + findById로 FAILED 확인
        Order.findOneAndUpdate.mockResolvedValue(null);
        Order.findById.mockResolvedValue({ _id: 'order-failed', status: 'FAILED' });

        const res = await request(app)
            .post('/api/order/callback')
            .set('X-Internal-Key', 'msa-training-internal-key-2026')
            .send({ orderId: 'order-failed', paymentStatus: 'COMPLETED' });

        // THEN: 409 Conflict — 종결 상태에서 역전 불가
        expect(res.status).toBe(409);
        expect(res.body.currentStatus).toBe('FAILED');
    });

    test('유효하지 않은 paymentStatus이면 400을 반환한다', async () => {
        // GIVEN: PENDING 상태의 주문
        const mockOrder = {
            _id: 'order-invalid',
            status: 'PENDING',
            save: jest.fn(),
        };
        Order.findById.mockResolvedValue(mockOrder);

        // WHEN: 허용되지 않는 paymentStatus 전송
        const res = await request(app)
            .post('/api/order/callback')
            .set('X-Internal-Key', 'msa-training-internal-key-2026')
            .send({ orderId: 'order-invalid', paymentStatus: 'UNKNOWN_STATUS' });

        // THEN: 400 Bad Request
        expect(res.status).toBe(400);
        expect(res.body.message).toContain('유효하지 않은 결제 상태');
    });

    test('존재하지 않는 주문 ID로 요청하면 404를 반환한다', async () => {
        // GIVEN: findOneAndUpdate null + findById도 null (주문 자체 없음)
        Order.findOneAndUpdate.mockResolvedValue(null);
        Order.findById.mockResolvedValue(null);

        const res = await request(app)
            .post('/api/order/callback')
            .set('X-Internal-Key', 'msa-training-internal-key-2026')
            .send({ orderId: 'nonexistent-id', paymentStatus: 'COMPLETED' });

        expect(res.status).toBe(404);
        expect(res.body.message).toContain('주문을 찾을 수 없습니다');
    });
});

// ==========================================================
// GET /api/order/health — 헬스 체크 테스트
// [제19강 변경] 서킷 브레이커 상태 검증 제거
// ==========================================================
describe('GET /api/order/health (헬스 체크)', () => {
    const app = createTestApp();

    test('서비스 상태 OK를 반환한다', async () => {
        const res = await request(app).get('/api/order/health');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('OK');
    });

    // [제19강 변경] 아래 테스트 제거:
    // 이전: "서킷 브레이커 OPEN 시 상태를 OPEN으로 반환한다"
    // 이유: 서킷 브레이커가 더 이상 사용되지 않으므로 authCircuitBreaker 필드가 없습니다.
});

// ==========================================================
// sendOrderMessage (RabbitMQ 메시지 발행) 검증
// [제19강 변경] Authorization 헤더 → X-User-Email 헤더
// ==========================================================
describe('RabbitMQ 메시지 발행 검증', () => {
    const app = createTestApp();

    // [제19강 변경] 인증 방식 변경에 따라 헤더만 교체
    // 이전: .set('Authorization', 'Bearer token') + authBreaker.fire mock
    // 이후: .set('X-User-Email', 'queue@test.com')
    test('주문 생성 시 올바른 메시지 형식으로 큐에 발행한다', async () => {
        await request(app)
            .post('/api/order')
            .set('X-User-Email', 'queue@test.com')
            .send({ itemId: 'ITEM-X', quantity: 3, price: 5000 });

        // 메시지에 필수 필드(orderId, amount, userEmail)가 포함되는지 확인
        expect(sendOrderMessage).toHaveBeenCalledTimes(1);
        const sentMessage = sendOrderMessage.mock.calls[0][0];
        expect(sentMessage).toHaveProperty('orderId');
        expect(sentMessage).toHaveProperty('amount', 15000);
        expect(sentMessage).toHaveProperty('userEmail', 'queue@test.com');
    });
});
