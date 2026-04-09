using FluentAssertions;
using GatewayService.Discovery;
using Microsoft.Extensions.Logging.Abstractions;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using WireMock.Server;
using Xunit;
using Yarp.ReverseProxy.Configuration;

namespace GatewayService.Tests.Discovery;

public class ConsulPollingWorkerTests : IDisposable
{
    private readonly WireMockServer _consul;

    public ConsulPollingWorkerTests()
    {
        _consul = WireMockServer.Start();
    }

    public void Dispose() => _consul.Stop();

    private (ConsulPollingWorker worker, ConsulProxyConfigProvider provider) BuildWorker(string[] services, TimeSpan? interval = null)
    {
        var http = new HttpClient { BaseAddress = new Uri(_consul.Url!) };
        var client = new ConsulHealthClient(http);
        var routes = new List<RouteConfig>
        {
            new RouteConfig { RouteId = "auth", ClusterId = "auth-service", Match = new RouteMatch { Path = "/auth/{**r}" } },
            new RouteConfig { RouteId = "order", ClusterId = "order-service", Match = new RouteMatch { Path = "/order/{**r}" } },
            new RouteConfig { RouteId = "payment", ClusterId = "payment-service", Match = new RouteMatch { Path = "/payment/{**r}" } },
        };
        var provider = new ConsulProxyConfigProvider(routes, NullLogger<ConsulProxyConfigProvider>.Instance);
        var worker = new ConsulPollingWorker(
            client, provider, services,
            interval ?? TimeSpan.FromMilliseconds(100),
            NullLogger<ConsulPollingWorker>.Instance);
        return (worker, provider);
    }

    private void StubService(string name, params (string addr, int port)[] instances)
    {
        var json = "[" + string.Join(",", instances.Select(i =>
            $"{{\"Service\":{{\"ID\":\"{name}-{i.addr}-{i.port}\",\"Address\":\"{i.addr}\",\"Port\":{i.port}}}}}")) + "]";
        _consul
            .Given(Request.Create().WithPath($"/v1/health/service/{name}").WithParam("passing", "true").UsingGet())
            .RespondWith(Response.Create().WithStatusCode(200).WithBody(json));
    }

    [Fact]
    public async Task _1_사이클_후_3개_서비스_모두_클러스터에_반영()
    {
        // GIVEN
        StubService("auth-service", ("auth1", 8080));
        StubService("order-service", ("ord1", 8081), ("ord2", 8081));
        StubService("payment-service", ("pay1", 8082));

        var (worker, provider) = BuildWorker(new[] { "auth-service", "order-service", "payment-service" });

        // WHEN: 1 사이클 강제 실행
        await worker.RunOnceAsync(CancellationToken.None);

        // THEN
        var config = provider.GetConfig();
        config.Clusters.Should().HaveCount(3);
        config.Clusters.Single(c => c.ClusterId == "order-service").Destinations.Should().HaveCount(2);
        config.Clusters.Single(c => c.ClusterId == "auth-service").Destinations.Should().HaveCount(1);
    }

    [Fact]
    public async Task Consul_다운_시_stale_캐시_유지()
    {
        // GIVEN: 1회차 정상
        StubService("auth-service", ("a1", 8080));
        StubService("order-service", ("o1", 8081));
        StubService("payment-service", ("p1", 8082));

        var (worker, provider) = BuildWorker(new[] { "auth-service", "order-service", "payment-service" });
        await worker.RunOnceAsync(CancellationToken.None);
        var firstConfig = provider.GetConfig();
        firstConfig.Clusters.Should().HaveCount(3);

        // WHEN: 2회차에서 Consul 모든 응답을 500으로 (stub 제거 + 500 stub)
        _consul.Reset();
        _consul.Given(Request.Create().UsingGet()).RespondWith(Response.Create().WithStatusCode(500));
        await worker.RunOnceAsync(CancellationToken.None);

        // THEN: stale 캐시 유지
        var secondConfig = provider.GetConfig();
        secondConfig.Clusters.Should().HaveCount(3, "Consul 다운 시 마지막 성공 캐시를 유지해야 한다");
    }

    [Fact]
    public async Task 폴링_결과_변화_시_새_IProxyConfig_발행()
    {
        // GIVEN
        StubService("auth-service", ("a1", 8080));
        StubService("order-service", ("o1", 8081));
        StubService("payment-service", ("p1", 8082));

        var (worker, provider) = BuildWorker(new[] { "auth-service", "order-service", "payment-service" });
        await worker.RunOnceAsync(CancellationToken.None);
        var v1 = provider.GetConfig();

        // WHEN: order-service 인스턴스가 2개로 증가
        _consul.Reset();
        StubService("auth-service", ("a1", 8080));
        StubService("order-service", ("o1", 8081), ("o2", 8081));
        StubService("payment-service", ("p1", 8082));
        await worker.RunOnceAsync(CancellationToken.None);

        // THEN
        var v2 = provider.GetConfig();
        v2.Should().NotBeSameAs(v1);
        v2.Clusters.Single(c => c.ClusterId == "order-service").Destinations.Should().HaveCount(2);
    }
}
