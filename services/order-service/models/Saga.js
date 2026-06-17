const mongoose = require('mongoose');

// 단계 하위 문서 — 자체 _id 불필요(_id:false)
const SagaStepSchema = new mongoose.Schema({
    name:      { type: String, required: true }, // T1_INVENTORY | T2_PAYMENT | T3_POINTS
    status:    { type: String, required: true }, // PENDING | DONE | COMPENSATED | FAILED
    payload:   { type: Object },                 // 재시도/보상에 필요한 데이터
    replyData: { type: Object },                 // participant 응답(paymentId 등)
    deadline:  { type: Date },                   // [Phase 4b] 타임아웃 판정 기준 시각
    compensateAttempts: { type: Number, default: 0 }, // [Phase 4b] 보상 재시도 횟수
}, { _id: false });

// [Phase 4a] outbox 엔트리 — "발행할 command"를 saga 도큐먼트에 함께 원자적으로 적재한다.
// 별도 컬렉션/트랜잭션 없이 단일 도큐먼트 원자성으로 dual-write 를 막는다(설계 §17.2 ADR-01).
const OutboxEntrySchema = new mongoose.Schema({
    id:            { type: String, required: true }, // 엔트리 식별자(멱등 SENT 표시용)
    queue:         { type: String, required: true }, // 발행 대상 큐
    message:       { type: Object, required: true }, // 발행할 메시지(봉투)
    status:        { type: String, required: true, default: 'PENDING' }, // PENDING | SENT
    attempts:      { type: Number, default: 0 },     // 발행 시도 횟수
    lastAttemptAt: { type: Date, default: null },    // 마지막 발행 시도 시각
}, { _id: false });

const SagaSchema = new mongoose.Schema({
    sagaId:        { type: String, required: true, unique: true }, // correlation 키
    orderId:       { type: String, required: true },
    state:         { type: String, required: true },
    currentStep:   { type: String },
    deadline:      { type: Date, default: null }, // [Phase 4b] 활성 대기 마감 시각(타임아웃 스윕 앵커). 전이 시 null 로 비우고 릴레이 SENT 시 무장.
    correlationId: { type: String },
    steps:         { type: [SagaStepSchema], default: [] },
    outbox:        { type: [OutboxEntrySchema], default: [] }, // [Phase 4a]
}, { timestamps: true }); // createdAt/updatedAt 자동 관리

// [Phase 4a] 릴레이 워커가 PENDING outbox 보유 saga 를 빠르게 찾도록 인덱스.
SagaSchema.index({ 'outbox.status': 1 });

// [Phase 4b] 타임아웃 스윕이 "활성 상태 + deadline 초과" saga 를 빠르게 찾도록 복합 인덱스.
SagaSchema.index({ state: 1, deadline: 1 });

module.exports = mongoose.model('Saga', SagaSchema);
