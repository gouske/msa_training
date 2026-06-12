package com.example.auth.points.messaging

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 외부 클라이언트가 주입한 correlationId가 부정 값(과대길이/제어문자/비문자열)이어도
 * reply 발행이 깨지지 않도록 boundary에서 정규화한다(payment normalize_correlation_id 미러).
 */
class CorrelationIdTest {
    private val pattern = Regex("^[A-Za-z0-9_-]{1,64}$")

    @Test
    fun `정상 값은 그대로 통과한다`() {
        assertEquals("abc-123_XYZ", CorrelationId.normalize("abc-123_XYZ"))
    }

    @Test
    fun `과대길이는 새 UUID로 대체된다`() {
        val tooLong = "x".repeat(65)
        val result = CorrelationId.normalize(tooLong)
        assertTrue(pattern.matches(result))
        assertTrue(result != tooLong)
    }

    @Test
    fun `허용되지 않는 문자는 새 UUID로 대체된다`() {
        val result = CorrelationId.normalize("bad value!@#")
        assertTrue(pattern.matches(result))
    }

    @Test
    fun `null과 비문자열은 새 UUID로 대체된다`() {
        assertTrue(pattern.matches(CorrelationId.normalize(null)))
        assertTrue(pattern.matches(CorrelationId.normalize(12345)))
    }
}
