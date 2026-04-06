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
- 인증: Gateway가 JWT를 검증하고 `X-User-Email` 헤더로 이메일을 전달
- 요청 바디: `{itemId, quantity, price}`
- 응답: `202 Accepted` `{message, orderId, status: "PENDING"}`
- 결제는 백그라운드에서 RabbitMQ를 통해 비동기로 처리됨

**POST /api/order/callback** (내부 전용)
- 인증: `X-Internal-Key` 헤더로 내부 API 키 검증 (제20강)
- Payment Service가 결제 완료 후 호출
- 요청 헤더: `X-Internal-Key: {INTERNAL_API_KEY}`
- 요청 바디: `{orderId, paymentStatus}`
- 상태 전이 규칙: `PENDING → SUCCESS / FAILED`만 허용, 종결 상태 변경 시 409 (제22강)
- 유효하지 않은 paymentStatus 시 400

## 주문 생성 흐름 (비동기 방식)

```
1. X-User-Email 헤더에서 이메일 읽기 (Gateway가 JWT 검증 후 주입)
2. MongoDB에 주문 저장 (status: "PENDING")
3. RabbitMQ order_queue에 메시지 발행 (producer.js)
4. 즉시 202 Accepted 반환 (클라이언트가 기다리지 않음)

[백그라운드]
5. Payment Service가 큐에서 메시지를 꺼내 결제 처리
6. POST /api/order/callback 호출 → 주문 상태 업데이트 (SUCCESS/FAILED)
```

## Order 스키마 (MongoDB)

```javascript
{
  userEmail: String,   // Gateway가 X-User-Email 헤더로 전달한 이메일
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
| `RABBITMQ_URL` | `amqp://localhost` | `amqp://rabbitmq` |
| `INTERNAL_API_KEY` | `msa-training-internal-key-2026` | 동일 (Payment Service와 공유) |

## 서킷 브레이커 (비활성화)

제17강에서 Auth Service 호출 보호용으로 도입했으나, 제19강에서 Gateway 중앙 JWT 인증으로 전환하면서 사용 중단됨.
`circuitBreaker.js` 파일은 학습 참고용으로 보존. `index.js`에서 import하지 않으므로 실행되지 않음.

## 핵심 파일

- `index.js` — 메인 Express 앱 (라우팅 + X-User-Email 헤더 읽기)
- `producer.js` — RabbitMQ 메시지 발행 모듈 (order_queue에 주문 데이터 전송)
- `models/Order.js` — MongoDB 스키마 정의
- `circuitBreaker.js` — (비활성화) Auth Service 보호용 서킷 브레이커 (제17강 학습 참고용)
