package com.example.auth.config

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder
import org.springframework.security.web.SecurityFilterChain

@Configuration // 1. 이 클래스는 "서버 설정 정보"를 담고 있다는 선언입니다.
class SecurityConfig {

    // 2. 비밀번호를 안전하게 암호화해주는 'BCrypt' 알고리즘 도구를 등록합니다.
    // 실무에서 가장 표준적으로 사용되는 강력한 암호화 방식입니다.
    @Bean
    fun passwordEncoder() = BCryptPasswordEncoder()

    // 3. 보안 필터 설정 (누가 들어올 수 있는지 정함)
    @Bean
    fun filterChain(http: HttpSecurity): SecurityFilterChain {
        http
            .csrf { it.disable() } // 테스트 편의를 위해 CSRF 보안 기능을 잠시 끕니다. (실무에선 상황에 따라 설정)
            .authorizeHttpRequests { auth ->
                auth.anyRequest().permitAll() // 현재는 학습 단계이므로 모든 요청을 허용합니다.
            }
        return http.build()
    }
}