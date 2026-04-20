"""
[결제 서비스] Payment Service - FastAPI 메인 앱

역할:
  1. HTTP 엔드포인트: POST /api/payment/process (동기 호출용 - 하위 호환 유지)
  2. RabbitMQ Consumer: order_queue를 구독하여 비동기 결제 처리

비동기 흐름:
  RabbitMQ order_queue → on_order_message() → 결제 처리
  → POST order-service:8081/api/order/callback (결제 결과 전달)
"""

import asyncio  # 동기 Consumer 스레드에서 비동기 find_instance 호출 시 사용
import os
import socket     # HOSTNAME fallback용 — Docker 환경에서는 CONSUL_SERVICE_ADDRESS 환경변수 우선
import threading  # Consumer를 FastAPI와 별도 스레드에서 실행하기 위해 사용
import time       # RabbitMQ 재연결 대기 시 사용
import json       # RabbitMQ 메시지 파싱. 큐에서 받은 메시지(bytes)를 딕셔너리로 변환하기 위해 사용
import pika       # pika: Python에서 AMQP 0-9-1 프로토콜(RabbitMQ)을 사용하는 표준 라이브러리
import requests   # requests: Python에서 HTTP 요청을 보내는 라이브러리. Order Service에 결과 전달 시 사용(Order Service 콜백 호출)
from contextlib import asynccontextmanager  # FastAPI lifespan 패턴에 필요한 컨텍스트 매니저
from fastapi import FastAPI
from pydantic import BaseModel
# [실전 #6] Consul 자기 등록/해제 모듈
from infrastructure.consul_registrar import register, deregister
# [실전 #6] Consul 서비스 조회 모듈 — Order 콜백 대상 주소를 동적으로 결정
from infrastructure.consul_lookup import find_instance, OrderUnreachableError
# [Issue #8] Correlation ID 검증 헬퍼 — 부정 입력으로 인한 콜백 실패/DLQ 오염 방지
from infrastructure.correlation_id import normalize_correlation_id

# --- 환경 변수 ---
# [실전 #6] ORDER_SERVICE_URL 제거 — 이제 Consul을 통해 동적으로 Order 인스턴스를 찾는다.
# RabbitMQ 호스트: Docker 환경에서는 서비스 이름 'rabbitmq', 로컬 실행 시 'localhost'
RABBITMQ_HOST = os.getenv("RABBITMQ_HOST", "localhost")
# [제20강 추가] 서비스 간 통신용 내부 API 키
# Order Service 콜백 호출 시 X-Internal-Key 헤더에 이 값을 포함해야 합니다.
# [핫픽스] 기본값 fallback 제거 — 환경변수 미설정 시 즉시 에러로 누락을 방지합니다.
INTERNAL_API_KEY = os.getenv("INTERNAL_API_KEY")
if not INTERNAL_API_KEY:
    raise RuntimeError("INTERNAL_API_KEY 환경변수가 설정되지 않았습니다. .env 파일을 확인하세요.")

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# RabbitMQ Consumer (비동기 결제 처리)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
def process_payment(order_data: dict) -> str:
    """
    실제 결제 처리 로직입니다.
    현재는 Mock 구현으로 항상 성공(COMPLETED)을 반환합니다.
    실무에서는 여기서 카드사 API, PG사 연동 등을 수행합니다.
    """
    print(f"💰 결제 처리 중... 주문ID: {order_data['orderId']}, 금액: {order_data['amount']}원")
    return "COMPLETED"

