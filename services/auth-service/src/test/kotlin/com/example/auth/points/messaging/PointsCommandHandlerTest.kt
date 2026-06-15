package com.example.auth.points.messaging

import com.example.auth.points.domain.PointPort
import com.example.auth.points.domain.PointsDeclinedError
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import org.junit.jupiter.api.Test
import org.springframework.dao.DataIntegrityViolationException
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * PointsCommandHandler 의 오류 3종 분류와 EARN/CANCEL 분기를 검증한다(payment saga_consumer 미러).
 *   - 비즈니스 거절(PointsDeclinedError) → POINTS_FAILED reply + ACK
 *   - malformed(JSON 파싱/필수 키 누락) → NACK_DLQ, reply 없음
 *   - 인프라 장애(일반 예외) → NACK_REQUEUE, reply 없음
 */
class PointsCommandHandlerTest {
    private val mapper = jacksonObjectMapper()

    /** 호출 인자/오류를 기록하는 fake 포트. */
    private class FakePointPort : PointPort {
        var earnError: RuntimeException? = null
        var cancelError: RuntimeException? = null
        val earnCalls = mutableListOf<List<Any>>()
        val cancelCalls = mutableListOf<List<Any>>()
        override fun earn(sagaId: String, stepName: String, userEmail: String, amount: Long): Long {
            earnCalls.add(listOf(sagaId, stepName, userEmail, amount))
            earnError?.let { throw it }
            return 500L
        }
        override fun cancel(sagaId: String, stepName: String, userEmail: String, amount: Long) {
            cancelCalls.add(listOf(sagaId, stepName, userEmail, amount))
            cancelError?.let { throw it }
        }
    }

    /** reply 를 수집하는 fake publisher. */
    private class CapturingPublisher : SagaReplyPublisher {
        val replies = mutableListOf<SagaReply>()
        override fun publish(reply: SagaReply) { replies.add(reply) }
    }

    private fun body(map: Map<String, Any?>): ByteArray = mapper.writeValueAsBytes(map)

    private fun earnCommand() = body(
        mapOf(
            "sagaId" to "saga-1", "type" to "EARN", "stepName" to "T3_POINTS",
            "payload" to mapOf("userEmail" to "user@test.com", "amount" to 100),
            "correlationId" to "corr-1",
        ),
    )

    private fun earnCommandWithAmount(amount: Any?) = body(
        mapOf(
            "sagaId" to "saga-1", "type" to "EARN", "stepName" to "T3_POINTS",
            "payload" to mapOf("userEmail" to "user@test.com", "amount" to amount),
            "correlationId" to "corr-1",
        ),
    )

    @Test
    fun `EARN 성공이면 POINTS_SUCCEEDED reply 후 ACK`() {
        val port = FakePointPort()
        val pub = CapturingPublisher()
        val handler = PointsCommandHandler(port, pub, mapper)

        val decision = handler.handle(earnCommand())

        assertEquals(AckDecision.ACK, decision)
        assertEquals(listOf(listOf<Any>("saga-1", "T3_POINTS", "user@test.com", 100L)), port.earnCalls)
        assertEquals(1, pub.replies.size)
        assertEquals("POINTS_SUCCEEDED", pub.replies[0].type)
        assertEquals("saga-1", pub.replies[0].sagaId)
        assertEquals("corr-1", pub.replies[0].correlationId)
    }

    @Test
    fun `정지 계정 거절이면 POINTS_FAILED reply 후 ACK`() {
        val port = FakePointPort().apply { earnError = PointsDeclinedError("정지 계정") }
        val pub = CapturingPublisher()
        val handler = PointsCommandHandler(port, pub, mapper)

        val decision = handler.handle(earnCommand())

        assertEquals(AckDecision.ACK, decision)
        assertEquals("POINTS_FAILED", pub.replies[0].type)
        assertEquals("정지 계정", pub.replies[0].payload["reason"])
    }

    @Test
    fun `깨진 JSON이면 reply 없이 NACK_DLQ`() {
        val port = FakePointPort()
        val pub = CapturingPublisher()
        val handler = PointsCommandHandler(port, pub, mapper)

        val decision = handler.handle("{not json".toByteArray())

        assertEquals(AckDecision.NACK_DLQ, decision)
        assertTrue(pub.replies.isEmpty())
        assertTrue(port.earnCalls.isEmpty())
    }

    @Test
    fun `필수 키(sagaId) 누락이면 NACK_DLQ`() {
        val port = FakePointPort()
        val pub = CapturingPublisher()
        val handler = PointsCommandHandler(port, pub, mapper)

        val decision = handler.handle(body(mapOf("type" to "EARN")))

        assertEquals(AckDecision.NACK_DLQ, decision)
    }

    @Test
    fun `EARN payload의 amount 누락이면 NACK_DLQ`() {
        val port = FakePointPort()
        val pub = CapturingPublisher()
        val handler = PointsCommandHandler(port, pub, mapper)

        val decision = handler.handle(
            body(mapOf("sagaId" to "s", "type" to "EARN", "stepName" to "T3_POINTS",
                "payload" to mapOf("userEmail" to "u@test.com"))),
        )

        assertEquals(AckDecision.NACK_DLQ, decision)
        assertTrue(port.earnCalls.isEmpty())
    }

    @Test
    fun `인프라 장애면 reply 없이 NACK_REQUEUE`() {
        val port = FakePointPort().apply { earnError = RuntimeException("DB down") }
        val pub = CapturingPublisher()
        val handler = PointsCommandHandler(port, pub, mapper)

        val decision = handler.handle(earnCommand())

        assertEquals(AckDecision.NACK_REQUEUE, decision)
        assertTrue(pub.replies.isEmpty())
    }

