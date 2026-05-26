package com.example.auth.infrastructure.consul

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.springframework.boot.test.context.runner.ApplicationContextRunner
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Import
import org.springframework.web.client.RestTemplate

/**
 * [PR #30 Codex 적대적 리뷰 follow-up — Q2/C]
 *
 * 검증 대상: `ConsulRegistrar` 의
 *   `@ConditionalOnProperty(name = ["consul.enabled"], havingValue = "true", matchIfMissing = true)`
 *
 * 검증 시나리오 3종:
 *   1. `consul.enabled=true`   → 빈 등록 (운영 / Docker / 로컬 기본)
 *   2. `consul.enabled=false`  → 빈 미등록 (테스트 프로파일)
 *   3. `consul.enabled` 미설정 → 기본값 `matchIfMissing=true` 적용 → 빈 등록
 *
 * ## 왜 이 테스트가 필요한가
 * PR #30 (P1 #1 해결) 에서 `@ConditionalOnProperty` toggle 을 도입하면서
 * application-test.yml 의 `consul.enabled=false` 만으로 ConsulRegistrar 가
 * 컨텍스트에 등록되지 않는 동작에 의존하게 됐다. 누군가가 무심코 annotation
 * 의 `matchIfMissing=true` 를 떼거나 property 이름을 바꾸면 운영에서도
 * ConsulRegistrar 가 안 뜨는 사고가 가능 — 이 테스트가 그 회귀를 잠근다.
 *
 * ## 빠른 실행을 위한 Mock RestTemplate 주입
 * `ConsulRegistrar.@PostConstruct register()` 는 Consul localhost:8500 에
 * 5회 retry 를 시도하며 지수 backoff(~3초) 가 끼어 매 테스트마다 시간을
 * 잡아먹는다. ConsulRegistrar 생성자가 `RestTemplate` 매개변수에 default
 * 값을 갖지만 Spring DI 는 single constructor 의 모든 매개변수를 명시적으로
 * inject 한다 — 컨텍스트에 RestTemplate 타입의 빈이 있으면 그게 주입된다.
 * `withBean(RestTemplate, { mock(...) })` 로 Mock 을 등록하면 put() 호출이
 * Mockito 기본 동작(void 무시) 으로 즉시 끝나 retry/backoff 가 발생하지 않는다.
 */
class ConsulRegistrarConditionalTest {

    /**
     * ConsulRegistrar (@Component) 를 ApplicationContextRunner 에 노출하기 위한
     * 더미 @Configuration. @Import 가 @Component 클래스를 컨텍스트에 등록한다.
     */
    @Configuration
    @Import(ConsulRegistrar::class)
    class TestConfig

    private val contextRunner = ApplicationContextRunner()
        .withUserConfiguration(TestConfig::class.java)
        // Mock RestTemplate 주입 — register() 의 put 호출이 즉시 끝나 retry backoff 제거.
        .withBean(RestTemplate::class.java, { mock(RestTemplate::class.java) })
        .withPropertyValues(
            // ConsulRegistrar 생성자가 @Value 로 요구하는 필수 property 들.
            "consul.host=localhost",
            "consul.port=8500",
            "spring.application.name=auth-service",
        )

    @Test
    fun `consul_enabled=true 이면 ConsulRegistrar 빈이 등록된다`() {
        contextRunner
            .withPropertyValues("consul.enabled=true")
            .run { context ->
                assertThat(context).hasSingleBean(ConsulRegistrar::class.java)
            }
    }

    @Test
    fun `consul_enabled=false 이면 ConsulRegistrar 빈이 미등록된다`() {
        contextRunner
            .withPropertyValues("consul.enabled=false")
            .run { context ->
                assertThat(context).doesNotHaveBean(ConsulRegistrar::class.java)
            }
    }

    @Test
    fun `consul_enabled 미설정이면 기본값 true 가 적용되어 빈이 등록된다 (matchIfMissing)`() {
        // 이 시나리오는 application.yml 에 consul.enabled 자체를 안 적어두는
        // 운영/Docker 기본 상태를 재현. matchIfMissing=true 보호 회귀.
        contextRunner.run { context ->
            assertThat(context).hasSingleBean(ConsulRegistrar::class.java)
        }
    }
}
