/**
 * [Codex Phase 2 review #3] Gateway 메트릭 미들웨어 위치 회귀 테스트.
 *
 * 검증 시나리오:
 *   - 토큰 없이 보호된 라우트(`/order/...`) 호출 → 401 응답
 *   - /metrics 응답 본문에 status 라벨이 401 인 카운터가 존재해야 한다
 *
 * 회귀 의도:
 *   UseHttpMetrics() 가 UseAuthentication() / UseAuthorization() 보다 뒤에 있으면
 *   인증 실패가 메트릭 미들웨어에 도달하지 못해 Prometheus 에서 사라진다.
 *   이 테스트는 그 회귀를 즉시 잡는다.
 */

using System.Net;
using System.Net.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace GatewayService.Tests;

public class MetricsEndpointTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient _client;

    public MetricsEndpointTests(WebApplicationFactory<Program> factory)
    {
        // 테스트 환경(TestServer) 은 Kestrel multi-listener 가 의미 없으므로
        // Metrics:ManagementHost 를 빈 값으로 override 해 RequireHost 를 적용하지 않게 한다.
        // 운영 동작(별도 포트만 /metrics 노출) 은 docker compose 통합 검증으로 따로 확인.
        _client = factory.WithWebHostBuilder(b => b.UseSetting("Metrics:ManagementHost", ""))
                         .CreateClient(new WebApplicationFactoryClientOptions
                         {
                             AllowAutoRedirect = false,
                         });
    }

    [Fact]
    public async Task Metrics_Endpoint_Responds_With_Prometheus_Exposition()
    {
        var response = await _client.GetAsync("/metrics");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.StartsWith("text/plain", response.Content.Headers.ContentType?.MediaType);
        var body = await response.Content.ReadAsStringAsync();
        // prometheus-net.AspNetCore 표준 메트릭 — UseHttpMetrics 가 등록한 것.
        Assert.Contains("http_request_duration_seconds", body);
    }

    [Fact]
    public async Task Authentication_Failures_Are_Captured_In_Metrics()
    {
        // 보호된 라우트(/order/*)를 토큰 없이 호출 → 401
        var unauth = await _client.GetAsync("/order/health");
        Assert.Equal(HttpStatusCode.Unauthorized, unauth.StatusCode);

        // 메트릭 본문에 401 응답이 카운터로 기록되어야 한다.
        // UseHttpMetrics 가 UseAuthentication/UseAuthorization 보다 뒤에 있으면 이 테스트가 실패한다.
        var metrics = await _client.GetAsync("/metrics");
        Assert.Equal(HttpStatusCode.OK, metrics.StatusCode);
        var body = await metrics.Content.ReadAsStringAsync();

        // prometheus-net 의 http_requests_received_total 라벨에 code="401" 이 있어야 한다.
        // (라벨 순서는 라이브러리가 정하므로 정확한 위치 대신 두 토큰 모두 같은 line 에 존재함을 본다)
        var hasUnauthorizedSeries = body
            .Split('\n')
            .Any(line => line.StartsWith("http_requests_received_total")
                         && line.Contains("code=\"401\""));
        Assert.True(
            hasUnauthorizedSeries,
            $"401 응답이 http_requests_received_total 의 카운터에 기록되지 않았다.\n메트릭 일부:\n{Truncate(body, 1500)}");
    }

    private static string Truncate(string s, int max) =>
        s.Length <= max ? s : s.Substring(0, max) + "...[truncated]";
}
