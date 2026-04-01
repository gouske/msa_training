package com.example.auth.service

import com.example.auth.config.JwtTokenProvider
import com.example.auth.domain.User
import com.example.auth.domain.UserRepository
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.InjectMocks
import org.mockito.Mock
import org.mockito.Mockito.*
import org.mockito.junit.jupiter.MockitoExtension
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder

/**
 * [테스트] AuthService 단위 테스트
 *
 * 학습 포인트:
 *   1. @Mock으로 Repository, PasswordEncoder 등 의존성을 가짜로 만드는 방법
 *   2. @InjectMocks로 테스트 대상에 mock을 자동 주입하는 방법
 *   3. when(...).thenReturn(...)으로 mock의 동작을 정의하는 방법
 *   4. 성공/실패 시나리오를 나누어 검증하는 방법
 *
 * 실행: ./gradlew test
 */
@ExtendWith(MockitoExtension::class) // Mockito 어노테이션(@Mock, @InjectMocks)을 활성화합니다.
class AuthServiceTest {

    // Mock 객체: 실제 DB나 외부 시스템 없이 가짜 동작을 정의합니다.
    @Mock
    private lateinit var userRepository: UserRepository

    @Mock
    private lateinit var passwordEncoder: BCryptPasswordEncoder

    @Mock
    private lateinit var jwtTokenProvider: JwtTokenProvider

    // 테스트 대상: 위의 Mock들이 자동으로 주입됩니다.
    @InjectMocks
    private lateinit var authService: AuthService

    // 테스트 공통 데이터
    private val testEmail = "test@example.com"
    private val testPassword = "password123"
    private val testName = "테스트유저"
    private val encodedPassword = "\$2a\$10\$encodedPasswordHash"

    // ==========================================================
    // 회원가입 테스트
    // ==========================================================

    @Test
    @DisplayName("회원가입 성공: 새 이메일로 가입하면 User 객체를 반환한다")
    fun signUp_success() {
        // GIVEN: 이메일 중복 없음 + 비밀번호 암호화 결과 설정
        `when`(userRepository.findByEmail(testEmail)).thenReturn(null)
        `when`(passwordEncoder.encode(testPassword)).thenReturn(encodedPassword)
        `when`(userRepository.save(any(User::class.java))).thenAnswer { invocation ->
            // save()에 전달된 User 객체를 그대로 반환 (id만 추가)
            val user = invocation.getArgument<User>(0)
            User(
                id = 1L,
                email = user.email,
                password = user.password,
                name = user.name
            )
        }

        // WHEN: 회원가입 실행
        val result = authService.signUp(testEmail, testPassword, testName)

        // THEN: 저장된 사용자 정보 검증
        assertEquals(testEmail, result.email)
        assertEquals(testName, result.name)
        assertEquals(encodedPassword, result.password) // 암호화된 비밀번호
        assertNotNull(result.id)

        // Mock 호출 순서 검증: 중복 확인 → 암호화 → 저장
        verify(userRepository).findByEmail(testEmail)
        verify(passwordEncoder).encode(testPassword)
        verify(userRepository).save(any(User::class.java))
    }

    @Test
    @DisplayName("회원가입 실패: 이미 존재하는 이메일로 가입하면 예외를 던진다")
    fun signUp_duplicateEmail_throwsException() {
        // GIVEN: 이메일이 이미 DB에 존재
        val existingUser = User(id = 1L, email = testEmail, password = encodedPassword, name = "기존유저")
        `when`(userRepository.findByEmail(testEmail)).thenReturn(existingUser)

        // WHEN & THEN: RuntimeException 발생 확인
        val exception = assertThrows(RuntimeException::class.java) {
            authService.signUp(testEmail, testPassword, testName)
        }

        assertEquals("이미 존재하는 이메일입니다.", exception.message)
        // save()는 호출되지 않아야 합니다 (중복 체크에서 걸림)
        verify(userRepository, never()).save(any(User::class.java))
    }

    // ==========================================================
    // 로그인 테스트
    // ==========================================================

    @Test
    @DisplayName("로그인 성공: 올바른 이메일과 비밀번호로 JWT 토큰을 반환한다")
    fun login_success() {
        // GIVEN: DB에 사용자 존재 + 비밀번호 일치
        val existingUser = User(id = 1L, email = testEmail, password = encodedPassword, name = testName)
        `when`(userRepository.findByEmail(testEmail)).thenReturn(existingUser)
        `when`(passwordEncoder.matches(testPassword, encodedPassword)).thenReturn(true)
        `when`(jwtTokenProvider.createToken(testEmail)).thenReturn("mock-jwt-token")

        // WHEN: 로그인 실행
        val token = authService.login(testEmail, testPassword)

        // THEN: JWT 토큰 반환
        assertEquals("mock-jwt-token", token)
        verify(jwtTokenProvider).createToken(testEmail)
    }

    @Test
    @DisplayName("로그인 실패: 존재하지 않는 이메일이면 예외를 던진다")
    fun login_emailNotFound_throwsException() {
        // GIVEN: DB에 해당 이메일 없음
        `when`(userRepository.findByEmail(testEmail)).thenReturn(null)

        // WHEN & THEN
        val exception = assertThrows(RuntimeException::class.java) {
            authService.login(testEmail, testPassword)
        }

        assertEquals("가입되지 않은 이메일입니다.", exception.message)
    }

    @Test
    @DisplayName("로그인 실패: 비밀번호가 틀리면 예외를 던진다")
    fun login_wrongPassword_throwsException() {
        // GIVEN: 사용자는 존재하지만 비밀번호 불일치
        val existingUser = User(id = 1L, email = testEmail, password = encodedPassword, name = testName)
        `when`(userRepository.findByEmail(testEmail)).thenReturn(existingUser)
        `when`(passwordEncoder.matches("wrong-password", encodedPassword)).thenReturn(false)

        // WHEN & THEN
        val exception = assertThrows(RuntimeException::class.java) {
            authService.login(testEmail, "wrong-password")
        }

        assertEquals("비밀번호가 일치하지 않습니다.", exception.message)
        // 토큰은 생성되지 않아야 합니다
        verify(jwtTokenProvider, never()).createToken(anyString())
    }
}
