using FluentAssertions;
using GatewayService.Discovery;
using Microsoft.Extensions.Logging.Abstractions;
using Yarp.ReverseProxy.Configuration;
using Xunit;

namespace GatewayService.Tests.Discovery;

/// <summary>
/// [Issue #11] Gateway readiness 정확도 — ReadinessChecker 단위 테스트.
///
/// 검증 시나리오:
///   1. Consul 폴링 전: 모든 cluster 가 비어있으면 not_ready + 누락 목록 반환.
///   2. 일부 cluster 만 destination 보유: 누락된 cluster 만 missingClusters 에 포함.
///   3. Destinations 가 비어있는 cluster (Consul 가 죽은 인스턴스만 보고한 경우): not_ready.
///   4. 모든 필수 cluster 가 ≥1 destination 보유: ready.
/// </summary>
public class ReadinessCheckerTests
{
    private static readonly IReadOnlyList<string> RequiredClusters = new[]
    {
        "auth-service",
        "order-service",
        "payment-service",
    };

    private static readonly IReadOnlyList<RouteConfig> EmptyRoutes = Array.Empty<RouteConfig>();

    private static ConsulProxyConfigProvider NewProvider() =>
        new(EmptyRoutes, NullLogger<ConsulProxyConfigProvider>.Instance);

    private static ClusterConfig ClusterWith(string id, params string[] destinationAddresses)
    {
        var dests = new Dictionary<string, DestinationConfig>();
        for (var i = 0; i < destinationAddresses.Length; i++)
        {
            dests[$"dest-{i}"] = new DestinationConfig { Address = destinationAddresses[i] };
        }
        return new ClusterConfig
        {
            ClusterId = id,
            Destinations = dests,
        };
    }

    [Fact]
    public void 폴링_전_빈_캐시면_not_ready_이고_모든_cluster가_누락_목록에_포함된다()
    {
        var provider = NewProvider();
        var checker = new ReadinessChecker(provider, RequiredClusters);

        var result = checker.Check();

        result.IsReady.Should().BeFalse();
        result.MissingClusters.Should().BeEquivalentTo(RequiredClusters);
    }

    [Fact]
    public void 일부_cluster만_destination_보유하면_누락된_cluster만_missing에_들어간다()
    {
        var provider = NewProvider();
        provider.Update(new[]
        {
            ClusterWith("auth-service", "http://auth-h1:8080/api/"),
            ClusterWith("order-service", "http://order-h1:8081/api/"),
            // payment-service 없음
        });
        var checker = new ReadinessChecker(provider, RequiredClusters);

        var result = checker.Check();

        result.IsReady.Should().BeFalse();
        result.MissingClusters.Should().ContainSingle().Which.Should().Be("payment-service");
    }

    [Fact]
    public void Destinations가_빈_cluster는_not_ready로_본다()
    {
        var provider = NewProvider();
        provider.Update(new[]
        {
            ClusterWith("auth-service", "http://auth-h1:8080/api/"),
            ClusterWith("order-service", "http://order-h1:8081/api/"),
            // Consul 가 보고한 cluster 자체는 있지만 healthy 인스턴스가 0
            new ClusterConfig
            {
                ClusterId = "payment-service",
                Destinations = new Dictionary<string, DestinationConfig>(),
            },
        });
        var checker = new ReadinessChecker(provider, RequiredClusters);

        var result = checker.Check();

        result.IsReady.Should().BeFalse();
        result.MissingClusters.Should().ContainSingle().Which.Should().Be("payment-service");
    }

    [Fact]
    public void 모든_필수_cluster가_destination_보유하면_ready()
    {
        var provider = NewProvider();
        provider.Update(new[]
        {
            ClusterWith("auth-service", "http://auth-h1:8080/api/"),
            ClusterWith("order-service", "http://order-h1:8081/api/", "http://order-h2:8081/api/"),
            ClusterWith("payment-service", "http://payment-h1:8082/api/"),
        });
        var checker = new ReadinessChecker(provider, RequiredClusters);

        var result = checker.Check();

        result.IsReady.Should().BeTrue();
        result.MissingClusters.Should().BeEmpty();
    }

    [Fact]
    public void 필수_목록이_비어있으면_항상_ready()
    {
        // 운영자가 의도적으로 readiness 검사를 비활성화한 케이스 — 빈 목록 = "확인할 cluster 없음" = ready.
        var provider = NewProvider();
        var checker = new ReadinessChecker(provider, Array.Empty<string>());

        var result = checker.Check();

        result.IsReady.Should().BeTrue();
        result.MissingClusters.Should().BeEmpty();
    }
}
