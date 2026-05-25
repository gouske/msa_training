using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Yarp.ReverseProxy.Configuration;

namespace GatewayService.Discovery;

/// <summary>
/// [실전 #6] Consul 폴링 워커.
///
/// 5초 간격으로 1 사이클씩 실행. 1 사이클 = 폴링 대상 서비스 N개를 순회:
///   GET /v1/health/service/auth-service?passing=true
///   GET /v1/health/service/order-service?passing=true
///   GET /v1/health/service/payment-service?passing=true
/// 3개 결과를 합쳐서 ConsulProxyConfigProvider.Update(clusters) 1회 호출.
///
/// Consul이 다운돼도 throw 안 함 → 마지막 성공 캐시(stale) 유지.
/// (5겹 안전망의 1번째: stale 캐시)
/// </summary>
public class ConsulPollingWorker : BackgroundService
{
    private readonly ConsulHealthClient _client;
    private readonly ConsulProxyConfigProvider _provider;
    private readonly string[] _services;
    private readonly TimeSpan _interval;
    private readonly ILogger<ConsulPollingWorker> _logger;

    public ConsulPollingWorker(
        ConsulHealthClient client,
        ConsulProxyConfigProvider provider,
        string[] services,
        TimeSpan interval,
        ILogger<ConsulPollingWorker> logger)
    {
        _client = client;
        _provider = provider;
        _services = services;
        _interval = interval;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // 시작 즉시 1회 실행 + 이후 _interval 간격 반복
        while (!stoppingToken.IsCancellationRequested)
        {
            await RunOnceAsync(stoppingToken);
            try
            {
                await Task.Delay(_interval, stoppingToken);
            }
            catch (TaskCanceledException) { /* shutdown */ }
        }
    }

    /// <summary>
    /// 1 폴링 사이클을 실행한다. 테스트에서 직접 호출 가능.
    /// </summary>
    public async Task RunOnceAsync(CancellationToken ct)
    {
        var newClusters = new List<ClusterConfig>();
        bool anyFailed = false;

        foreach (var name in _services)
        {
            try
            {
                var instances = await _client.GetPassingInstancesAsync(name, ct);
                // 각 인스턴스를 YARP DestinationConfig로 변환.
                // Address 에는 path 없이 host:port 만 둔다. Route 의 PathRemovePrefix transform 이
                // 요청 경로에서 "/auth" 등의 prefix 를 제거한 뒤, YARP 가 나머지 경로("/api/auth/signup")
                // 를 destination 에 붙여 최종 URL 을 만든다.
                //
                // [K8s + Consul 회고 / Codex 적대적 리뷰 #1]
                // dict key 우선순위: Consul Service.ID > Address-Port fallback.
                //
                // 변경 이유: K8s 환경에서는 POD_NAME 기반으로 Consul ID 가 유니크해지지만,
                // POD_IP(Address) 는 일시적으로 중복될 수 있다 — Pod 비정상 종료 후
                // DeregisterCriticalServiceAfter 30초 동안 stale 등록이 남고, 그 사이
                // K8s 가 동일 IP 를 신규 Pod 에 재사용하면 서로 다른 ID 두 개가 같은
                // Address:Port 를 가리키는 정상적인 일시 상태가 발생한다.
                //
                // 기존 "dest-{Address}-{Port}" key 는 이 시점에 ArgumentException(duplicate)
                // 으로 cycle 을 죽이고 stale 캐시 유지 경로로 빠져 라우팅 갱신이 멈췄다.
                // GroupBy 로 한번 더 감싸 ID 가 비정상적으로 중복(예: Consul 응답 오류)
                // 되어도 cycle 이 생존하도록 보호한다.
                var dests = instances
                    .GroupBy(i => string.IsNullOrEmpty(i.Id) ? $"{i.Address}-{i.Port}" : i.Id)
                    .ToDictionary(
                        g => $"dest-{g.Key}",
                        g => new DestinationConfig { Address = $"http://{g.First().Address}:{g.First().Port}" });

                newClusters.Add(new ClusterConfig
                {
                    ClusterId = name,
                    Destinations = dests,
                });
            }
            catch (Exception e)
            {
                // Consul 응답 실패 시 경고 로그만 남기고 계속 진행
                _logger.LogWarning("Consul polling failed for {Name}: {Msg}. Using stale cache.", name, e.Message);
                anyFailed = true;
            }
        }

        // 5겹 안전망 1번째: 한 서비스라도 실패하면 stale 캐시 유지 (Provider 갱신 안 함)
        if (!anyFailed)
        {
            _provider.Update(newClusters);
        }
    }
}
