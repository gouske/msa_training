package com.example.auth.config

import com.example.auth.config.JwtAuthenticationFilter
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder
import org.springframework.security.web.SecurityFilterChain
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter

@Configuration // 1. 이 클래스는 "서버 설정 정보"를 담고 있다는 선언입니다.
class SecurityConfig {

    // 2. 비밀번호를 안전하게 암호화해주는 'BCrypt' 알고리즘 도구를 등록합니다.
    // 실무에서 가장 표준적으로 사용되는 강력한 암호화 방식입니다.
    @Bean
    fun passwordEncoder() = BCryptPasswordEncoder()

    // 3. 보안 필터 설정 (누가 들어올 수 있는지 정함)
    /**
     * 우리 성(서버) 전체의 보안 규칙을 정하는 설계도입니다.
     */
    @Bean
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
                auth.requestMatchers("/api/auth/signup", "/api/auth/login").permitAll()
                // 그 외의 모든 곳은 반드시 '팔찌'가 있어야만 들어올 수 있게 막습니다.
                auth.anyRequest().authenticated()
            }
        return http.build()
    }
}