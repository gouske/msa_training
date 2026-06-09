package com.example.auth.points.domain

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.EnumType
import jakarta.persistence.Enumerated
import jakarta.persistence.Id
import jakarta.persistence.Table
import java.time.LocalDateTime

/** 사용자별 포인트 잔액 (user_email PK). status 로 적립 가능 여부를 표현한다. */
@Entity
@Table(name = "point_balance")
class PointBalance(
    @Id
    @Column(name = "user_email")
    val userEmail: String,

    @Column(nullable = false)
    var balance: Long = 0,

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    var status: PointAccountStatus = PointAccountStatus.ACTIVE,

    @Column(name = "updated_at", nullable = false)
    var updatedAt: LocalDateTime = LocalDateTime.now(),
)
