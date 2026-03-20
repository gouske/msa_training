package com.example.auth.dto

/**
 * 에러가 났을 때 클라이언트에게 보낼 표준 택배 박스입니다.
 */
data class ErrorResponse(
    val status: Int,     // 숫자 코드 (예: 400, 404)
    val message: String, // 에러 메시지 (예: "이미 존재하는 이메일입니다.")
    val timestamp: Long = System.currentTimeMillis() // 에러 발생 시간
)