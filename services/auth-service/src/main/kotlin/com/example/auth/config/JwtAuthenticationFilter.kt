package com.example.auth.config

import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.slf4j.LoggerFactory
import org.slf4j.MDC
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.web.filter.OncePerRequestFilter
import java.util.UUID

/**
 * 모든 요청을 가로채서 '통행증(JWT)'이 진짜인지 검사하는 파수꾼 클래스입니다.
 * OncePerRequestFilter를 상속받으면, 모든 요청마다 딱 한 번씩 이 검문소를 거치게 됩니다.
 *
 * [제20강] Correlation ID 기능 추가:
 * - 요청 헤더의 X-Correlation-ID를 MDC(Mapped Diagnostic Context)에 저장합니다.
 * - MDC에 저장된 값은 logback-spring.xml 패턴의 %X{correlationId}로 모든 로그에 자동 포함됩니다.
 * - 응답 헤더에도 동일한 ID를 추가하여 클라이언트가 추적할 수 있게 합니다.
 * - try/finally: 스레드 풀 재사용 시 이전 요청의 ID가 남지 않도록 반드시 제거합니다.
 */
class JwtAuthenticationFilter(
    private val jwtTokenProvider: JwtTokenProvider
) : OncePerRequestFilter() {

    companion object {
        private val log = LoggerFactory.getLogger(JwtAuthenticationFilter::class.java)

        /**
         * [Issue #8] 허용 Correlation ID 형식.
         *   - charset: URL-safe (`A-Za-z0-9_-`)
         *   - 길이: 1 ~ 64 (UUID v4 36자 + 여유)
         * Gateway 를 거치지 않은 내부 호출(디버깅/직접 호출) 에도 방어적으로 검증한다.
         *
         * 부정 입력(길이 불일치/charset 불일치) 치환 시 WARN 로그를 남긴다.
         * 원본 값은 로그에 기록하지 않고(로그 인젝션 방지) 길이만 노출한다.
         * 누락(null/빈 문자열) 은 정상 흐름이라 로그를 생략한다.
         */
        private val CORRELATION_ID_PATTERN = Regex("^[A-Za-z0-9_-]{1,64}\$")

        internal fun normalizeCorrelationId(raw: String?): String {
            if (raw != null && CORRELATION_ID_PATTERN.matches(raw)) return raw

            val replacement = UUID.randomUUID().toString()
            if (!raw.isNullOrEmpty()) {
                log.warn(
                    "correlation_id 부정 입력 치환 — 원본 길이={}, 치환 ID={}",
                    raw.length,
                    replacement
                )
            }
            return replacement
        }
    }

    override fun doFilterInternal(
        request: HttpServletRequest,
        response: HttpServletResponse,
        filterChain: FilterChain
    ) {
        // [제20강 / Issue #8] 1. X-Correlation-ID 읽기 — 검증 후 통과 시 재사용,
        //    누락/형식 불일치 시 Auth Service 자체에서 UUID v4 발급.
        val correlationId = normalizeCorrelationId(request.getHeader("X-Correlation-ID"))

        // [제20강] 2. MDC(Mapped Diagnostic Context)에 저장합니다.
        // MDC는 스레드 로컬 저장소입니다 — 이 요청을 처리하는 스레드의 모든 로그에
        // correlationId 값이 자동으로 포함됩니다 (logback-spring.xml의 %X{correlationId} 참조).
        MDC.put("correlationId", correlationId)

        // [제20강] 3. 응답 헤더에 correlationId를 추가합니다.
        response.addHeader("X-Correlation-ID", correlationId)

        try {
            // 4. 사용자가 보낸 편지(Header)에서 'Authorization' 항목을 확인합니다.
            val token = resolveToken(request)

            // 5. 토큰이 있고, 그 토큰이 우리 서버의 도장이 찍힌 진짜 토큰이라면?
            if (token != null && jwtTokenProvider.validateToken(token)) {
                // 6. 토큰에서 사용자 이메일을 꺼내서 '인증 성공' 도장을 꽝 찍어줍니다.
                val auth = jwtTokenProvider.getAuthentication(token)

                // 7. 이 '인증 도장'을 서버의 임시 저장소(SecurityContext)에 보관합니다.
                SecurityContextHolder.getContext().authentication = auth
            }

            // 8. 다음 검문소로 넘어가거나, 최종 목적지로 보내줍니다.
            filterChain.doFilter(request, response)

        } finally {
            // [제20강] 9. MDC 정리 — 반드시 finally에서 실행합니다.
            // Spring은 스레드 풀을 재사용하므로, 정리하지 않으면 다음 요청에 이전 correlationId가 남습니다.
            MDC.remove("correlationId")
        }
    }

    // 편지 헤더에서 "Bearer [토큰]" 형태로 된 문자열을 찾아 순수하게 토큰 값만 쏙 빼내는 기능입니다.
    private fun resolveToken(request: HttpServletRequest): String? {
        val bearerToken = request.getHeader("Authorization")
        if (bearerToken != null && bearerToken.startsWith("Bearer ")) {
            return bearerToken.substring(7) // "Bearer " 뒷부분만 가져옵니다.
        }
        return null
    }
}