package com.example.auth.points.messaging

import com.example.auth.points.domain.PointPort
import com.example.auth.points.domain.PointsDeclinedError
import com.example.auth.points.messaging.PointsContracts.MSG
import com.example.auth.points.messaging.PointsContracts.STEP
import com.fasterxml.jackson.databind.ObjectMapper
import org.slf4j.LoggerFactory

/**
 * saga.points.command 처리 핵심 로직 — payment-service saga_consumer.handle_command 미러.
 *
 * 오류 분류(설계 §8 / Phase 2 Codex high 자산 계승):
 *   - malformed(JSON 파싱/필수 키 누락) → NACK_DLQ, reply 없음
 *   - 인프라 장애(일반 예외) → NACK_REQUEUE, reply 없음
 *   - 비즈니스 거절(PointsDeclinedError) → POINTS_FAILED reply + ACK (보상으로 처리하는 정상 흐름)
 *
 * Spring AMQP 타입에 의존하지 않는 순수 클래스 → fake 로 단위 테스트.
 */
class PointsCommandHandler(
    private val pointPort: PointPort,
    private val replyPublisher: SagaReplyPublisher,
    private val objectMapper: ObjectMapper,
) {
    private val log = LoggerFactory.getLogger(PointsCommandHandler::class.java)

    /** 필수 필드 누락 등 재처리 불가한 메시지를 표시하는 내부 예외. */
    private class MalformedCommandException(message: String) : RuntimeException(message)

    fun handle(body: ByteArray): AckDecision {
        // 1단계: 파싱 + sagaId/type 필수 검증. 실패 시 재처리해도 동일 → DLQ 격리.
        val command: Map<String, Any?>
        val sagaId: String
        val type: String
        try {
            @Suppress("UNCHECKED_CAST")
            command = objectMapper.readValue(body, Map::class.java) as Map<String, Any?>
            sagaId = command["sagaId"] as? String ?: throw MalformedCommandException("sagaId 누락")
            type = command["type"] as? String ?: throw MalformedCommandException("type 누락")
        } catch (e: MalformedCommandException) {
            log.warn("🚨 malformed command(필수 필드 누락) — DLQ 격리: {}", e.message)
            return AckDecision.NACK_DLQ
        } catch (e: Exception) {
            log.warn("🚨 malformed command(JSON 파싱 실패) — DLQ 격리: {}", e.message)
            return AckDecision.NACK_DLQ
        }

        val stepName = command["stepName"] as? String ?: STEP.POINTS
        @Suppress("UNCHECKED_CAST")
        val payload = command["payload"] as? Map<String, Any?> ?: emptyMap()
        val correlationId = CorrelationId.normalize(command["correlationId"])

        fun reply(replyType: String, replyPayload: Map<String, Any?> = emptyMap()) {
            replyPublisher.publish(SagaReply(sagaId, replyType, stepName, replyPayload, correlationId))
        }

        // 2단계: 명령 처리. 오류 종류별로 ACK/NACK 분기.
        try {
            when (type) {
                MSG.EARN -> {
                    val userEmail = payload["userEmail"] as? String
                        ?: throw MalformedCommandException("payload.userEmail 누락")
                    val amount = (payload["amount"] as? Number)?.toLong()
                        ?: throw MalformedCommandException("payload.amount 누락")
                    val balance = pointPort.earn(sagaId, stepName, userEmail, amount)
                    log.info("✨ 포인트 적립 sagaId={} balance={} correlationId={}", sagaId, balance, correlationId)
                    reply(MSG.POINTS_SUCCEEDED, mapOf("balance" to balance))
                }

                MSG.CANCEL -> {
                    val userEmail = payload["userEmail"] as? String
                        ?: throw MalformedCommandException("payload.userEmail 누락")
                    val amount = (payload["amount"] as? Number)?.toLong()
                        ?: throw MalformedCommandException("payload.amount 누락")
                    pointPort.cancel(sagaId, stepName, userEmail, amount)
                    log.info("↩️ 포인트 취소(보상) sagaId={}", sagaId)
                    // CANCEL 은 Orchestrator 에 소비자가 없어 reply 를 보내지 않고 ACK 만 한다(의도적 비대칭).
                }

                else -> log.warn("⚠️ 알 수 없는 command type 무시: {}", type)
            }
        } catch (e: MalformedCommandException) {
            log.warn("🚨 malformed payload(필수 키 누락) — DLQ 격리: {}", e.message)
            return AckDecision.NACK_DLQ
        } catch (e: PointsDeclinedError) {
            log.info("🚫 포인트 거절 sagaId={}: {}", sagaId, e.message)
            reply(MSG.POINTS_FAILED, mapOf("reason" to (e.message ?: "거절")))
        } catch (e: Exception) {
            // 인프라 장애(DB/네트워크 등) — 일시적일 수 있으므로 재시도. reply 는 보내지 않는다.
            log.error("🚨 인프라 오류 — 재시도 sagaId={}: {}", sagaId, e.message)
            return AckDecision.NACK_REQUEUE
        }

        // 정상 처리(성공/비즈니스 거절/unknown/CANCEL) → ACK
        return AckDecision.ACK
    }
}
