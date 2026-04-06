# Gateway Service

## 기술 스택

- **언어/프레임워크**: C# / ASP.NET Core 8.0
- **리버스 프록시**: YARP 2.3.0
- **인증**: JWT Bearer (Microsoft.AspNetCore.Authentication.JwtBearer 8.0.13)
- **포트**: 9000

## 실행 및 빌드

```bash
cd services/gateway-service/GatewayService

dotnet run                        # 로컬 실행
dotnet publish -c Release         # 빌드
```

## 라우팅 규칙

`appsettings.json`에 정의되며, Docker 실행 시 환경 변수로 덮어쓴다.

| 요청 경로 | 전달 대상 | 인증 정책 |
|-----------|----------|----------|
| `/auth/{**remainder}` | `http://auth-service:8080/api/` | Anonymous (토큰 불필요) |
| `/order/{**remainder}` | `http://order-service:8081/api/` | default (JWT 필요) |
| `/payment/{**remainder}` | `http://payment-service:8082/api/` | default (JWT 필요) |

경로의 첫 번째 세그먼트(`/auth`, `/order`, `/payment`)는 제거되고 나머지만 업스트림으로 전달된다.

## JWT 인증 (제19강)

Gateway가 JWT를 중앙에서 검증하고, 인증된 사용자의 이메일을 `X-User-Email` 헤더로 백엔드 서비스에 전달한다.

**미들웨어 파이프라인 순서**:
1. `UseAuthentication()` — JWT 토큰 파싱/검증
2. `UseAuthorization()` — 라우트별 인증 정책 확인
3. 커스텀 미들웨어 — `X-User-Email` 헤더 주입
4. `MapReverseProxy()` — YARP 프록시

**JWT 설정**: `appsettings.json`의 `Jwt` 섹션
- `SecretKey`: Auth Service의 `jwt.secret`과 동일해야 함
- `Issuer`: `msa-auth-service` (Auth Service가 발급한 토큰만 수락, 제20강)
- `Audience`: `msa-gateway` (이 Gateway를 대상으로 발급된 토큰만 수락, 제20강)

## Docker 환경 변수

YARP 설정은 `__`로 계층을 구분해 환경 변수로 오버라이드한다.

```yaml
ASPNETCORE_ENVIRONMENT: Production
ReverseProxy__Clusters__auth-cluster__Destinations__dest1__Address: http://auth-service:8080/api/
ReverseProxy__Clusters__order-cluster__Destinations__dest1__Address: http://order-service:8081/api/
ReverseProxy__Clusters__payment-cluster__Destinations__dest1__Address: http://payment-service:8082/api/
Jwt__SecretKey: ${JWT_SECRET_KEY:-default-local-test-key-1234567890}
```

## 테스트

```bash
cd services/gateway-service/GatewayService.Tests
dotnet test
```

xUnit + WebApplicationFactory 기반. JWT 인증 미들웨어의 라우트별 동작을 검증한다.

## 핵심 파일

- `GatewayService/Program.cs` — JWT 인증 + YARP 등록 및 앱 구성
- `GatewayService/appsettings.json` — JWT 설정 + 라우트/클러스터 정의
- `GatewayService.Tests/JwtAuthenticationTests.cs` — JWT 인증 테스트
