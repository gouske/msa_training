// 1. 필요한 부품(Express)을 불러옵니다.
const express = require('express');
const app = express();

// 2. 서버가 사용할 문 번호(Port)를 정합니다.
// Auth 서비스가 8080을 쓰고 있으니, 주문 서비스는 8081을 쓰겠습니다.
const PORT = 8081;

// 3. JSON 형태의 택배 박스를 해석할 수 있게 설정합니다.
app.use(express.json());

// 4. "나 살아있어!"라고 외치는 Health Check 입구를 만듭니다.
app.get('/api/order/health', (req, res) => {
    res.json({ message: "✅ Order Service is Running on Node.js!" });
});

// 5. 서버를 가동합니다.
app.listen(PORT, () => {
    console.log(`🚀 주문 서비스가 http://localhost:${PORT} 에서 시작되었습니다.`);
});