def on_order_message(ch, method, properties, body):
    """
    order_queue에서 메시지를 수신했을 때 실행되는 콜백 함수입니다.
    흐름: 메시지 수신 → 결제 처리 → Order Service에 결과 콜백

    [제21강 변경] 수동 ACK/NACK으로 변경
    이전: 메시지 수신 즉시 자동 ACK → 콜백 실패 시 메시지 유실 → 주문 영구 PENDING
    이후: 콜백 성공(2xx) 시에만 ACK, 실패 시 NACK → 메시지가 DLQ로 이동하여 나중에 재처리 가능

    ACK(Acknowledge): "이 메시지를 잘 처리했어!" → RabbitMQ가 큐에서 삭제
    NACK(Negative Acknowledge): "이 메시지 ���리에 실패했어!" → DLQ로 이동
    """
    # body는 bytes 타입이므로 JSON으로 파싱합니다.
    order_data = json.loads(body)
    order_id = order_data["orderId"]
    # [제20강 / Issue #8] RabbitMQ 메시지 본문에서 correlationId 를 꺼낸 뒤
    # HTTP 헤더에 재주입하기 전에 반드시 검증한다. 외부 클라이언트가 Gateway 우회로
    # 부정 값을 주입했을 가능성을 고려해 defense in depth 로 한 번 더 정규화.
    # 형식 불일치면 서버 생성 UUID 로 치환 — 콜백 실패 → DLQ 오염 경로 차단.
    correlation_id = normalize_correlation_id(order_data.get("correlationId"))
    print(f" [v] 결제 서비스: 주문 메시지 수신됨 orderId={order_id} correlationId={correlation_id}")

    # 결제 처리 실행
    payment_status = process_payment(order_data)

    # [실전 #6] Order Service에 결제 결과를 HTTP POST로 알려줍니다.
    # Consul에서 passing 인스턴스를 조회하여 콜백 대상 주소를 동적으로 결정합니다.
    # on_order_message는 동기 함수이므로 asyncio.run()으로 비동기 find_instance를 호출합니다.
    try:
        consul_url = f"http://{os.getenv('CONSUL_HOST', 'localhost')}:{os.getenv('CONSUL_PORT', '8500')}"
        try:
            host, port = asyncio.run(find_instance(consul_url, "order-service"))
        except OrderUnreachableError as e:
            print(f"🚨 Order 콜백 불가 — Consul 조회 실패: {e}. RabbitMQ DLQ 경로로 빠짐.")
            ch.basic_nack(delivery_tag=method.delivery_tag, requeue=False)
            return

        callback_url = f"http://{host}:{port}/api/order/callback"
        # [제20강] X-Correlation-ID 헤더를 콜백 요청에 포함합니다.
        # Order Service가 이 헤더를 로그에 기록하면, Kibana에서 요청 전체 경로를 추적할 수 있습니다.
        response = requests.post(callback_url, json={
            "orderId": order_id,
            "paymentStatus": payment_status
        }, headers={
            "X-Internal-Key": INTERNAL_API_KEY,
            "X-Correlation-ID": correlation_id,
        }, timeout=5)

        # [핫픽스] 응답 코드별 ACK/NACK 분기
        # 이전: raise_for_status()로 모든 비-2xx를 NACK → 409(이미 처리됨)도 DLQ로 이동
        # 이후: 409는 "이미 처리 완료"이므로 ACK (DLQ 오염 방지)
        status_code = response.status_code

        if 200 <= status_code < 300:
            # 정상 처리 완료 → ACK
            print(f"✅ 주문 상태 업데이트 콜백 완료: {order_id} → {payment_status}")
            ch.basic_ack(delivery_tag=method.delivery_tag)

        elif status_code == 409:
            # 이미 처리된 주문 (멱등 응답) → ACK로 처리 (재시도해도 결과 동일)
            # DLQ에 보내지 않습니다 — 이것은 장애가 아니라 정상적인 중복 요청입니다.
            print(f"⚠️ 이미 처리된 주문 (409): {order_id} — ACK 처리")
            ch.basic_ack(delivery_tag=method.delivery_tag)

        else:
            # 그 외 4xx/5xx 에러 → NACK → DLQ로 이동
            print(f"🚨 Order Service 콜백 실패 (HTTP {status_code}): {order_id}")
            ch.basic_nack(delivery_tag=method.delivery_tag, requeue=False)

    except Exception as e:
        print(f"🚨 Order Service 콜백 예외: {e}")

        # 네트워크 오류, 타임아웃 등 → NACK → DLQ로 이동
        ch.basic_nack(delivery_tag=method.delivery_tag, requeue=False)