    @Test
    fun `CANCEL은 cancel 호출 후 reply 없이 ACK`() {
        val port = FakePointPort()
        val pub = CapturingPublisher()
        val handler = PointsCommandHandler(port, pub, mapper)

        val decision = handler.handle(
            body(mapOf("sagaId" to "saga-1", "type" to "CANCEL", "stepName" to "T3_POINTS",
                "payload" to mapOf("userEmail" to "user@test.com", "amount" to 100))),
        )

        assertEquals(AckDecision.ACK, decision)
        assertEquals(1, port.cancelCalls.size)
        assertTrue(pub.replies.isEmpty()) // CANCEL 은 소비자가 없어 reply 하지 않는다
    }

    @Test
    fun `알 수 없는 command type은 reply 없이 ACK로 버린다`() {
        val port = FakePointPort()
        val pub = CapturingPublisher()
        val handler = PointsCommandHandler(port, pub, mapper)

        val decision = handler.handle(body(mapOf("sagaId" to "s", "type" to "UNKNOWN")))

        assertEquals(AckDecision.ACK, decision)
        assertTrue(pub.replies.isEmpty())
        assertNull(port.earnCalls.firstOrNull())
    }

    @Test
    fun `EARN amount가 0이면 NACK_DLQ`() {
        val port = FakePointPort()
        val pub = CapturingPublisher()
        val decision = PointsCommandHandler(port, pub, mapper).handle(earnCommandWithAmount(0))
        assertEquals(AckDecision.NACK_DLQ, decision)
        assertTrue(port.earnCalls.isEmpty())
        assertTrue(pub.replies.isEmpty())
    }

    @Test
    fun `EARN amount가 음수면 NACK_DLQ`() {
        val port = FakePointPort()
        val pub = CapturingPublisher()
        val decision = PointsCommandHandler(port, pub, mapper).handle(earnCommandWithAmount(-100))
        assertEquals(AckDecision.NACK_DLQ, decision)
        assertTrue(port.earnCalls.isEmpty())
    }

    @Test
    fun `EARN amount가 소수면 NACK_DLQ`() {
        val port = FakePointPort()
        val pub = CapturingPublisher()
        val decision = PointsCommandHandler(port, pub, mapper).handle(earnCommandWithAmount(10.5))
        assertEquals(AckDecision.NACK_DLQ, decision)
        assertTrue(port.earnCalls.isEmpty())
    }

    @Test
    fun `EARN amount가 상한을 초과하면 NACK_DLQ`() {
        val port = FakePointPort()
        val pub = CapturingPublisher()
        val decision = PointsCommandHandler(port, pub, mapper)
            .handle(earnCommandWithAmount(PointsCommandHandler.MAX_POINTS_AMOUNT + 1))
        assertEquals(AckDecision.NACK_DLQ, decision)
        assertTrue(port.earnCalls.isEmpty())
    }

    @Test
    fun `EARN userEmail이 공백이면 NACK_DLQ`() {
        val port = FakePointPort()
        val pub = CapturingPublisher()
        val decision = PointsCommandHandler(port, pub, mapper).handle(
            body(mapOf("sagaId" to "s", "type" to "EARN", "stepName" to "T3_POINTS",
                "payload" to mapOf("userEmail" to "   ", "amount" to 100))),
        )
        assertEquals(AckDecision.NACK_DLQ, decision)
        assertTrue(port.earnCalls.isEmpty())
    }

    @Test
    fun `CANCEL amount가 음수면 NACK_DLQ`() {
        val port = FakePointPort()
        val pub = CapturingPublisher()
        val decision = PointsCommandHandler(port, pub, mapper).handle(
            body(mapOf("sagaId" to "saga-1", "type" to "CANCEL", "stepName" to "T3_POINTS",
                "payload" to mapOf("userEmail" to "user@test.com", "amount" to -100))),
        )
        assertEquals(AckDecision.NACK_DLQ, decision)
        assertTrue(port.cancelCalls.isEmpty())
    }

    @Test
    fun `EARN 중복(UNIQUE 위반)이면 멱등 성공으로 POINTS_SUCCEEDED reply 후 ACK`() {
        val port = FakePointPort().apply { earnError = DataIntegrityViolationException("duplicate key") }
        val pub = CapturingPublisher()
        val handler = PointsCommandHandler(port, pub, mapper)

        val decision = handler.handle(earnCommand())

        assertEquals(AckDecision.ACK, decision) // 재시도 루프(NACK_REQUEUE) 아님
        assertEquals(1, pub.replies.size)
        assertEquals("POINTS_SUCCEEDED", pub.replies[0].type)
    }

    @Test
    fun `CANCEL 중복(UNIQUE 위반)이면 reply 없이 ACK`() {
        val port = FakePointPort().apply { cancelError = DataIntegrityViolationException("duplicate key") }
        val pub = CapturingPublisher()
        val handler = PointsCommandHandler(port, pub, mapper)

        val decision = handler.handle(
            body(mapOf("sagaId" to "saga-1", "type" to "CANCEL", "stepName" to "T3_POINTS",
                "payload" to mapOf("userEmail" to "user@test.com", "amount" to 100))),
        )

        assertEquals(AckDecision.ACK, decision)
        assertTrue(pub.replies.isEmpty()) // CANCEL 은 reply 없음(비대칭 유지)
    }
}
