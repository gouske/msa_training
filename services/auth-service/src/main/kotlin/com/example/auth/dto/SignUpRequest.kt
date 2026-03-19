package com.example.auth.dto

/**
 * 회원가입을 위해 사용자가 보내는 데이터를 담는 전용 박스입니다.
 * 실무에서는 이 단계에서 "이메일 형식이 맞는지", "비밀번호가 너무 짧지는 않은지" 등을 검사합니다.
 */
data class SignUpRequest(
    val email: String,    // 사용자가 입력한 이메일
    val password: String, // 사용자가 입력한 비밀번호
    val name: String      // 사용자가 입력한 이름
)