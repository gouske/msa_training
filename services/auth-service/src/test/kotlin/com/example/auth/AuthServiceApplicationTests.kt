package com.example.auth

import com.example.auth.infrastructure.consul.ConsulRegistrar
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.context.ApplicationContext
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
class AuthServiceApplicationTests @Autowired constructor(
    private val applicationContext: ApplicationContext,
) {

    @Test
    fun contextLoads() {
    }

    /**
     * [PR #31 / Codex 적대적 리뷰 medium finding 대응]
     *
     * `application-test.yml` 의 `consul.enabled=false` 설정이 실제로 로드되어
     * `ConsulRegistrar` 의 `@ConditionalOnProperty` 가 빈을 등록하지 않는지를
     * **실제 test profile 컨텍스트** 에서 검증.
     *
     * ## 왜 별도 단언이 필요한가
     * `ConsulRegistrarConditionalTest` 는 conditional annotation 자체의 동작은
     * 잠금하지만, "application-test.yml 에 consul.enabled 설정이 실제로 들어
     * 있는가" 라는 yml 파일 자체의 드리프트는 감지하지 못한다 (테스트 코드가
     * 직접 property 주입해서 검증하기 때문).
     *
     * 누군가 무심코 application-test.yml 에서 `consul.enabled` 줄을 삭제하거나
     * 이름을 오타로 바꿔도 ConsulRegistrar 의 matchIfMissing=true 폴백 때문에
     * 빈이 다시 등록되며, `register()` 의 graceful 실패 흡수로 contextLoads
     * 까지는 통과해 회귀를 놓치게 된다. 본 단언이 그 회귀를 잡는다.
     */
    @Test
    fun `test profile 에서는 ConsulRegistrar 빈이 미등록된다`() {
        // application-test.yml 의 consul.enabled=false 가 정상 적용되면 빈 0개.
        // 만약 yml 에서 해당 설정이 사라지면 matchIfMissing=true 로 빈 1개가 등록되어
        // 이 단언이 실패한다 — yml 드리프트 회귀 차단.
        val consulRegistrarBeans = applicationContext.getBeansOfType(ConsulRegistrar::class.java)
        assertThat(consulRegistrarBeans)
            .`as`("application-test.yml 의 consul.enabled=false 가 실제로 로드되어야 한다")
            .isEmpty()
    }

}
