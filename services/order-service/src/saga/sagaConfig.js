/**
 * Saga 워커 튜닝 상수 — 환경변수로 덮어쓸 수 있다(없으면 기본값).
 */
module.exports = {
    // [Phase 4a] OutboxRelayWorker 폴링 간격(ms)
    OUTBOX_RELAY_INTERVAL_MS: Number(process.env.OUTBOX_RELAY_INTERVAL_MS) || 2000,

    // [Phase 4b] 단계 reply 대기 한도(ms). 초과 시 타임아웃 보상/정지-전진 재구동.
    STEP_TIMEOUT_MS: Number(process.env.STEP_TIMEOUT_MS) || 15000,
    // [Phase 4b] 타임아웃 스윕 워커 폴링 간격(ms)
    TIMEOUT_SWEEP_INTERVAL_MS: Number(process.env.TIMEOUT_SWEEP_INTERVAL_MS) || 5000,
    // [Phase 4b] 보상(환불) 최대 재시도 횟수. 초과 시 COMPENSATION_FAILED + 운영자 개입.
    MAX_COMPENSATE_ATTEMPTS: Number(process.env.MAX_COMPENSATE_ATTEMPTS) || 5,
    // [Phase 4b] outbox 발행 재시도 경고 임계(초과 시 운영자 경고 로그 — 발행 자체는 계속 재시도).
    MAX_OUTBOX_ATTEMPTS: Number(process.env.MAX_OUTBOX_ATTEMPTS) || 10,
};
