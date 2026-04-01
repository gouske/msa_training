# Gateway Service

## 기술 스택

- **언어/프레임워크**: C# / ASP.NET Core 8.0
- **리버스 프록시**: YARP 2.3.0
- **포트**: 9000

## 실행 및 빌드

```bash
cd services/gateway-service/GatewayService

dotnet run                        # 로컬 실행
dotnet publish -c Release         # 빌드
```

## 라우팅 규칙

`appsettings.json`에 정의되며, Docker 실행 시 환경 변수로 덮어쓴다.

| 요청 경로 | 전달 대상 |
|-----------|----------|
| `/auth/{**remainder}` | `http://auth-service:8080/api/` |
| `/order/{**remainder}` | `http://order-service:8081/api/` |
| `/payment/{**remainder}` | `http://payment-service:8082/api/` |

경로의 첫 번째 세그먼트(`/auth`, `/order`, `/payment`)는 제거되고 나머지만 업스트림으로 전달된다.

## Docker 환경 변수

YARP 설정은 `__`로 계층을 구분해 환경 변수로 오버라이드한다.

```yaml
ASPNETCORE_ENVIRONMENT: Production
ReverseProxy__Clusters__auth-cluster__Destinations__dest1__Address: http://auth-service:8080/api/
ReverseProxy__Clusters__order-cluster__Destinations__dest1__Address: http://order-service:8081/api/
ReverseProxy__Clusters__payment-cluster__Destinations__dest1__Address: http://payment-service:8082/api/
```

## 핵심 파일

- `GatewayService/Program.cs` — YARP 등록 및 앱 구성
- `GatewayService/appsettings.json` — 라우트/클러스터 정의
