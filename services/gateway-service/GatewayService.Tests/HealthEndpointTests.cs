/**
 * [제22강] /health 엔드포인트 테스트
 *
 * 학습 포인트:
 *   1. K8s livenessProbe/readinessProbe가 사용하는 /health 엔드포인트가 200 OK를 반환하는지 확인
 *   2. JWT 토큰 없이도 접근 가능한지 확인 (AllowAnonymous)
 *   3. 응답 본문에 status: "healthy" 가 포함되는지 확인
 */

using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace GatewayService.Tests;

/// <summary>
/// K8s 헬스 프로브용 /health 엔드포인트 동작을 검증합니다.
/// </summary>
public class HealthEndpointTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient _client;

    public HealthEndpointTests(WebApplicationFactory<Program> factory)
    {
        _client = factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            // 리다이렉트 자동 처리 안 함 (401/302 구분 목적)
            AllowAutoRedirect = false
        });
    }

    [Fact]
    public async Task Health_ReturnsOk_WithoutJwt()
    {
        // Arrange — JWT 토큰 없이 요청
        // Act
        var response = await _client.GetAsync("/health");

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Health_ReturnsHealthyStatus_InBody()
    {
        // Arrange
        // Act
        var response = await _client.GetAsync("/health");
        var body = await response.Content.ReadAsStringAsync();

        // Assert — { "status": "healthy" } 포함 여부 확인
        using var doc = JsonDocument.Parse(body);
        var status = doc.RootElement.GetProperty("status").GetString();
        Assert.Equal("healthy", status);
    }

    /// <summary>
    /// [Issue #11] /health/ready 는 Consul 폴링 전에는 503 을 반환해야 한다.
    /// WebApplicationFactory 환경에서는 외부 Consul 가 없으므로 cluster 가 비어
    /// 모든 필수 cluster (auth-service / order-service / payment-service) 가 누락 상태다.
    /// → 트래픽을 받기 전에 K8s readinessProbe 가 NotReady 로 마킹할 수 있어야 한다.
    /// </summary>
    [Fact]
    public async Task HealthReady_ReturnsServiceUnavailable_BeforeConsulPolling()
    {
        var response = await _client.GetAsync("/health/ready");

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);

        var body = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(body);
        Assert.Equal("not_ready", doc.RootElement.GetProperty("status").GetString());
        var missing = doc.RootElement.GetProperty("missingClusters")
            .EnumerateArray()
            .Select(e => e.GetString())
            .ToArray();
        // ConsulPollingWorker(BackgroundService) 가 WebApplicationFactory 시작 후 첫 폴링을
        // 시도하면서 일부 cluster 가 짧은 시간 부분 채워질 수 있다 (race condition).
        // 핵심 동작은 "필수 cluster 가 모두 채워지지 않으면 not_ready + 누락 목록 노출" 이므로
        // missing 이 비어있지 않다는 것만 검증한다.
        Assert.NotEmpty(missing);
    }

    /// <summary>
    /// /health/ready 도 인증 없이 접근 가능해야 한다 (K8s probe 는 토큰 없이 호출).
    /// </summary>
    [Fact]
    public async Task HealthReady_AccessibleWithoutJwt()
    {
        var response = await _client.GetAsync("/health/ready");

        // 인증 실패면 401 이어야 함 — 503 인 한 익명 접근이 허용된 것.
        Assert.NotEqual(HttpStatusCode.Unauthorized, response.StatusCode);
    }
}
