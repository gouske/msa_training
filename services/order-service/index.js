// 1. 필요한 부품(Express)을 불러옵니다.
const express = require('express');
const axios = require('axios'); // 다른 서버에 요청을 보낼 도구(전화기)
const mongoose = require('mongoose'); // DB 도구
const Order = require('./models/Order'); // 위에서 만든 모델

// 2. 서버가 사용할 문 번호(Port)를 정합니다.
// Auth 서비스가 8080을 쓰고 있으니, 주문 서비스는 8081을 쓰겠습니다.
const PORT = 8081;

// 3. JSON 형태의 택배 박스를 해석할 수 있게 설정합니다.
const app = express();
app.use(express.json());

// 🔌 DB 연결 (실무에선 환경변수로 처리합니다)
mongoose.connect('mongodb://localhost:27017/order_db');

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
        
        const authResponse = await axios.get('http://localhost:8080/api/auth/validate', {
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

        // 6. 결제 서비스(Python) 호출
        try {
            // 💰 결제 서비스(Python) 호출!!
            const paymentResponse = await axios.post('http://localhost:8082/api/payment/process', {
                orderId: savedOrder._id, // 실제로는 생성된 DB ID를 넣습니다.
                amount: price * quantity
            });

            if (paymentResponse.data.status === "COMPLETED") {
                // 7. 결제 성공 시 주문 상태 업데이트
                savedOrder.status = "SUCCESS";
                await savedOrder.save();

                // DB에 주문 저장 로직...
                return res.status(201).json({
                    message: "주문 및 결제 완료!",
                    orderId: savedOrder._id,
                    order: savedOrder,
                    paymentInfo: paymentResponse.data,
                    buyer: userEmail
                });
            } else {
                // 결제 거절 시 처리
                savedOrder.status = "FAILED";
                await savedOrder.save();
                return res.status(400).json({ message: `ID ${savedOrder._id} 결제가 거절되었습니다.` });
            }
        } catch (payError) {
            // 결제 서버 연결 실패 시
            savedOrder.status = "ERROR";
            await savedOrder.save();
            return res.status(500).json({ message: "결제 서비스 응답 오류" });
        }
    } catch (error) {
        // 4. 만약 인증 서비스가 꺼져있거나 응답이 없다면 주문을 거절합니다.
        console.error("🚨 인증 서비스와 연결할 수 없습니다!");
        return res.status(500).json({
            message: "인증 서비스 응답 오류로 주문을 처리할 수 없습니다.",
            error: error.message
        });
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