package com.example.auth.points.domain

import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest
import org.springframework.context.annotation.Import
import org.springframework.test.context.ActiveProfiles
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/**
 * PointService 의 멱등 적립과 정지 계정 거절을 검증한다.
 * @DataJpaTest 는 JPA 슬라이스만 띄우므로 AMQP/RabbitMQ 와 무관하게 빠르게 돈다(H2, test 프로파일).
 */
@DataJpaTest
@Import(PointService::class)
@ActiveProfiles("test")
class PointServiceTest @Autowired constructor(
    private val pointService: PointService,
    private val balanceRepo: PointBalanceRepository,
    private val txRepo: PointTransactionRepository,
) {
    @Test
    fun `신규 사용자에게 적립하면 잔액이 증가하고 원장에 EARN이 기록된다`() {
        val balance = pointService.earn("saga-1", "T3_POINTS", "user@test.com", 100)

        assertEquals(100, balance)
        assertEquals(100, balanceRepo.findById("user@test.com").get().balance)
        assertEquals(1, txRepo.count())
    }

    @Test
    fun `같은 sagaId·stepName 적립 명령이 중복돼도 한 번만 적립된다`() {
        pointService.earn("saga-1", "T3_POINTS", "user@test.com", 100)
        val secondBalance = pointService.earn("saga-1", "T3_POINTS", "user@test.com", 100)

        assertEquals(100, secondBalance) // 두 번째는 부수효과 없이 현재 잔액 반환
        assertEquals(100, balanceRepo.findById("user@test.com").get().balance)
        assertEquals(1, txRepo.count()) // 원장 기록도 한 번뿐
    }

    @Test
    fun `정지된 계정에 적립하면 PointsDeclinedError를 던지고 잔액을 바꾸지 않는다`() {
        balanceRepo.save(PointBalance(userEmail = "suspended@test.com", status = PointAccountStatus.SUSPENDED))

        assertFailsWith<PointsDeclinedError> {
            pointService.earn("saga-2", "T3_POINTS", "suspended@test.com", 100)
        }
        assertEquals(0, balanceRepo.findById("suspended@test.com").get().balance)
        assertEquals(0, txRepo.count())
    }
}
