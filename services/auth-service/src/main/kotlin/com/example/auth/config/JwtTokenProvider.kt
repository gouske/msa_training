package com.example.auth.config

import io.jsonwebtoken.Jwts
import io.jsonwebtoken.security.Keys
import org.springframework.beans.factory.annotation.Value
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken
import org.springframework.security.core.Authentication
import org.springframework.security.core.authority.SimpleGrantedAuthority
import org.springframework.stereotype.Component
import java.nio.charset.StandardCharsets
import java.security.Key
import java.util.*
import jakarta.annotation.PostConstruct

@Component // 1. 스프링이 관리하는 "토큰 제조기" 부품으로 등록합니다.
class JwtTokenProvider {

    // 💡 연결의 핵심: @Value : org.springframework.beans.factory.annotation.Value
    // 스프링이 application.yml을 뒤져서 'jwt.secret'에 적힌 글자를 찾아
    // 이 secretKeyString 변수에 자동으로 배달(주입)해줍니다.
    @Value("\${jwt.secret}")
    private lateinit var secretKeyString: String

    private lateinit var secretKey: Key // java.security.Key
    // 2. 토큰을 암호화할 때 쓸 '비밀 도장'입니다. 실무에선 환경 변수로 숨겨야 합니다.
//    private val secretKey = Keys.secretKeyFor(SignatureAlgorithm.HS256)

    @PostConstruct
    fun init() {
        // 배달받은 글자를 실제 도장(Key) 객체로 바꿉니다.
        this.secretKey = Keys.hmacShaKeyFor(secretKeyString.toByteArray(StandardCharsets.UTF_8))
    }

    // 3. 토큰의 유효 기간 (예: 1시간)
    private val validityInMilliseconds: Long = 3600000

    /**
     * 사용자의 이메일을 받아서 '디지털 통행증'을 만드는 함수입니다.
     */
    // 1. 토큰을 만들 때 (createToken 함수)
    fun createToken(email: String): String {
        val now = Date()
        val validity = Date(now.time + validityInMilliseconds)

        return Jwts.builder()
            .subject(email) // .setSubject() 대신 .subject()로 더 간결해졌습니다.
            .issuedAt(now)
            .expiration(validity)
            .signWith(secretKey) // 최신 버전은 알고리즘을 생략해도 key를 보고 알아서 판단합니다.
            .compact()
    }

    // 2. 토큰을 검증할 때 (validateToken 함수)
    fun validateToken(token: String): Boolean {
        return try {
            // .parserBuilder() 대신 .parser()를 사용하고 바로 열쇠를 꽂습니다.
            Jwts.parser()
                .verifyWith(secretKey as javax.crypto.SecretKey) // 보안이 강화되어 전용 열쇠 타입을 요구합니다.
                .build()
                .parseSignedClaims(token) // parseClaimsJws 대신 이 이름을 씁니다.
            true
        } catch (e: Exception) {
            false
        }
    }

    /**
     * [실무 핵심] 토큰을 까서 "이 사람은 누구인가?"를 증명하는 신분증(Authentication)을 만듭니다.
     * 팔찌를 보고 "이 사람은 홍길동이네"라고 인증 정보를 만들어주는 함수입니다.
     */
    fun getAuthentication(token: String): Authentication {
        // 1. 토큰을 우리 비밀 열쇠로 열어서 그 안의 내용물(Claims)을 가져옵니다.
        val claims = Jwts.parser()
            .verifyWith(secretKey as javax.crypto.SecretKey)
            .build()
            .parseSignedClaims(token)
            .payload

        // 2. 토큰 주인(Subject)인 이메일을 꺼냅니다.
        val email = claims.subject

        // 3. 실무 팁: 이 사람의 권한(Role)을 설정합니다.
        // 지금은 기본 권한인 'ROLE_USER'를 부여하겠습니다.
        val authorities = listOf(SimpleGrantedAuthority("ROLE_USER"))

        // 4. 최종적으로 스프링 시큐리티가 인정하는 '공식 신분증'을 만들어 반환합니다.
        // (이름, 비밀번호(보안상 비움), 권한 리스트) 순서입니다.
        return UsernamePasswordAuthenticationToken(email, "", authorities)
    }
}