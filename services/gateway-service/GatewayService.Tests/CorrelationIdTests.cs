/**
 * [제20강] Correlation ID 미들웨어 테스트
 *
 * 학습 포인트:
 *   1. Gateway가 X-Correlation-ID 헤더를 생성하는지 확인
 *   2. 클라이언트가 보낸 X-Correlation-ID를 그대로 유지하는지 확인
 *   3. 응답 헤더에 X-Correlation-ID가 포함되는지 확인
 *
 * 테스트 전략:
 *   YARP가 백엔드에 연결하려다 실패해도 (BadGateway/ServiceUnavailable),
 *   응답 헤더는 Gateway 미들웨어가 이미 설정한 값을 포함합니다.
 *   OnStarting() 콜백이 응답 본문이 쓰이기 전에 실행되기 때문입니다.
 */

using System.Net;
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Text;
using System.IdentityModel.Tokens.Jwt;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.IdentityModel.Tokens;
using Xunit;

namespace GatewayService.Tests;

/// <summary>
/// Gateway의 X-Correlation-ID 미들웨어 동작을 검증합니다.
/// </summary>
public class CorrelationIdTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient _client;

    // 테스트용 JWT 시크릿 (appsettings.json의 Jwt:SecretKey와 동일)
    private const string TestSecretKey = "default-local-test-key-1234567890";
    private const string TestIssuer    = "msa-auth-service";
    private const string TestAudience  = "msa-gateway";

    public CorrelationIdTests(WebApplicationFactory<Program> factory)
    {
        _client = factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false
        });
    }

    // ══════════════════════════════════════════════════════════════
    // 헬퍼: 유효한 JWT 토큰 생성
    // ══════════════════════════════════════════════════════════════
    private static string CreateValidToken(string email = "test@example.com")
    {
        var key         = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(TestSecretKey));
        var credentials = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

        var descriptor = new SecurityTokenDescriptor
        {
            Subject            = new ClaimsIdentity([new Claim(JwtRegisteredClaimNames.Sub, email)]),
            Expires            = DateTime.UtcNow.AddHours(1),
            Issuer             = TestIssuer,
            Audience           = TestAudience,
            SigningCredentials = credentials
        };

        var handler = new JwtSecurityTokenHandler();
        return handler.WriteToken(handler.CreateToken(descriptor));
    }

    // ──────────────────────────────────────────────────────────────
    // 테스트 1: 클라이언트가 헤더를 보내지 않으면 Gateway가 새 UUID를 생성합니다.
    // ──────────────────────────────────────────────────────────────
    [Fact]
    public async Task 클라이언트가_헤더_없이_요청하면_응답에_CorrelationId가_생성된다()
    {
        // Arrange: X-Correlation-ID 없이 인증 요청 (auth 경로는 Anonymous → 백엔드 연결 시도)
        var request = new HttpRequestMessage(HttpMethod.Get, "/auth/health");
        // X-Correlation-ID 헤더를 의도적으로 넣지 않습니다.

        // Act
        var response = await _client.SendAsync(request);

        // Assert: 백엔드가 없어서 502/503이 오더라도 헤더는 Gateway가 이미 설정한 값입니다.
        Assert.True(
            response.Headers.Contains("X-Correlation-ID"),
            "응답 헤더에 X-Correlation-ID가 없습니다.");

        var correlationId = response.Headers.GetValues("X-Correlation-ID").First();

        // UUID 형식인지 확인 (예: "550e8400-e29b-41d4-a716-446655440000")
        Assert.True(
            Guid.TryParse(correlationId, out _),
            $"X-Correlation-ID가 UUID 형식이 아닙니다: {correlationId}");
    }

    // ──────────────────────────────────────────────────────────────
    // 테스트 2: 클라이언트가 헤더를 보내면 그 값을 그대로 유지합니다.
    // ──────────────────────────────────────────────────────────────
    [Fact]
    public async Task 클라이언트가_보낸_CorrelationId는_응답에서도_동일하다()
    {
        // Arrange
        var myCorrelationId = "my-trace-abc-123";
        var request = new HttpRequestMessage(HttpMethod.Get, "/auth/health");
        request.Headers.Add("X-Correlation-ID", myCorrelationId);

        // Act
        var response = await _client.SendAsync(request);

        // Assert
        Assert.True(response.Headers.Contains("X-Correlation-ID"));
        var returned = response.Headers.GetValues("X-Correlation-ID").First();
        Assert.Equal(myCorrelationId, returned);
    }

    // ──────────────────────────────────────────────────────────────
    // 테스트 3: 인증이 필요한 경로에서도 Correlation ID가 응답 헤더에 포함됩니다.
    //           (401로 거부되는 경우에도 헤더는 포함되어야 합니다.)
    // ──────────────────────────────────────────────────────────────
    [Fact]
    public async Task 인증_실패_응답에도_CorrelationId_헤더가_포함된다()
    {
        // Arrange: 토큰 없이 인증 필요 경로 호출 → 401 예상
        var myCorrelationId = Guid.NewGuid().ToString();
        var request = new HttpRequestMessage(HttpMethod.Get, "/order/orders");
        request.Headers.Add("X-Correlation-ID", myCorrelationId);

        // Act
        var response = await _client.SendAsync(request);

        // Assert: 401이지만 Correlation ID는 응답 헤더에 있어야 합니다.
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.True(response.Headers.Contains("X-Correlation-ID"));
        var returned = response.Headers.GetValues("X-Correlation-ID").First();
        Assert.Equal(myCorrelationId, returned);
    }
}
