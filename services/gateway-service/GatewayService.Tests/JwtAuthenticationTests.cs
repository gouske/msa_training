/**
 * [테스트] Gateway JWT 인증 미들웨어 검증
 *
 * 학습 포인트:
 *   1. WebApplicationFactory로 ASP.NET Core 앱을 메모리에서 실행하는 방법
 *   2. System.IdentityModel.Tokens.Jwt로 테스트용 JWT 토큰을 직접 생성하는 방법
 *   3. YARP 라우트별 인증 정책(Anonymous vs default)이 올바르게 동작하는지 검증
 *
 * 테스트 전략:
 *   YARP는 실제 백엔드 서비스(Auth, Order, Payment)가 없으면 프록시에 실패합니다.
 *   하지만 인증 미들웨어는 YARP보다 먼저 실행되므로:
 *     - 401 반환 = 인증 실패 (미들웨어가 거부, YARP 실행 전에 차단)
 *     - 401 아님 = 인증 통과 (YARP가 백엔드 연결을 시도했다는 의미)
 *   이 차이로 인증 로직이 올바른지 검증할 수 있습니다.
 *
 * 실행: cd GatewayService.Tests && dotnet test
 */

using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Text;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.IdentityModel.Tokens;
using Xunit;

namespace GatewayService.Tests;

/// <summary>
/// Gateway의 JWT 인증 미들웨어를 테스트하는 클래스입니다.
/// WebApplicationFactory<Program>: Program.cs의 전체 미들웨어 파이프라인을
/// 실제 HTTP 서버 없이 메모리 안에서 실행합니다.
/// </summary>
public class JwtAuthenticationTests : IClassFixture<WebApplicationFactory<Program>>
{
    // _client: 테스트에서 HTTP 요청을 보내는 가짜 클라이언트입니다.
    // 실제 네트워크를 거치지 않고 메모리 안에서 요청/응답을 처리합니다.
    private readonly HttpClient _client;

    // Auth Service와 동일한 비밀 키 (appsettings.json의 Jwt:SecretKey와 일치해야 합니다)
    private const string TestSecretKey = "default-local-test-key-1234567890";

    // [제20강 추가] Auth Service와 동일한 Issuer/Audience 값
    // appsettings.json의 Jwt:Issuer, Jwt:Audience와 일치해야 합니다.
    private const string TestIssuer = "msa-auth-service";
    private const string TestAudience = "msa-gateway";

