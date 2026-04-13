package com.example.auth.config

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.slf4j.MDC
import org.springframework.mock.web.MockFilterChain
import org.springframework.mock.web.MockHttpServletRequest
import org.springframework.mock.web.MockHttpServletResponse

/**
 * [제20강] JwtAuthenticationFilter — Correlation ID 동작 테스트
 *
 * 학습 포인트:
 *   1. MockHttpServletRequest/Response로 서블릿 환경을 흉내냅니다 (Spring Test 제공).
 *   2. MockFilterChain으로 실제 다음 필터 없이 체인 실행을 시뮬레이션합니다.
 *   3. MDC 정리(cleanup) — 필터 통과 후 MDC에 값이 남지 않아야 함을 검증합니다.
 *
 * 실행: ./gradlew test
 */
@DisplayName("JwtAuthenticationFilter — Correlation ID 테스트")
class JwtAuthenticationFilterTest {

    private lateinit var filter: JwtAuthenticationFilter
    private lateinit var jwtTokenProvider: JwtTokenProvider

    @BeforeEach
    fun setUp() {
        // JwtTokenProvider를 실제로 생성합니다 (mock 대신 실제 객체 사용)
        jwtTokenProvider = JwtTokenProvider()

        // @Value 필드를 리플렉션으로 설정
        val secretField = JwtTokenProvider::class.java.getDeclaredField("secretKeyString")
        secretField.isAccessible = true
        secretField.set(jwtTokenProvider, "default-local-test-key-1234567890")

        val issuerField = JwtTokenProvider::class.java.getDeclaredField("issuer")
        issuerField.isAccessible = true
        issuerField.set(jwtTokenProvider, "msa-auth-service")

        val audienceField = JwtTokenProvider::class.java.getDeclaredField("audience")
        audienceField.isAccessible = true
        audienceField.set(jwtTokenProvider, "msa-gateway")

        jwtTokenProvider.init()

        filter = JwtAuthenticationFilter(jwtTokenProvider)
    }

    // ──────────────────────────────────────────────────────────────────
    // 테스트 1: 요청 헤더에 X-Correlation-ID가 있으면 응답에도 동일한 값이 포함된다.
    // ──────────────────────────────────────────────────────────────────
    @Test
    @DisplayName("요청 헤더의 X-Correlation-ID가 응답 헤더에 그대로 전달된다")
    fun `X-Correlation-ID 헤더가 요청에 있으면 응답에도 동일한 값이 포함된다`() {
        // Arrange
        val request = MockHttpServletRequest()
        val response = MockHttpServletResponse()
        val chain = MockFilterChain()

        val correlationId = "test-trace-abc-123"
        request.addHeader("X-Correlation-ID", correlationId)

        // Act
        // doFilter(public)를 사용합니다 — OncePerRequestFilter의 doFilterInternal은 protected
        filter.doFilter(request, response, chain)

        // Assert
        assertEquals(correlationId, response.getHeader("X-Correlation-ID"))
    }

    // ──────────────────────────────────────────────────────────────────
    // 테스트 2: 요청 헤더에 X-Correlation-ID가 없으면 UUID를 새로 생성하여 응답에 포함한다.
    // ──────────────────────────────────────────────────────────────────
    @Test
    @DisplayName("X-Correlation-ID 헤더가 없으면 UUID를 생성하여 응답 헤더에 추가한다")
    fun `X-Correlation-ID 헤더가 없으면 UUID를 생성하여 응답에 포함한다`() {
        // Arrange
        val request = MockHttpServletRequest()
        val response = MockHttpServletResponse()
        val chain = MockFilterChain()
        // X-Correlation-ID 헤더를 의도적으로 넣지 않습니다.

        // Act
        filter.doFilter(request, response, chain)

        // Assert: 응답에 헤더가 있고, UUID 형식인지 확인
        val returnedId = response.getHeader("X-Correlation-ID")
        assertNotNull(returnedId, "X-Correlation-ID가 응답에 없습니다.")
        assertDoesNotThrow({ java.util.UUID.fromString(returnedId) }) {
            "X-Correlation-ID가 UUID 형식이 아닙니다: $returnedId"
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // 테스트 3: 필터 실행 후 MDC가 정리된다.
    // ──────────────────────────────────────────────────────────────────
    @Test
    @DisplayName("필터 실행이 끝나면 MDC에서 correlationId가 제거된다")
    fun `필터 완료 후 MDC가 정리된다`() {
        // Arrange
        val request = MockHttpServletRequest()
        request.addHeader("X-Correlation-ID", "cleanup-test-id")
        val response = MockHttpServletResponse()
        val chain = MockFilterChain()

        // Act
        filter.doFilter(request, response, chain)

        // Assert: 필터 완료 후 MDC에 값이 남아 있으면 안 됩니다.
        // 스레드 풀 재사용 시 이전 요청의 ID가 누출되는 문제를 방지합니다.
        assertNull(MDC.get("correlationId"), "필터 완료 후 MDC에 correlationId가 남아 있습니다.")
    }
}
