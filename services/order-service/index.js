// 1. 필요한 부품(Express)을 불러옵니다.
const express = require('express');
const mongoose = require('mongoose'); // DB 도구
const Order = require('./models/Order'); // 위에서 만든 모델

// [비동기 메시징] RabbitMQ 메시지 발행 모듈
// 기존 동기식 HTTP 결제 호출을 대체합니다.
const { sendOrderMessage } = require('./producer');

// [제19강 변경] 서킷 브레이커 import 제거
// 이전 코드: const { authBreaker } = require('./circuitBreaker');
// 이유: Gateway가 JWT를 중앙에서 검증하므로 Order Service가 Auth Service를 직접 호출할 필요가 없어졌습니다.
// circuitBreaker.js 파일은 학습 참고용으로 보존합니다.

// 2. 서버가 사용할 문 번호(Port)를 정합니다.
// Auth 서비스가 8080을 쓰고 있으니, 주문 서비스는 8081을 쓰겠습니다.
const PORT = 8081;

// 환경 변수 MONGO_URI가 있으면 그걸 쓰고, 없으면(로컬 실행 시) localhost를 써라!
// DB 및 외부 서비스 연결 설정 (환경변수 || 기본값)
const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/order_db';

// [제20강 추가] 서비스 간 통신용 내부 API 키
// Payment Service가 콜백을 보낼 때 X-Internal-Key 헤더에 이 값을 포함합니다.
// 이 키가 일치해야만 콜백 요청을 수락합니다.
// [핫픽스] 기본값 fallback 제거 — 환경변수 미설정 시 즉시 에러로 누락을 방지합니다.
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
if (!INTERNAL_API_KEY) {
    console.error("🚨 INTERNAL_API_KEY 환경변수가 설정되지 않았습니다. .env 파일을 확인하세요.");
    process.exit(1);
}

// 3. JSON 형태의 택배 박스를 해석할 수 있게 설정합니다.
const app = express();
app.use(express.json());

// 🔌 DB 연결 (실무에선 환경변수로 처리합니다)
mongoose.connect(mongoURI)
    .then(() => console.log('MongoDB Connected...'))
    .catch(err => console.log(err));

/**
 * 🛒 주문 생성 API (POST /api/order)
 *
 * [제19강 변경] JWT 검증 흐름이 바뀌었습니다.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ 변경 전 (제17강):                                                │
 * │   클라이언트 → Order Service → Auth Service(HTTP 호출) → 이메일 획득 │
 * │   서킷 브레이커(opossum)로 Auth Service 장애를 감지했습니다.          │
 * │                                                                 │
 * │ 변경 후 (제19강):                                                │
 * │   클라이언트 → Gateway(JWT 검증) → Order Service(헤더에서 이메일 읽기)│
 * │   Gateway가 JWT를 검증하고 X-User-Email 헤더에 이메일을 넣어줍니다.  │
 * └─────────────────────────────────────────────────────────────────┘
 */
app.post('/api/order', async (req, res) => {
    // [제19강 변경] Gateway가 주입한 X-User-Email 헤더에서 이메일을 읽습니다.
    // 이전 코드: const authHeader = req.headers['authorization'];
    //           const authResponse = await authBreaker.fire(authHeader);
    //           const userEmail = authResponse.data.email;
    // → Auth Service HTTP 호출 + 서킷 브레이커 전체가 아래 한 줄로 대체됩니다.
    const userEmail = req.headers['x-user-email'];

    // 방어적 검사: Gateway를 거치지 않고 직접 접근한 경우를 대비합니다.
    // 정상적으로 Gateway를 통해 들어온 요청에는 항상 이 헤더가 있습니다.
    if (!userEmail) {
        return res.status(401).json({
            message: "인증 정보가 없습니다. Gateway를 통해 접근해주세요. (X-User-Email 헤더 누락)"
        });
    }

    const { itemId, quantity, price } = req.body;

    try {
        // [제19강 변경] 이전에는 여기서 authBreaker.fire()로 Auth Service를 호출하고,
        // circuit_open 체크, 토큰 유효성 체크 등 약 20줄의 코드가 있었습니다.
        // Gateway가 이 모든 것을 처리하므로 아래 로직에 바로 진입합니다.
        console.log(`✅ 인증 완료 (Gateway 검증): 사용자 [${userEmail}]의 주문을 처리합니다.`);

        // 5. DB에 '대기' 상태로 먼저 저장 (결제 전이니까요!)
        const newOrder = new Order({
            userEmail: userEmail,
            itemId: itemId,
            quantity: quantity,
            price: price,
            status: "PENDING"
        });

        const savedOrder = await newOrder.save();
        console.log(`✅ 주문 저장 완료: ID ${savedOrder._id} PENDING`);

        // 6. [비동기 전환] RabbitMQ 메시지 발행
        console.log("📨 결제 메시지를 RabbitMQ 큐에 발행 중...");
        await sendOrderMessage({
            orderId: savedOrder._id.toString(),
            amount: price * quantity,
            userEmail: userEmail
        });

        // 7. 결제 완료를 기다리지 않고 즉시 202 Accepted 반환
        return res.status(202).json({
            message: "주문이 접수되었습니다. 결제가 백그라운드에서 처리됩니다.",
            orderId: savedOrder._id,
            status: "PENDING"
        });
    } catch (error) {
        console.error("🚨 주문 처리 중 오류 발생:", error.message);
        return res.status(500).json({
            message: "주문 처리 중 오류가 발생했습니다.",
            error: error.message
        });
    }
});

