package com.example.auth.config

import org.springframework.boot.actuate.autoconfigure.security.servlet.EndpointRequest
import org.springframework.boot.actuate.health.HealthEndpoint
import org.springframework.boot.actuate.metrics.export.prometheus.PrometheusScrapeEndpoint
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.annotation.Order
import org.springframework.http.HttpMethod
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder
import org.springframework.security.web.SecurityFilterChain
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter

@Configuration // 1. 이 클래스는 "서버 설정 정보"를 담고 있다는 선언입니다.
class SecurityConfig {

    companion object {
        // POST만 허용할 경로
        private val AUTH_POST_WHITELIST = arrayOf(
            "/api/auth/login",
            "/api/auth/signup"
        )

        // GET만 허용할 경로 — 비즈니스 API 포트(8080) 전용.
        //
        // [Codex review #2 반영] /actuator/** 는 별도 management 포트(9081) 로 분리되어
        // 이 SecurityFilterChain 에 닿지 않는다. 따라서 비즈니스 포트의 화이트리스트에서 제외 →
        // Gateway 의 /auth/* 익명 라우트를 통한 actuator 노출 경로 자체가 사라진다.
        private val AUTH_GET_WHITELIST = arrayOf(
            "/api/auth/validate",
            "/api/auth/health"
        )
    }

    // 2. 비밀번호를 안전하게 암호화해주는 'BCrypt' 알고리즘 도구를 등록합니다.
    // 실무에서 가장 표준적으로 사용되는 강력한 암호화 방식입니다.
    @Bean
    fun passwordEncoder() = BCryptPasswordEncoder()

    // [관측성 검증에서 발견된 버그 수정] Actuator 전용 필터 체인 — 허용 목록만 익명 개방.
    //
    // 기존 가정("management 포트(9081)는 SecurityFilterChain 에 닿지 않는다")은 틀렸다 —
    // Spring Boot 는 management 자식 컨텍스트에도 springSecurityFilterChain 을 등록하므로
    // 아래 비즈니스 체인의 anyRequest().authenticated() 가 /actuator/** 까지 차단해
    // Prometheus scrape 가 403 으로 실패했다 (health / prometheus 모두).
    //
    // 포트 분리(9081 은 호스트 미노출, 내부 네트워크의 Prometheus 만 도달)는 여전히 유효한
    // 방어선이지만, 그것 하나에만 의존하지 않는다 — 매처를 두 엔드포인트로 못박아 두면
    // 노출 목록이 넓어지거나 포트가 실수로 열려도 민감 엔드포인트가 따라 열리지 않는다.
    @Bean
    @Order(1)
    fun actuatorFilterChain(http: HttpSecurity): SecurityFilterChain {
        http
            .securityMatcher(EndpointRequest.to(HealthEndpoint::class.java, PrometheusScrapeEndpoint::class.java))
            .csrf { it.disable() }
            .authorizeHttpRequests { it.anyRequest().permitAll() }
        return http.build()
    }

    // [Codex adversarial review (PR #50) high finding 대응] 나머지 Actuator 는 전면 거부.
    //
    // 위 허용 목록에 없는 Actuator 엔드포인트(env / beans / configprops / heapdump / loggers …)를
    // 명시적으로 막는다. 이 체인이 없으면 매칭되지 않은 actuator 요청이 아래 비즈니스 체인으로
    // 흘러가고, 거기서 JWT 인증만 통과하면 접근할 수 있게 된다.
    //
    // authenticated() 가 아니라 denyAll() 인 이유: 이 서비스에는 운영자용 Actuator 콘솔이 없다.
    // 관리 엔드포인트를 쓸 정당한 소비자가 없으므로, 권한 모델을 새로 만들기보다 전면 차단이
    // 단순하고 안전하다. 훗날 필요해지면 그때 역할 기반으로 여는 편이 낫다.
    @Bean
    @Order(2)
    fun actuatorDenyFilterChain(http: HttpSecurity): SecurityFilterChain {
        http
            .securityMatcher(EndpointRequest.toAnyEndpoint())
            .csrf { it.disable() }
            .authorizeHttpRequests { it.anyRequest().denyAll() }
        return http.build()
    }

    // 3. 보안 필터 설정 (누가 들어올 수 있는지 정함)
    /**
     * 우리 성(서버) 전체의 보안 규칙을 정하는 설계도입니다.
     */
    @Bean
    @Order(3)
    fun filterChain(http: HttpSecurity, jwtTokenProvider: JwtTokenProvider): SecurityFilterChain {
        http
            .csrf { it.disable() } // 테스트를 위해 CSRF 보안은 잠시 끕니다.
            // 💡 중요: 우리가 만든 JWT 검문소를 '기본 로그인 검문소' 앞에 배치합니다!
            .addFilterBefore(
                JwtAuthenticationFilter(jwtTokenProvider),
                UsernamePasswordAuthenticationFilter::class.java
            )
            .authorizeHttpRequests { auth ->
                // 가입과 로그인은 팔찌가 없어도 들어올 수 있게 열어둡니다.
                auth.requestMatchers(HttpMethod.POST, *AUTH_POST_WHITELIST).permitAll()
                auth.requestMatchers(HttpMethod.GET, *AUTH_GET_WHITELIST).permitAll()
                // 그 외의 모든 곳은 반드시 '팔찌'가 있어야만 들어올 수 있게 막습니다.
                auth.anyRequest().authenticated()
            }
        return http.build()
    }
}