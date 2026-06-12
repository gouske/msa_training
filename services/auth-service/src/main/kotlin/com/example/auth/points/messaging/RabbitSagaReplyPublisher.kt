package com.example.auth.points.messaging

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.amqp.core.MessageBuilder
import org.springframework.amqp.core.MessageDeliveryMode
import org.springframework.amqp.rabbit.core.RabbitTemplate

/**
 * saga.reply 큐로 reply 를 발행하는 실제 구현.
 * 기본 exchange("")에 라우팅 키=큐 이름으로 보내면 동일 이름의 큐로 전달된다(payment _publish_reply 와 동일).
 * body 는 order-service 가 JSON.parse(toString()) 로 읽으므로 JSON 바이트로 직렬화한다.
 */
class RabbitSagaReplyPublisher(
    private val rabbitTemplate: RabbitTemplate,
    private val objectMapper: ObjectMapper,
) : SagaReplyPublisher {

    override fun publish(reply: SagaReply) {
        val body = objectMapper.writeValueAsBytes(
            mapOf(
                "sagaId" to reply.sagaId,
                "type" to reply.type,
                "stepName" to reply.stepName,
                "payload" to reply.payload,
                "correlationId" to reply.correlationId,
            ),
        )
        val message = MessageBuilder.withBody(body)
            .setContentType("application/json")
            .setDeliveryMode(MessageDeliveryMode.PERSISTENT) // 메시지 영속화(payment delivery_mode=2 대응)
            .build()
        rabbitTemplate.send("", PointsContracts.QUEUE.REPLY, message)
    }
}