    /// <summary>
    /// 생성자: WebApplicationFactory에서 테스트용 HttpClient를 생성합니다.
    /// IClassFixture 인터페이스 덕분에 이 클래스의 모든 테스트가
    /// 같은 Factory 인스턴스를 공유합니다 (앱을 매번 새로 띄우지 않음).
    /// </summary>
    public JwtAuthenticationTests(WebApplicationFactory<Program> factory)
    {
        // CreateClient(): 메모리 내 테스트 서버에 연결된 HttpClient를 생성합니다.
        // 이 클라이언트로 보내는 요청은 실제 Program.cs의 미들웨어 파이프라인을 통과합니���.
        _client = factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            // AllowAutoRedirect = false: 리다이렉트를 자동으로 따라가지 않습니다.
            // 401 응답을 정확히 받기 위해 필요합니다.
            AllowAutoRedirect = false
        });
    }

    // ══════════════════════════════════════════════════════════════
    // 헬퍼 메서드: 테스트용 JWT 토큰 생성
    // ════════���═════════════════════════════════════════════════════

    /// <summary>
    /// 테스트용 JWT 토큰을 생성합니다. Auth Service의 JwtTokenProvider.createToken()과
    /// 동일한 형식으로 토큰을 만들어 Gateway가 정상적으로 검증할 수 있게 합니다.
    /// </summary>
    /// <param name="email">토큰에 넣을 사용자 이메일 (sub claim)</param>
    /// <param name="secretKey">서명에 사용할 비밀 키</param>
    /// <param name="expiresIn">토큰 만료 시간 (null이면 1시간)</param>
    /// <returns>서명된 JWT 문자열 (예: "eyJhbGciOi...")</returns>
    /// <param name="issuer">토큰 발급자 (null이면 기본값 사용)</param>
    /// <param name="audience">토큰 대상 (null이면 기본값 사용)</param>
    private static string CreateTestToken(
        string email = "test@example.com",
        string? secretKey = null,
        TimeSpan? expiresIn = null,
        string? issuer = TestIssuer,
        string? audience = TestAudience)
    {
        // 서명 키 생성: UTF-8 바이트 배열 → SymmetricSecurityKey
        // Auth Service(Kotlin)의 Keys.hmacShaKeyFor(secretKeyString.toByteArray())와 동일합니다.
        var key = new SymmetricSecurityKey(
            Encoding.UTF8.GetBytes(secretKey ?? TestSecretKey));

        // SigningCredentials: 어떤 키와 알고리즘으로 서명할지 지정합니다.
        // HmacSha256 = Auth Service의 signWith(secretKey)와 동일한 HS256 알고리즘입니다.
        var credentials = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

        // SecurityTokenDescriptor: JWT의 구성 요소를 정의합니다.
        // 만료된 토큰을 생성하기 위해 NotBefore와 IssuedAt도 과거로 설정해야 합니다.
        // 그렇지 않으면 JwtSecurityTokenHandler가 "만료가 발급시간보다 이전"이라는 오류를 발생시킵니다.
        var now = DateTime.UtcNow;
        var expiresDuration = expiresIn ?? TimeSpan.FromHours(1);
        var isExpired = expiresDuration.TotalSeconds < 0;

        var tokenDescriptor = new SecurityTokenDescriptor
        {
            // Subject: JWT의 payload에 들어갈 claim(정보)들입니다.
            // "sub" claim에 이메일을 넣습니다 — Auth Service의 .subject(email)과 동일합니다.
            Subject = new ClaimsIdentity(new[]
            {
                // JwtRegisteredClaimNames.Sub = "sub" (JWT 표준 claim 이름)
                new Claim(JwtRegisteredClaimNames.Sub, email)
            }),

            // 만료된 토큰을 만들 때: 발급 시간과 NotBefore도 과거로 설정합니다.
            // 예: 2시간 전 발급, 1시간 전 만료 → 현재 시점에서 이미 만료된 토큰
            NotBefore = isExpired ? now.AddHours(-2) : now,
            IssuedAt  = isExpired ? now.AddHours(-2) : now,

            // Expires: 토큰 만료 시간입니다.
            // 기본값 1시간 — Auth Service의 validityInMilliseconds(3600000)과 동일합니다.
            Expires = isExpired ? now.AddSeconds(-1) : now.Add(expiresDuration),

            // [제20강 추가] 발급자(Issuer)와 대상(Audience) claim
            // Auth Service가 JWT에 넣는 "iss"와 "aud" 값을 동일하게 설정합니다.
            Issuer = issuer,
            Audience = audience,

            // SigningCredentials: 위에서 만든 서명 정보를 사용합니다.
            SigningCredentials = credentials
        };

        // JwtSecurityTokenHandler: .NET에서 JWT를 생성/파싱하는 표준 도구입니다.
        var tokenHandler = new JwtSecurityTokenHandler();

        // CreateToken: tokenDescriptor 기반으로 JWT 객체를 생성합니다.
        var token = tokenHandler.CreateToken(tokenDescriptor);

        // WriteToken: JWT 객체를 "header.payload.signature" 문자열로 변환합니다.
        return tokenHandler.WriteToken(token);
    }

    // ══════════════════════════════════════════════════════════════
    // 보호된 경로 (/order/*) 테스트 — "default" 정책 (인증 필요)
    // ═════════���════════════════════════════════���═══════════════════

    /// <summary>
    /// 토큰 없이 보호된 경로에 접근하면 401 Unauthorized를 반환합니다.
    ///
    /// 흐름: 요청 → UseAuthentication(토큰 없음) → UseAuthorization(인증 필요)
    ///       → 401 반환 (YARP까지 도달하지 않음)
    /// </summary>
    [Fact]
    public async Task OrderRoute_NoToken_Returns401()
    {
        // WHEN: 토큰 없이 보호된 경로 요청
        var response = await _client.GetAsync("/order/health");

        // THEN: 401 Unauthorized (인증 미들웨어가 차단)
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    /// <summary>
    /// 유효한 토큰으로 보호된 경로에 접근하면 인증을 통과합니다.
    /// 401이 아닌 응답 = 인증 성공 → YARP가 백엔드 연결을 시도했다는 의미입니다.
    /// (백엔드가 없으므로 502 Bad Gateway 등이 올 수 있지만, 핵심은 401이 아닌 것입니다)
    ///
    /// 흐름: 요청 → UseAuthentication(토큰 검증 성공) → UseAuthorization(통과)
    ///       → 커스텀 미들웨어(X-User-Email 주입) → YARP(백엔드 연결 시도)
    /// </summary>
    [Fact]
    public async Task OrderRoute_ValidToken_PassesAuthentication()
    {
        // GIVEN: 유효한 JWT 토큰 생성 (Auth Service가 발급한 것과 동일한 형식)
        var token = CreateTestToken("buyer@test.com");

        // WHEN: Authorization: Bearer {토큰} 헤더와 함께 요청
        var request = new HttpRequestMessage(HttpMethod.Get, "/order/health");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await _client.SendAsync(request);

        // THEN: 401이 아닌 응답 = 인증 통과
        // 백엔드 서비스가 없으므로 502 등이 올 수 있지만, 인증은 성공한 것입��다.
        Assert.NotEqual(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    /// <summary>
    /// 만료된 토큰으로 접근하면 401 Unauthorized를 반환합니다.
    /// TokenValidationParameters.ValidateLifetime = true이므로 만료된 토큰은 거부됩���다.
    ///
    /// 흐름: 요청 → UseAuthentication(만료 확인 → 실패) → 401 반환
    /// </summary>
    [Fact]
    public async Task OrderRoute_ExpiredToken_Returns401()
    {
        // GIVEN: 이미 만료된 토큰 생성 (1초 전에 만료)
        // TimeSpan.FromSeconds(-1): 현재 시간보다 1초 전이 만료 시간
        var expiredToken = CreateTestToken(expiresIn: TimeSpan.FromSeconds(-1));

        // WHEN: 만료된 토큰으로 요청
        var request = new HttpRequestMessage(HttpMethod.Get, "/order/health");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", expiredToken);
        var response = await _client.SendAsync(request);

        // THEN: 401 Unauthorized (만료된 토큰 거부)
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    /// <summary>
    /// 다른 비밀 키로 서명된 토큰은 401 Unauthorized를 반환합니다.
    /// 서명 검증 실패: 토큰의 서명이 Gateway가 알고 있는 키와 일치하지 않습니다.
    ///
    /// 실무에서 이런 경우:
    ///   - 다른 시스템에서 발급한 토큰으로 접근 시도
    ///   - 토큰을 위조하려는 공격 시도
    /// </summary>
    [Fact]
    public async Task OrderRoute_WrongSignature_Returns401()
    {
        // GIVEN: 다른 키로 서명된 토큰 (Gateway의 키와 불일치)
        // Gateway는 "default-local-test-key-1234567890"을 기대하지만
        // 이 토큰은 "completely-different-secret-key-999"로 서명되었습니다.
        var wrongKeyToken = CreateTestToken(
            secretKey: "completely-different-secret-key-999");

        // WHEN: 잘못된 서명의 토큰으로 요청
        var request = new HttpRequestMessage(HttpMethod.Get, "/order/health");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", wrongKeyToken);
        var response = await _client.SendAsync(request);

        // THEN: 401 Unauthorized (서명 검증 실패)
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    /// <summary>
    /// 형식이 잘못된 토큰(JWT가 아닌 문자열)은 401 Unauthorized를 반환합니다.
    /// </summary>
    [Fact]
    public async Task OrderRoute_MalformedToken_Returns401()
    {
        // GIVEN: JWT 형식이 아닌 임의 문자열
        var request = new HttpRequestMessage(HttpMethod.Get, "/order/health");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", "not-a-valid-jwt");
        var response = await _client.SendAsync(request);

        // THEN: 401 Unauthorized
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    // ════��═════════════════════════════════════════════════════════
    // Anonymous 경로 (/auth/*) 테스트 — "Anonymous" 정책 (인증 불필요)
    // ══════════════════════════════════════════════════════════════

    /// <summary>
    /// auth 경로는 토큰 없이도 접근 가능합니다.
    /// appsettings.json에서 auth-route의 AuthorizationPolicy를 "Anonymous"로 설정했기 때문입니다.
    /// 로그인/회원가입은 토큰이 없는 상태에서 호출해야 하므로 인증을 요구하면 안 됩니다.
    ///
    /// 흐름: 요청 → UseAuthentication(토큰 없음, 괜찮음)
    ///       → UseAuthorization(Anonymous 정책 → 통과)
    ///       → YARP(백엔드 연결 시도)
    /// </summary>
    [Fact]
    public async Task AuthRoute_NoToken_DoesNotReturn401()
    {
        // WHEN: 토큰 없이 auth 경로 요청
        var response = await _client.GetAsync("/auth/health");

        // THEN: 401이 아닌 응답 (인증 없이 접근 허용)
        // 백엔드가 없으므로 502 등이 올 수 있지만, 핵심은 인증에서 차단되지 않는 것입니다.
        Assert.NotEqual(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    // ���════════════════════════════��════════════════════════════════
    // Payment 경로 (/payment/*) 테스트 — "default" 정책 (인증 필요)
    // ══════════════════════════════════════════════════════════════

    /// <summary>
    /// payment 경로도 order 경로와 마찬가지로 인증이 필요합니다.
    /// 토큰 없이 접근하면 401을 반환합니다.
    /// </summary>
    [Fact]
    public async Task PaymentRoute_NoToken_Returns401()
    {
        // WHEN: 토큰 없이 payment 경로 요청
        var response = await _client.GetAsync("/payment/health");

        // THEN: 401 Unauthorized
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    /// <summary>
    /// payment 경로에 유효한 토큰으로 접근하면 인증을 통과합니다.
    /// </summary>
    [Fact]
    public async Task PaymentRoute_ValidToken_PassesAuthentication()
    {
        // GIVEN: 유효한 JWT 토큰
        var token = CreateTestToken("payer@test.com");

        // WHEN: 토큰과 함께 payment 경로 요청
        var request = new HttpRequestMessage(HttpMethod.Get, "/payment/health");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await _client.SendAsync(request);

        // THEN: 401이 아닌 응답 = 인증 통과
        Assert.NotEqual(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    // ══════════════════════════════════════════════════════════════
    // [제20강 추가] Issuer/Audience 검증 테스트
    // ══════════════════════════════════════════════════════════════

    /// <summary>
    /// 다른 발급자(Issuer)의 토큰은 401 Unauthorized를 반환합니다.
    /// Gateway는 "msa-auth-service"가 발급한 토큰만 수락합니다.
    /// 다른 시스템(예: "other-system")이 같은 키로 발급한 토큰은 거부됩니다.
    ///
    /// 실무에서 이런 경우:
    ///   - 여러 마이크로서비스가 같은 비밀 키를 공유하지만
    ///     각각 다른 용도의 토큰을 발급하는 환경
    ///   - 개발/스테이징/운영 환경이 같은 키를 실수로 공유하는 경우
    /// </summary>
    [Fact]
    public async Task OrderRoute_WrongIssuer_Returns401()
    {
        // GIVEN: 다른 발급자의 토큰 (같은 키, 다른 issuer)
        var wrongIssuerToken = CreateTestToken(
            issuer: "other-system",
            audience: TestAudience);

        // WHEN: 잘못된 발급자 토큰으로 요청
        var request = new HttpRequestMessage(HttpMethod.Get, "/order/health");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", wrongIssuerToken);
        var response = await _client.SendAsync(request);

        // THEN: 401 Unauthorized (발급자 불일치)
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    /// <summary>
    /// 다른 대상(Audience)의 토큰은 401 Unauthorized를 반환합니다.
    /// Gateway는 "msa-gateway"를 대상으로 발급된 토큰만 수락합니다.
    /// 다른 대상(예: "other-service")으로 발급된 토큰은 거부됩니다.
    /// </summary>
    [Fact]
    public async Task OrderRoute_WrongAudience_Returns401()
    {
        // GIVEN: 다른 대상의 토큰 (같은 키, 다른 audience)
        var wrongAudienceToken = CreateTestToken(
            issuer: TestIssuer,
            audience: "other-service");

        // WHEN: 잘못된 대상 토큰으로 요청
        var request = new HttpRequestMessage(HttpMethod.Get, "/order/health");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", wrongAudienceToken);
        var response = await _client.SendAsync(request);

        // THEN: 401 Unauthorized (대상 불일치)
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    // ══════════════════════════════════════════════════════════════
    // [핫픽스] 내부 콜백 경로 차단 테스트
    // ══════════════════════════════════════════════════════════════

    /// <summary>
    /// 유효한 토큰이 있어도 콜백 경로(/order/order/callback)는 403으로 차단됩니다.
    /// Gateway의 /order/{**remainder} 와일드카드가 내부 콜백까지 프록시하는 것을 방지합니다.
    /// </summary>
    [Fact]
    public async Task OrderCallbackRoute_ValidToken_Returns403()
    {
        // GIVEN: 유효한 JWT 토큰
        var token = CreateTestToken("attacker@test.com");

        // WHEN: 유효한 토큰으로 콜백 경로 접근 시도
        var request = new HttpRequestMessage(HttpMethod.Post, "/order/order/callback");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Content = new StringContent(
            "{\"orderId\":\"fake\",\"paymentStatus\":\"COMPLETED\"}",
            System.Text.Encoding.UTF8, "application/json");
        var response = await _client.SendAsync(request);

        // THEN: 403 Forbidden (내부 전용 엔드포인트 차단)
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    /// <summary>
    /// 토큰 없이 콜백 경로에 접근해도 401이 아닌 403이 반환됩니다.
    /// 콜백 차단 미들웨어가 인증 미들웨어 이후에 실행되지만,
    /// order-route가 "default" 정책이므로 토큰 없으면 401이 먼저 반환됩니다.
    /// </summary>
    [Fact]
    public async Task OrderCallbackRoute_NoToken_Returns401()
    {
        // WHEN: 토큰 없이 콜백 경로 접근
        var response = await _client.PostAsync("/order/order/callback", null);

        // THEN: 401 Unauthorized (인증 미들웨어가 먼저 차단)
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }
}
