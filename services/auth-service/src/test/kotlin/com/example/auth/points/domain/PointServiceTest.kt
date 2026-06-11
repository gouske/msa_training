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

    @Test
    fun `취소하면 적립했던 포인트가 차감되고 CANCEL이 원장에 기록된다`() {
        pointService.earn("saga-1", "T3_POINTS", "user@test.com", 100)

        pointService.cancel("saga-1", "T3_POINTS", "user@test.com", 100)

        assertEquals(0, balanceRepo.findById("user@test.com").get().balance)
        assertEquals(2, txRepo.count()) // EARN + CANCEL
    }

    @Test
    fun `같은 취소 명령이 중복돼도 한 번만 차감된다`() {
        pointService.earn("saga-1", "T3_POINTS", "user@test.com", 100)

        pointService.cancel("saga-1", "T3_POINTS", "user@test.com", 100)
        pointService.cancel("saga-1", "T3_POINTS", "user@test.com", 100)

        assertEquals(0, balanceRepo.findById("user@test.com").get().balance)
        assertEquals(2, txRepo.count()) // CANCEL 은 한 번만
    }

    @Test
    fun `적립 이력이 없는 사용자 취소는 안전한 no-op이다`() {
        pointService.cancel("saga-x", "T3_POINTS", "ghost@test.com", 100)

        assertEquals(0, txRepo.count())
        assertEquals(false, balanceRepo.findById("ghost@test.com").isPresent)
    }

    @Test
    fun `적립되지 않은 saga의 취소는 기존 잔액을 건드리지 않는다`() {
        // 다른 saga로 잔액 200 확보
        pointService.earn("saga-earned", "T3_POINTS", "user@test.com", 200)

        // EARN 이력이 없는 다른 saga의 취소가 도착
        pointService.cancel("saga-no-earn", "T3_POINTS", "user@test.com", 100)

        assertEquals(200, balanceRepo.findById("user@test.com").get().balance) // 잔액 불변
        assertEquals(1, txRepo.count()) // CANCEL 미기록(EARN 1건만)
    }

    @Test
    fun `EARN 금액과 다른 금액의 취소는 no-op이다`() {
        pointService.earn("saga-1", "T3_POINTS", "user@test.com", 100)

        pointService.cancel("saga-1", "T3_POINTS", "user@test.com", 50) // 금액 불일치

        assertEquals(100, balanceRepo.findById("user@test.com").get().balance) // 불변
        assertEquals(1, txRepo.count()) // CANCEL 미기록
    }

    @Test
    fun `0 이하 금액 적립은 IllegalArgumentException`() {
        assertFailsWith<IllegalArgumentException> {
            pointService.earn("saga-1", "T3_POINTS", "user@test.com", 0)
        }
    }
}
