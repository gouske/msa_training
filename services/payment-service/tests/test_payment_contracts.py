"""
[테스트] Saga 계약 상수 — order-service sagaContracts.js와 값이 일치하는지 검증.

학습 포인트:
  - 두 언어(JS/Python)로 작성된 서비스가 같은 큐/메시지 이름을 써야 메시지가 전달됩니다.
  - 문자열을 양쪽에 따로 하드코딩하면 오타 1글자에 메시지가 유실되므로,
    "계약"을 상수로 고정하고 이 테스트가 회귀를 잡습니다.
"""
from payment_contracts import QUEUE, MSG, STEP, dlq_name, queue_arguments


class TestContractValues:
    """JS sagaContracts.js 와 동일해야 하는 리터럴 값"""

    def test_queue_names(self):
        """RabbitMQ 큐 이름이 order-service와 동일한지 확인"""
        assert QUEUE["PAYMENT_COMMAND"] == "saga.payment.command"
        assert QUEUE["POINTS_COMMAND"] == "saga.points.command"
        assert QUEUE["REPLY"] == "saga.reply"

    def test_message_types(self):
        """메시지 타입이 order-service와 동일한지 확인"""
        assert MSG["CHARGE"] == "CHARGE"
        assert MSG["REFUND"] == "REFUND"
        assert MSG["PAYMENT_SUCCEEDED"] == "PAYMENT_SUCCEEDED"
        assert MSG["PAYMENT_FAILED"] == "PAYMENT_FAILED"
        assert MSG["REFUND_SUCCEEDED"] == "REFUND_SUCCEEDED"
        assert MSG["REFUND_FAILED"] == "REFUND_FAILED"

    def test_step_names(self):
        """Saga 단계 이름이 order-service와 동일한지 확인"""
        assert STEP["PAYMENT"] == "T2_PAYMENT"


class TestQueueDeclaration:
    """큐 선언 args — 양 서비스가 동일하게 선언해야 충돌이 없다"""

    def test_dlq_name(self):
        """DLQ(Dead Letter Queue) 이름 생성이 올바른지 확인"""
        assert dlq_name("saga.payment.command") == "saga.payment.command.dlq"
        assert dlq_name("saga.reply") == "saga.reply.dlq"

    def test_queue_arguments_routes_to_dlq(self):
        """큐 선언 시 NACK된 메시지가 DLQ로 라우팅되는지 확인"""
        args = queue_arguments("saga.payment.command")
        assert args["x-dead-letter-exchange"] == ""
        assert args["x-dead-letter-routing-key"] == "saga.payment.command.dlq"