/**
 * [내부 콜백 API] POST /api/order/callback
 *
 * Payment Service의 Consumer가 결제 처리 완료 후 이 엔드포인트를 호출합니다.
 * 외부에 노출되지 않는 서비스 간 통신용 엔드포인트입니다.
 * 수신한 결제 결과에 따라 MongoDB의 주문 상태를 업데이트합니다.
 *
 * [제20강 변경] 내부 API 키 검증 추가
 * 이전: 누구나 호출 가능 → 주문 상태 위조 위험
 * 이후: X-Internal-Key 헤더의 값이 INTERNAL_API_KEY와 일치해야만 수락
 *
 * 요청 헤더: X-Internal-Key: {내부 API 키}
 * 요청 바디: { orderId: string, paymentStatus: "COMPLETED" | "FAILED" }
 */
app.post('/api/order/callback', async (req, res) => {
    // [제20강 추가] 내부 API 키 검증
    // Payment Service만 알고 있는 키를 확인하여 외부 호출을 차단합니다.
    const internalKey = req.headers['x-internal-key'];
    if (internalKey !== INTERNAL_API_KEY) {
        return res.status(403).json({
            message: "내부 서비스 인증 실패 (X-Internal-Key 불일치)"
        });
    }

    const { orderId, paymentStatus } = req.body;

    try {
        // [제22강 추가] paymentStatus 유효성 검증
        const allowedStatuses = ["COMPLETED", "FAILED"];
        if (!allowedStatuses.includes(paymentStatus)) {
            return res.status(400).json({
                message: `유효하지 않은 결제 상태: ${paymentStatus}`
            });
        }

        const newStatus = paymentStatus === "COMPLETED" ? "SUCCESS" : "FAILED";

        // [핫픽스] 원자적 조건부 업데이트 (findOneAndUpdate)
        // 이전: findById → status 체크 → save (read-check-write, 경쟁 조건 취약)
        //       동시 콜백 시 두 요청이 모두 PENDING을 읽고 각각 다른 상태를 저장할 수 있었음
        // 이후: findOneAndUpdate로 MongoDB 레벨에서 원자적으로 처리
        //       {status: "PENDING"} 조건이 쿼리에 포함되어 한 요청만 성공, 나머지는 null 반환
        const updatedOrder = await Order.findOneAndUpdate(
            { _id: orderId, status: "PENDING" },   // 조건: PENDING 상태인 주문만
            { status: newStatus },                  // 변경: SUCCESS 또는 FAILED
            { new: true }                           // 옵션: 수정된 문서를 반환
        );

        // null 반환 = 주문이 없거나 이미 PENDING이 아님
        if (!updatedOrder) {
            // 주문 자체가 존재하는지 확인 (404 vs 409 구분)
            const existingOrder = await Order.findById(orderId);
            if (!existingOrder) {
                return res.status(404).json({ message: `주문을 찾을 수 없습니다: ${orderId}` });
            }
            // 주문은 있지만 이미 종결 상태 → 409 Conflict (멱등 응답)
            console.log(`⚠️ 이미 처리된 주문 무시: ID ${orderId} (현재: ${existingOrder.status})`);
            return res.status(409).json({
                message: `이미 처리된 주문입니다. 현재 상태: ${existingOrder.status}`,
                currentStatus: existingOrder.status
            });
        }

        console.log(`✅ 주문 상태 업데이트: ID ${orderId} → ${updatedOrder.status}`);
        return res.status(200).json({ message: "주문 상태 업데이트 완료", status: updatedOrder.status });
    } catch (error) {
        console.error(`🚨 주문 상태 업데이트 실패: ${error.message}`);
        return res.status(500).json({ message: "주문 상태 업데이트 오류", error: error.message });
    }
});

// 5. "나 살아있어!"라고 외치는 Health Check 입구를 만듭니다.
// [제19강 변경] 서킷 브레이커 상태 필드를 제거했습니다.
// 이전 코드: const cbState = authBreaker.opened ? "OPEN" : "CLOSED";
//           res.json({ status: "OK", ..., authCircuitBreaker: cbState });
// 이유: Gateway가 JWT를 검증하므로 Auth Service 호출용 서킷 브레이커가 더 이상 필요하지 않습니다.
app.get('/api/order/health', (req, res) => {
    res.json({
        status: "OK",
        message: "✅ Order Service is Running on Node.js!",
    });
});

// 6. 서버를 가동합니다.
app.listen(PORT, () => {
    console.log(`🚀 주문 서비스가 http://localhost:${PORT} 에서 시작되었습니다.`);
});
