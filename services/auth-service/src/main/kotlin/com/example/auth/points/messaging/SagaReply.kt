package com.example.auth.points.messaging

/** Orchestrator(order-service)로 보낼 reply 봉투. order-service handleReply 가 type+sagaId 로 매칭한다. */
data class SagaReply(
    val sagaId: String,
    val type: String,
    val stepName: String?,
    val payload: Map<String, Any?>,
    val correlationId: String,
)

/** reply 발행 경계. 실제 구현(RabbitTemplate)과 핸들러 로직을 분리해 단위 테스트를 쉽게 한다. */
fun interface SagaReplyPublisher {
    fun publish(reply: SagaReply)
}
