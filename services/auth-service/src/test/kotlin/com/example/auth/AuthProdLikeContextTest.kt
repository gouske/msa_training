package com.example.auth

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.context.TestPropertySource
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers

/**
 * [PR #30 Codex 적대적 리뷰 follow-up — Q1/A]
 *
 * 운영 `application.yml` 의 PostgreSQL DataSource / JPA dialect / 스키마 생성
 * 경로가 실제 PostgreSQL 15 에서 정상 동작하는지 검증하는 **prod-like 컨텍스트
 * 로딩 테스트**.
 *
 * 기존 가벼운 H2 contextLoads (`AuthServiceApplicationTests`) 는 그대로 유지하고,
 * 이 테스트가 운영 PG 와 동일한 엔진으로 한 번 더 검증한다. 두 입장의 안전망:
 *   - H2: Docker 없이도 통과 → 진입 장벽 ↓
 *   - PG: 운영 환경 정확성 보장 → 배포 신뢰도 ↑
 *
 * ## 실행 방법 (Q3/E — 명시적 opt-in)
 *
 * 기본적으로 `./gradlew test` 에서는 **자동 skip** 된다. 환경 변수 `RUN_PROD_LIKE_TESTS=true`
 * 가 명시되어 있을 때만 실행. 이유:
 *   - Testcontainers 의 `@Testcontainers(disabledWithoutDocker = true)` 가 macOS
 *     Docker Desktop 의 비표준 socket 경로(`~/.docker/run/docker.sock`)를 신뢰성
 *     있게 감지하지 못해, "Docker 가 켜져있어도 skip" 되는 false negative 가 발생.
 *   - JUnit 5 의 `@BeforeAll Assumptions.assumeTrue` 는 `@Container.start()` 보다
 *     늦게 호출되어 timing 보호가 불완전.
 *   - `@EnabledIfEnvironmentVariable` 은 `evaluateExecutionCondition` 단계에서
 *     평가되어 `@Container` 시작 전에 안전하게 skip/run 분기를 결정한다.
 *
 * 로컬 검증:
 * ```bash
 * RUN_PROD_LIKE_TESTS=true ./gradlew test --tests "com.example.auth.AuthProdLikeContextTest"
 * ```
 *
 * CI 에서는 workflow 의 env 섹션에 `RUN_PROD_LIKE_TESTS: true` 추가 (별도 PR 로
 * `.github/workflows/<name>.yml` 에 적용 예정).
 *
 * ## ConsulRegistrar 격리 (Q2/C 결정)
 * 이 테스트는 PG 만 검증한다 — `consul.enabled=false` 로 `ConsulRegistrar` 빈
 * 자체를 제외해 Consul 호출 시도가 발생하지 않도록 한다. `ConsulRegistrar` 의
 * `@ConditionalOnProperty` 동작은 `ConsulRegistrarConditionalTest` 에서 별도 보장.
 *
 * ## JWT 시크릿
 * 운영 시크릿 노출 방지 + 컨텍스트 부팅만 검증하면 충분하므로 더미 32바이트+ 값
 * 을 `@TestPropertySource` 로 주입.
 */
@SpringBootTest
@Testcontainers
@EnabledIfEnvironmentVariable(
    named = "RUN_PROD_LIKE_TESTS",
    matches = "true",
    disabledReason = "Docker + Testcontainers 가 필요한 prod-like 테스트. " +
        "RUN_PROD_LIKE_TESTS=true 환경변수로 명시 opt-in 시에만 실행.",
)
@TestPropertySource(properties = [
    // ConsulRegistrar 격리 — PG 만 검증.
    "consul.enabled=false",
    // Actuator 별도 management 포트 비활성 — 동일 테스트 클래스 내 충돌 방지.
    "management.server.port=-1",
    // JWT HS256 키 길이 제약(32 바이트 이상) 만족하는 더미값.
    "jwt.secret=prod-like-test-secret-key-must-be-at-least-32-bytes-1234567890",
])
class AuthProdLikeContextTest {

    companion object {
        /**
         * 운영과 동일 메이저 버전 (PostgreSQL 15) 컨테이너.
         * `@JvmStatic` + `@Container` 조합으로 클래스당 한 번만 시작/종료된다.
         */
        @Container
        @JvmStatic
        val postgres: PostgreSQLContainer<*> = PostgreSQLContainer("postgres:15")
            .withDatabaseName("auth_prod_like")
            .withUsername("test")
            .withPassword("test")

        /**
         * 컨테이너의 동적 URL/계정을 Spring `Environment` 에 주입.
         * 운영 `application.yml` 의 `spring.datasource.*` 를 override 한다.
         * `ddl-auto=update` 는 운영값 그대로 — 실제 PG 에서 users 테이블 생성을 검증.
         */
        @DynamicPropertySource
        @JvmStatic
        fun configure(registry: DynamicPropertyRegistry) {
            registry.add("spring.datasource.url", postgres::getJdbcUrl)
            registry.add("spring.datasource.username", postgres::getUsername)
            registry.add("spring.datasource.password", postgres::getPassword)
        }

    }

    /**
     * 운영용 `application.yml` + PostgreSQL 15 컨테이너로 전체 Spring 컨텍스트가
     * 정상 부팅되는지 확인. 실 DB 방언 / Hikari 풀 / JPA 스키마 생성 / 모든 빈 와이어링
     * 까지 한 번에 검증.
     *
     * 본문 비어있어도 OK — `@SpringBootTest` 자체가 컨텍스트 로드를 시도하며,
     * 어떤 빈 생성이라도 실패하면 이 테스트가 ERROR 로 떨어진다.
     */
    @Test
    fun `운영 application_yml 로 PostgreSQL 컨테이너에 정상 부팅된다`() {
    }
}
