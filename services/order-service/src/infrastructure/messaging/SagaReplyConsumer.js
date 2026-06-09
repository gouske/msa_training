/**
 * SagaReplyConsumer — participant들의 reply(saga.reply)를 받아 Orchestrator에 전달.
 *
 * 역할:
 *   - saga.reply 큐를 구독하고, 각 메시지를 orchestrator.handleReply()로 넘깁니다.
 *   - 정상 처리 시 ACK, 파싱/처리 실패 시 NACK(requeue=false)으로 DLQ에 격리합니다.
 *
 * 설계 메모:
 *   - 채널은 channelProvider로 주입받아 연결 수명 관리와 분리합니다(단위 테스트 용이).
 *   - 멱등 전이 가드는 SagaOrchestrator가 책임집니다 — 같은 reply가 두 번 와도 안전합니다.
 */
const { QUEUE, queueAssertOptions, dlqName } = require('../../saga/sagaContracts');

class SagaReplyConsumer {
    /**
     * @param {object} deps
     * @param {() => Promise<import('amqplib').Channel>} deps.channelProvider
     * @param {{ handleReply: (reply: object) => Promise<void> }} deps.orchestrator
     */
    constructor({ channelProvider, orchestrator }) {
        this._getChannel = channelProvider;
        this._orchestrator = orchestrator;
    }

    /** saga.reply 구독을 시작한다. */
    async start() {
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
        console.log(' [*] 주문 서비스: saga.reply 대기 중...');
    }
}

module.exports = { SagaReplyConsumer };
