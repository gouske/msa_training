# AGENTS.md (gateway-service)

## 범위

이 가이드는 `services/gateway-service` 작업에만 적용합니다.

## 역할

- API Gateway 역할 담당
- YARP Reverse Proxy로 경로 기반 라우팅 수행
- 직접 비즈니스 로직은 두지 않고 라우팅/엣지 설정에 집중

## 주요 파일

- `GatewayService/Program.cs`
- `GatewayService/appsettings.json`
- `GatewayService/appsettings.Development.json`
- `GatewayService/GatewayService.csproj`
- `GatewayService/Dockerfile`

## 라우팅 규칙

- `/auth/*` -> `auth-service:8080/api/*`
- `/order/*` -> `order-service:8081/api/*`
- `/payment/*` -> `payment-service:8082/api/*`

경로 prefix(`/auth`, `/order`, `/payment`)와 대상 서비스의 `/api` prefix를 혼동하지 않습니다.

## 로컬 실행/검증

```bash
cd services/gateway-service/GatewayService
dotnet run
```

헬스 확인(백엔드 서비스 기동 필요):

- `GET http://localhost:9000/auth/health`
- `GET http://localhost:9000/order/health`
- `GET http://localhost:9000/payment/health`

## 작업 원칙

- 라우팅 변경 시 `appsettings.json`과 Docker/환경변수 오버라이드 동작을 함께 점검합니다.
- 서비스 주소를 하드코딩하지 말고 환경별 설정 우선순위를 유지합니다.
- 인증/주문/결제 비즈니스 로직은 각 서비스에서 수정합니다.
