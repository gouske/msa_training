package com.example.auth.controller

import com.example.auth.dto.SignUpRequest
import com.example.auth.service.AuthService
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*

@RestController // 1. 이 클래스는 웹 요청을 받는 '문지기'입니다.
@RequestMapping("/api/auth") // 2. 모든 요청 주소는 /api/auth로 시작합니다.
class AuthController(
    private val authService: AuthService // 3. 실제 업무를 처리할 '지배인(Service)'을 데려옵니다.
) {

    /**
     * 회원가입 API (POST 방식)
     * 사용자가 보낸 택배 박스(@RequestBody)를 받아서 서비스에 전달합니다.
     */
    @PostMapping("/signup")
    fun signUp(@RequestBody request: SignUpRequest): ResponseEntity<Any> {
        // 4. 서비스에게 회원가입 업무를 시킵니다.
        val savedUser = authService.signUp(
            email = request.email,
            password = request.password,
            name = request.name
        )

        // 5. 결과 보고: 성공했다는 메시지와 함께 가입된 정보를 돌려줍니다.
        // 실무 팁: 보안을 위해 비밀번호는 빼고 응답하는 것이 원칙이지만, 지금은 확인을 위해 전체를 보냅니다.
        return ResponseEntity.ok(mapOf(
            "message" to "회원가입 성공!",
            "user" to mapOf(
                "id" to savedUser.id,
                "email" to savedUser.email,
                "name" to savedUser.name
            )
        ))
    }

    @GetMapping("/health")
    fun healthCheck() = "✅ Auth Service is Running!"
}