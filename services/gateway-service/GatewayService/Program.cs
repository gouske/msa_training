using System.Text;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;
// [제24강 Phase 2] prometheus-net.AspNetCore — UseHttpMetrics, MapMetrics 확장 메서드
using Prometheus;

var builder = WebApplication.CreateBuilder(args);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// [제19강 추가] JWT 인증 서비스 등록
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// appsettings.json의 "Jwt:SecretKey"에서 비밀 키를 읽어옵니다.
// 이 키는 Auth Service(Kotlin)가 JWT를 서명할 때 사용하는 키와 반드시 동일해야 합니다.
// Docker 환경에서는 환경 변수 Jwt__SecretKey로 오버라이드됩니다.
var jwtSecretKey = builder.Configuration["Jwt:SecretKey"]
    ?? throw new InvalidOperationException("Jwt:SecretKey 설정이 필요합니다.");
var signingKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtSecretKey));

// [제20강 추가] JWT 발급자(Issuer)와 대상(Audience) 설정
// Auth Service가 발급한 토큰에만 이 값이 들어 있으므로, 다른 시스템의 토큰을 거부할 수 있습니다.
var jwtIssuer = builder.Configuration["Jwt:Issuer"] ?? "msa-auth-service";
var jwtAudience = builder.Configuration["Jwt:Audience"] ?? "msa-gateway";

// AddAuthentication(): 인증 시스템을 DI 컨테이너에 등록합니다.
// JwtBearerDefaults.AuthenticationScheme = "Bearer" → 기본 인증 방식을 JWT Bearer로 설정합니다.
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        // [변경 전] 기존에는 이 설정이 없었습니다. Gateway는 토큰을 검사하지 않고 그냥 통과시켰습니다.
        // [변경 후] 이제 Gateway가 직접 토큰을 검증합니다. Auth Service를 호출하지 않고 비밀 키로 서명을 확인합니다.

        // MapInboundClaims = false: JWT의 claim 이름을 .NET 기본 형식으로 변환하지 않습니다.
        // 예: "sub" → ClaimTypes.NameIdentifier 변환을 막아서 JWT 원본 이름("sub")을 그대로 유지합니다.
        // 이렇게 하면 Auth Service가 설정한 claim 이름과 일치하므로 혼동이 없습니다.
        options.MapInboundClaims = false;

        options.TokenValidationParameters = new TokenValidationParameters
        {
            // ✅ 서명 키 검증: 토큰이 우리가 아는 비밀 키로 서명되었는지 확인합니다.
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = signingKey,

            // [제20강 변경] 발행자(Issuer) 검증 활성화
            // 이전: ValidateIssuer = false (Auth Service가 iss를 설정하지 않았으므로)
            // 이후: ValidateIssuer = true (Auth Service가 iss = "msa-auth-service"를 설정)
            // → 다른 시스템에서 발급한 토큰을 거부할 수 있습니다.
            ValidateIssuer = true,
            ValidIssuer = jwtIssuer,

            // [제20강 변경] 대상(Audience) 검증 활성화
            // 이전: ValidateAudience = false (Auth Service가 aud를 설정하지 않았으므로)
            // 이후: ValidateAudience = true (Auth Service가 aud = "msa-gateway"를 설정)
            // → 이 Gateway를 대상으로 발급된 토큰만 수락합니다.
            ValidateAudience = true,
            ValidAudience = jwtAudience,

            // ✅ 토큰 만료 시간 검증: "exp" claim을 확인하여 만료된 토큰을 거부합니다.
            ValidateLifetime = true,

            // ClockSkew = 0: 기본값은 5분의 여유 시간이 있지만, 학습용으로 정확한 만료를 적용합니다.
            // 실무에서는 서버 간 시간 차이를 고려하여 1~2분 정도 여유를 두기도 합니다.
            ClockSkew = TimeSpan.Zero,

            // NameClaimType: User.Identity.Name에 어떤 claim 값을 넣을지 지정합니다.
            // "sub" = JWT의 subject claim = Auth Service가 넣은 사용자 이메일입니다.
            NameClaimType = "sub"
        };
    });

// AddAuthorization(): 권한 부여 시스템을 등록합니다.
// YARP 라우트에서 "AuthorizationPolicy": "default"로 설정하면
// ASP.NET Core의 기본 정책(RequireAuthenticatedUser)이 적용됩니다.
builder.Services.AddAuthorization();

