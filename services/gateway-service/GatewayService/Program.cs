var builder = WebApplication.CreateBuilder(args);

// 1. 게이트웨이 서비스 등록
builder.Services.AddReverseProxy()
    .LoadFromConfig(builder.Configuration.GetSection("ReverseProxy"));

var app = builder.Build();

// 2. 게이트웨이 활성화
app.MapReverseProxy();

app.Run("http://localhost:9000"); // 게이트웨이는 9000번 문을 씁니다!
