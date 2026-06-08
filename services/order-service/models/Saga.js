const mongoose = require('mongoose');

// 단계 하위 문서 — 자체 _id 불필요(_id:false)
const SagaStepSchema = new mongoose.Schema({
    name:      { type: String, required: true }, // T1_INVENTORY | T2_PAYMENT | T3_POINTS
    status:    { type: String, required: true }, // PENDING | DONE | COMPENSATED | FAILED
    payload:   { type: Object },                 // 재시도/보상에 필요한 데이터
    replyData: { type: Object },                 // participant 응답(paymentId 등)
}, { _id: false });

const SagaSchema = new mongoose.Schema({
    sagaId:        { type: String, required: true, unique: true }, // correlation 키
    orderId:       { type: String, required: true },
    state:         { type: String, required: true },
    currentStep:   { type: String },
    correlationId: { type: String },
    steps:         { type: [SagaStepSchema], default: [] },
}, { timestamps: true }); // createdAt/updatedAt 자동 관리

module.exports = mongoose.model('Saga', SagaSchema);
