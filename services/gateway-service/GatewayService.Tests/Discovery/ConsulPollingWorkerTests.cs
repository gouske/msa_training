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

    /// <summary>
    /// [K8s + Consul 회고 / Codex 적대적 리뷰 대응]
    /// Consul ID 를 명시적으로 지정할 수 있는 stub helper.
    /// POD_NAME 기반 유니크 ID + POD_IP(Address) 충돌 시나리오(stale Pod 의 IP 가 신규 Pod 에 재사용)
    /// 를 정확히 재현하기 위해 필요하다.
    /// </summary>
    private void StubServiceWithIds(string name, params (string id, string addr, int port)[] instances)
    {
        var json = "[" + string.Join(",", instances.Select(i =>
            $"{{\"Service\":{{\"ID\":\"{i.id}\",\"Address\":\"{i.addr}\",\"Port\":{i.port}}}}}")) + "]";
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

    // ─────────────────────────────────────────────────────────────────────────
    // [Codex 적대적 리뷰 #1] K8s Pod 단위 유니크 Consul 등록 회귀 테스트.
    //
    // 회고: replica 마다 POD_NAME 으로 Consul ID 를 유니크화했지만, Consul Address 는
    // POD_IP 이다. DeregisterCriticalServiceAfter 30초 동안 stale 등록이 남고
    // K8s 가 그 IP 를 신규 Pod 에 재사용하면 → 서로 다른 ID 두 개가 같은 Address:Port
    // 를 가리키는 정상적인 일시 상태가 발생한다.
    //
    // 기존 ConsulPollingWorker 는 `dest-{Address}-{Port}` 로 dict key 를 만들어
    // ArgumentException(duplicate key) → catch → stale 캐시 유지로 라우팅 갱신이 멈춘다.
    // 이 두 케이스를 cycle 이 죽지 않고 정상 진행되도록 회귀 보장한다.
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task 같은_AddressPort_다른_ID_2개_여도_polling_cycle_이_죽지_않는다()
    {
        // GIVEN: order-service 에 ID 만 다르고 Address:Port 가 동일한 인스턴스 2개
        // (stale Pod 등록 + IP 재사용된 신규 Pod 가 30초 동안 공존하는 상태 재현)
        StubService("auth-service", ("a1", 8080));
        StubServiceWithIds("order-service",
            ("order-service-pod-old-x1y2", "10.244.0.5", 8081),
            ("order-service-pod-new-z9w8", "10.244.0.5", 8081));
        StubService("payment-service", ("p1", 8082));

        var (worker, provider) = BuildWorker(new[] { "auth-service", "order-service", "payment-service" });

        // WHEN
        await worker.RunOnceAsync(CancellationToken.None);

        // THEN: cycle 이 anyFailed=true 로 죽지 않고 provider 가 정상 갱신되어야 한다.
        // (한 서비스라도 실패하면 stale 캐시 유지 정책 → 3개 모두 신규 갱신되었는지로 검증)
        var config = provider.GetConfig();
        config.Clusters.Should().HaveCount(3, "duplicate Address:Port 가 cycle 을 죽이면 안 된다");

        var orderDests = config.Clusters.Single(c => c.ClusterId == "order-service").Destinations;
        orderDests.Should().NotBeEmpty("ID 가 다르면 별개 destination 으로 등록되거나, 최소 1개는 살아남아야 한다");
        // ID 가 다르면 두 destination 모두 보존되는 것이 이상적 (POD_NAME 으로 충돌 회피)
        orderDests.Should().HaveCount(2, "서로 다른 Consul ID 는 별개 인스턴스로 보존되어야 한다");
    }

    [Fact]
    public async Task 같은_Consul_ID_2개_가_들어와도_polling_cycle_이_죽지_않는다()
    {
        // GIVEN: Consul 응답에 ID 가 완전히 동일한 인스턴스 2개가 섞이는 비정상 케이스.
        // 정상 Consul 은 ID 유일성을 보장하지만, 방어적으로 cycle 이 죽지 않아야 한다.
        StubService("auth-service", ("a1", 8080));
        StubServiceWithIds("order-service",
            ("order-service-duplicate-id", "10.244.0.5", 8081),
            ("order-service-duplicate-id", "10.244.0.6", 8081));
        StubService("payment-service", ("p1", 8082));

        var (worker, provider) = BuildWorker(new[] { "auth-service", "order-service", "payment-service" });

        // WHEN
        await worker.RunOnceAsync(CancellationToken.None);

        // THEN: cycle 이 죽지 않고 (anyFailed=false) provider 가 갱신되어야 한다.
        var config = provider.GetConfig();
        config.Clusters.Should().HaveCount(3, "ID 중복으로 cycle 이 죽으면 안 된다");

        var orderDests = config.Clusters.Single(c => c.ClusterId == "order-service").Destinations;
        // GroupBy(Id) 로 중복이 제거되므로 1개만 남는다.
        orderDests.Should().HaveCount(1, "동일 ID 는 GroupBy 로 1개만 남아야 한다");
    }
}
