package com.example.auth.infrastructure.consul

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import org.springframework.web.client.RestTemplate

class ConsulRegistrarTest {

    private lateinit var mockConsul: MockWebServer
    private lateinit var registrar: ConsulRegistrar

    @BeforeEach
    fun setUp() {
        mockConsul = MockWebServer().apply { start() }
        registrar = ConsulRegistrar(
            consulHost = mockConsul.hostName,
            consulPort = mockConsul.port,
            servicePort = 8080,
            serviceName = "auth-service",
            healthPath = "/actuator/health",
            restTemplate = RestTemplate(),
        )
    }

    @AfterEach
    fun tearDown() {
        mockConsul.shutdown()
    }

    @Test
    fun `register는 PUT을 올바른 페이로드로 호출한다`() {
        // GIVEN
        mockConsul.enqueue(MockResponse().setResponseCode(200))

        // WHEN
        registrar.register()

        // THEN
        val req: RecordedRequest = mockConsul.takeRequest()
        assertEquals("PUT", req.method)
        assertEquals("/v1/agent/service/register", req.path)
        val body = req.body.readUtf8()
        assertTrue(body.contains("\"Name\":\"auth-service\""))
        assertTrue(body.contains("\"Port\":8080"))
        assertTrue(body.contains("\"HTTP\":\"http://"))
        assertTrue(body.contains("/actuator/health\""))
        assertTrue(body.contains("\"Interval\":\"10s\""))
        assertTrue(body.contains("\"DeregisterCriticalServiceAfter\":\"30s\""))
    }

    @Test
    fun `Consul 다운 시 register는 5회 재시도 후 예외 던지지 않는다`() {
        // GIVEN: 5회 모두 500
        repeat(5) { mockConsul.enqueue(MockResponse().setResponseCode(500)) }

        // WHEN + THEN: 예외 안 던짐 (서비스 부팅은 성공해야)
        assertDoesNotThrow { registrar.register() }
        assertEquals(5, mockConsul.requestCount)
    }

    @Test
    fun `deregister는 service-id로 PUT 호출한다`() {
        // GIVEN
        mockConsul.enqueue(MockResponse().setResponseCode(200)) // register
        mockConsul.enqueue(MockResponse().setResponseCode(200)) // deregister
        registrar.register()
        mockConsul.takeRequest() // register 소비

        // WHEN
        registrar.deregister()

        // THEN
        val req = mockConsul.takeRequest()
        assertEquals("PUT", req.method)
        assertTrue(req.path!!.startsWith("/v1/agent/service/deregister/auth-service-"))
    }

    @Test
    fun `register 두 번 호출해도 같은 ID로 PUT (멱등성)`() {
        // GIVEN
        mockConsul.enqueue(MockResponse().setResponseCode(200))
        mockConsul.enqueue(MockResponse().setResponseCode(200))

        // WHEN
        registrar.register()
        registrar.register()

        // THEN
        val first = mockConsul.takeRequest().body.readUtf8()
        val second = mockConsul.takeRequest().body.readUtf8()
        // 같은 ID 사용 (호스트/포트 동일)
        val firstId = Regex("\"ID\":\"([^\"]+)\"").find(first)!!.groupValues[1]
        val secondId = Regex("\"ID\":\"([^\"]+)\"").find(second)!!.groupValues[1]
        assertEquals(firstId, secondId)
    }

