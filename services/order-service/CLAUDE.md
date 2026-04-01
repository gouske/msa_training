# Order Service

## 기술 스택

- **런타임/프레임워크**: Node.js 24 / Express 5.2.1
- **데이터베이스**: MongoDB (Mongoose 9.3.2)
- **HTTP 클라이언트**: Axios 1.13.6
- **메시지 발행**: amqplib 0.10.8 (RabbitMQ AMQP 클라이언트)
- **포트**: 8081

## 실행 및 빌드

```bash
cd services/order-service

npm install    # 의존성 설치
node index.js  # 실행
```

## 엔드포인트

| 메서드 | 경로 | 기능 |
|--------|------|------|
| POST | `/api/order` | 주문 생성 (비동기 결제) |
| POST | `/api/order/callback` | 결제 결과 수신 (Payment Service 내부 호출용) |
| GET | `/api/order/health` | 헬스 체크 |

**POST /api/order**
- 요청 헤더: `Authorization: Bearer {token}`
- 요청 바디: `{itemId, quantity, price}`
- 응답: `202 Accepted` `{message, orderId, status: "PENDING"}`
- 결제는 백그라운드에서 RabbitMQ를 통해 비동기로 처리됨

**POST /api/order/callback** (내부 전용)
- Payment Service가 결제 완료 후 호출
- 요청 바디: `{orderId, paymentStatus}`
- 주문 상태를 `PENDING → SUCCESS / FAILED`로 업데이트

## 주문 생성 흐름 (비동기 방식)

```
1. Authorization 헤더에서 JWT 추출
2. GET http://{AUTH_HOST}:8080/api/auth/validate  →  {valid, email}
3. MongoDB에 주문 저장 (status: "PENDING")
4. RabbitMQ order_queue에 메시지 발행 (producer.js)
5. 즉시 202 Accepted 반환 (클라이언트가 기다리지 않음)

[백그라운드]
6. Payment Service가 큐에서 메시지를 꺼내 결제 처리
7. POST /api/order/callback 호출 → 주문 상태 업데이트 (SUCCESS/FAILED)
```

## Order 스키마 (MongoDB)

```javascript
{
  userEmail: String,   // Auth Service에서 받은 이메일
  itemId:    String,
  quantity:  Number,
  price:     Number,
  status:    String,   // PENDING | SUCCESS | FAILED
  createdAt: Date
}
```

## 환경 변수

| 변수 | 로컬 기본값 | Docker 값 |
|------|------------|-----------|
| `MONGO_URI` | `mongodb://localhost:27017/order_db` | `mongodb://order-db:27017/order_db` |
| `AUTH_HOST` | `localhost` | `auth-service` |
| `PAYMENT_HOST` | `localhost` | `payment-service` |
| `RABBITMQ_URL` | `amqp://localhost` | `amqp://rabbitmq` |

## 서킷 브레이커 (Circuit Breaker)

Auth Service 호출에 `opossum` 라이브러리 기반 서킷 브레이커 적용 (제17강).

| 상태 | 설명 |
|------|------|
| CLOSED | 정상. Auth Service 직접 호출 |
| OPEN | 차단 중. fallback 즉시 반환 (503) |
| HALF-OPEN | 회복 시도. 테스트 요청 1건 통과 |

**설정값** (`circuitBreaker.js`):
- `timeout`: 3000ms — Auth Service 응답 제한 시간
- `errorThresholdPercentage`: 50 — 실패율 50% 초과 시 OPEN 전환
- `resetTimeout`: 10000ms — OPEN 상태에서 10초 후 HALF-OPEN 전환
- `volumeThreshold`: 3 — 최소 3번 요청 후 통계 적용

**CB 상태 확인**: `GET /api/order/health` 응답의 `authCircuitBreaker` 필드

## 핵심 파일

- `index.js` — 메인 Express 앱 (라우팅 + 서비스 간 호출 로직)
- `circuitBreaker.js` — Auth Service 보호용 서킷 브레이커 모듈 (opossum)
- `producer.js` — RabbitMQ 메시지 발행 모듈 (order_queue에 주문 데이터 전송)
- `models/Order.js` — MongoDB 스키마 정의
