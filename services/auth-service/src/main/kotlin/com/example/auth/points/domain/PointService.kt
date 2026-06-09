package com.example.auth.points.domain

import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.LocalDateTime

/**
 * 포인트 도메인 서비스. 적립/취소를 멱등하게 처리한다(25강 핵심: 명령 재전송에도 정확히 한 번).
 *
 * 멱등 전략:
 *   - point_transactions.idempotency_key(UNIQUE)에 이미 같은 키가 있으면 부수효과 없이 종료.
 *   - 동시성(같은 명령 병렬 수신) 강화(CAS/단계별 idempotency)는 Phase 4 로 이연(설계 §14 L3).
 */
@Service
class PointService(
    private val balanceRepo: PointBalanceRepository,
    private val txRepo: PointTransactionRepository,
) : PointPort {

    @Transactional
    override fun earn(sagaId: String, stepName: String, userEmail: String, amount: Long): Long {
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
        TODO("Task 4 에서 구현")
    }

    private fun earnKey(sagaId: String, stepName: String): String = "$sagaId:$stepName"
}