def start_consumer():
    """
    RabbitMQ order_queue 구독을 시작합니다.

    [재시도 루프]
    docker-compose의 depends_on은 컨테이너 '시작'만 보장하고 서비스 '준비 완료'는 보장하지 않습니다.
    RabbitMQ가 완전히 뜨기 전에 연결을 시도할 수 있으므로, 실패 시 5초 후 재시도합니다.
    """
    while True:
        try:
            # pika.BlockingConnection: 동기(블로킹) 방식으로 RabbitMQ에 연결합니다.
            # FastAPI는 asyncio 기반이지만 pika는 asyncio와 호환되지 않으므로
            # 별도 스레드에서 BlockingConnection을 사용합니다.
            connection = pika.BlockingConnection(
                pika.ConnectionParameters(host=RABBITMQ_HOST)
            )
            channel = connection.channel()

            # [제21강 추가] DLQ(Dead Letter Queue) 선언
            # 처리에 실패한 메시지가 이동하는 "실패 보관함"입니다.
            # 운영자가 나중에 RabbitMQ 관리 대시보드에서 확인하거나 재처리할 수 있습니다.
            channel.queue_declare(queue='order_dlq', durable=True)

            # [제21강 변경] 큐 선언 시 DLQ 연결 설정 추가
            # 이전: channel.queue_declare(queue='order_queue', durable=True)
            # 이후: arguments로 DLQ를 연결하여 NACK된 메시지가 자동으로 order_dlq로 이동
            #
            # x-dead-letter-exchange: '' (빈 문자열) = RabbitMQ 기본 exchange 사용
            # x-dead-letter-routing-key: 'order_dlq' = 실패 메시지를 order_dlq 큐로 라우팅
            channel.queue_declare(queue='order_queue', durable=True, arguments={
                'x-dead-letter-exchange': '',
                'x-dead-letter-routing-key': 'order_dlq'
            })

            # [제21강 변경] auto_ack=False → 수동 ACK/NACK
            # 이전: auto_ack=True → 메시지 수신 즉시 삭제 → 처리 실패해도 복구 불가
            # 이후: auto_ack=False → on_order_message에서 명시적으로 ACK/NACK 호출
            channel.basic_consume(
                queue='order_queue',
                on_message_callback=on_order_message,
                auto_ack=False  # 수동 ACK: 처리 완료를 직접 알려야 합니다
            )

            print(' [*] 결제 서비스: RabbitMQ 메시지 대기 중...')
            channel.start_consuming() # 블로킹 루프 - 메시지가 올 때마다 콜백 실행

        except Exception as e:
            print(f"⚠️  RabbitMQ 연결 실패, 5초 후 재시도: {e}")
            time.sleep(5)

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# FastAPI 앱 설정
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    FastAPI 앱의 시작/종료 시 실행할 작업을 정의합니다.

    [lifespan 패턴] 구버전의 @app.on_event("startup") 대신 사용하는 최신 방식입니다.
    예전 방식: @app.on_event("startup") ← 현재는 deprecated(더 이상 권장 안 함)
    새 방식: lifespan 함수 사용 ← FastAPI 최신 권장 방식
    - yield 앞: 서버가 요청을 받기 전 실행 (초기화)
    - yield 뒤: 서버 종료 시 실행 (정리)
    """
    # RabbitMQ Consumer를 별도 스레드에서 실행합니다.
    # daemon=True: 메인 프로세스(FastAPI)가 종료되면 이 스레드도 자동으로 종료됩니다.
    consumer_thread = threading.Thread(
        target=start_consumer,
        daemon=True,
        name="rabbitmq-consumer"
    )
    consumer_thread.start()
    print("🚀 RabbitMQ Consumer 스레드 시작됨")

    # [실전 #6] Consul 자기 등록
    # 주소 결정 우선순위: CONSUL_SERVICE_ADDRESS → HOSTNAME → socket.gethostname() fallback
    # Docker 환경에서 컨테이너 ID 대신 서비스 이름을 쓰려면 CONSUL_SERVICE_ADDRESS 주입 필요
    consul_url = f"http://{os.getenv('CONSUL_HOST', 'localhost')}:{os.getenv('CONSUL_PORT', '8500')}"
    host = (
        os.getenv("CONSUL_SERVICE_ADDRESS")
        or os.getenv("HOSTNAME")
        or socket.gethostname()
    )
    sid = await register(
        consul_url=consul_url,
        name="payment-service",
        host=host,
        port=8082,
        health_path="/api/payment/health",
    )
    app.state.consul_service_id = sid
    app.state.consul_url = consul_url

    yield  # 이 지점에서 FastAPI가 요청을 받기 시작합니다.

    # [실전 #6] Consul 해제 (graceful shutdown)
    # 종료 처리: daemon=True이므로 RabbitMQ 스레드는 별도 종료 코드 불필요
    await deregister(consul_url, sid)

# lifespan을 FastAPI 앱에 등록합니다.
app = FastAPI(lifespan=lifespan)

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# HTTP 엔드포인트 (동기 호출용 - 하위 호환 유지)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# 결제 요청 데이터를 담는 바구니(Schema)
class PaymentRequest(BaseModel):
    orderId: str
    amount: int

@app.get("/api/payment/health")
def health_check():
    return {"status": "OK", "message": "✅ Payment Service is Running on Python!"}

@app.post("/api/payment/process")
async def process_payment_http(request: PaymentRequest):
    """
    [HTTP 동기 엔드포인트] 직접 HTTP 호출로 결제를 처리합니다.
    현재는 비동기 방식(RabbitMQ)으로 전환했지만, 하위 호환을 위해 유지합니다.
    """
    print(f"💰 [HTTP] 결제 진행 중... 주문번호: {request.orderId}, 금액: {request.amount}")
    return {
        "paymentId": "PAY-" + request.orderId,
        "status": "COMPLETED",
        "message": f"{request.amount}원 결제가 완료되었습니다."
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8082)  # 결제 서비스는 8082번 포트를 씁니다!
