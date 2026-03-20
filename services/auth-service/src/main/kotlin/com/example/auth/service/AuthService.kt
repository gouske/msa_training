package com.example.auth.service

import com.example.auth.config.JwtTokenProvider
import com.example.auth.domain.User
import com.example.auth.domain.UserRepository
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional

@Service // 1. "나는 실제 업무(로직)를 처리하는 서비스야!"라고 선언합니다.
class AuthService(
    private val userRepository: UserRepository, // DB와 대화하는 통역사를 데려옵니다.
    private val passwordEncoder: BCryptPasswordEncoder, // 암호화 기계를 데려옵니다.
    private val jwtTokenProvider: JwtTokenProvider
) {

    /**
     * 회원 가입을 처리하는 핵심 기능 (실무용 로직)
     */
    @Transactional // 2. "이 함수 안의 작업은 하나라도 실패하면 모두 취소해!"라는 안전장치입니다.
    fun signUp(email: String, password: String, name: String): User {

        // 3. 중복 가입 체크 (실무 필수!)
        // 이미 해당 이메일로 가입된 사람이 있는지 DB에서 확인합니다.
        if (userRepository.findByEmail(email) != null) {
            throw RuntimeException("이미 존재하는 이메일입니다.") // 에러가 나면 작업이 중단됩니다.
        }

        // 4. 비밀번호 암호화
        // 사용자가 입력한 생(Raw) 비밀번호를 암호화 기계에 넣어 복잡한 문자로 바꿉니다.
        val encodedPassword = passwordEncoder.encode(password)

        // 5. 새 회원 객체 생성
        val newUser = User(
            email = email,
            password = encodedPassword ?: "",
            name = name
        )

        // 6. DB 창고에 저장하고, 저장된 결과물을 반환합니다.
        return userRepository.save(newUser)
    }

    fun login(email: String, rawPassword: String): String {
        // 1. 가입된 회원인지 확인
        val user = userRepository.findByEmail(email)
            ?: throw RuntimeException("가입되지 않은 이메일입니다.")

        // 2. 비밀번호가 일치하는지 확인 (암호화된 것과 입력받은 것 비교)
        if (!passwordEncoder.matches(rawPassword, user.password)) {
            throw RuntimeException("비밀번호가 일치하지 않습니다.")
        }

        // 3. 로그인이 성공했으니 '디지털 통행증'을 발급해서 돌려줍니다.
        return jwtTokenProvider.createToken(user.email)
    }
}