package com.example.auth.points.messaging

import com.rabbitmq.client.Channel
import org.slf4j.LoggerFactory
import org.springframework.amqp.core.Message
import org.springframework.amqp.rabbit.listener.api.ChannelAwareMessageListener

/**
 * saga.points.command 메시지를 받아 PointsCommandHandler 에 위임하고,
 * 그 결정(AckDecision)을 RabbitMQ 채널의 수동 ACK/NACK 으로 번역한다.
 *
 * 수동 ACK(AcknowledgeMode.MANUAL) 이유: malformed(requeue=false→DLQ) 와 인프라 장애(requeue=true→재시도)를
 * 구분해야 하므로, Spring 의 자동 ACK 대신 채널 API 를 직접 호출한다(payment consumer 와 대칭).
 */
class SagaPointsListener(
    private val handler: PointsCommandHandler,
) : ChannelAwareMessageListener {
    private val log = LoggerFactory.getLogger(SagaPointsListener::class.java)

    override fun onMessage(message: Message, channel: Channel?) {
        requireNotNull(channel) { "수동 ACK 모드에는 Channel 이 필요하다" }
        val deliveryTag = message.messageProperties.deliveryTag

        val decision = try {
            handler.handle(message.body)
        } catch (e: Exception) {
            // 핸들러는 보통 예외를 삼키고 AckDecision 을 반환하지만, 예기치 못한 예외는 재시도로 처리.
            log.error("🚨 핸들러 예외 — 재시도 처리: {}", e.message)
            AckDecision.NACK_REQUEUE
        }

        when (decision) {
            AckDecision.ACK -> channel.basicAck(deliveryTag, false)
            AckDecision.NACK_DLQ -> channel.basicNack(deliveryTag, false, false)
            AckDecision.NACK_REQUEUE -> channel.basicNack(deliveryTag, false, true)
        }
    }
}
