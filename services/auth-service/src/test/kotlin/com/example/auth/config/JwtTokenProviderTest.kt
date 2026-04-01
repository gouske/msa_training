package com.example.auth.config

import io.jsonwebtoken.Jwts
import io.jsonwebtoken.security.Keys
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import java.nio.charset.StandardCharsets

/**
 * [테스트] JwtTokenProvider 단위 테스트
 *
 * 학습 포인트:
 *   1. JWT 토큰의 생성/검증/파싱이 올바르게 동작하는지 확인
 *   2. 리플렉션으로 @Value, @PostConstruct 대신 직접 필드를 설정하는 방법
 *   3. 만료 토큰, 잘못된 서명 등 비정상 시나리오 테스트
 *
 * 실행: ./gradlew test
 */
class JwtTokenProviderTest {

    private lateinit var jwtTokenProvider: JwtTokenProvider

    // 테스트용 비밀 키 (실제 application.yml의 기본값과 동일)
    private val testSecret = "default-local-test-key-1234567890"

    @BeforeEach
    fun setUp() {
        jwtTokenProvider = JwtTokenProvider()

        // @Value로 주입되는 secretKeyString 필드를 리플렉션으로 직접 설정
        val secretKeyStringField = JwtTokenProvider::class.java.getDeclaredField("secretKeyString")
        secretKeyStringField.isAccessible = true
        secretKeyStringField.set(jwtTokenProvider, testSecret)

        // @PostConstruct init()을 수동으로 호출하여 secretKey 초기화
        jwtTokenProvider.init()
    }

    // ==========================================================
    // createToken 테스트
    // ==========================================================

    @Test
    @DisplayName("토큰 생성: 이메일로 JWT 토큰을 생성한다")
    fun createToken_returnsValidJwt() {
        // WHEN: 토큰 생성
        val token = jwtTokenProvider.createToken("user@test.com")

        // THEN: 토큰이 비어있지 않고, JWT 형식(header.payload.signature)인지 확인
        assertNotNull(token)
        assertTrue(token.isNotBlank())
        assertEquals(3, token.split(".").size, "JWT는 3개의 부분으로 구성되어야 합니다")
    }

    @Test
    @DisplayName("토큰 생성: 토큰에 이메일(subject)이 포함되어 있다")
    fun createToken_containsEmail() {
        val email = "subject@test.com"
        val token = jwtTokenProvider.createToken(email)

        // 토큰을 직접 파싱하여 subject(이메일) 확인
        val key = Keys.hmacShaKeyFor(testSecret.toByteArray(StandardCharsets.UTF_8))
        val claims = Jwts.parser()
            .verifyWith(key)
            .build()
            .parseSignedClaims(token)
            .payload

        assertEquals(email, claims.subject)
    }

    // ==========================================================
    // validateToken 테스트
    // ==========================================================

    @Test
    @DisplayName("토큰 검증 성공: 올바른 토큰은 true를 반환한다")
    fun validateToken_validToken_returnsTrue() {
        // GIVEN: 정상적으로 생성된 토큰
        val token = jwtTokenProvider.createToken("valid@test.com")

        // WHEN & THEN
        assertTrue(jwtTokenProvider.validateToken(token))
    }

    @Test
    @DisplayName("토큰 검증 실패: 잘못된 문자열은 false를 반환한다")
    fun validateToken_invalidToken_returnsFalse() {
        // GIVEN: JWT 형식이 아닌 문자열
        assertFalse(jwtTokenProvider.validateToken("this-is-not-a-jwt"))
    }

    @Test
    @DisplayName("토큰 검증 실패: 다른 비밀 키로 서명된 토큰은 false를 반환한다")
    fun validateToken_wrongSecret_returnsFalse() {
        // GIVEN: 다른 키로 서명된 토큰 (위조 시도)
        val otherKey = Keys.hmacShaKeyFor(
            "completely-different-secret-key-99".toByteArray(StandardCharsets.UTF_8)
        )
        val forgedToken = Jwts.builder()
            .subject("hacker@evil.com")
            .signWith(otherKey)
            .compact()

        // WHEN & THEN: 우리 키로 검증하면 실패
        assertFalse(jwtTokenProvider.validateToken(forgedToken))
    }

    @Test
    @DisplayName("토큰 검증 실패: 빈 문자열은 false를 반환한다")
    fun validateToken_emptyString_returnsFalse() {
        assertFalse(jwtTokenProvider.validateToken(""))
    }

    // ==========================================================
    // getAuthentication 테스트
    // ==========================================================

    @Test
    @DisplayName("인증 정보 추출: 토큰에서 이메일(principal)을 꺼낸다")
    fun getAuthentication_extractsEmail() {
        // GIVEN
        val email = "auth@test.com"
        val token = jwtTokenProvider.createToken(email)

        // WHEN: 토큰에서 인증 정보 추출
        val authentication = jwtTokenProvider.getAuthentication(token)

        // THEN: principal에 이메일이 들어있어야 합니다
        assertEquals(email, authentication.name)
    }

    @Test
    @DisplayName("인증 정보 추출: ROLE_USER 권한이 포함되어 있다")
    fun getAuthentication_hasRoleUser() {
        val token = jwtTokenProvider.createToken("role@test.com")
        val authentication = jwtTokenProvider.getAuthentication(token)

        // 권한 목록에 ROLE_USER가 있는지 확인
        val authorities = authentication.authorities.map { it.authority }
        assertTrue(authorities.contains("ROLE_USER"))
    }

    @Test
    @DisplayName("인증 정보 추출: 비밀번호(credentials)는 빈 문자열이다")
    fun getAuthentication_credentialsIsEmpty() {
        val token = jwtTokenProvider.createToken("cred@test.com")
        val authentication = jwtTokenProvider.getAuthentication(token)

        // 보안을 위해 credentials는 비어있어야 합니다
        assertEquals("", authentication.credentials)
    }
}
