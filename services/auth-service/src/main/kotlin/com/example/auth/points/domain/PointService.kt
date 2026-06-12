package com.example.auth.points.domain

import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.LocalDateTime

/**
 * 포인트 도메인 서비스. 적립/취소를 멱등하게 처리한다(25강 핵심: 명령 재전송에도 정확히 한 번).
 *
 * 멱등 전략:
 *   - point_transactions.idempotency_key(UNIQUE)에 이미 같은 키가 있으면 부수효과 없이 종료.
 *   - CANCEL 은 같은 saga 의 EARN 원장이 있고 userEmail/amount 가 일치할 때만 보상한다(stale/out-of-order 방어).
 *   - 동시성(같은 명령 병렬 수신) 강화(CAS/단계별 idempotency)는 Phase 4 로 이연(설계 §14 L3).
 */
@Service
class PointService(
    private val balanceRepo: PointBalanceRepository,
    private val txRepo: PointTransactionRepository,
) : PointPort {

    @Transactional
    override fun earn(sagaId: String, stepName: String, userEmail: String, amount: Long): Long {
        require(amount > 0) { "적립 금액은 양수여야 합니다: $amount" }
        val idemKey = earnKey(sagaId, stepName)

        // 멱등: 이미 처리한 명령이면 부수효과 없이 현재 잔액을 반환한다.
        if (txRepo.findByIdempotencyKey(idemKey) != null) {
            return balanceRepo.findById(userEmail).map { it.balance }.orElse(0L)
        }

        // 잔액 계정이 없으면 ACTIVE 로 생성(신규 사용자는 적립 가능).
        val balance = balanceRepo.findById(userEmail)
            .orElseGet { balanceRepo.save(PointBalance(userEmail = userEmail)) }

        // 비즈니스 거절: 정지 계정에는 적립하지 않는다.
        if (balance.status == PointAccountStatus.SUSPENDED) {
            throw PointsDeclinedError("정지된 계정에는 포인트를 적립할 수 없습니다: $userEmail")
        }

        balance.balance += amount
        balance.updatedAt = LocalDateTime.now()
        balanceRepo.save(balance)
        txRepo.save(
            PointTransaction(
                userEmail = userEmail,
                amount = amount,
                type = PointTransactionType.EARN,
                idempotencyKey = idemKey,
            ),
        )
        return balance.balance
    }

    @Transactional
    override fun cancel(sagaId: String, stepName: String, userEmail: String, amount: Long) {
        require(amount > 0) { "취소 금액은 양수여야 합니다: $amount" }
        val cancelIdem = cancelKey(sagaId, stepName)

        // 멱등: 이미 취소한 명령이면 아무것도 하지 않는다.
        if (txRepo.findByIdempotencyKey(cancelIdem) != null) return

        // 보상 대상 EARN 원장이 실제로 있어야만 취소한다(stale/out-of-order/무관 CANCEL 방어).
        // 없으면 보상할 적립이 없으므로 원장·잔액 모두 건드리지 않는다.
        val earnTx = txRepo.findByIdempotencyKey(earnKey(sagaId, stepName)) ?: return

        // EARN 원장과 userEmail/amount 가 일치하지 않으면 보상하지 않는다(잘못된 차감 방지).
        if (earnTx.userEmail != userEmail || earnTx.amount != amount) return

        val balance = balanceRepo.findById(userEmail).orElse(null) ?: return

        // 의미적 취소: 적립분을 차감(음수 방지).
        balance.balance = (balance.balance - amount).coerceAtLeast(0L)
        balance.updatedAt = LocalDateTime.now()
        balanceRepo.save(balance)
        txRepo.save(
            PointTransaction(
                userEmail = userEmail,
                amount = amount,
                type = PointTransactionType.CANCEL,
                idempotencyKey = cancelIdem,
            ),
        )
    }

    private fun earnKey(sagaId: String, stepName: String): String = "$sagaId:$stepName"

    private fun cancelKey(sagaId: String, stepName: String): String = "$sagaId:$stepName:CANCEL"
}
