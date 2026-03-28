"""
[결제 서비스] Payment Service - FastAPI 메인 앱

역할:
  1. HTTP 엔드포인트: POST /api/payment/process (동기 호출용 - 하위 호환 유지)
  2. RabbitMQ Consumer: order_queue를 구독하여 비동기 결제 처리

비동기 흐름:
  RabbitMQ order_queue → on_order_message() → 결제 처리
  → POST order-service:8081/api/order/callback (결제 결과 전달)
"""

import os
import threading  # Consumer를 FastAPI와 별도 스레드에서 실행하기 위해 사용
import time       # RabbitMQ 재연결 대기 시 사용
import json       # RabbitMQ 메시지 파싱. 큐에서 받은 메시지(bytes)를 딕셔너리로 변환하기 위해 사용
import pika       # pika: Python에서 AMQP 0-9-1 프로토콜(RabbitMQ)을 사용하는 표준 라이브러리
import requests   # requests: Python에서 HTTP 요청을 보내는 라이브러리. Order Service에 결과 전달 시 사용(Order Service 콜백 호출)
from contextlib import asynccontextmanager  # FastAPI lifespan 패턴에 필요한 컨텍스트 매니저
from fastapi import FastAPI
from pydantic import BaseModel

# --- 환경 변수 ---
# Order Service 콜백 주소: 결제 완료 후 주문 상태 업데이트를 위해 호출합니다.
ORDER_SERVICE_URL = os.getenv("ORDER_SERVICE_URL", "http://localhost:8081")
# RabbitMQ 호스트: Docker 환경에서는 서비스 이름 'rabbitmq', 로컬 실행 시 'localhost'
RABBITMQ_HOST = os.getenv("RABBITMQ_HOST", "localhost")

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
    """
    # body는 bytes 타입이므로 JSON으로 파싱합니다.
    order_data = json.loads(body)
    order_id = order_data["orderId"]
    print(f" [v] 결제 서비스: 주문 메시지 수신됨 orderId={order_id}")

    # 결제 처리 실행
    payment_status = process_payment(order_data)

    # Order Service에 결제 결과를 HTTP POST로 알려줍니다.
    # [서비스 간 통신] Consumer(비동기 수신자)가 처리 결과를 원래 서비스에 콜백하는 패턴
    try:
        callback_url = f"{ORDER_SERVICE_URL}/api/order/callback"
        requests.post(callback_url, json={
            "orderId": order_id,
            "paymentStatus": payment_status
        }, timeout=5)  # timeout: 콜백 응답을 최대 5초만 기다립니다.
        print(f"✅ 주문 상태 업데이트 콜백 완료: {order_id} → {payment_status}")
    except Exception as e:
        print(f"🚨 Order Service 콜백 실패: {e}")

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

            # 큐 선언 - producer(order-service)와 동일한 설정으로 맞춰야 합니다.
            # durable: true → RabbitMQ 재시작 시에도 큐가 유지됩니다.
            channel.queue_declare(queue='order_queue', durable=True)

            # basic_consume: 큐에 메시지가 도착하면 on_order_message를 호출하도록 등록합니다.
            # auto_ack=True: 메시지 수신 즉시 자동으로 확인 응답을 보냅니다.
            #   (처리 실패 시 재처리가 필요하다면 auto_ack=False + ch.basic_ack()를 사용)
            channel.basic_consume(
                queue='order_queue',
                on_message_callback=on_order_message,
                auto_ack=True
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

    yield  # 이 지점에서 FastAPI가 요청을 받기 시작합니다.
    # 종료 처리: daemon=True이므로 별도 종료 코드 불필요

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
