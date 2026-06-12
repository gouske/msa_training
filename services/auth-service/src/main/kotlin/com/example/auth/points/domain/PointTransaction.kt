package com.example.auth.points.domain

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.EnumType
import jakarta.persistence.Enumerated
import jakarta.persistence.GeneratedValue
import jakarta.persistence.GenerationType
import jakarta.persistence.Id
import jakarta.persistence.Table
import jakarta.persistence.UniqueConstraint
import java.time.LocalDateTime

/**
 * 포인트 적립/취소 원장. idempotency_key UNIQUE 로 같은 Saga 단계 명령의 중복 처리를 막는다.
 * (멱등키: EARN = "sagaId:stepName", CANCEL = "sagaId:stepName:CANCEL")
 */
@Entity
@Table(
    name = "point_transactions",
    uniqueConstraints = [UniqueConstraint(name = "uk_point_tx_idem", columnNames = ["idempotency_key"])],
)
class PointTransaction(
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    val id: Long? = null,

    @Column(name = "user_email", nullable = false)
    val userEmail: String,

    @Column(nullable = false)
    val amount: Long,

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 10)
    val type: PointTransactionType,

    @Column(name = "idempotency_key", nullable = false, unique = true)
    val idempotencyKey: String,

    @Column(name = "created_at", nullable = false)
    val createdAt: LocalDateTime = LocalDateTime.now(),
)
