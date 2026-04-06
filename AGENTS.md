# AGENTS.md

이 파일은 저장소 전역(루트) 가이드입니다.

## Language
- 모든 응답과 코드 리뷰는 한국어로 작성할 것
- 코드 주석과 커밋 메시지는 한글을 기본으로 하고 필요한 부분만 영어를 허용함

## 참조 우선순위

1. 작업 대상 서비스 디렉터리에 `AGENTS.md`가 있으면 그 파일을 우선 참조합니다.
2. 루트 `AGENTS.md`는 교차 서비스 작업 또는 전역 아키텍처 확인이 필요할 때만 참조합니다.

서비스별 가이드:

- `services/gateway-service/AGENTS.md`
- `services/auth-service/AGENTS.md`
- `services/order-service/AGENTS.md`
- `services/payment-service/AGENTS.md`

## 전역 개요 (필요 시만)

- Gateway: .NET 8 + YARP (`9000`)
- Auth: Kotlin + Spring Boot + PostgreSQL (`8080`)
- Order: Node.js + Express + MongoDB (`8081`)
- Payment: Python + FastAPI + RabbitMQ Consumer (`8082`)
- Infra: PostgreSQL, MongoDB, RabbitMQ

전체 실행:

```bash
docker-compose up --build
docker-compose down
```

Gateway 진입점: `http://localhost:9000`
