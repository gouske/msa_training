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
                var dests = instances.ToDictionary(
                    i => $"dest-{i.Address}-{i.Port}",
                    i => new DestinationConfig { Address = $"http://{i.Address}:{i.Port}" });

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
