/**
 * Saga 워커 튜닝 상수 — 환경변수로 덮어쓸 수 있다(없으면 기본값).
 */
module.exports = {
    // OutboxRelayWorker 폴링 간격(ms)
    OUTBOX_RELAY_INTERVAL_MS: Number(process.env.OUTBOX_RELAY_INTERVAL_MS) || 2000,
};
