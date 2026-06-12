package com.example.auth.points.messaging

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

/**
 * PointsContracts 가 order-service sagaContracts.js / payment-service payment_contracts.py 와
 * 1:1로 같은 값을 갖는지 검증한다. 한 글자라도 어긋나면 메시지가 유실되므로 테스트로 못 박는다.
 */
class PointsContractsTest {
    @Test
    fun `큐 이름은 양쪽 서비스와 동일하다`() {
        assertEquals("saga.points.command", PointsContracts.QUEUE.POINTS_COMMAND)
        assertEquals("saga.payment.command", PointsContracts.QUEUE.PAYMENT_COMMAND)
        assertEquals("saga.reply", PointsContracts.QUEUE.REPLY)
    }

    @Test
    fun `메시지 타입은 양쪽 서비스와 동일하다`() {
        assertEquals("EARN", PointsContracts.MSG.EARN)
        assertEquals("CANCEL", PointsContracts.MSG.CANCEL)
        assertEquals("POINTS_SUCCEEDED", PointsContracts.MSG.POINTS_SUCCEEDED)
        assertEquals("POINTS_FAILED", PointsContracts.MSG.POINTS_FAILED)
    }

    @Test
    fun `단계 이름과 DLQ 규칙은 양쪽 서비스와 동일하다`() {
        assertEquals("T3_POINTS", PointsContracts.STEP.POINTS)
        assertEquals("saga.points.command.dlq", PointsContracts.dlqName(PointsContracts.QUEUE.POINTS_COMMAND))
        assertEquals("saga.reply.dlq", PointsContracts.dlqName(PointsContracts.QUEUE.REPLY))
    }
}
