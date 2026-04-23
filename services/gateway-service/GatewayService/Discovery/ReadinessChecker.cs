using Yarp.ReverseProxy.Configuration;

namespace GatewayService.Discovery;

/// <summary>
/// [Issue #11] Gateway readiness 정확도 — YARP 라우팅 가능 상태 검사기.
///
/// 배경:
///   /health 만 있던 시절에는 K8s readinessProbe 가 항상 200 을 받아 Pod 가 Ready 로 유지되었다.
///   Consul 폴링이 실패하거나 모든 백엔드 인스턴스가 unhealthy 면 라우팅이 불가능한데도
///   Service endpoint 에서 제거되지 않아 트래픽이 계속 들어와 502 가 발생했다.
///
/// 동작:
///   생성 시 주입된 "필수 cluster 이름 목록" 을 IProxyConfigProvider 의 현재 캐시와 비교한다.
///   각 필수 cluster 가 ≥ 1 destination 을 보유하고 있어야 ready.
///   하나라도 누락 / Destinations 가 비어있으면 not_ready, 어떤 cluster 가 빠졌는지 반환한다.
///
/// 운영 메모:
///   - 빈 필수 목록은 의도적 비활성화로 간주 → 항상 ready.
///   - liveness 는 별도로 /health 가 담당한다. (프로세스 생존만 확인)
/// </summary>
public sealed class ReadinessChecker
{
    private readonly IProxyConfigProvider _provider;
    private readonly IReadOnlyList<string> _requiredClusters;

    public ReadinessChecker(IProxyConfigProvider provider, IReadOnlyList<string> requiredClusters)
    {
        _provider = provider ?? throw new ArgumentNullException(nameof(provider));
        _requiredClusters = requiredClusters ?? throw new ArgumentNullException(nameof(requiredClusters));
    }

    public ReadinessResult Check()
    {
        if (_requiredClusters.Count == 0)
        {
            return new ReadinessResult(true, Array.Empty<string>());
        }

        var clusters = _provider.GetConfig().Clusters;
        var clusterById = clusters.ToDictionary(c => c.ClusterId ?? string.Empty);

        var missing = new List<string>();
        foreach (var name in _requiredClusters)
        {
            if (!clusterById.TryGetValue(name, out var cluster) ||
                cluster.Destinations is null ||
                cluster.Destinations.Count == 0)
            {
                missing.Add(name);
            }
        }

        return new ReadinessResult(missing.Count == 0, missing);
    }
}

/// <summary>
/// readiness 결과 DTO. <see cref="MissingClusters"/> 는 ready 일 때 빈 컬렉션이다.
/// </summary>
public sealed record ReadinessResult(bool IsReady, IReadOnlyList<string> MissingClusters);
