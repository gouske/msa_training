const mongoose = require('mongoose');

// 📋 주문 장부의 양식(Schema)을 정합니다.
const OrderSchema = new mongoose.Schema({
    userEmail: { type: String, required: true }, // 인증 서비스에서 받은 이메일
    itemId: { type: String, required: true },
    quantity: { type: Number, required: true },
    price: { type: Number, required: true },
    status: { type: String, default: 'PENDING' }, // 주문 상태
    createdAt: { type: Date, default: Date.now }
}, { 
    // # [핵심] 데이터를 JSON으로 변환할 때(응답 보낼 때) 실행할 옵션을 정합니다.
    toJSON: { 
        transform: function (doc, ret) {
            // # 어떤 응답에서도 __v는 자동으로 삭제되어 나갑니다.
            delete ret.__v;
            return ret;
        }
    }
});

module.exports = mongoose.model('Order', OrderSchema);