using FluentAssertions;
using GatewayService.Discovery;
using Microsoft.Extensions.Logging.Abstractions;
using Yarp.ReverseProxy.Configuration;
using Xunit;

namespace GatewayService.Tests.Discovery;

/// <summary>
/// [실전 #6] YARP IProxyConfigProvider 구현 단위 테스트.
///
/// 핵심 행위:
///   1. 빈 캐시 시 GetConfig() 가 빈 클러스터 반환 (NPE 없음)
///   2. Update() 호출 시 새 IProxyConfig 인스턴스 생성 + ChangeToken 트리거
///   3. Routes는 정적 (생성자에 한 번 받고 변경 안 됨)
/// </summary>
public class ConsulProxyConfigProviderTests
{
    private readonly List<RouteConfig> _staticRoutes = new()
    {
        new RouteConfig
        {
            RouteId = "order-route",
            ClusterId = "order-service",
            Match = new RouteMatch { Path = "/order/{**remainder}" },
        },
    };

    [Fact]
    public void 초기_상태에서_GetConfig는_빈_클러스터_반환()
    {
        // GIVEN
        var provider = new ConsulProxyConfigProvider(_staticRoutes, NullLogger<ConsulProxyConfigProvider>.Instance);

        // WHEN
        var config = provider.GetConfig();

        // THEN
        config.Clusters.Should().BeEmpty();
        config.Routes.Should().HaveCount(1);
        config.Routes[0].RouteId.Should().Be("order-route");
    }

    [Fact]
    public void Update_호출_시_새_클러스터로_갱신()
    {
        // GIVEN
        var provider = new ConsulProxyConfigProvider(_staticRoutes, NullLogger<ConsulProxyConfigProvider>.Instance);
        var newClusters = new List<ClusterConfig>
        {
            new ClusterConfig
            {
                ClusterId = "order-service",
                Destinations = new Dictionary<string, DestinationConfig>
                {
                    ["dest-h1"] = new DestinationConfig { Address = "http://h1:8081/api/" },
                    ["dest-h2"] = new DestinationConfig { Address = "http://h2:8081/api/" },
                },
            },
        };

        // WHEN
        provider.Update(newClusters);

        // THEN
        var config = provider.GetConfig();
        config.Clusters.Should().HaveCount(1);
        config.Clusters[0].Destinations.Should().HaveCount(2);
    }

    [Fact]
    public void Update_호출_시_ChangeToken_트리거()
    {
        // GIVEN
        var provider = new ConsulProxyConfigProvider(_staticRoutes, NullLogger<ConsulProxyConfigProvider>.Instance);
        var initialConfig = provider.GetConfig();
        bool changed = false;
        initialConfig.ChangeToken.RegisterChangeCallback(_ => { changed = true; }, null);

        // WHEN
        provider.Update(new List<ClusterConfig>
        {
            new ClusterConfig { ClusterId = "x" },
        });

        // THEN
        changed.Should().BeTrue("Update 후 기존 ChangeToken이 트리거되어야 YARP가 라우팅을 재구성한다");
        provider.GetConfig().Should().NotBeSameAs(initialConfig, "Update 후 새 IProxyConfig 인스턴스가 발행되어야 한다");
    }

    [Fact]
    public void 두_번_Update_호출_시_각_단계의_ChangeToken이_독립()
    {
        // GIVEN
        var provider = new ConsulProxyConfigProvider(_staticRoutes, NullLogger<ConsulProxyConfigProvider>.Instance);

        // WHEN
        provider.Update(new List<ClusterConfig> { new ClusterConfig { ClusterId = "v1" } });
        var configV1 = provider.GetConfig();

        provider.Update(new List<ClusterConfig> { new ClusterConfig { ClusterId = "v2" } });
        var configV2 = provider.GetConfig();

        // THEN
        configV1.Should().NotBeSameAs(configV2);
        configV1.Clusters[0].ClusterId.Should().Be("v1");
        configV2.Clusters[0].ClusterId.Should().Be("v2");
    }
}
