package com.example.auth.points.messaging

import com.rabbitmq.client.Channel
import org.junit.jupiter.api.Test
import org.mockito.kotlin.any
import org.mockito.kotlin.mock
import org.mockito.kotlin.verify
import org.mockito.kotlin.whenever
import org.springframework.amqp.core.Message
import org.springframework.amqp.core.MessageProperties

/**
 * SagaPointsListener 가 핸들러의 AckDecision 을 채널의 basicAck/basicNack(requeue) 로
 * 정확히 번역하는지 검증한다(payment 의 ch.basic_ack/ch.basic_nack 대응).
 */
class SagaPointsListenerTest {
    private fun messageWithTag(tag: Long): Message {
        val props = MessageProperties().apply { deliveryTag = tag }
        return Message("{}".toByteArray(), props)
    }

    @Test
    fun `ACK 결정이면 basicAck`() {
        val handler = mock<PointsCommandHandler>()
        whenever(handler.handle(any())).thenReturn(AckDecision.ACK)
        val channel = mock<Channel>()
        val listener = SagaPointsListener(handler)

        listener.onMessage(messageWithTag(7L), channel)

        verify(channel).basicAck(7L, false)
    }

    @Test
    fun `NACK_DLQ 결정이면 requeue=false 로 basicNack`() {
        val handler = mock<PointsCommandHandler>()
        whenever(handler.handle(any())).thenReturn(AckDecision.NACK_DLQ)
        val channel = mock<Channel>()
        val listener = SagaPointsListener(handler)

        listener.onMessage(messageWithTag(8L), channel)

        verify(channel).basicNack(8L, false, false)
    }

    @Test
    fun `NACK_REQUEUE 결정이면 requeue=true 로 basicNack`() {
        val handler = mock<PointsCommandHandler>()
        whenever(handler.handle(any())).thenReturn(AckDecision.NACK_REQUEUE)
        val channel = mock<Channel>()
        val listener = SagaPointsListener(handler)

        listener.onMessage(messageWithTag(9L), channel)

        verify(channel).basicNack(9L, false, true)
    }

    @Test
    fun `핸들러가 예외를 던지면 안전하게 재시도(NACK requeue=true)`() {
        val handler = mock<PointsCommandHandler>()
        whenever(handler.handle(any())).thenThrow(RuntimeException("unexpected"))
        val channel = mock<Channel>()
        val listener = SagaPointsListener(handler)

        listener.onMessage(messageWithTag(10L), channel)

        verify(channel).basicNack(10L, false, true)
    }
}
