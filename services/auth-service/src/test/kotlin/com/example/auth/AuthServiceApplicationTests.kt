package com.example.auth

import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.test.context.ActiveProfiles

/**
 * Spring 컨텍스트가 정상적으로 로드되는지 검증하는 가장 가벼운 통합 테스트.
 *
 * [P1 #1 / @SpringBootTest PostgreSQL 의존 분리]
 * @ActiveProfiles("test") 가 src/test/resources/application-test.yml 을 활성화하여:
 *   - 운영 PostgreSQL 대신 H2 in-memory 잡음 → DB 미가동 환경에서도 통과
 *   - consul.enabled=false → ConsulRegistrar 미등록 → Consul 호출 시도 없음
 *   - management.server.port=-1 → Actuator 별도 포트 비활성 → 포트 충돌 없음
 */
@SpringBootTest
@ActiveProfiles("test")
class AuthServiceApplicationTests {

    @Test
    fun contextLoads() {
    }

}
