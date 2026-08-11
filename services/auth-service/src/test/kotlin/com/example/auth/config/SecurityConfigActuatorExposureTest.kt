package com.example.auth.config

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.actuate.observability.AutoConfigureObservability
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.client.TestRestTemplate
import org.springframework.boot.test.web.server.LocalManagementPort
import org.springframework.http.HttpStatus
import org.springframework.test.context.ActiveProfiles
import org.springframework.test.context.TestPropertySource

/**
 * [Codex adversarial review (PR #50) high finding 대응]
 *
 * ## 무엇을 잠그는가
 * 403 수정의 1차 구현은 `EndpointRequest.toAnyEndpoint()` 전체에 permitAll 을 걸었다.
 * 그 상태에서는 **노출 목록(`management.endpoints.web.exposure.include`)이 넓어지는 순간**
 * `env` · `beans` · `configprops` · `heapdump` 같은 민감 엔드포인트까지 익명 접근이 열린다.
 * 즉 보안 경계가 "포트 분리" 한 겹뿐이고, Security 체인은 아무 방어도 하지 않는 상태였다.
 *
 * ## 왜 별도 테스트 클래스인가
 * `SecurityConfigActuatorTest` 는 운영 기본 노출(health, prometheus)에서의 동작을 검증한다.
 * 그 구성에서는 `/actuator/env` 가 애초에 매핑되지 않아 404 이므로, permitAll 과 denyAll 을
 * 구분하지 못한다 — 이 회귀를 잡으려면 **노출 목록을 의도적으로 넓힌 컨텍스트**가 필요하다.
 * 그래서 이 클래스만 exposure 를 확장해 띄운다 (운영 설정은 건드리지 않는다).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
@AutoConfigureObservability
@TestPropertySource(properties = [
    // 운영과 동일한 management 자식 컨텍스트 구조 재현 (application-test.yml 은 -1 로 꺼둠).
    "management.server.port=0",
    // [핵심] 누군가 디버깅 목적으로 노출 목록을 넓힌 상황을 시뮬레이션.
    // Security 체인이 허용 목록을 강제하지 않으면 아래 민감 엔드포인트가 그대로 열린다.
    "management.endpoints.web.exposure.include=health,prometheus,env,beans,configprops",
])
class SecurityConfigActuatorExposureTest {

    @LocalManagementPort
    private var managementPort: Int = 0

    @Autowired
    private lateinit var restTemplate: TestRestTemplate

    private fun managementUrl(path: String) = "http://localhost:$managementPort$path"

    /**
     * 노출 목록이 넓어져도 scrape 에 필요한 두 엔드포인트만 익명 허용되어야 한다.
     */
    @ParameterizedTest
    @ValueSource(strings = ["/actuator/health", "/actuator/prometheus"])
    fun `허용 목록 엔드포인트는 인증 없이 200 을 반환한다`(path: String) {
        val response = restTemplate.getForEntity(managementUrl(path), String::class.java)

        assertThat(response.statusCode)
            .`as`("$path 는 Prometheus scrape / 헬스체크 경로이므로 익명 허용되어야 한다")
            .isEqualTo(HttpStatus.OK)
    }

    /**
     * 허용 목록 밖 엔드포인트는 노출되어 있더라도 Security 체인이 거부해야 한다.
     * (1차 구현의 toAnyEndpoint + permitAll 에서는 200 으로 통과 → 이 테스트가 실패한다.)
     */
    @ParameterizedTest
    @ValueSource(strings = ["/actuator/env", "/actuator/beans", "/actuator/configprops"])
    fun `허용 목록 밖 Actuator 엔드포인트는 무인증 200 을 반환하지 않는다`(path: String) {
        val response = restTemplate.getForEntity(managementUrl(path), String::class.java)

        assertThat(response.statusCode)
            .`as`("$path 는 노출되어 있어도 Security 체인이 막아야 한다 (포트 분리에만 의존하지 않는다)")
            .isIn(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
    }

    /**
     * 경로 접미사로 허용 매처를 우회할 수 없어야 한다.
     * `/actuator/env/{name}` 같은 하위 경로도 동일하게 거부 대상이다.
     */
    @Test
    fun `허용 목록 밖 엔드포인트의 하위 경로도 거부된다`() {
        val response = restTemplate.getForEntity(managementUrl("/actuator/env/java.version"), String::class.java)

        assertThat(response.statusCode)
            .isIn(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
    }
}
