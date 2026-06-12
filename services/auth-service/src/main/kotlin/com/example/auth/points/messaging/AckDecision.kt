package com.example.auth.points.messaging

/**
 * 메시지 처리 후 브로커에 어떻게 응답할지 결정.
 *   - ACK: 정상 처리(성공/비즈니스 거절/unknown) — 큐에서 제거
 *   - NACK_DLQ: malformed — 재처리해도 동일하므로 DLQ 격리(requeue=false)
 *   - NACK_REQUEUE: 인프라 장애 — 일시적일 수 있으므로 재시도(requeue=true)
 */
enum class AckDecision { ACK, NACK_DLQ, NACK_REQUEUE }
