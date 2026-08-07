package com.example.auth.config

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.actuate.observability.AutoConfigureObservability
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.client.TestRestTemplate
import org.springframework.boot.test.web.server.LocalManagementPort
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.http.HttpStatus
import org.springframework.test.context.ActiveProfiles
import org.springframework.test.context.TestPropertySource

/**
 * [관측성 검증(2026-08-07)에서 발견된 403 버그 회귀 테스트]
 *
 * ## 무엇이 깨져 있었나
 * 운영 구성은 Actuator 를 별도 management 포트(9081)로 분리하고, SecurityConfig 는
 * "management 포트는 SecurityFilterChain 에 닿지 않는다"고 가정했다. 그러나 Spring Boot 는
 * management **자식 컨텍스트에도** springSecurityFilterChain 을 등록하므로, 비즈니스 체인의
 * `anyRequest().authenticated()` 가 `/actuator/prometheus` · `/actuator/health` 까지 차단했다.
 * 결과: Prometheus scrape 가 403 으로 전 기간 실패 (타깃 DOWN).
 *
 * ## 이 테스트가 잠그는 것
 * MockMvc(메인 컨텍스트만) 로는 이 버그를 재현할 수 없다. 그래서 RANDOM_PORT 로
 * **실제 management 자식 컨텍스트를 기동**해 운영과 동일한 포트 분리 구조에서 검증한다:
 *   1. management 포트의 /actuator/prometheus 는 인증 없이 200 + 메트릭 본문
 *   2. management 포트의 /actuator/health 는 인증 없이 200
 *   3. 비즈니스 포트의 보호 경로는 여전히 인증 요구 (actuator 체인이 과도 개방하지 않음)
 *   4. 비즈니스 포트에서는 actuator 가 열리지 않음 (포트 분리 경계 유지)
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
// @SpringBootTest 는 기본으로 메트릭 export 를 끈다 → PrometheusMeterRegistry 미생성
// → prometheus 엔드포인트가 등록되지 않아 EndpointRequest 매처에 안 걸린다.
// 운영과 동일하게 endpoint 를 띄워 검증하기 위해 observability 를 켠다.
@AutoConfigureObservability
@TestPropertySource(properties = [
    // application-test.yml 은 포트 충돌 방지를 위해 management 서버를 끈다(-1).
    // 이 테스트만 랜덤 포트(0)로 다시 켜서 운영과 동일한 자식 컨텍스트 구조를 재현한다.
    "management.server.port=0",
])
class SecurityConfigActuatorTest {

    @LocalServerPort
    private var businessPort: Int = 0

    @LocalManagementPort
    private var managementPort: Int = 0

    @Autowired
    private lateinit var restTemplate: TestRestTemplate

    private fun managementUrl(path: String) = "http://localhost:$managementPort$path"

    private fun businessUrl(path: String) = "http://localhost:$businessPort$path"

    @Test
    fun `management 포트의 actuator prometheus 는 인증 없이 200 과 메트릭 본문을 반환한다`() {
        val response = restTemplate.getForEntity(managementUrl("/actuator/prometheus"), String::class.java)

        assertThat(response.statusCode)
            .`as`("Prometheus scrape 경로가 Security 체인에 막히면 안 된다 (버그 재현 시 403)")
            .isEqualTo(HttpStatus.OK)
        // 상태 코드만으로는 로그인 페이지 등 200 응답과 구분이 안 되므로 본문 형식까지 확인.
        assertThat(response.body).contains("# HELP")
    }

    @Test
    fun `management 포트의 actuator health 는 인증 없이 200 을 반환한다`() {
        val response = restTemplate.getForEntity(managementUrl("/actuator/health"), String::class.java)

        assertThat(response.statusCode).isEqualTo(HttpStatus.OK)
        assertThat(response.body).contains("UP")
    }

    @Test
    fun `비즈니스 포트의 보호 경로는 여전히 인증을 요구한다`() {
        // actuator 전용 permitAll 체인이 비즈니스 API 까지 개방해버리는 회귀를 차단.
        val response = restTemplate.getForEntity(businessUrl("/api/protected/anything"), String::class.java)

        assertThat(response.statusCode)
            .`as`("화이트리스트 외 경로는 인증 없이는 거부되어야 한다")
            .isIn(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
    }

    @Test
    fun `비즈니스 포트에서는 actuator 가 노출되지 않는다`() {
        // 포트 분리 보안 경계: 메인 컨텍스트에는 actuator 매핑이 없어야 한다.
        val response = restTemplate.getForEntity(businessUrl("/actuator/prometheus"), String::class.java)

        assertThat(response.statusCode)
            .`as`("비즈니스 포트로는 메트릭이 절대 200 으로 열리면 안 된다")
            .isIn(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND)
    }
}
