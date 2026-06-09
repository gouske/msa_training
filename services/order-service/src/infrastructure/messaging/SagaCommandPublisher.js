/**
 * SagaCommandPublisher — Orchestrator의 commandPublisher 인터페이스 실제 구현.
 *
 * 역할:
 *   - SagaOrchestrator가 호출하는 publish(queue, message)를 RabbitMQ 발행으로 수행합니다.
 *   - 큐와 그 DLQ를 동일한 옵션으로 선언해 payment/auth consumer와 속성 충돌이 없게 합니다.
 *
 * 설계 메모:
 *   - 채널을 직접 만들지 않고 channelProvider(async () => channel)를 주입받습니다
 *     → 연결 수명 관리(RabbitMQConnection)와 발행 로직을 분리하고, 단위 테스트가 쉬워집니다.
 *   - publish 실패가 Saga를 정지시키는 문제(설계 §14 L1/L2)는 Phase 4(outbox)에서 다룹니다.
 */
const { queueAssertOptions, dlqName } = require('../../saga/sagaContracts');

class SagaCommandPublisher {
    /**
     * @param {() => Promise<import('amqplib').Channel>} channelProvider 채널을 반환하는 async 함수
     */
    constructor(channelProvider) {
        this._getChannel = channelProvider;
    }

    /**
     * 큐에 메시지를 발행한다(SagaOrchestrator가 기대하는 인터페이스).
     * @param {string} queue 대상 큐 이름
     * @param {object} message 직렬화할 메시지 객체
     */
    async publish(queue, message) {
        const channel = await this._getChannel();
        // DLQ 먼저 선언한 뒤, DLQ로 라우팅하는 큐를 선언한다.
        await channel.assertQueue(dlqName(queue), { durable: true });
        await channel.assertQueue(queue, queueAssertOptions(queue));
        channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)), { persistent: true });
    }
}

module.exports = { SagaCommandPublisher };
