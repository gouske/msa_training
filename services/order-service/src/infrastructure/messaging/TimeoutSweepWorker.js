/**
 * TimeoutSweepWorker — deadline 이 지난(reply 무응답/정지) saga 를 주기적으로 발견해
 * SagaOrchestrator.handleTimeout 으로 위임한다(설계 §17.12.2).
 *
 * 역할:
 *   - 정지-전진(STARTED), 응답 대기 타임아웃 보상(INVENTORY_RESERVED/PAYMENT_CHARGED),
 *     보상 재시도/에스컬레이션(COMPENSATING)을 한 워커가 같은 폴링으로 처리한다.
 *   - 워커는 얇게 유지하고 실제 전이·부수효과는 orchestrator 가 담당한다(상태머신 단일 출처).
 */
const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_BATCH = 20;

class TimeoutSweepWorker {
    /**
     * @param {object} deps
     * @param {{findTimedOut:Function}} deps.sagaRepository
     * @param {{handleTimeout:Function}} deps.orchestrator
     * @param {number} [deps.intervalMs]
     * @param {number} [deps.batchSize]
     * @param {() => Date} [deps.now] 테스트 주입용 시계
     */
    constructor({ sagaRepository, orchestrator, intervalMs = DEFAULT_INTERVAL_MS, batchSize = DEFAULT_BATCH, now = () => new Date() }) {
        this._repo = sagaRepository;
        this._orchestrator = orchestrator;
        this._intervalMs = intervalMs;
        this._batchSize = batchSize;
        this._now = now;
        this._timer = null;
    }

    /** 주기적 폴링 시작. */
    start() {
        if (this._timer) return;
        this._timer = setInterval(() => {
            this.tick().catch((err) => console.error('🚨 타임아웃 스윕 tick 실패:', err.message));
        }, this._intervalMs);
        if (typeof this._timer.unref === 'function') this._timer.unref();
        console.log(' [*] 주문 서비스: 타임아웃 스윕 워커 시작');
    }

    /** 폴링 중지(graceful shutdown). */
    stop() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }

    /** 한 번의 폴링 주기 — deadline 초과 saga 를 orchestrator 에 위임한다. */
    async tick() {
        const timedOut = await this._repo.findTimedOut(this._now(), this._batchSize);
        for (const saga of timedOut) {
            // saga 별 에러 격리 — 한 건의 실패가 같은 배치의 나머지 처리를 막지 않게 한다(다음 주기에 재시도).
            try {
                await this._orchestrator.handleTimeout(saga);
            } catch (err) {
                console.error(`🚨 타임아웃 처리 실패 sagaId=${saga.sagaId}:`, err.message);
            }
        }
    }
}

module.exports = { TimeoutSweepWorker };
