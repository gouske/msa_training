package com.example.auth.config

import io.jsonwebtoken.Jwts
import io.jsonwebtoken.SignatureAlgorithm
import io.jsonwebtoken.security.Keys
import org.springframework.stereotype.Component
import java.util.*

@Component // 1. 스프링이 관리하는 "토큰 제조기" 부품으로 등록합니다.
class JwtTokenProvider {

    // 2. 토큰을 암호화할 때 쓸 '비밀 도장'입니다. 실무에선 환경 변수로 숨겨야 합니다.
    private val secretKey = Keys.secretKeyFor(SignatureAlgorithm.HS256)

    // 3. 토큰의 유효 기간 (예: 1시간)
    private val validityInMilliseconds: Long = 3600000

    /**
     * 사용자의 이메일을 받아서 '디지털 통행증'을 만드는 함수입니다.
     */
    fun createToken(email: String): String {
        val claims = Jwts.claims().setSubject(email) // 토큰 주인 정보 입력
        val now = Date()
        val validity = Date(now.time + validityInMilliseconds) // 만료 시간 계산

        return Jwts.builder()
            .setClaims(claims) // 내용물 담기
            .setIssuedAt(now)  // 발급 시간 기록
            .setExpiration(validity) // 만료 시간 기록
            .signWith(secretKey) // 서버의 비밀 도장으로 꽝!
            .compact() // 압축해서 문자열로 반환
    }
}