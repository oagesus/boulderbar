FROM mcr.microsoft.com/dotnet/sdk:10.0-alpine AS build
WORKDIR /src
COPY src/Boulderbar/Boulderbar.csproj src/Boulderbar/
RUN dotnet restore src/Boulderbar/Boulderbar.csproj
COPY . .
RUN dotnet publish src/Boulderbar/Boulderbar.csproj -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine
WORKDIR /app
RUN mkdir -p /data && chown $APP_UID:$APP_UID /data
COPY --from=build /app/publish .
USER $APP_UID
ENV ASPNETCORE_URLS=http://+:8080 \
    BB_DB=/data/boulderbar.db \
    DOTNET_gcServer=0
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["dotnet", "Boulderbar.dll"]
