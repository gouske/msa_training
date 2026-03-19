package com.msa_training.auth_service

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController // 이 클래스는 API를 처리하는 컨트롤러야!
@RequestMapping("/api/auth") // 주소창에 /api/auth라고 치면 여기로 와!
class AuthController {

    @GetMapping("/health") // /api/auth/health라고 치면 아래 함수 실행!
    fun healthCheck(): String {
        return "✅ Auth Service is Running perfectly!"
    }
}