// [실전 #6] Consul 동적 라우팅
// 1. Routes는 정적: appsettings.json 의 ReverseProxy.Routes 섹션을 한 번만 읽어 List<RouteConfig> 로 변환
//    각 route 에 PathRemovePrefix transform 을 자동으로 붙여, 요청 "/auth/api/auth/signup" 에서
//    "/auth" prefix 를 제거한 뒤 백엔드의 실제 경로 "/api/auth/signup" 으로 전달한다.
//    (route-id 규칙: "auth-route" → prefix "/auth", "order-route" → "/order", "payment-route" → "/payment")
var staticRoutes = builder.Configuration
    .GetSection("ReverseProxy:Routes")
    .GetChildren()
    .Select(routeSection =>
    {
        var routeId = routeSection.Key;
        var pathPrefix = "/" + routeId.Split('-')[0]; // "auth-route" → "/auth"
        var route = new Yarp.ReverseProxy.Configuration.RouteConfig
        {
            RouteId = routeId,
            ClusterId = routeSection["ClusterId"],
            Match = new Yarp.ReverseProxy.Configuration.RouteMatch
            {
                Path = routeSection.GetSection("Match")["Path"],
            },
            AuthorizationPolicy = routeSection["AuthorizationPolicy"],
            Transforms = new List<IReadOnlyDictionary<string, string>>
            {
                new Dictionary<string, string> { ["PathRemovePrefix"] = pathPrefix }
            },
        };
        return route;
    })
    .ToList();

// 2. ConsulHealthClient를 HttpClient + Consul:Address 로 등록
var consulAddress = builder.Configuration["Consul:Address"] ?? "http://localhost:8500";
builder.Services.AddHttpClient<GatewayService.Discovery.ConsulHealthClient>(c =>
{
    c.BaseAddress = new Uri(consulAddress);
    c.Timeout = TimeSpan.FromSeconds(3);
});

// 3. Provider를 싱글턴으로 등록 + IProxyConfigProvider 인터페이스에도 같은 인스턴스 노출
builder.Services.AddSingleton(sp =>
    new GatewayService.Discovery.ConsulProxyConfigProvider(
        staticRoutes,
        sp.GetRequiredService<ILogger<GatewayService.Discovery.ConsulProxyConfigProvider>>()));
builder.Services.AddSingleton<Yarp.ReverseProxy.Configuration.IProxyConfigProvider>(sp =>
    sp.GetRequiredService<GatewayService.Discovery.ConsulProxyConfigProvider>());

// 4. 폴링 워커 등록 (BackgroundService)
var pollingServices = builder.Configuration.GetSection("Consul:Services").Get<string[]>()
    ?? new[] { "auth-service", "order-service", "payment-service" };
var intervalSec = builder.Configuration.GetValue<int?>("Consul:PollIntervalSeconds") ?? 5;

builder.Services.AddHostedService(sp => new GatewayService.Discovery.ConsulPollingWorker(
    sp.GetRequiredService<GatewayService.Discovery.ConsulHealthClient>(),
    sp.GetRequiredService<GatewayService.Discovery.ConsulProxyConfigProvider>(),
    pollingServices,
    TimeSpan.FromSeconds(intervalSec),
    sp.GetRequiredService<ILogger<GatewayService.Discovery.ConsulPollingWorker>>()));

// 5. YARP 등록 — 등록된 IProxyConfigProvider 자동 사용 (LoadFromConfig 호출하지 않음)
builder.Services.AddReverseProxy();

// [Issue #11] readiness 검사기 — 필수 cluster 가 모두 라우팅 가능해야 200 을 반환한다.
// pollingServices 와 동일한 목록을 사용 → "Consul 에서 폴링 중인 서비스가 모두 healthy 인스턴스 ≥ 1" 일 때 ready.
builder.Services.AddSingleton(sp => new GatewayService.Discovery.ReadinessChecker(
    sp.GetRequiredService<Yarp.ReverseProxy.Configuration.IProxyConfigProvider>(),
    pollingServices));

