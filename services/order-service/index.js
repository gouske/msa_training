// 1. 필요한 부품(Express)을 불러옵니다.
const express = require('express');
const axios = require('axios'); // 다른 서버에 요청을 보낼 도구(전화기)
const mongoose = require('mongoose'); // DB 도구
const Order = require('./models/Order'); // 위에서 만든 모델

// [비동기 메시징] RabbitMQ 메시지 발행 모듈
// 기존 동기식 HTTP 결제 호출을 대체합니다.
const { sendOrderMessage } = require('./producer');

// 2. 서버가 사용할 문 번호(Port)를 정합니다.
// Auth 서비스가 8080을 쓰고 있으니, 주문 서비스는 8081을 쓰겠습니다.
const PORT = 8081;

// 환경 변수 MONGO_URI가 있으면 그걸 쓰고, 없으면(로컬 실행 시) localhost를 써라!
// DB 및 외부 서비스 연결 설정 (환경변수 || 기본값)
const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/order_db';
// Auth Service 주소도 환경에 따라 변경 (Docker: auth-service, Local: localhost)
const authUrl = process.env.AUTH_HOST || 'localhost'; // `http://${AUTH_HOST}:8080/api/auth/validate`;
// const paymentUrl = process.env.PAYMENT_HOST || 'localhost'; // `http://${paymentUrl}:8082/api/payment/process`;

// 3. JSON 형태의 택배 박스를 해석할 수 있게 설정합니다.
const app = express();
app.use(express.json());

// 🔌 DB 연결 (실무에선 환경변수로 처리합니다)
// mongoose.connect('mongodb://order-db:27017/order_db');
mongoose.connect(mongoURI)
    .then(() => console.log('MongoDB Connected...'))
    .catch(err => console.log(err));

/**
 * 🛒 주문 생성 API (POST /api/order)
 * 실무 시나리오: 주문을 넣으면, 인증 서비스에 이 사람이 살아있는지 확인 요청을 보냅니다.
 */
