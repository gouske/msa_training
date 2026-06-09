package com.example.auth.points.messaging

/**
 * Saga 계약 상수 — auth-service(포인트 participant)가 order-service(Orchestrator)와 공유하는 "약속".
 *
 * 학습 포인트:
 *   - order-service의 src/saga/sagaContracts.js, payment-service의 payment_contracts.py 와
 *     값이 1:1로 같아야 한다. 큐 이름·메시지 타입을 양쪽에 따로 하드코딩하면 오타 1글자에 메시지가 사라진다.
 *   - 큐 선언 시 DLQ 라우팅도 동일하게 맞춰야 RabbitMQ가 큐 속성 충돌(PRECONDITION_FAILED)을 내지 않는다.
 */
object PointsContracts {
    /** RabbitMQ 큐 이름 (sagaContracts.js QUEUE 와 동일) */
    object QUEUE {
        const val PAYMENT_COMMAND = "saga.payment.command"
        const val POINTS_COMMAND = "saga.points.command"
        const val REPLY = "saga.reply"
    }

    /** 메시지 타입 (sagaContracts.js MSG 와 동일) */
    object MSG {
        // command (Orchestrator가 발행)
        const val CHARGE = "CHARGE"
        const val REFUND = "REFUND"
        const val EARN = "EARN"
        const val CANCEL = "CANCEL"
        // reply (participant가 발행)
        const val PAYMENT_SUCCEEDED = "PAYMENT_SUCCEEDED"
        const val PAYMENT_FAILED = "PAYMENT_FAILED"
        const val POINTS_SUCCEEDED = "POINTS_SUCCEEDED"
        const val POINTS_FAILED = "POINTS_FAILED"
        const val REFUND_SUCCEEDED = "REFUND_SUCCEEDED"
        const val REFUND_FAILED = "REFUND_FAILED"
    }

    /** Saga 단계 이름 (sagaContracts.js STEP 와 동일) */
    object STEP {
        const val INVENTORY = "T1_INVENTORY"
        const val PAYMENT = "T2_PAYMENT"
        const val POINTS = "T3_POINTS"
    }

    /** 큐 이름에 대응하는 DLQ 이름. payment_contracts.dlq_name() / sagaContracts.dlqName() 과 동일 규칙. */
    fun dlqName(queue: String): String = "$queue.dlq"
}
