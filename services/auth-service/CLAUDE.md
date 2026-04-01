# Auth Service

## 기술 스택

- **언어/프레임워크**: Kotlin 1.9.24 / Spring Boot 3.3.5
- **Java**: 21
- **데이터베이스**: PostgreSQL 15
- **JWT**: JJWT 0.12.6 (유효기간 1시간)
- **보안**: Spring Security + BCrypt
- **포트**: 8080

## 실행 및 빌드

```bash
cd services/auth-service

./gradlew bootRun        # 로컬 실행
./gradlew clean bootJar  # JAR 빌드
```

로컬 실행 시 PostgreSQL이 `localhost:5432`에 실행 중이어야 한다.

## 엔드포인트

| 메서드 | 경로 | 기능 | 요청 바디 |
|--------|------|------|----------|
| POST | `/api/auth/signup` | 회원가입 | `{email, password, name}` |
| POST | `/api/auth/login` | 로그인 | `{email, password}` |
| GET | `/api/auth/validate` | JWT 검증 | Header: `Authorization: Bearer {token}` |
| GET | `/api/auth/health` | 헬스 체크 | — |

- `/api/auth/validate` 응답: `{valid: boolean, email: string}` — Order Service가 호출함

## DB 설정

**application.yml** (로컬 기본값)
```yaml
spring.datasource:
  url: jdbc:postgresql://localhost:5432/auth_db
  username: myuser
  password: mypassword
jpa.hibernate.ddl-auto: update  # 시작 시 스키마 자동 생성
jwt.secret: ${JWT_SECRET_KEY:default-local-test-key-1234567890}
```

**Docker 환경 변수**
```yaml
SPRING_DATASOURCE_URL: jdbc:postgresql://auth-db:5432/auth_db
SPRING_DATASOURCE_USERNAME: myuser
SPRING_DATASOURCE_PASSWORD: mypassword
```

## User 엔티티 (`users` 테이블)

```kotlin
id: Long (PK, auto-increment)
email: String (unique, not null)
password: String (BCrypt 암호화)
name: String
createdAt: LocalDateTime
lastLoginAt: LocalDateTime?
```

## 핵심 파일

```
src/main/kotlin/com/example/auth/
├── controller/AuthController.kt       # REST 엔드포인트
├── service/AuthService.kt             # 회원가입/로그인 로직
├── config/JwtTokenProvider.kt         # JWT 생성/검증
├── config/SecurityConfig.kt           # Spring Security 설정
├── domain/User.kt                     # JPA 엔티티
└── domain/UserRepository.kt           # DB 접근
```
