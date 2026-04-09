using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;

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

var app = builder.Build();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 미들웨어 파이프라인 순서가 중요합니다!
//
// [변경 전] 기존에는 MapReverseProxy()만 있어서 모든 요청이 무조건 통과했습니다.
// [변경 후] 인증 → 권한 확인 → 헤더 주입 → YARP 프록시 순서로 처리됩니다.
//
// 요청 흐름:
//   클라이언트 → UseAuthentication (토큰 파싱)
//             → UseAuthorization (권한 확인: Anonymous vs 인증 필요)
//             → 커스텀 미들웨어 (X-User-Email 헤더 주입)
//             → MapReverseProxy (백엔드 서비스로 전달)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 1단계: 인증 미들웨어 — Authorization 헤더에서 JWT를 꺼내 검증합니다.
//        검증 성공 시 HttpContext.User에 사용자 정보(claims)를 채웁니다.
app.UseAuthentication();

// 2단계: 권한 미들웨어 — YARP 라우트별 AuthorizationPolicy를 확인합니다.
//        "Anonymous" 라우트: 토큰 없이도 통과
//        "default" 라우트: 인증된 사용자만 통과 (토큰 없으면 401 Unauthorized 반환)
app.UseAuthorization();

// 3단계: [핫픽스] 내부 전용 콜백 경로를 외부에서 접근하지 못하도록 차단합니다.
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

// 4단계: 커스텀 미들웨어 — 인증된 사용자의 이메일을 X-User-Email 헤더에 넣어줍니다.
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

// 4단계: YARP 게이트웨이 활성화 (기존 코드)
app.MapReverseProxy();

app.Run();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// [테스트용] WebApplicationFactory가 Program 클래스를 찾을 수 있게 공개합니다.
// top-level statements(최상위 구문)를 사용하면 컴파일러가 자동으로
// internal class Program을 만드는데, 테스트 프로젝트에서 접근하려면
// public partial로 선언해야 합니다.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
public partial class Program { }
