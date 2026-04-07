# 프로젝트 공통 가이드

이 파일은 모든 작업에서 항상 적용되는 프로젝트 가이드입니다.
(루트 `CLAUDE.md` / `AGENTS.md` 는 동일 내용으로 유지됩니다.)
특정 서비스에서 작업할 때는 해당 `services/{name}/CLAUDE.md` 도 함께 참고하세요.

## 언어
- 응답·문서·주석·커밋 메시지는 한국어 기본 (필요 시 영어 허용)

## 프로젝트 개요
4개 마이크로서비스로 구성된 MSA 학습/포트폴리오 프로젝트.

| 서비스 | 스택 | 포트 | 가이드 |
|--------|------|------|--------|
| gateway-service | C# / .NET 8 + YARP | 9000 | services/gateway-service/CLAUDE.md |
| auth-service | Kotlin + Spring Boot + PostgreSQL | 8080 | services/auth-service/CLAUDE.md |
| order-service | Node.js + Express + MongoDB | 8081 | services/order-service/CLAUDE.md |
| payment-service | Python + FastAPI | 8082 | services/payment-service/CLAUDE.md |

- 진입점: `http://localhost:9000` (Gateway가 JWT 검증 후 백엔드로 라우팅)
- Infra: PostgreSQL · MongoDB · RabbitMQ · ELK Stack

## 빌드 / 실행
```bash
docker-compose up --build   # 전체 스택 빌드 + 시작
docker-compose down         # 중지 (볼륨 보존)
```
서비스별 단독 실행·테스트 명령은 각 서비스의 `CLAUDE.md` 참조.

## ✅ 반드시 (Must)
- **TDD**: 새 동작은 실패 테스트 작성 → 통과 → 리팩터링 순. **테스트 없는 PR 금지.**
- **DDD**: 서비스마다 독립 바운디드 컨텍스트. 도메인 로직은 controller/route 밖(`service/`/`domain/`)에 둔다. 서비스 경계를 넘는 직접 DB 호출 금지.
- **테스트 통과 후 커밋**: 수정 범위에 영향 받는 테스트를 통과시킨 뒤 커밋한다.

## ❌ 절대 금지 (Must Not)
- **DB 데이터 삭제 금지** — 마이그레이션·시드 외 어떤 형태로도 운영/로컬 공유 DB 데이터를 임의 삭제하지 않는다. **`docker-compose down -v`(볼륨 삭제)는 사용자 명시 승인 후에만 실행.**
- **`main` 브랜치 직접 push 금지** — 모든 변경은 `feat/*`·`fix/*`·`refactor/*` 등 feature 브랜치 → PR → 리뷰 → 머지로 진행. `git push origin main`, `git push --force` 금지.
- **민감정보 커밋 금지** — `.env`, API 키, JWT 시크릿, DB 비밀번호 등은 절대 커밋하지 않는다. 새 환경 변수는 `.env.example`에 더미 값으로 등록하고 실제 값은 환경 변수로 주입.
- **destructive 명령 사용자 승인 필수** — `rm -rf`, `git reset --hard`, `git push --force`, DB drop, `docker-compose down -v` 등은 사용자 확인 없이 실행하지 않는다.

## 환경 변수 / 공유 시크릿
- `JWT_SECRET_KEY`: Auth Service ↔ Gateway 동일해야 함. 변경 시 양쪽 동시 갱신.
- `INTERNAL_API_KEY`: Order Service ↔ Payment Service 동일해야 함. 변경 시 양쪽 동시 갱신.
- 신규 환경 변수 추가 시 `.env.example`에 더미 값과 함께 추가.

## 브랜치 / 커밋
- 브랜치: `feat/*`, `fix/*`, `refactor/*`, `chore/*`, `docs/*`
- 커밋 메시지: 한글 + Conventional Commits — 예: `feat(order): 주문 상태 전이 검증 추가`
- PR은 단일 목적 단위, 작업 의도와 검증 방법을 본문에 명시.
