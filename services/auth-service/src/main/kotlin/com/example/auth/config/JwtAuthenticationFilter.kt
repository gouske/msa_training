package com.example.auth.config

import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.web.filter.OncePerRequestFilter

/**
 * 모든 요청을 가로채서 '통행증(JWT)'이 진짜인지 검사하는 파수꾼 클래스입니다.
 * OncePerRequestFilter를 상속받으면, 모든 요청마다 딱 한 번씩 이 검문소를 거치게 됩니다.
 */
class JwtAuthenticationFilter(
    private val jwtTokenProvider: JwtTokenProvider // 8강에서 만든 토큰 제조기를 가져옵니다.
) : OncePerRequestFilter() {

    override fun doFilterInternal(
        request: HttpServletRequest,
        response: HttpServletResponse,
        filterChain: FilterChain
    ) {
        // 1. 사용자가 보낸 편지(Header)에서 'Authorization' 항목을 확인합니다.
        val token = resolveToken(request)

        // 2. 토큰이 있고, 그 토큰이 우리 서버의 도장이 찍힌 진짜 토큰이라면?
        if (token != null && jwtTokenProvider.validateToken(token)) {
            // 3. 토큰에서 사용자 이메일을 꺼내서 '인증 성공' 도장을 꽝 찍어줍니다.
            val auth = jwtTokenProvider.getAuthentication(token)

            // 4. 이 '인증 도장'을 서버의 임시 저장소(SecurityContext)에 보관합니다.
            // 이렇게 해두면 뒤에 있는 방(Controller)들이 "아, 이미 검사 끝난 사람이구나"라고 믿어줍니다.
            SecurityContextHolder.getContext().authentication = auth
        }

        // 5. 다음 검문소로 넘어가거나, 최종 목적지로 보내줍니다.
        filterChain.doFilter(request, response)
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