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
from payment_ledger import PaymentDeclinedError


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

    def test_charge_business_decline_publishes_payment_failed_and_acks(self, deps):
        """
        비즈니스 거절(한도 초과, 카드 거절 등) → PAYMENT_FAILED reply + ACK.
        보상으로 처리하는 정상 흐름이므로 DLQ로 보내지 않음.
        """
        ch, method, ledger = deps
        ledger.charge.side_effect = PaymentDeclinedError("한도 초과")

        handle_command(ch, method, None, _command(MSG["CHARGE"], {"orderId": "order-1", "amount": 10000}), ledger)

        routing_key, reply = _published_reply(ch)
        assert reply["type"] == MSG["PAYMENT_FAILED"]
        assert "한도 초과" in reply["payload"]["reason"]
        # 비즈니스 거절은 정상 흐름 → ACK
        ch.basic_ack.assert_called_once_with(delivery_tag=7)
        ch.basic_nack.assert_not_called()

    def test_charge_infra_error_nacks_for_retry_without_reply(self, deps):
        """
        인프라 장애(MongoDB 연결 끊김, 네트워크 오류 등) → reply 없이 재시도(nack, requeue=True).
        """
        ch, method, ledger = deps
        ledger.charge.side_effect = RuntimeError("MongoDB 연결 끊김")

        handle_command(ch, method, None, _command(MSG["CHARGE"], {"orderId": "order-1", "amount": 10000}), ledger)

        # reply 발행 없음
        ch.basic_publish.assert_not_called()
        # ACK 없음 (재시도 대기)
        ch.basic_ack.assert_not_called()
        # NACK with requeue=True (재시도 큐로 복귀)
        ch.basic_nack.assert_called_once_with(delivery_tag=7, requeue=True)

    def test_charge_malformed_payload_goes_to_dlq(self, deps):
        """
        malformed payload(필수 키 누락) → DLQ 격리(nack, requeue=False).
        이미 재처리해도 동일한 결과이므로 DLQ로 보낸다.
        """
        ch, method, ledger = deps
        # amount 키 누락 → payload["amount"] 접근 시 KeyError
        handle_command(ch, method, None, _command(MSG["CHARGE"], {"orderId": "order-1"}), ledger)

        # 원장에 접근하지 않음 (KeyError로 조기 반환)
        ledger.charge.assert_not_called()
        # reply 발행 없음
        ch.basic_publish.assert_not_called()
        # ACK 없음
        ch.basic_ack.assert_not_called()
        # NACK with requeue=False (DLQ로 이동, 재시도 안 함)
        ch.basic_nack.assert_called_once_with(delivery_tag=7, requeue=False)


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


class TestMalformedMessage:
    def test_invalid_json_goes_to_dlq(self, deps):
        """
        잘못된 JSON(파싱 실패) → DLQ 격리(nack, requeue=False).
        재처리해도 동일하게 파싱 실패하므로 DLQ로 보낸다.
        """
        ch, method, ledger = deps

        handle_command(ch, method, None, b"not json", ledger)

        # reply 발행 없음
        ch.basic_publish.assert_not_called()
        # ACK 없음
        ch.basic_ack.assert_not_called()
        # NACK with requeue=False (DLQ로 이동)
        ch.basic_nack.assert_called_once_with(delivery_tag=7, requeue=False)

    def test_missing_required_field_goes_to_dlq(self, deps):
        """
        필수 필드 누락(sagaId/type 없음) → DLQ 격리(nack, requeue=False).
        """
        ch, method, ledger = deps
        # sagaId 없는 명령
        malformed = json.dumps({
            "type": MSG["CHARGE"],
            "payload": {"orderId": "order-1", "amount": 10000},
        }).encode()

        handle_command(ch, method, None, malformed, ledger)

        ch.basic_publish.assert_not_called()
        ch.basic_ack.assert_not_called()
        ch.basic_nack.assert_called_once_with(delivery_tag=7, requeue=False)
