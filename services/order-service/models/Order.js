const mongoose = require('mongoose');

// 📋 주문 장부의 양식(Schema)을 정합니다.
const OrderSchema = new mongoose.Schema({
    userEmail: { type: String, required: true }, // 인증 서비스에서 받은 이메일
    itemId: { type: String, required: true },
    quantity: { type: Number, required: true },
    status: { type: String, default: 'PENDING' }, // 주문 상태
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Order', OrderSchema);