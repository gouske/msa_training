using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace GatewayService.Discovery;

/// <summary>
/// [실전 #6] Consul HTTP API 클라이언트.
///
/// 책임: GET /v1/health/service/{name}?passing=true 호출 → ConsulInstance 목록 반환.
/// HttpClient를 생성자 주입 받아 단위 테스트에서 WireMock으로 교체 가능.
/// </summary>
public class ConsulHealthClient
{
    private readonly HttpClient _http;

    public ConsulHealthClient(HttpClient http)
    {
        _http = http;
    }

    /// <summary>
    /// 지정한 서비스 이름으로 'passing' 상태인 인스턴스 목록만 가져온다.
    /// 빈 결과는 빈 리스트 반환 (예외 X). 네트워크/HTTP 5xx는 예외.
    /// </summary>
    public async Task<List<ConsulInstance>> GetPassingInstancesAsync(
        string serviceName,
        CancellationToken ct)
    {
        // Consul Health API: passing=true 파라미터로 건강한 인스턴스만 필터링
        var resp = await _http.GetAsync(
            $"/v1/health/service/{serviceName}?passing=true",
            ct);

        // 4xx/5xx 응답이면 HttpRequestException 발생
        resp.EnsureSuccessStatusCode();

        // JSON 응답을 ConsulServiceEntry 목록으로 역직렬화
        var entries = await resp.Content.ReadFromJsonAsync<List<ConsulServiceEntry>>(
            cancellationToken: ct);

        // Service 필드만 추출해 반환. null이면 빈 리스트.
        return entries?.Select(e => e.Service).ToList() ?? new List<ConsulInstance>();
    }

    // Consul 응답 JSON 최상위 구조: [{ "Service": {...}, "Checks": [...] }, ...]
    private class ConsulServiceEntry
    {
        [JsonPropertyName("Service")]
        public ConsulInstance Service { get; set; } = new();
    }
}

/// <summary>
/// Consul에 등록된 서비스 인스턴스 1건. Address+Port 가 핵심.
/// Task 6 ConsulProxyConfigProvider 에서 목적지 URL 조합에 사용된다.
/// </summary>
public class ConsulInstance
{
    /// <summary>Consul이 부여한 고유 서비스 ID (예: order-service-host1-8081)</summary>
    [JsonPropertyName("ID")]
    public string Id { get; set; } = "";

    /// <summary>서비스가 실행 중인 호스트 주소 (IP 또는 호스트명)</summary>
    [JsonPropertyName("Address")]
    public string Address { get; set; } = "";

    /// <summary>서비스가 수신 중인 포트 번호</summary>
    [JsonPropertyName("Port")]
    public int Port { get; set; }
}
