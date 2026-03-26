var builder = WebApplication.CreateBuilder(args);

// [임시 진단] 실제로 어떤 환경·설정이 로드됐는지 확인
// Console.WriteLine($">>> Environment: {builder.Environment.EnvironmentName}");
// Console.WriteLine($">>> Auth Address: {builder.Configuration["ReverseProxy:Clusters:auth-cluster:Destinations:dest1:Address"]}");

// 1. 게이트웨이 서비스 등록
builder.Services.AddReverseProxy()
    .LoadFromConfig(builder.Configuration.GetSection("ReverseProxy"));

var app = builder.Build();

// 2. 게이트웨이 활성화
app.MapReverseProxy();

// app.Run("http://localhost:9000"); // 게이트웨이는 9000번 문을 씁니다!
app.Run();
