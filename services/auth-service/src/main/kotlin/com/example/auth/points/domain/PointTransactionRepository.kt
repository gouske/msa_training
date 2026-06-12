package com.example.auth.points.domain

import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.stereotype.Repository

@Repository
interface PointTransactionRepository : JpaRepository<PointTransaction, Long> {
    fun findByIdempotencyKey(idempotencyKey: String): PointTransaction?
}
