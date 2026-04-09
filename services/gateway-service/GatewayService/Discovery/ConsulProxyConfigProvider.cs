using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Primitives;
using Yarp.ReverseProxy.Configuration;

namespace GatewayService.Discovery;

/// <summary>
/// [실전 #6] YARP의 IProxyConfigProvider 커스텀 구현.
///
/// YARP는 GetConfig()를 호출해서 라우팅 테이블을 받아간다.
/// 우리는 Consul에서 받은 클러스터 목록을 메모리 캐시에 두고,
/// ConsulPollingWorker가 Update()를 호출할 때마다 새 IProxyConfig를 발행한다.
///
/// 발행 시 ChangeToken을 트리거하면 YARP가 자동으로 라우팅 테이블을 재구성한다.
/// 즉 우리는 폴링 + Update만 책임지고, 라우팅 재구성은 YARP가 알아서 한다.
///
/// Routes는 정적 (생성자에 한 번 받고 변경 없음). Clusters만 동적.
/// </summary>
public class ConsulProxyConfigProvider : IProxyConfigProvider
{
    private readonly IReadOnlyList<RouteConfig> _routes;
    private readonly ILogger<ConsulProxyConfigProvider> _logger;
    private volatile ConsulProxyConfig _current;

    public ConsulProxyConfigProvider(
        IReadOnlyList<RouteConfig> routes,
        ILogger<ConsulProxyConfigProvider> logger)
    {
        _routes = routes;
        _logger = logger;
        _current = new ConsulProxyConfig(Array.Empty<ClusterConfig>(), _routes);
    }

    public IProxyConfig GetConfig() => _current;

    /// <summary>
    /// Consul 폴링 결과로 클러스터 목록을 갱신한다.
    /// 호출하면 (1) 새 IProxyConfig 인스턴스 발행 (2) 이전 ChangeToken 트리거.
    /// </summary>
    public void Update(IReadOnlyList<ClusterConfig> clusters)
    {
        var old = _current;
        _current = new ConsulProxyConfig(clusters, _routes);
        old.SignalChange();
        _logger.LogDebug("ProxyConfig 갱신: clusters={Count}", clusters.Count);
    }
}

/// <summary>
/// IProxyConfig 구현체. 한 번 만들어지면 불변.
/// 새 클러스터가 들어오면 새 인스턴스가 발행된다.
/// </summary>
internal sealed class ConsulProxyConfig : IProxyConfig
{
    private readonly CancellationTokenSource _cts = new();

    public ConsulProxyConfig(
        IReadOnlyList<ClusterConfig> clusters,
        IReadOnlyList<RouteConfig> routes)
    {
        Clusters = clusters;
        Routes = routes;
        ChangeToken = new CancellationChangeToken(_cts.Token);
    }

    public IReadOnlyList<ClusterConfig> Clusters { get; }
    public IReadOnlyList<RouteConfig> Routes { get; }
    public IChangeToken ChangeToken { get; }

    /// <summary>이 config를 'stale' 로 만든다 — YARP가 새 GetConfig()를 호출하게 됨.</summary>
    internal void SignalChange()
    {
        try { _cts.Cancel(); } catch (ObjectDisposedException) { }
    }
}
