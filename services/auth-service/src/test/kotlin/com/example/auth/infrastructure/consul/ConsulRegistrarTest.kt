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
}
