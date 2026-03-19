package com.example.auth.domain

import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.stereotype.Repository

@Repository // 4. "나는 DB 통역사야!"라고 알려주는 장치
interface UserRepository : JpaRepository<User, Long> {
    // 실무 꿀팁: 기본 기능(저장, 삭제) 외에 필요한 기능만 이렇게 이름으로 정의하면 끝!
    fun findByEmail(email: String): User?
}