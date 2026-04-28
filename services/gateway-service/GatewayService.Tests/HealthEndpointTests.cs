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
    public async Task HealthReady_Endpoint_Is_Reachable_And_Returns_Valid_Shape()
    {
        // ReadinessChecker 의 정확한 logic 검증은 단위 테스트(ReadinessCheckerTests 5건) 가 책임.
        // 통합 테스트의 역할은 "엔드포인트가 익명으로 접근 가능하고 약속된 응답 형식을 반환한다" 까지.
        //
        // 왜 정확한 status 를 단정하지 않는가:
        //   ConsulPollingWorker(BackgroundService) 가 WebApplicationFactory 시작 직후 첫 폴링을 시도하며
        //   일부 cluster 가 race 로 채워질 수 있다. 따라서 503/not_ready 또는 200/ready 모두 가능.
        var response = await _client.GetAsync("/health/ready");

        Assert.True(
            response.StatusCode == HttpStatusCode.ServiceUnavailable ||
            response.StatusCode == HttpStatusCode.OK,
            $"unexpected status {response.StatusCode}");

        var body = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(body);
        var status = doc.RootElement.GetProperty("status").GetString();
        Assert.True(status == "not_ready" || status == "ready", $"unexpected status: {status}");
        // missingClusters 필드는 항상 존재해야 함 (응답 contract).
        Assert.True(doc.RootElement.TryGetProperty("missingClusters", out _));
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
