package com.example.auth.infrastructure.consul

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import jakarta.annotation.PostConstruct
import jakarta.annotation.PreDestroy
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.boot.web.client.RestTemplateBuilder
import org.springframework.stereotype.Component
import org.springframework.web.client.RestTemplate
import java.net.InetAddress

/**
 * [실전 #6] Consul HTTP API 자기 등록 컴포넌트.
 *
 * 동작:
 *   - @PostConstruct: Spring 컨테이너가 빈 초기화 후 자동 호출 → register()
 *   - @PreDestroy : 빈 소멸 직전 자동 호출 → deregister()
 *
 * 외부 Consul 클라이언트 라이브러리를 쓰지 않고 RestTemplate으로 직접 HTTP 호출.
 * 4개 언어로 같은 패턴을 구현하는 학습 목적상 의도한 선택.
 *
 * 주소 결정 우선순위:
 *   1. consul.service-address 환경변수 (docker-compose 에서 서비스명 주입)
 *   2. InetAddress.getLocalHost().hostName (로컬 실행 환경용 fallback)
 *
 * Docker 환경에서 hostName 은 컨테이너 ID 라 다른 서비스가 DNS 해석을 못 함 —
 * 반드시 CONSUL_SERVICE_ADDRESS=auth-service 로 override 해야 한다.
 */
// [P1 #1 / @SpringBootTest PostgreSQL 의존 분리]
// 기본값 true → 운영/Docker/로컬 실행에서는 기존처럼 자동 등록.
// 테스트 profile (application-test.yml) 에서 consul.enabled=false 로 두면
// 이 빈이 컨텍스트에 아예 등록되지 않아 @PostConstruct register() 가 실행되지 않는다.
// → @SpringBootTest 가 Consul(localhost:8500) 미가동 환경에서 무의미한 지연/실패 없이 뜬다.
@ConditionalOnProperty(name = ["consul.enabled"], havingValue = "true", matchIfMissing = true)
@Component
class ConsulRegistrar(
    @Value("\${consul.host}") private val consulHost: String,
    @Value("\${consul.port}") private val consulPort: Int,
    @Value("\${server.port:8080}") private val servicePort: Int,
    @Value("\${spring.application.name:auth-service}") private val serviceName: String,
    @Value("\${consul.health-path:/api/auth/health}") private val healthPath: String,
    @Value("\${consul.service-address:#{null}}") private val overrideAddress: String? = null,
    private val restTemplate: RestTemplate = RestTemplateBuilder().build(),
) {
    private val log = LoggerFactory.getLogger(ConsulRegistrar::class.java)
    private val objectMapper = jacksonObjectMapper()

    // 주소 결정: override 우선, 없으면 hostName fallback
    private val host: String = overrideAddress ?: InetAddress.getLocalHost().hostName
    private val serviceId: String = "$serviceName-$host-$servicePort"

    @PostConstruct
    fun register() {
        // Jackson으로 Map → JSON 직렬화 (문자열 수작업 결합보다 안전하고 4언어 패턴 일관성 유지)
        val payload = objectMapper.writeValueAsString(mapOf(
            "ID" to serviceId,
            "Name" to serviceName,
            "Address" to host,
            "Port" to servicePort,
            "Check" to mapOf(
                "HTTP" to "http://$host:$servicePort$healthPath",
                "Interval" to "10s",
                "Timeout" to "2s",
                "DeregisterCriticalServiceAfter" to "30s",
            ),
        ))

        repeat(5) { attempt ->
            try {
                restTemplate.put("http://$consulHost:$consulPort/v1/agent/service/register", payload)
                log.info("Consul 등록 성공: id={}", serviceId)
                return
            } catch (e: Exception) {
                log.warn("Consul 등록 실패 (attempt {}/5): {}", attempt + 1, e.message)
                try {
                    Thread.sleep((100L * (1 shl attempt)).coerceAtMost(2000)) // exponential backoff
                } catch (ie: InterruptedException) {
                    Thread.currentThread().interrupt()
                    return
                }
            }
        }
        log.error("Consul 등록 5회 모두 실패. id={} — 서비스는 격리된 상태로 계속 동작합니다.", serviceId)
    }

    @PreDestroy
    fun deregister() {
        try {
            restTemplate.put("http://$consulHost:$consulPort/v1/agent/service/deregister/$serviceId", null)
            log.info("Consul 해제 성공: id={}", serviceId)
        } catch (e: Exception) {
            log.warn("Consul 해제 실패 (무시): {}", e.message)
        }
    }
}
