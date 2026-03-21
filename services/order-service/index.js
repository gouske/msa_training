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
    const { itemId, quantity } = req.body;

    try {
        // 2. [실무 핵심] 인증 서비스의 /validate API를 호출하면서 받은 토큰을 그대로 넘깁니다.
        console.log("☎️ 인증 서비스에 상태 확인 요청 중...");
        
        const authResponse = await axios.get('http://localhost:8080/api/auth/validate', {
            headers: { Authorization: authHeader } // 토큰 전달(Relay)
        });

        // 3. 인증 서비스가 "오케이!"라고 하면 주문을 진행합니다.
        if (authResponse.data.valid) {
            const userEmail = authResponse.data.email;
            console.log(`✅ 인증 성공: 사용자 [${userEmail}]의 주문을 처리합니다.`);

            // 실제로는 여기서 DB에 주문을 저장하겠죠?
            // 💾 [실무 코드] 새로운 주문 객체를 만들어 DB에 저장합니다.
            const newOrder = new Order({
                userEmail: userEmail,
                itemId: itemId,
                quantity: quantity,
                status: "SUCCESS"
            });

            const savedOrder = await newOrder.save(); // 실제 DB 저장 실행!
            console.log(`✅ 주문 저장 완료: ID ${savedOrder._id}`);

            return res.status(201).json({
                message: "주문이 성공적으로 생성되었습니다.",
                orderId: savedOrder._id,
                order: savedOrder,
                buyer: userEmail
            });
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