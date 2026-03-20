package com.example.auth.dto

/**
 * 로그인을 위해 사용자가 보내는 데이터를 담는 전용 박스입니다.
 */
data class LoginRequest(
    val email: String,    // 사용자가 입력한 이메일
    val password: String, // 사용자가 입력한 비밀번호
)