    @Test
    fun `consul_service_address override 가 있으면 주소가 덮어쓰여진다`() {
        // GIVEN: overrideAddress 를 "auth-service" (docker-compose 서비스명) 로 직접 주입
        val customRegistrar = ConsulRegistrar(
            consulHost = mockConsul.hostName,
            consulPort = mockConsul.port,
            servicePort = 8080,
            serviceName = "auth-service",
            healthPath = "/actuator/health",
            overrideAddress = "auth-service",
            restTemplate = RestTemplate(),
        )
        mockConsul.enqueue(MockResponse().setResponseCode(200))

        // WHEN
        customRegistrar.register()

        // THEN: 페이로드의 Address 가 "auth-service"
        val body = mockConsul.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"Address\":\"auth-service\""))
        assertTrue(body.contains("\"HTTP\":\"http://auth-service:8080/actuator/health\""))
        // service-id 도 override 주소를 포함
        assertTrue(body.contains("\"ID\":\"auth-service-auth-service-8080\""))
    }

    // ──────────────────────────────────────────────────────────────────────
    // [K8s + Consul 회고] Downward API 로 주입된 POD_IP / POD_NAME 시나리오.
    //
    // 기존 결함:
    //   K8s replicas=2 환경에서 두 Pod 모두 CONSUL_SERVICE_ADDRESS="auth-service" 로
    //   동일 serviceId 등록 → 한 Pod 의 @PreDestroy deregister 가 다른 Pod 도 사라지게 만듦.
    //
    // 해결:
    //   POD_IP   → Consul Address (인스턴스 단위 헬스 체크 도달)
    //   POD_NAME → serviceId 의 인스턴스 키 (replica 마다 유니크)
    //
    // 회귀 차단:
    //   아래 3개 테스트가 우선순위 체인과 결함 시나리오를 모두 잠근다.
    // ──────────────────────────────────────────────────────────────────────

    @Test
    fun `POD_IP 가 있으면 Address 는 POD_IP 가 되고 overrideAddress 보다 우선한다`() {
        // GIVEN: K8s 환경처럼 POD_IP 가 주입되고, overrideAddress 도 같이 있는 상황
        val k8sRegistrar = ConsulRegistrar(
            consulHost = mockConsul.hostName,
            consulPort = mockConsul.port,
            servicePort = 8080,
            serviceName = "auth-service",
            healthPath = "/api/auth/health",
            overrideAddress = "auth-service",     // 무시되어야 함 (POD_IP 가 우선)
            podIp = "10.244.0.42",
            restTemplate = RestTemplate(),
        )
        mockConsul.enqueue(MockResponse().setResponseCode(200))

        // WHEN
        k8sRegistrar.register()

        // THEN: Address 는 POD_IP, 헬스 체크 URL 도 POD_IP 로 도달
        val body = mockConsul.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"Address\":\"10.244.0.42\""), body)
        assertTrue(body.contains("\"HTTP\":\"http://10.244.0.42:8080/api/auth/health\""), body)
    }

    @Test
    fun `POD_NAME 이 다른 두 Pod 은 서로 다른 serviceId 로 등록된다 (충돌 결함 회귀 차단)`() {
        // GIVEN: K8s replicas=2 처럼 POD_IP/POD_NAME 이 다른 두 인스턴스
        val pod1 = ConsulRegistrar(
            consulHost = mockConsul.hostName,
            consulPort = mockConsul.port,
            servicePort = 8080,
            serviceName = "auth-service",
            healthPath = "/api/auth/health",
            podIp = "10.244.0.42",
            podName = "auth-service-deadbeef-x12k9",
            restTemplate = RestTemplate(),
        )
        val pod2 = ConsulRegistrar(
            consulHost = mockConsul.hostName,
            consulPort = mockConsul.port,
            servicePort = 8080,
            serviceName = "auth-service",
            healthPath = "/api/auth/health",
            podIp = "10.244.0.43",
            podName = "auth-service-deadbeef-y77m2",
            restTemplate = RestTemplate(),
        )
        mockConsul.enqueue(MockResponse().setResponseCode(200))
        mockConsul.enqueue(MockResponse().setResponseCode(200))

        // WHEN: 두 Pod 모두 등록
        pod1.register()
        pod2.register()

        // THEN: 두 등록 요청의 serviceId 가 서로 다르다
        val body1 = mockConsul.takeRequest().body.readUtf8()
        val body2 = mockConsul.takeRequest().body.readUtf8()
        val id1 = Regex("\"ID\":\"([^\"]+)\"").find(body1)!!.groupValues[1]
        val id2 = Regex("\"ID\":\"([^\"]+)\"").find(body2)!!.groupValues[1]
        assertEquals("auth-service-auth-service-deadbeef-x12k9-8080", id1)
        assertEquals("auth-service-auth-service-deadbeef-y77m2-8080", id2)
        assertTrue(id1 != id2, "두 Pod 의 serviceId 가 달라야 한다 — replica ID 충돌 결함의 회귀 차단")
    }

    @Test
    fun `POD_IP·POD_NAME 둘 다 없으면 Docker Compose 기존 fallback 이 그대로 동작한다`() {
        // GIVEN: Docker Compose 환경처럼 POD_IP/POD_NAME 부재, overrideAddress 만 있음
        val composeRegistrar = ConsulRegistrar(
            consulHost = mockConsul.hostName,
            consulPort = mockConsul.port,
            servicePort = 8080,
            serviceName = "auth-service",
            healthPath = "/api/auth/health",
            overrideAddress = "auth-service",  // docker-compose 의 hostname
            restTemplate = RestTemplate(),
        )
        mockConsul.enqueue(MockResponse().setResponseCode(200))

        // WHEN
        composeRegistrar.register()

        // THEN: 기존 동작 그대로 — overrideAddress 가 Address/Id 에 그대로 들어간다
        val body = mockConsul.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"Address\":\"auth-service\""), body)
        assertTrue(body.contains("\"ID\":\"auth-service-auth-service-8080\""), body)
    }
}
