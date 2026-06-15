package com.example.auth.points.messaging

import com.example.auth.points.domain.PointPort
import com.example.auth.points.domain.PointsDeclinedError
import com.example.auth.points.messaging.PointsContracts.MSG
import com.example.auth.points.messaging.PointsContracts.STEP
import com.fasterxml.jackson.databind.ObjectMapper
import org.slf4j.LoggerFactory
import org.springframework.dao.DataIntegrityViolationException

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

    companion object {
        /** 단일 명령당 포인트 상한 — 원장 오버플로/남용을 막는 sanity bound. */
        const val MAX_POINTS_AMOUNT = 10_000_000L
    }

    /** 필수 필드 누락 등 재처리 불가한 메시지를 표시하는 내부 예외. */
    private class MalformedCommandException(message: String) : RuntimeException(message)

    /**
     * payload 에서 userEmail/amount 를 꺼내며 서비스 경계에서 무결성을 검증한다.
     * 위반(공백 이메일/정수 아님/0 이하/상한 초과/누락)은 malformed → DLQ 로 격리한다(F2).
     */
    private fun extractUserEmailAndAmount(payload: Map<String, Any?>): Pair<String, Long> {
        val userEmail = (payload["userEmail"] as? String)?.takeIf { it.isNotBlank() }
            ?: throw MalformedCommandException("payload.userEmail 누락/공백")
        val amountNumber = payload["amount"] as? Number
            ?: throw MalformedCommandException("payload.amount 누락")
        val amount = amountNumber.toLong()
        // 소수/비정수 거부 (예: 10.5 가 toLong() 으로 10 으로 절단되는 것 방지)
        if (amountNumber.toDouble() != amount.toDouble()) {
            throw MalformedCommandException("payload.amount 가 정수가 아님: $amountNumber")
        }
        if (amount <= 0) throw MalformedCommandException("payload.amount 가 양수가 아님: $amount")
        if (amount > MAX_POINTS_AMOUNT) throw MalformedCommandException("payload.amount 가 상한 초과: $amount")
        return userEmail to amount
    }

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
                    val (userEmail, amount) = extractUserEmailAndAmount(payload)
                    val balance = pointPort.earn(sagaId, stepName, userEmail, amount)
                    log.info("✨ 포인트 적립 sagaId={} balance={} correlationId={}", sagaId, balance, correlationId)
                    reply(MSG.POINTS_SUCCEEDED, mapOf("balance" to balance))
                }

                MSG.CANCEL -> {
                    val (userEmail, amount) = extractUserEmailAndAmount(payload)
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
        } catch (e: DataIntegrityViolationException) {
            // 중복 명령(at-least-once outbox 재발행) — 다른 트랜잭션이 이미 같은 idempotency_key 로 처리.
            // 충돌 트랜잭션은 롤백됐으므로 멱등 성공으로 간주한다(재시도 루프 방지).
            //
            // 가정/한계: 현재 auth 는 단일 인스턴스 + 리스너 concurrency=1(순차 처리)이라
            //   point_transactions.idempotency_key UNIQUE 충돌만 이 경로로 들어온다(순차라 사실상 드묾).
            //   향후 멀티 consumer 로 확장하면 "동시 신규 사용자 EARN"의 point_balance PK 충돌도
            //   같은 예외가 되어 잘못된 멱등 성공으로 적립이 누락될 수 있다 → 그때는 point_balance
            //   생성을 원자적 upsert 로 바꿔 PK 충돌 자체를 없애는 것이 정석(설계 §17.7 알려진 한계).
            log.info("♻️ 중복 명령(멱등 성공) sagaId={} type={}", sagaId, type)
            if (type == MSG.EARN) reply(MSG.POINTS_SUCCEEDED, mapOf("idempotent" to true))
            // CANCEL 은 reply 없이 ACK (기존 비대칭 유지)
        } catch (e: Exception) {
            // 인프라 장애(DB/네트워크 등) — 일시적일 수 있으므로 재시도. reply 는 보내지 않는다.
            log.error("🚨 인프라 오류 — 재시도 sagaId={}: {}", sagaId, e.message)
            return AckDecision.NACK_REQUEUE
        }

        // 정상 처리(성공/비즈니스 거절/unknown/CANCEL) → ACK
        return AckDecision.ACK
    }
}
