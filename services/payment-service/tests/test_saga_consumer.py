"""
[테스트] saga_consumer.handle_command — CHARGE/REFUND 분기 + reply 발행.

학습 포인트:
  - command(명령)를 받아 결제/환불을 수행하고, 결과를 reply(응답)로 돌려줍니다.
  - 외부 의존성(RabbitMQ 채널, 원장)을 mock으로 격리해 분기 로직만 검증합니다.
"""
import json
from unittest.mock import MagicMock

import pytest

from saga_consumer import handle_command
from payment_contracts import QUEUE, MSG, STEP


def _command(msg_type, payload, saga_id="saga-1"):
    """command 메시지 bytes 생성 헬퍼"""
    return json.dumps({
        "sagaId": saga_id,
        "type": msg_type,
        "stepName": STEP["PAYMENT"],
        "payload": payload,
        "correlationId": "trace-1",
    }).encode()


@pytest.fixture
def deps():
    ch = MagicMock()
    method = MagicMock()
    method.delivery_tag = 7
    ledger = MagicMock()
    return ch, method, ledger


def _published_reply(ch):
    """ch.basic_publish 에 전달된 (routing_key, reply dict)"""
    kwargs = ch.basic_publish.call_args.kwargs
    return kwargs["routing_key"], json.loads(kwargs["body"])


class TestCharge:
    def test_charge_success_publishes_payment_succeeded(self, deps):
        ch, method, ledger = deps
        ledger.charge.return_value = "PAY-abc"

        handle_command(ch, method, None, _command(MSG["CHARGE"], {"orderId": "order-1", "amount": 10000}), ledger)

        ledger.charge.assert_called_once_with("saga-1", STEP["PAYMENT"], "order-1", 10000)
        routing_key, reply = _published_reply(ch)
        assert routing_key == QUEUE["REPLY"]
        assert reply["type"] == MSG["PAYMENT_SUCCEEDED"]
        assert reply["sagaId"] == "saga-1"
        assert reply["payload"]["paymentId"] == "PAY-abc"
        assert reply["correlationId"] == "trace-1"  # correlationId 전파
        ch.basic_ack.assert_called_once_with(delivery_tag=7)

    def test_charge_failure_publishes_payment_failed_and_acks(self, deps):
        ch, method, ledger = deps
        ledger.charge.side_effect = RuntimeError("PG 거절")

        handle_command(ch, method, None, _command(MSG["CHARGE"], {"orderId": "order-1", "amount": 10000}), ledger)

        routing_key, reply = _published_reply(ch)
        assert reply["type"] == MSG["PAYMENT_FAILED"]
        # 비즈니스 실패는 정상 흐름(보상으로 처리) → ACK (DLQ로 보내지 않음)
        ch.basic_ack.assert_called_once_with(delivery_tag=7)


class TestRefund:
    def test_refund_success_publishes_refund_succeeded(self, deps):
        ch, method, ledger = deps

        handle_command(ch, method, None, _command(MSG["REFUND"], {"paymentId": "PAY-abc", "orderId": "order-1"}), ledger)

        ledger.refund.assert_called_once_with("PAY-abc")
        routing_key, reply = _published_reply(ch)
        assert routing_key == QUEUE["REPLY"]
        assert reply["type"] == MSG["REFUND_SUCCEEDED"]
        ch.basic_ack.assert_called_once_with(delivery_tag=7)


class TestUnknownType:
    def test_unknown_type_acks_without_publish(self, deps):
        ch, method, ledger = deps

        handle_command(ch, method, None, _command("BOGUS", {}), ledger)

        ch.basic_publish.assert_not_called()
        ledger.charge.assert_not_called()
        ch.basic_ack.assert_called_once_with(delivery_tag=7)  # 알 수 없는 타입은 버리고 ACK
