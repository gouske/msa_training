"""
saga_consumer — Saga 결제 participant.

역할:
  - saga.payment.command 큐를 구독하여 type(CHARGE/REFUND)으로 분기 처리합니다.
  - 처리 결과를 saga.reply 큐로 발행해 Orchestrator(order-service)가 상태머신을 전이하게 합니다.

설계 메모(Phase 2 범위):
  - 결제 비즈니스 실패(PG 거절 등)는 "장애"가 아니라 정상 흐름입니다 →
    PAYMENT_FAILED reply를 보내고 command 메시지는 ACK합니다(보상은 Orchestrator가 수행).
    이렇게 해야 DLQ가 비즈니스 실패로 오염되지 않습니다(제21강 자산 계승).
  - 신뢰성(outbox/재처리 등)은 Phase 4로 이연합니다.

  Phase 2 오류 분류(제25강 Codex high 수정):
  - malformed(JSON 파싱/필수 키 누락) → DLQ 격리(nack, requeue=False), reply 없음
  - 인프라 장애(원장/네트워크 등) → 재시도(nack, requeue=True), reply 없음
  - 비즈니스 거절(PaymentDeclinedError) → *_FAILED reply + ACK (보상으로 처리)
"""
import json
import os
import time

import pika

from payment_contracts import QUEUE, MSG, queue_arguments, dlq_name
from payment_ledger import PaymentDeclinedError
from infrastructure.correlation_id import normalize_correlation_id

RABBITMQ_HOST = os.getenv("RABBITMQ_HOST", "localhost")


def _publish_reply(ch, reply: dict) -> None:
    """saga.reply 큐로 응답을 발행한다."""
    ch.basic_publish(
        exchange="",
        routing_key=QUEUE["REPLY"],
        body=json.dumps(reply).encode(),
        properties=pika.BasicProperties(delivery_mode=2),  # 메시지 영속화
    )


def handle_command(ch, method, properties, body, ledger) -> None:
    """
    saga.payment.command 메시지 콜백. 오류를 3종으로 분류해 ACK/NACK 정책을 달리한다.

    오류 분류:
      - malformed(JSON 파싱 실패/필수 키 누락) → DLQ 격리(nack, requeue=False), reply 없음
      - 인프라 장애(원장/네트워크 등 일반 예외) → 재시도(nack, requeue=True), reply 없음
      - 비즈니스 거절(PaymentDeclinedError) → *_FAILED reply + ACK (보상으로 처리하는 정상 흐름)

    @param ledger: PaymentLedger 인스턴스(테스트 시 mock 주입)
    """
    # 1단계: 메시지 파싱 + 필수 필드 검증
    # 실패 시 재처리해도 동일하므로 DLQ로 격리한다.
    try:
        command = json.loads(body)
        saga_id = command["sagaId"]
        msg_type = command["type"]
    except (json.JSONDecodeError, KeyError, TypeError) as e:
        print(f"🚨 malformed command(파싱/필수필드 누락) — DLQ 격리: {e}")
        ch.basic_nack(delivery_tag=method.delivery_tag, requeue=False)
        return

    step_name = command.get("stepName")
    payload = command.get("payload", {})
    # correlationId는 reply로 그대로 전파 — 분산 추적 연속성 유지(제20강 자산)
    correlation_id = normalize_correlation_id(command.get("correlationId"))

    def reply(reply_type, reply_payload=None):
        """saga.reply 큐로 응답을 발행한다."""
        _publish_reply(ch, {
            "sagaId": saga_id,
            "type": reply_type,
            "stepName": step_name,
            "payload": reply_payload or {},
            "correlationId": correlation_id,
        })

    # 2단계: 명령 처리. 오류 종류별로 ACK/NACK을 분기한다.
    try:
        if msg_type == MSG["CHARGE"]:
            payment_id = ledger.charge(saga_id, step_name, payload["orderId"], payload["amount"])
            print(f"💰 결제 승인 sagaId={saga_id} paymentId={payment_id} correlationId={correlation_id}")
            reply(MSG["PAYMENT_SUCCEEDED"], {"paymentId": payment_id})

        elif msg_type == MSG["REFUND"]:
            ledger.refund(payload["paymentId"])
            print(f"↩️  결제 환불 sagaId={saga_id} paymentId={payload.get('paymentId')}")
            reply(MSG["REFUND_SUCCEEDED"], {"paymentId": payload.get("paymentId")})

        else:
            # 알 수 없는 명령 타입 — 버린다(재처리해도 동일하므로 ACK).
            print(f"⚠️ 알 수 없는 command type 무시: {msg_type}")

    except KeyError as e:
        # payload 필수 키 누락 → malformed → DLQ 격리
        print(f"🚨 malformed payload(필수 키 누락) — DLQ 격리: {e}")
        ch.basic_nack(delivery_tag=method.delivery_tag, requeue=False)
        return

    except PaymentDeclinedError as e:
        # 비즈니스 거절(한도 초과/카드 거절 등) — 보상으로 처리하는 정상 흐름
        # → *_FAILED + ACK
        reply_type = MSG["REFUND_FAILED"] if msg_type == MSG["REFUND"] else MSG["PAYMENT_FAILED"]
        print(f"🚫 결제/환불 거절 sagaId={saga_id}: {e}")
        reply(reply_type, {"reason": str(e)})

    except Exception as e:  # noqa: BLE001
        # 인프라 장애(원장/네트워크 등) — 일시적일 수 있으므로 재시도(requeue=True).
        # reply는 보내지 않는다.
        print(f"🚨 인프라 오류 — 재시도 sagaId={saga_id}: {e}")
        ch.basic_nack(delivery_tag=method.delivery_tag, requeue=True)
        return

    # 정상 처리(성공/비즈니스 거절/unknown) → ACK
    ch.basic_ack(delivery_tag=method.delivery_tag)


def start_saga_consumer(ledger) -> None:
    """
    saga.payment.command 구독을 시작한다(별도 스레드에서 실행).
    RabbitMQ 연결 실패 시 5초 후 재시도(기존 order_queue consumer와 동일 패턴).
    """
    command_queue = QUEUE["PAYMENT_COMMAND"]
    reply_queue = QUEUE["REPLY"]

    while True:
        try:
            connection = pika.BlockingConnection(pika.ConnectionParameters(host=RABBITMQ_HOST))
            channel = connection.channel()

            # command 큐 + 그 DLQ 선언 (order-service publisher와 동일 args)
            channel.queue_declare(queue=dlq_name(command_queue), durable=True)
            channel.queue_declare(queue=command_queue, durable=True, arguments=queue_arguments(command_queue))

            # reply 큐 + 그 DLQ 선언 (order-service consumer와 동일 args — 선언 충돌 방지)
            channel.queue_declare(queue=dlq_name(reply_queue), durable=True)
            channel.queue_declare(queue=reply_queue, durable=True, arguments=queue_arguments(reply_queue))

            channel.basic_consume(
                queue=command_queue,
                on_message_callback=lambda ch, method, props, body: handle_command(ch, method, props, body, ledger),
                auto_ack=False,
            )
            print(" [*] 결제 Saga consumer: saga.payment.command 대기 중...")
            channel.start_consuming()

        except Exception as e:  # noqa: BLE001
            print(f"⚠️  Saga consumer RabbitMQ 연결 실패, 5초 후 재시도: {e}")
            time.sleep(5)
