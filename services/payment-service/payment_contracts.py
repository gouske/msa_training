"""
Saga 계약 상수 — payment-service가 order-service(Orchestrator)와 공유하는 "약속".

학습 포인트:
  - order-service의 src/saga/sagaContracts.js 와 값이 1:1로 같아야 합니다.
  - 큐 이름·메시지 타입을 양쪽에 따로 하드코딩하면 오타 1글자로 메시지가 사라집니다.
  - 큐 선언 시 DLQ(실패 보관함) 라우팅도 양쪽이 동일하게 맞춰야 RabbitMQ가
    큐 속성 충돌 오류를 내지 않습니다.
"""

# RabbitMQ 큐 이름 (sagaContracts.js QUEUE 와 동일)
QUEUE = {
    "PAYMENT_COMMAND": "saga.payment.command",  # Orchestrator → payment (CHARGE/REFUND)
    "POINTS_COMMAND": "saga.points.command",    # Orchestrator → auth (EARN/CANCEL)
    "REPLY": "saga.reply",                      # participant → Orchestrator
}

# 메시지 타입 (sagaContracts.js MSG 와 동일)
MSG = {
    # command
    "CHARGE": "CHARGE",
    "REFUND": "REFUND",
    "EARN": "EARN",
    "CANCEL": "CANCEL",
    # reply
    "PAYMENT_SUCCEEDED": "PAYMENT_SUCCEEDED",
    "PAYMENT_FAILED": "PAYMENT_FAILED",
    "POINTS_SUCCEEDED": "POINTS_SUCCEEDED",
    "POINTS_FAILED": "POINTS_FAILED",
    "REFUND_SUCCEEDED": "REFUND_SUCCEEDED",
    "REFUND_FAILED": "REFUND_FAILED",
}

# Saga 단계 이름 (sagaContracts.js STEP 와 동일)
STEP = {
    "INVENTORY": "T1_INVENTORY",
    "PAYMENT": "T2_PAYMENT",
    "POINTS": "T3_POINTS",
}


def dlq_name(queue: str) -> str:
    """큐 이름에 대응하는 DLQ(Dead Letter Queue) 이름을 반환한다."""
    return f"{queue}.dlq"


def queue_arguments(queue: str) -> dict:
    """
    큐 선언 시 사용할 arguments — NACK된 메시지를 DLQ로 라우팅한다.
    order-service의 queueAssertOptions(queue).arguments 와 동일해야 한다.
    """
    return {
        "x-dead-letter-exchange": "",           # 기본 exchange 사용
        "x-dead-letter-routing-key": dlq_name(queue),
    }
