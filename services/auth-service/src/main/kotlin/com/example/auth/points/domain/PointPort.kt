package com.example.auth.points.domain

/**
 * 포인트 적립/취소 경계 인터페이스. 메시징 핸들러가 이 포트에만 의존하도록 해
 * 핸들러 단위 테스트에서 fake 로 대체할 수 있게 한다.
 */
interface PointPort {
    /** 적립. 멱등(같은 sagaId:stepName 재요청은 부수효과 없음). @return 처리 후 잔액. @throws PointsDeclinedError 정지 계정. */
    fun earn(sagaId: String, stepName: String, userEmail: String, amount: Long): Long

    /** 적립 취소(보상). 멱등. 적립 이력이 없으면 no-op. */
    fun cancel(sagaId: String, stepName: String, userEmail: String, amount: Long)
}
