package com.example.auth.domain

import jakarta.persistence.*
import java.time.LocalDateTime

@Entity // 1. 이 클래스는 DB의 '표'와 1:1로 매칭돼요!
@Table(name = "users") // DB에서는 'users'라는 이름의 표로 저장할게요.
class User(
    @Id // 2. 각 회원을 구분하는 고유 번호 (PK)
    @GeneratedValue(strategy = GenerationType.IDENTITY) // 번호는 1, 2, 3... 자동으로 증가!
    val id: Long? = null,

    @Column(unique = true, nullable = false) // 3. 이메일은 중복되면 안 되고, 꼭 써야 해요.
    var email: String,

    @Column(nullable = false)
    var password: String = "", // 암호화된 비밀번호가 저장될 곳

    @Column(nullable = false)
    var name: String,

    val createdAt: LocalDateTime = LocalDateTime.now(), // 가입 시간 (자동 기록)

    var lastLoginAt: LocalDateTime? = null // 마지막 로그인 시간
)