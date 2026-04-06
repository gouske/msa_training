# Payment Service

## 기술 스택

- **언어/프레임워크**: Python 3.13 / FastAPI 0.135.1
- **웹 서버**: Uvicorn 0.42.0
- **데이터 검증**: Pydantic 2.12.5
- **메시지 수신**: pika 1.3.2 (RabbitMQ AMQP 클라이언트)
- **HTTP 클라이언트**: requests 2.32.4 (Order Service 콜백 호출용)
- **포트**: 8082

## 실행 및 빌드

```bash
cd services/payment-service

python -m venv .venv           # 가상 환경 생성
source .venv/bin/activate      # 활성화 (macOS/Linux)
pip install -r requirements.txt

PYTHONUNBUFFERED=1 python main.py  # 실행 (로그 즉시 출력)
# 또는: uvicorn main:app --host 0.0.0.0 --port 8082
```

## 엔드포인트

| 메서드 | 경로 | 기능 |
|--------|------|------|
| POST | `/api/payment/process` | 결제 처리 (HTTP 동기 방식, 하위 호환용) |
| GET | `/api/payment/health` | 헬스 체크 |

**POST /api/payment/process**
- 요청 바디: `{orderId: str, amount: int}`
- 응답: `{paymentId: "PAY-{orderId}", status: "COMPLETED", message: "{amount}원 결제가 완료되었습니다."}`

## RabbitMQ Consumer (비동기 결제 처리)

앱 시작 시 `lifespan` 이벤트를 통해 Consumer 스레드가 자동으로 시작된다.

```
order_queue 메시지 수신
  → on_order_message() 콜백 실행
  → process_payment() 결제 처리 (현재 Mock)
  → POST {ORDER_SERVICE_URL}/api/order/callback (결제 결과 전달, X-Internal-Key 헤더 포함)
```

- `threading.Thread(daemon=True)` 로 실행 — FastAPI(asyncio)와 pika(블로킹) 충돌 방지
- RabbitMQ 연결 실패 시 5초 후 자동 재시도 (depends_on 한계 보완)
- 수동 ACK/NACK: 콜백 성공 시 ACK, 실패 시 NACK → DLQ(order_dlq)로 이동 (제21강)
- `response.raise_for_status()`로 콜백 HTTP 응답 코드 검증 (제21강)

## 구현 상태

현재 **목(Mock) 구현**으로, 항상 `COMPLETED`를 반환한다. 실제 결제 로직은 미구현.

## 환경 변수

| 변수 | 로컬 기본값 | Docker 값 |
|------|------------|-----------|
| `RABBITMQ_HOST` | `localhost` | `rabbitmq` |
| `ORDER_SERVICE_URL` | `http://localhost:8081` | `http://order-service:8081` |
| `INTERNAL_API_KEY` | `msa-training-internal-key-2026` | 동일 (Order Service와 공유) |
| `PYTHONUNBUFFERED` | — | `1` (Docker 로그 즉시 출력) |

## 핵심 파일

- `main.py` — FastAPI 앱 전체 (HTTP 엔드포인트 + RabbitMQ Consumer 통합, 단일 파일 구성)
