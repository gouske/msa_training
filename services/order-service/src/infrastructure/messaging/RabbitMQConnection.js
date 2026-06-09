/**
 * RabbitMQConnection — Saga용 long-lived 연결/채널 관리.
 *
 * 역할:
 *   - publisher(발행)와 consumer(수신)가 공유하는 단일 연결 + 단일 채널을 lazy로 만듭니다.
 *   - 기존 producer.js는 발행마다 connect/close 했지만, consumer는 상주해야 하므로
 *     연결을 유지합니다. 연결이 끊기면 캐시를 비워 다음 getChannel() 호출 시 재생성합니다.
 *
 * 설계 메모:
 *   - getChannel은 async 함수로 노출되어 publisher/consumer의 channelProvider로 주입됩니다.
 *   - 견고한 재발행/재구독(reconnect 후 consumer 자동 재등록 보장 등)은 Phase 4로 이연합니다.
 *     Phase 2는 "끊기면 다음 호출에서 새 채널" 수준의 단순 복구만 제공합니다.
 */
const amqp = require('amqplib');

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost';

class RabbitMQConnection {
    constructor(url = RABBITMQ_URL) {
        this._url = url;
        this._connection = null;
        this._channel = null;
        this._connecting = null; // 동시 호출 시 connect 중복 방지용 in-flight Promise
    }

    /**
     * 공유 채널을 반환한다(없으면 생성). 연결이 끊겨 있으면 새로 만든다.
     * @returns {Promise<import('amqplib').Channel>}
     */
    async getChannel() {
        if (this._channel) return this._channel;
        if (this._connecting) return this._connecting;

        this._connecting = this._connect();
        try {
            return await this._connecting;
        } finally {
            this._connecting = null;
        }
    }

    async _connect() {
        const connection = await amqp.connect(this._url);
        const channel = await connection.createChannel();

        // 연결/채널이 끊기면 캐시를 비워 다음 getChannel()이 재생성하도록 한다.
        const reset = () => {
            this._connection = null;
            this._channel = null;
        };
        connection.on('close', reset);
        connection.on('error', () => {});  // 'error' 뒤에는 'close'가 따라오므로 reset은 close에서

        this._connection = connection;
        this._channel = channel;
        return channel;
    }

    /** graceful shutdown 시 호출(선택). */
    async close() {
        try {
            if (this._channel) await this._channel.close();
            if (this._connection) await this._connection.close();
        } finally {
            this._connection = null;
            this._channel = null;
        }
    }
}

module.exports = { RabbitMQConnection };
