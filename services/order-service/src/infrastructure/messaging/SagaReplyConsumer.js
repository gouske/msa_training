/**
 * SagaReplyConsumer — participant들의 reply(saga.reply)를 받아 Orchestrator에 전달.
 *
 * 역할:
 *   - saga.reply 큐를 구독하고, 각 메시지를 orchestrator.handleReply()로 넘깁니다.
 *   - 정상 처리 시 ACK, 파싱/처리 실패 시 NACK(requeue=false)으로 DLQ에 격리합니다.
 *   - 시작 실패(RabbitMQ 미준비)나 채널 끊김 시 자동으로 재시도·재구독합니다
 *     (payment-service의 command consumer와 동일한 복원력).
 *
 * 설계 메모:
 *   - 채널은 channelProvider로 주입받아 연결 수명 관리와 분리합니다(단위 테스트 용이).
 *   - 멱등 전이 가드는 SagaOrchestrator가 책임집니다 — 같은 reply가 두 번 와도 안전합니다.
 */
const { QUEUE, queueAssertOptions, dlqName } = require('../../saga/sagaContracts');

const DEFAULT_RETRY_DELAY_MS = 5000;

class SagaReplyConsumer {
    /**
     * @param {object} deps
     * @param {() => Promise<import('amqplib').Channel>} deps.channelProvider
     * @param {{ handleReply: (reply: object) => Promise<void> }} deps.orchestrator
     * @param {number} [deps.retryDelayMs] 시작/재구독 재시도 간격(ms)
     */
    constructor({ channelProvider, orchestrator, retryDelayMs = DEFAULT_RETRY_DELAY_MS }) {
        this._getChannel = channelProvider;
        this._orchestrator = orchestrator;
        this._retryDelayMs = retryDelayMs;
        this._restartTimer = null;
    }

    /** saga.reply 구독을 시작한다. 실패하거나 채널이 끊기면 자동 재시도한다. */
    async start() {
        try {
            const channel = await this._getChannel();
            await channel.assertQueue(dlqName(QUEUE.REPLY), { durable: true });
            await channel.assertQueue(QUEUE.REPLY, queueAssertOptions(QUEUE.REPLY));

            await channel.consume(QUEUE.REPLY, async (msg) => {
                if (!msg) return; // consumer 취소 신호 — 무시
                try {
                    const reply = JSON.parse(msg.content.toString());
                    await this._orchestrator.handleReply(reply);
                    channel.ack(msg);
                } catch (err) {
                    // 파싱 실패 또는 처리 중 예외 → DLQ로 격리(무한 재처리 방지)
                    console.error('🚨 saga.reply 처리 실패 — DLQ로 보냅니다:', err.message);
                    channel.nack(msg, false, false);
                }
            });

            // 채널이 끊기면 재구독한다(연결 복구 후 reply를 다시 소비하기 위함).
            channel.on('close', () => this._scheduleRestart());
            console.log(' [*] 주문 서비스: saga.reply 대기 중...');
        } catch (err) {
            // RabbitMQ 미준비 등으로 시작 실패 → 일정 시간 후 재시도
            console.warn('⚠️ saga.reply consumer 시작 실패 — 재시도 예정:', err.message);
            this._scheduleRestart();
        }
    }

    /** 재시작을 한 번만 예약한다(중복 타이머 방지). */
    _scheduleRestart() {
        if (this._restartTimer) return;
        this._restartTimer = setTimeout(() => {
            this._restartTimer = null;
            this.start().catch(() => {}); // start 내부에서 다시 예약하므로 여기서는 무시
        }, this._retryDelayMs);
        // 타이머가 프로세스 종료를 막지 않도록(Node 환경) — 테스트의 fake timer에는 unref가 없을 수 있다.
        if (typeof this._restartTimer.unref === 'function') this._restartTimer.unref();
    }

    /** 재시작 예약 타이머를 취소한다(graceful shutdown). */
    stop() {
        if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    }
}

module.exports = { SagaReplyConsumer };
