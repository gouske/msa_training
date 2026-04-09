using System.Threading.Tasks;
using FluentAssertions;
using GatewayService.Discovery;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using WireMock.Server;
using Xunit;

namespace GatewayService.Tests.Discovery;

/// <summary>
/// [실전 #6] Consul HTTP API 클라이언트 단위 테스트
///
/// WireMock.Net 으로 가짜 Consul 서버를 띄우고 클라이언트의 HTTP 호출을 검증한다.
/// 실제 Consul 컨테이너 없이 동작하므로 CI/CD에 안전.
/// </summary>
public class ConsulHealthClientTests : IDisposable
{
    private readonly WireMockServer _consul;
    private readonly ConsulHealthClient _client;

    public ConsulHealthClientTests()
    {
        _consul = WireMockServer.Start();
        var http = new HttpClient { BaseAddress = new Uri(_consul.Url!) };
        _client = new ConsulHealthClient(http);
    }

    public void Dispose()
    {
        _consul.Stop();
    }

    [Fact]
    public async Task 정상_응답이면_passing_인스턴스_목록_반환()
    {
        // GIVEN
        _consul
            .Given(Request.Create()
                .WithPath("/v1/health/service/order-service")
                .WithParam("passing", "true")
                .UsingGet())
            .RespondWith(Response.Create()
                .WithStatusCode(200)
                .WithHeader("Content-Type", "application/json")
                .WithBody(@"[
                    { ""Service"": { ""ID"": ""order-service-h1-8081"", ""Address"": ""h1"", ""Port"": 8081 } },
                    { ""Service"": { ""ID"": ""order-service-h2-8081"", ""Address"": ""h2"", ""Port"": 8081 } }
                ]"));

        // WHEN
        var result = await _client.GetPassingInstancesAsync("order-service", CancellationToken.None);

        // THEN
        result.Should().HaveCount(2);
        result[0].Address.Should().Be("h1");
        result[0].Port.Should().Be(8081);
        result[1].Address.Should().Be("h2");
    }

    [Fact]
    public async Task 빈_배열_응답이면_빈_목록_반환()
    {
        // GIVEN
        _consul
            .Given(Request.Create()
                .WithPath("/v1/health/service/payment-service")
                .UsingGet())
            .RespondWith(Response.Create()
                .WithStatusCode(200)
                .WithBody("[]"));

        // WHEN
        var result = await _client.GetPassingInstancesAsync("payment-service", CancellationToken.None);

        // THEN
        result.Should().BeEmpty();
    }

    [Fact]
    public async Task _5xx_응답이면_HttpRequestException()
    {
        // GIVEN
        _consul
            .Given(Request.Create()
                .WithPath("/v1/health/service/auth-service")
                .UsingGet())
            .RespondWith(Response.Create().WithStatusCode(500));

        // WHEN + THEN
        var act = () => _client.GetPassingInstancesAsync("auth-service", CancellationToken.None);
        await act.Should().ThrowAsync<HttpRequestException>();
    }
}
