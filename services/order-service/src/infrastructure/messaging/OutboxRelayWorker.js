/**
 * OutboxRelayWorker — saga 도큐먼트에 적재된 PENDING outbox command 를 RabbitMQ 로 발행한다.
 *
 * 역할(설계 §17.4):
 *   - 주기적으로 PENDING outbox 를 가진 saga 를 폴링해 각 엔트리를 발행하고 SENT 로 표시한다.
 *   - 발행 실패(브로커 일시 장애)면 SENT 로 표시하지 않고 시도 횟수만 올려 다음 주기에 재시도한다.
 *   - SENT 표시는 PENDING 인 단일 엔트리에만 적용되므로, 인스턴스 2개가 동시에 릴레이를 돌려도
 *     한 번만 SENT 가 된다(발행 자체는 at-least-once — 참여자가 멱등이라 안전).
 */
const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_BATCH = 20;
const DEFAULT_STEP_TIMEOUT_MS = 15000;
const DEFAULT_MAX_OUTBOX_ATTEMPTS = 10;

class OutboxRelayWorker {
    /**
     * @param {object} deps
     * @param {{findWithPendingOutbox:Function, markOutboxSent:Function, incOutboxAttempt:Function}} deps.sagaRepository
     * @param {{publish:Function}} deps.commandPublisher
     * @param {number} [deps.intervalMs]
     * @param {number} [deps.batchSize]
     * @param {number} [deps.stepTimeoutMs] SENT 시 무장할 reply 대기 한도(ms)
     * @param {number} [deps.maxOutboxAttempts] 발행 재시도 경고 임계
     * @param {() => Date} [deps.now] 테스트 주입용 시계
     */
    constructor({ sagaRepository, commandPublisher, intervalMs = DEFAULT_INTERVAL_MS, batchSize = DEFAULT_BATCH, stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS, maxOutboxAttempts = DEFAULT_MAX_OUTBOX_ATTEMPTS, now = () => new Date() }) {
        this._repo = sagaRepository;
        this._publisher = commandPublisher;
        this._intervalMs = intervalMs;
        this._batchSize = batchSize;
        this._stepTimeoutMs = stepTimeoutMs;
        this._maxOutboxAttempts = maxOutboxAttempts;
        this._now = now;
        this._timer = null;
    }

    /** 주기적 폴링 시작. */
    start() {
        if (this._timer) return;
        this._timer = setInterval(() => {
            this.tick().catch((err) => console.error('🚨 outbox 릴레이 tick 실패:', err.message));
        }, this._intervalMs);
        if (typeof this._timer.unref === 'function') this._timer.unref();
        console.log(' [*] 주문 서비스: outbox 릴레이 워커 시작');
    }

    /** 폴링 중지(graceful shutdown). */
    stop() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }

    /** 한 번의 폴링 주기 — PENDING outbox 를 모두 발행 시도한다. */
    async tick() {
        const sagas = await this._repo.findWithPendingOutbox(this._batchSize);
        for (const saga of sagas) {
            const pending = (saga.outbox || []).filter((e) => e.status === 'PENDING');
            for (const entry of pending) {
                const now = this._now();
                try {
                    await this._publisher.publish(entry.queue, entry.message);
                    // [Phase 4b] 발행 성공 시점에 reply 대기 deadline 무장(적재≠발행이므로 SENT 시점에 찍는다).
                    const deadline = new Date(now.getTime() + this._stepTimeoutMs);
                    await this._repo.markOutboxSent(saga.sagaId, entry.id, now, deadline, entry.message.stepName);
                } catch (err) {
                    // 브로커 일시 장애 — 다음 주기에 재시도(상태는 PENDING 유지)
                    await this._repo.incOutboxAttempt(saga.sagaId, entry.id, now);
                    // [Phase 4b] 재시도가 임계를 넘으면 운영자 가시성을 위해 경고(발행 자체는 계속 재시도).
                    if ((entry.attempts || 0) + 1 >= this._maxOutboxAttempts) {
                        console.error(`🚨 outbox 발행 ${this._maxOutboxAttempts}회 초과 — 운영자 확인 필요 sagaId=${saga.sagaId} entry=${entry.id} queue=${entry.queue}`);
                    }
                }
            }
        }
    }
}

module.exports = { OutboxRelayWorker };