var app = builder.Build();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 미들웨어 파이프라인 순서가 중요합니다!
//
// [변경 전] 기존에는 MapReverseProxy()만 있어서 모든 요청이 무조건 통과했습니다.
// [변경 후] Correlation ID → 인증 → 권한 확인 → 헤더 주입 → YARP 프록시 순서로 처리됩니다.
//
// 요청 흐름:
//   클라이언트 → Correlation ID 미들웨어 (모든 요청에 추적 ID 부여 — 반드시 최우선)
//             → UseAuthentication (토큰 파싱)
//             → UseAuthorization (권한 확인: Anonymous vs 인증 필요)
//             → 커스텀 미들웨어 (X-User-Email 헤더 주입)
//             → MapReverseProxy (백엔드 서비스로 전달)
//
// [제20강] Correlation ID가 UseAuthentication 앞에 있어야 하는 이유:
//   UseAuthorization이 401을 반환하면 파이프라인이 그 시점에서 끊깁니다.
//   Correlation ID 미들웨어가 뒤에 있으면 실행 자체가 되지 않아
//   401 응답 헤더에 X-Correlation-ID가 포함되지 않습니다.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// [제20강 / Issue #8] 1단계: Correlation ID 미들웨어 — 반드시 인증보다 먼저 등록합니다.
// 역할: 모든 요청에 고유 ID를 붙여서, 여러 마이크로서비스를 거치는 요청을 하나로 추적합니다.
// 흐름: 외부 클라이언트가 X-Correlation-ID를 보내면 검증 후 통과 시 재사용,
//       없거나 형식이 부적합하면 Gateway에서 새 UUID를 생성합니다.
//       → 응답 헤더에도 동일한 ID를 돌려줍니다.
//
// [Issue #8 보안 강화]
//   - 외부 입력을 그대로 다운스트림에 전파하면 악의적 값(과대길이/제어문자/비ASCII)이
//     Order/Payment 의 헤더 파싱 또는 RabbitMQ 메시지 처리를 방해할 수 있어
//     주문이 반복적으로 DLQ 로 이동(오염)될 위험이 있다.
//   - 허용 charset = `[A-Za-z0-9_-]`, 길이 1~64 (UUID 36자 + 여유)
//   - 검증 실패 시 서버 생성 UUID 로 치환 (요청 자체는 거부하지 않음 — 추적 가능성 유지)
//   - 치환 발생 시 WARN 로그로 기록 → 공격 시도/포맷 회귀 관측 가능
//     (원본 값은 기록하지 않음 — 로그 인젝션 방지, 길이만 노출)
var correlationIdPattern = new Regex(@"^[A-Za-z0-9_-]{1,64}$", RegexOptions.Compiled);
var correlationIdLogger = app.Services.GetRequiredService<ILoggerFactory>()
    .CreateLogger("CorrelationId");

app.Use(async (context, next) =>
{
    // 1) 클라이언트가 헤더를 보냈으면 검증, 통과 시 재사용 / 실패 시 새 UUID 생성
    var inboundId = context.Request.Headers["X-Correlation-ID"].ToString();
    string correlationId;
    if (correlationIdPattern.IsMatch(inboundId))
    {
        correlationId = inboundId;
    }
    else
    {
        correlationId = Guid.NewGuid().ToString();
        // 비어있지 않은 입력이 규칙 불일치 → 부정 입력으로 간주하고 WARN 기록.
        // 빈 값(헤더 누락)은 정상 흐름이므로 로그 생략.
        if (!string.IsNullOrEmpty(inboundId))
        {
            correlationIdLogger.LogWarning(
                "X-Correlation-ID 부정 입력 치환 — 원본 길이={InboundLength}, 치환 ID={CorrelationId}",
                inboundId.Length, correlationId);
        }
    }

    // 2) 다운스트림으로 흘려보낼 헤더는 항상 검증된 값으로 덮어쓴다.
    //    Headers 인덱서 할당은 기존 값을 교체한다 — 외부 부정 입력 차단.
    context.Request.Headers["X-Correlation-ID"] = correlationId;

    // 3) 응답 헤더에도 동일한 ID를 추가 → 클라이언트가 자신의 요청을 추적할 수 있습니다.
    //    OnStarting: 응답 본문이 쓰이기 직전에 실행되므로 401/403 응답에도 헤더가 포함됩니다.
    context.Response.OnStarting(() =>
    {
        context.Response.Headers["X-Correlation-ID"] = correlationId;
        return Task.CompletedTask;
    });

    await next();
});

// 2단계: 인증 미들웨어 — Authorization 헤더에서 JWT를 꺼내 검증합니다.
//        검증 성공 시 HttpContext.User에 사용자 정보(claims)를 채웁니다.
app.UseAuthentication();

// 3단계: 권한 미들웨어 — YARP 라우트별 AuthorizationPolicy를 확인합니다.
//        "Anonymous" 라우트: 토큰 없이도 통과
//        "default" 라우트: 인증된 사용자만 통과 (토큰 없으면 401 Unauthorized 반환)
app.UseAuthorization();

