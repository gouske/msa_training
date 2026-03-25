# 1단계: 빌드 (SDK 포함)
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /app/publish

# 2단계: 실행 (런타임만 포함 - 가벼움)
FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /app/publish .

# [수정] 여기에 넣어야 컨테이너 실행 시 Production 모드로 동작합니다.
ENV ASPNETCORE_ENVIRONMENT=Production

ENTRYPOINT ["dotnet", "GatewayService.dll"]