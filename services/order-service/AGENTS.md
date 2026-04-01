# AGENTS.md (order-service)

## 범위

이 가이드는 `services/order-service` 작업에만 적용합니다.

## 역할

- 주문 생성 API 제공
- Auth Service JWT 검증 호출
- MongoDB 주문 저장
- RabbitMQ에 결제 요청 메시지 발행(Producer)
- Payment 콜백 수신 후 주문 상태 업데이트

## 주요 파일

- `index.js`
- `models/Order.js`
- `circuitBreaker.js`
- `producer.js`
- `__tests__/circuitBreaker.test.js`
- `package.json`
- `Dockerfile`

## 핵심 API

- `POST /api/order`
- `POST /api/order/callback` (내부 서비스 콜백)
- `GET /api/order/health`

## 로컬 실행/검증

```bash
cd services/order-service
npm install
node index.js
```

테스트:

```bash
cd services/order-service
npm test
```

## 작업 원칙

- 주문 생성 플로우 변경 시 인증 호출, DB 저장, 메시지 발행 순서를 깨지 않도록 유지합니다.
- 장애 격리를 위해 Auth 호출은 `circuitBreaker.js` 경유 원칙을 지킵니다.
- 결제 연동은 동기 HTTP보다 큐 기반 비동기 흐름을 기본으로 유지합니다.
- 주문 상태 전이는 `PENDING -> SUCCESS|FAILED` 계약을 우선 유지합니다.
