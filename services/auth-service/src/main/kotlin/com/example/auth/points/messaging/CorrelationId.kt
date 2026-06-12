package com.example.auth.points.messaging

import java.util.UUID

/**
 * Correlation ID 정규화 — payment-service infrastructure/correlation_id.py 의 규칙 미러.
 *
 * 규칙:
 *   - 허용 charset: [A-Za-z0-9_-], 길이 1~64 (UUID v4 36자 + 여유)
 *   - 형식 불일치/비문자열/null 이면 새 UUID v4 를 발급한다(메시지 처리는 계속 — 추적 가능성 유지).
 */
object CorrelationId {
    private val PATTERN = Regex("^[A-Za-z0-9_-]{1,64}$")

    fun normalize(value: Any?): String =
        (value as? String)?.takeIf { PATTERN.matches(it) } ?: UUID.randomUUID().toString()
}
