# CLAUDE.md

이 파일은 Claude Code(claude.ai/code)가 이 저장소에서 작업할 때 참고하는 가이드입니다.

## Language
- 모든 응답과 코드 리뷰는 한국어로 작성할 것
- 코드 주석과 커밋 메시지는 한글을 기본으로 하고 필요한 부분만 영어를 허용함

## 프로젝트 개요

4개의 서비스를 서로 다른 기술 스택으로 구현한 MSA(마이크로서비스 아키텍처) 학습 프로젝트.

| 서비스 | 기술 스택 | 포트 |
|--------|----------|------|
| gateway-service | C#/.NET 8 + YARP | 9000 |
| auth-service | Kotlin + Spring Boot | 8080 |
| order-service | Node.js + Express | 8081 |
| payment-service | Python + FastAPI | 8082 |
| rabbitmq | RabbitMQ 3 (management) | 5672 / 15672 |
| elasticsearch | Elasticsearch 8.17.0 | 9200 |
| logstash | Logstash 8.17.0 | 5044 |
| kibana | Kibana 8.17.0 | 5601 |
| filebeat | Filebeat 8.17.0 | - |

## 전체 스택 실행

```bash
docker-compose up          # 전체 서비스 시작
docker-compose down        # 전체 서비스 중지
docker-compose up --build  # 재빌드 후 시작
```

RabbitMQ 관리 대시보드: `http://localhost:15672` (guest / guest)

## 아키텍처

### 요청 라우팅 + JWT 인증

```
클라이언트 → Gateway (포트 9000) → /auth/*    → auth-service:8080  (Anonymous)
             JWT 검증 + 헤더 주입   → /order/*   → order-service:8081  (JWT 필요)
                                 → /payment/* → payment-service:8082  (JWT 필요)
```

게이트웨이는 YARP를 사용해 경로의 첫 번째 세그먼트를 제거하고 각 서비스의 `/api/` 경로로 전달한다.
Gateway가 JWT를 중앙 검증하고, 인증된 사용자 이메일을 `X-User-Email` 헤더로 백엔드에 전달한다.

### 주문 생성 시 서비스 간 호출 흐름 (비동기)

```
POST /order (클라이언트, Authorization: Bearer {JWT})
  → Gateway
      1. JWT 검증 (비밀 키로 서명 확인)
      2. X-User-Email 헤더 주입
  → Order Service
      3. X-User-Email 헤더에서 이메일 읽기
      4. MongoDB에 주문 저장 (PENDING)
      5. RabbitMQ order_queue에 메시지 발행
      6. 202 Accepted 즉시 반환

[백그라운드]
  RabbitMQ → Payment Service (Consumer 스레드)
      7. 결제 처리
      8. POST order-service:8081/api/order/callback
      9. 주문 상태 업데이트 → SUCCESS / FAILED
```

## 커밋 메시지 규칙

한글로 작성하며 Conventional Commits 형식을 따른다.

```
feat(service): 기능 설명
fix(service): 버그 수정 내용
refactor(service): 리팩토링 내용
```

## 서비스별 상세 정보

특정 서비스 작업 시 해당 서비스의 `CLAUDE.md`를 읽어 컨텍스트를 파악할 것.

- **Gateway**: `services/gateway-service/CLAUDE.md`
- **Auth**: `services/auth-service/CLAUDE.md`
- **Order**: `services/order-service/CLAUDE.md`
- **Payment**: `services/payment-service/CLAUDE.md`
