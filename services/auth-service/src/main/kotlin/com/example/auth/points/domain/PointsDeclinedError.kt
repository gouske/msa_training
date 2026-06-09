package com.example.auth.points.domain

/**
 * 포인트 적립/취소가 비즈니스 규칙상 거절됨(예: 계정 정지).
 * 인프라 장애와 구분하기 위한 명시적 예외. 이 예외가 발생하면 "보상으로 처리하는 정상 흐름"이므로
 * consumer 는 POINTS_FAILED reply 를 보내고 메시지를 ACK 한다(DLQ로 보내지 않음).
 * (payment-service PaymentDeclinedError 대응)
 */
class PointsDeclinedError(message: String) : RuntimeException(message)