app.post('/api/order', async (req, res) => {
    // 1. 클라이언트가 보낸 편지 머리말(Header)에서 토큰을 꺼냅니다.
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        return res.status(401).json({ message: "로그인이 필요합니다. (토큰 없음)" });
    }
    const { itemId, quantity, price } = req.body;

    try {
        // 2. [실무 핵심] 인증 서비스의 /validate API를 호출하면서 받은 토큰을 그대로 넘깁니다.
        console.log("☎️ 인증 서비스에 상태 확인 요청 중...");
        
        const authResponse = await axios.get(`http://${authUrl}:8080/api/auth/validate`, {
        // const authResponse = await axios.get('http://auth-service:8080/api/auth/validate', {
        // const authResponse = await axios.get(authUrl, {
            headers: { Authorization: authHeader } // 토큰 전달(Relay)
        });

        // 3. 인증 서비스가 인증 실패를 반환하면 오류 처리.
        if (!authResponse.data.valid) {
            return res.status(401).json({ message: "유효하지 않은 토큰입니다." });
        }

        // 4. 인증 서비스가 "오케이!"라고 하면 주문을 진행합니다.
        const userEmail = authResponse.data.email;
        console.log(`✅ 인증 성공: 사용자 [${userEmail}]의 주문을 처리합니다.`);

        // 5. DB에 '대기' 상태로 먼저 저장 (결제 전이니까요!)
        // 실제로는 여기서 DB에 주문을 저장하겠죠?
        // 💾 [실무 코드] 새로운 주문 객체를 만들어 DB에 저장합니다.
        const newOrder = new Order({
            userEmail: userEmail,
            itemId: itemId,
            quantity: quantity,
            price: price, // 👈 가격 정보도 저장하세요!
            status: "PENDING" // 👈 일단 대기 상태로 저장
        });

        const savedOrder = await newOrder.save(); // 실제 DB 저장 실행!
        console.log(`✅ 주문 저장 완료: ID ${savedOrder._id} PENDING`);

        // 6. [비동기 전환] 동기 HTTP 호출 → RabbitMQ 메시지 발행
        //    기존 방식: axios.post(payment-service) → 결제 완료까지 대기 → 응답
        //    변경 방식: RabbitMQ에 메시지만 넣고 즉시 202 반환, 결제는 백그라운드에서 처리
        console.log("📨 결제 메시지를 RabbitMQ 큐에 발행 중...");
        await sendOrderMessage({
            orderId: savedOrder._id.toString(), // ObjectId → 문자열 변환 (JSON 직렬화를 위해)
            amount: price * quantity,
            userEmail: userEmail
        });
        // console.log(`📬 메시지 발행 완료: 주문 ID ${savedOrder._id}, 상태 PENDING`);

        // 7. 결제 완료를 기다리지 않고 즉시 202 Accepted 반환
        //    202: "요청을 접수했지만 처리가 아직 완료되지 않았음"을 의미하는 HTTP 상태 코드
        return res.status(202).json({
            message: "주문이 접수되었습니다. 결제가 백그라운드에서 처리됩니다.",
            orderId: savedOrder._id,
            status: "PENDING"
        });

        // 동기 코드 deprecated
        // 6. 결제 서비스(Python) 호출
        // try {
        //     // 💰 결제 서비스(Python) 호출!!
        //     // const paymentResponse = await axios.post('http://payment-service:8082/api/payment/process', {
        //     const paymentResponse = await axios.post(`http://${paymentUrl}:8082/api/payment/process`, {
        //         orderId: savedOrder._id, // 실제로는 생성된 DB ID를 넣습니다.
        //         amount: price * quantity
        //     });

        //     if (paymentResponse.data.status === "COMPLETED") {
        //         // 7. 결제 성공 시 주문 상태 업데이트
        //         savedOrder.status = "SUCCESS";
        //         await savedOrder.save();
        //         console.log(`✅ 주문 결제 완료: ID ${savedOrder._id} SUCCESS`);

        //         // [핵심] Mongoose 객체를 일반 객체로 변환합니다.
        //         // # DB 전용 객체를 다루기 쉬운 일반 데이터 뭉치로 바꿉니다.
        //         // const orderObject = savedOrder.toObject();
        //         // # [핵심] 일반 객체에서 __v 필드만 골라 삭제합니다.
        //         // delete orderObject.__v;

        //         const orderObject = savedOrder.toJSON();

        //         // DB에 주문 저장 로직...
        //         return res.status(201).json({
        //             message: "주문 및 결제 완료!",
        //             orderId: savedOrder._id,
        //             // # __v가 제거된 정제된 데이터를 보냅니다.
        //             order: orderObject,
        //             paymentInfo: paymentResponse.data,
        //             buyer: userEmail
        //         });
        //     } else {
        //         // 결제 거절 시 처리
        //         savedOrder.status = "FAILED";
        //         await savedOrder.save();
        //         return res.status(400).json({ message: `ID ${savedOrder._id} 결제가 거절되었습니다.` });
        //     }
        // } catch (payError) {
        //     // 결제 서버 연결 실패 시
        //     savedOrder.status = "ERROR";
        //     await savedOrder.save();
        //     return res.status(500).json({ message: "결제 서비스 응답 오류" });
        // }
    } catch (error) {
        // 4. 만약 인증 서비스가 꺼져있거나 응답이 없다면 주문을 거절합니다.
        console.error("🚨 인증 서비스와 연결할 수 없습니다!");
        return res.status(500).json({
            message: "인증 서비스 응답 오류로 주문을 처리할 수 없습니다.",
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
 * 요청 바디: { orderId: string, paymentStatus: "COMPLETED" | "FAILED" }
 */
app.post('/api/order/callback', async (req, res) => {
    const { orderId, paymentStatus } = req.body;

    try {
        // MongoDB에서 주문을 찾아 상태를 업데이트합니다.
        const order = await Order.findById(orderId);
        if (!order) {
            return res.status(404).json({ message: `주문을 찾을 수 없습니다: ${orderId}` });
        }

        // 결제 결과에 따라 상태 분기
        order.status = paymentStatus === "COMPLETED" ? "SUCCESS" : "FAILED";
        await order.save();

        console.log(`✅ 주문 상태 업데이트: ID ${orderId} → ${order.status}`);
        return res.status(200).json({ message: "주문 상태 업데이트 완료", status: order.status });
    } catch (error) {
        console.error(`🚨 주문 상태 업데이트 실패: ${error.message}`);
        return res.status(500).json({ message: "주문 상태 업데이트 오류", error: error.message });
    }
});

// 5. "나 살아있어!"라고 외치는 Health Check 입구를 만듭니다.
app.get('/api/order/health', (req, res) => {
    res.json({ message: "✅ Order Service is Running on Node.js!" });
});

// 6. 서버를 가동합니다.
app.listen(PORT, () => {
    console.log(`🚀 주문 서비스가 http://localhost:${PORT} 에서 시작되었습니다.`);
});