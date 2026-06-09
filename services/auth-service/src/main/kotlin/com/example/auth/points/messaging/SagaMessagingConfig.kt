package com.example.auth.points.messaging

import com.example.auth.points.domain.PointPort
import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.amqp.core.AcknowledgeMode
import org.springframework.amqp.core.Queue
import org.springframework.amqp.core.QueueBuilder
import org.springframework.amqp.rabbit.connection.ConnectionFactory
import org.springframework.amqp.rabbit.core.RabbitTemplate
import org.springframework.amqp.rabbit.listener.SimpleMessageListenerContainer
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

/**
 * 포인트 Saga participant 의 RabbitMQ 배선.
 *
 * @ConditionalOnProperty(saga.messaging.enabled, matchIfMissing=true):
 *   운영/로컬에서는 기본 활성, 테스트 프로파일(application-test.yml)에서 false 로 꺼
 *   RabbitMQ 미연결 상태에서도 컨텍스트가 로딩되게 한다(Consul enabled 게이팅과 동일 패턴).
 *
 * 큐/DLQ 선언 옵션은 order-service queueAssertOptions / payment queue_arguments 와 동일해야
 * RabbitMQ 가 큐 속성 충돌(PRECONDITION_FAILED)을 내지 않는다.
 */
@Configuration
@ConditionalOnProperty(prefix = "saga.messaging", name = ["enabled"], havingValue = "true", matchIfMissing = true)
class SagaMessagingConfig {

    // ── 큐 선언 (RabbitAdmin 이 시작 시 자동 선언) ──────────────────
    @Bean
    fun pointsCommandQueue(): Queue =
        QueueBuilder.durable(PointsContracts.QUEUE.POINTS_COMMAND)
            .withArgument("x-dead-letter-exchange", "")
            .withArgument("x-dead-letter-routing-key", PointsContracts.dlqName(PointsContracts.QUEUE.POINTS_COMMAND))
            .build()

    @Bean
    fun pointsCommandDlq(): Queue =
        QueueBuilder.durable(PointsContracts.dlqName(PointsContracts.QUEUE.POINTS_COMMAND)).build()

    @Bean
    fun replyQueue(): Queue =
        QueueBuilder.durable(PointsContracts.QUEUE.REPLY)
            .withArgument("x-dead-letter-exchange", "")
            .withArgument("x-dead-letter-routing-key", PointsContracts.dlqName(PointsContracts.QUEUE.REPLY))
            .build()

    @Bean
    fun replyDlq(): Queue =
        QueueBuilder.durable(PointsContracts.dlqName(PointsContracts.QUEUE.REPLY)).build()

    // ── 빈 배선 ──────────────────────────────────────────────────
    @Bean
    fun sagaReplyPublisher(rabbitTemplate: RabbitTemplate, objectMapper: ObjectMapper): SagaReplyPublisher =
        RabbitSagaReplyPublisher(rabbitTemplate, objectMapper)

    @Bean
    fun pointsCommandHandler(
        pointPort: PointPort,
        replyPublisher: SagaReplyPublisher,
        objectMapper: ObjectMapper,
    ): PointsCommandHandler = PointsCommandHandler(pointPort, replyPublisher, objectMapper)

    @Bean
    fun sagaPointsListener(handler: PointsCommandHandler): SagaPointsListener = SagaPointsListener(handler)

    // ── 수동 ACK 리스너 컨테이너 ──────────────────────────────────
    @Bean
    fun sagaPointsContainer(
        connectionFactory: ConnectionFactory,
        sagaPointsListener: SagaPointsListener,
    ): SimpleMessageListenerContainer {
        val container = SimpleMessageListenerContainer(connectionFactory)
        container.setQueueNames(PointsContracts.QUEUE.POINTS_COMMAND)
        container.setMessageListener(sagaPointsListener)
        container.acknowledgeMode = AcknowledgeMode.MANUAL // 오류 종류별 requeue 제어를 위해 수동 ACK
        container.setPrefetchCount(1)
        return container
    }
}
