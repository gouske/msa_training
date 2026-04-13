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
}
