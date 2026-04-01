# AGENTS.md (auth-service)

## 범위

이 가이드는 `services/auth-service` 작업에만 적용합니다.

## 역할

- 회원가입/로그인/JWT 검증 API 제공
- PostgreSQL 사용자 저장소 관리
- Spring Security + JWT 필터 체인 관리

## 주요 파일

- `src/main/kotlin/com/example/auth/controller/AuthController.kt`
- `src/main/kotlin/com/example/auth/service/AuthService.kt`
- `src/main/kotlin/com/example/auth/config/SecurityConfig.kt`
- `src/main/kotlin/com/example/auth/config/JwtAuthenticationFilter.kt`
- `src/main/kotlin/com/example/auth/config/JwtTokenProvider.kt`
- `src/main/resources/application.yml`
- `build.gradle.kts`
- `Dockerfile`

## 핵심 API

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `GET /api/auth/validate`
- `GET /api/auth/health`

## 로컬 실행/검증

```bash
cd services/auth-service
./gradlew bootRun
```

테스트:

```bash
cd services/auth-service
./gradlew test
```

## 작업 원칙

- 인증 관련 변경 시 `AuthController`와 `SecurityConfig`를 함께 점검합니다.
- JWT secret은 코드 하드코딩 대신 설정/환경변수(`jwt.secret`, `JWT_SECRET_KEY`)를 사용합니다.
- 예외 응답 포맷 변경 시 `GlobalExceptionHandler`와 DTO를 함께 맞춥니다.
- API 계약 변경 시 호출자(order-service) 영향 여부를 반드시 확인합니다.