// 4단계: [핫픽스] 내부 전용 콜백 경로를 외부에서 접근하지 못하도록 차단합니다.
// 문제: /order/{**remainder} 와일드카드가 /order/order/callback도 프록시하여
//       외부 사용자가 내부 콜백 API에 도달할 수 있었습니다.
// 해결: 요청 경로에 "/order/callback"이 포함되면 즉시 403을 반환합니다.
app.Use(async (context, next) =>
{
    if (context.Request.Path.Value?.Contains("/order/callback", StringComparison.OrdinalIgnoreCase) == true)
    {
        context.Response.StatusCode = 403;
        context.Response.ContentType = "application/json";
        await context.Response.WriteAsync("{\"message\":\"내부 전용 엔드포인트입니다.\"}");
        return;
    }
    await next();
});

// 5단계: 커스텀 미들웨어 — 인증된 사용자의 이메일을 X-User-Email 헤더에 넣어줍니다.
// [변경 전] 기존에는 Order Service가 Auth Service에 HTTP 호출을 해서 이메일을 받아왔습니다.
// [변경 후] Gateway가 JWT에서 이메일을 추출하여 헤더로 전달합니다.
//          → Order Service는 이 헤더만 읽으면 되므로 Auth Service를 호출할 필요가 없습니다.
app.Use(async (context, next) =>
{
    // User.Identity.IsAuthenticated: JWT 검증이 성공했는지 확인합니다.
    // Anonymous 라우트(/auth/*)에서는 false이므로 헤더가 추가되지 않습니다.
    if (context.User.Identity?.IsAuthenticated == true)
    {
        // User.Identity.Name: 위에서 NameClaimType = "sub"으로 설정했으므로
        // JWT의 subject claim(=사용자 이메일)이 Name에 들어 있습니다.
        var email = context.User.Identity.Name;
        if (!string.IsNullOrEmpty(email))
        {
            // 백엔드 서비스(Order, Payment)로 전달되는 요청에 이메일 헤더를 추가합니다.
            context.Request.Headers["X-User-Email"] = email;
        }
    }
    await next();
});

// [제22강 추가] K8s livenessProbe 용 헬스 체크 엔드포인트.
// 프로세스 생존만 확인 — DB/Consul 상태 무관하게 200 을 반환한다.
// YARP 보다 먼저 등록해야 YARP가 캡처하지 않는다.
app.MapGet("/health", () => Results.Ok(new { status = "healthy" }))
    .AllowAnonymous();

// [Issue #11] K8s readinessProbe 전용 엔드포인트.
// auth/order/payment cluster 모두 ≥1 destination 을 보유할 때만 200 을 반환한다.
// 그렇지 않으면 503 + 누락 cluster 목록 → Service endpoint 에서 자동으로 제외돼 트래픽이 격리된다.
app.MapGet("/health/ready", (GatewayService.Discovery.ReadinessChecker checker) =>
{
    var result = checker.Check();
    if (result.IsReady)
    {
        return Results.Ok(new { status = "ready", missingClusters = Array.Empty<string>() });
    }
    return Results.Json(
        new { status = "not_ready", missingClusters = result.MissingClusters },
        statusCode: StatusCodes.Status503ServiceUnavailable);
}).AllowAnonymous();

// [제24강 Phase 2] Prometheus 메트릭 — prometheus-net.AspNetCore
//   UseHttpMetrics: 모든 HTTP 요청의 method/code/endpoint/duration 자동 수집.
//     라이브러리가 ASP.NET Core 의 라우트 매칭 결과를 endpoint 라벨로 사용하므로
//     Phase 1 의 "raw URL 노출 차단" 약속과 호환된다.
//   MapMetrics: GET /metrics 노출. 자기 자신은 endpoint 라벨이 채워지지 않아 카디널리티 안전.
//   YARP MapReverseProxy 보다 먼저 등록해야 YARP catch-all 이 /metrics 를 잡지 않는다.
app.UseHttpMetrics();
app.MapMetrics().AllowAnonymous();

// 6단계: YARP 게이트웨이 활성화 (기존 코드)
app.MapReverseProxy();

app.Run();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// [테스트용] WebApplicationFactory가 Program 클래스를 찾을 수 있게 공개합니다.
// top-level statements(최상위 구문)를 사용하면 컴파일러가 자동으로
// internal class Program을 만드는데, 테스트 프로젝트에서 접근하려면
// public partial로 선언해야 합니다.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
public partial class Program { }
