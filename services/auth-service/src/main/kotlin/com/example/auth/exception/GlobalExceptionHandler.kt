package com.example.auth.exception

import com.example.auth.dto.ErrorResponse
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice

@RestControllerAdvice // 1. 모든 컨트롤러에서 발생하는 에러를 여기서 다 잡겠다는 뜻입니다!
class GlobalExceptionHandler {

    /**
     * 우리가 Service에서 던진 RuntimeException을 여기서 가로챕니다.
     */
    @ExceptionHandler(RuntimeException::class)
    fun handleRuntimeException(e: RuntimeException): ResponseEntity<ErrorResponse> {

        // 2. 클라이언트에게 보낼 에러 박스를 만듭니다.
        val errorResponse = ErrorResponse(
            status = HttpStatus.BAD_REQUEST.value(), // 400 에러 코드
            message = e.message ?: "알 수 없는 에러가 발생했습니다."
        )

        // 3. 로그도 남기고, 클라이언트에게 예쁘게 응답합니다.
        println("🚨 [에러 발생]: ${e.message}")
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(errorResponse)
    }

    /**
     * (실무 팁) 그 외에 우리가 예상치 못한 모든 에러(500 에러)를 여기서 잡습니다.
     */
    @ExceptionHandler(Exception::class)
    fun handleAllException(e: Exception): ResponseEntity<ErrorResponse> {
        val errorResponse = ErrorResponse(
            status = HttpStatus.INTERNAL_SERVER_ERROR.value(),
            message = "서버 내부 오류가 발생했습니다. 잠시 후 다시 시도해주세요."
        )
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(errorResponse)
    }
}