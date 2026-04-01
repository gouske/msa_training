# AGENTS.md (payment-service)

## 범위

이 가이드는 `services/payment-service` 작업에만 적용합니다.

## 역할

- 결제 처리 서비스(FastAPI)
- RabbitMQ `order_queue` Consumer 동작
- 결제 결과를 Order Service 콜백으로 전달
- 하위 호환용 HTTP 결제 엔드포인트 유지

## 주요 파일

- `main.py`
- `requirements.txt`
- `Dockerfile`

## 핵심 API

- `GET /api/payment/health`
- `POST /api/payment/process` (동기 하위 호환)

## 메시징 흐름

1. RabbitMQ `order_queue` 메시지 수신
2. 결제 처리 로직 실행
3. `POST {ORDER_SERVICE_URL}/api/order/callback` 호출

## 로컬 실행/검증

```bash
cd services/payment-service
pip install -r requirements.txt
python main.py
```

## 작업 원칙

- Consumer는 FastAPI 메인 스레드와 분리된 백그라운드 스레드로 유지합니다.
- 큐 수신 데이터 스키마(`orderId`, `amount`, `userEmail`) 변경 시 producer(order-service)와 함께 조정합니다.
- 콜백 실패 로깅은 남기되 Consumer 전체가 중단되지 않도록 처리합니다.
- 하위 호환 HTTP 엔드포인트는 제거 전에 호출처 영향도를 먼저 확인합니다.
