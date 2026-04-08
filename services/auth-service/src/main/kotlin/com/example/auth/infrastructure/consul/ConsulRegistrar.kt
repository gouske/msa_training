package com.example.auth.infrastructure.consul

import jakarta.annotation.PostConstruct
import jakarta.annotation.PreDestroy
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
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
 */
@Component
class ConsulRegistrar(
    @Value("\${consul.host}") private val consulHost: String,
    @Value("\${consul.port}") private val consulPort: Int,
    @Value("\${server.port:8080}") private val servicePort: Int,
    @Value("\${spring.application.name:auth-service}") private val serviceName: String,
    @Value("\${consul.health-path:/actuator/health}") private val healthPath: String,
    private val restTemplate: RestTemplate = RestTemplateBuilder().build(),
) {
    private val log = LoggerFactory.getLogger(ConsulRegistrar::class.java)

    // 자기 식별: 호스트명-포트 조합. 같은 컨테이너 재시작 시 같은 ID로 upsert.
    private val host: String = InetAddress.getLocalHost().hostName
    private val serviceId: String = "$serviceName-$host-$servicePort"

    @PostConstruct
    fun register() {
        // compact JSON 형태로 직렬화 — 테스트에서 정확한 키:값 패턴 검증을 위해 공백 제거
        val payload = """{"ID":"$serviceId","Name":"$serviceName","Address":"$host","Port":$servicePort,"Check":{"HTTP":"http://$host:$servicePort$healthPath","Interval":"10s","Timeout":"2s","DeregisterCriticalServiceAfter":"30s"}}"""

        repeat(5) { attempt ->
            try {
                restTemplate.put("http://$consulHost:$consulPort/v1/agent/service/register", payload)
                log.info("Consul 등록 성공: id={}", serviceId)
                return
            } catch (e: Exception) {
                log.warn("Consul 등록 실패 (attempt {}/5): {}", attempt + 1, e.message)
                Thread.sleep((100L * (1 shl attempt)).coerceAtMost(2000)) // exponential backoff
            }
        }
        log.error("Consul 등록 5회 모두 실패. 서비스는 격리된 상태로 계속 동작합니다.")
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
