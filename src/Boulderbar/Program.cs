using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using Boulderbar;

var builder = WebApplication.CreateBuilder(args);

var dbPath = Environment.GetEnvironmentVariable("BB_DB");
if (string.IsNullOrWhiteSpace(dbPath))
    dbPath = Path.Combine(Directory.GetCurrentDirectory(), "data", "boulderbar.db");

if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("ASPNETCORE_URLS")))
    builder.WebHost.UseUrls("http://localhost:8080");

var db = new Db(dbPath);
db.Initialize();

builder.Services.AddSingleton(db);
builder.Services.AddSingleton<CollectorState>();
builder.Services.AddHostedService<Collector>();

builder.Services.AddHttpClient("boulderbar", client =>
{
    client.Timeout = TimeSpan.FromSeconds(20);
    client.DefaultRequestHeaders.UserAgent.ParseAdd(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
    client.DefaultRequestHeaders.AcceptLanguage.ParseAdd("de-AT,de;q=0.9,en;q=0.6");
    client.DefaultRequestHeaders.Accept.ParseAdd("application/json, text/html;q=0.9, */*;q=0.5");
    client.DefaultRequestHeaders.Referrer = new Uri("https://boulderbar.net/standorte/");
    client.DefaultRequestHeaders.CacheControl = new CacheControlHeaderValue { NoCache = true };
});

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = context => context.Context.Response.Headers.CacheControl = "no-cache"
});

app.MapGet("/api/locations", (Db store) => Results.Ok(store.GetLocations()));

app.MapGet("/api/coverage", (Db store) => Results.Ok(store.GetCoverage()));

app.MapGet("/api/latest", (Db store) => Results.Ok(store.GetLatest()));

app.MapGet("/api/series", (Db store, long? from, long? to, int? bucket, string? locations) =>
{
    var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    var start = from ?? now - 86400;
    var end = to ?? now;

    if (end <= start)
        return Results.BadRequest(new { error = "to must be greater than from" });

    var size = bucket ?? Db.SlotSeconds;
    if (size != 900 && size != 1800 && size != 3600 && size != 21600 && size != 86400)
        return Results.BadRequest(new { error = "bucket must be 900, 1800, 3600, 21600 or 86400" });

    if ((end - start) / size > 5000)
        return Results.BadRequest(new { error = "range too large for this resolution" });

    var wanted = ParseLocations(locations) ?? store.GetLocations().Select(l => l.Id).ToList();
    if (wanted.Count == 0)
        return Results.Ok(new { ts = Array.Empty<long>(), bucket = size, series = new Dictionary<string, double?[]>() });

    var (axis, series) = store.GetSeries(start, end, size, wanted);
    return Results.Ok(new
    {
        ts = axis,
        bucket = size,
        series = series.ToDictionary(pair => pair.Key.ToString(CultureInfo.InvariantCulture), pair => pair.Value)
    });
});

app.MapGet("/api/export.csv", (Db store) =>
{
    var body = new StringBuilder("timestamp_utc,unix,location_id,capacity\n");
    foreach (var (ts, loc, capacity) in store.ExportAll())
    {
        body.Append(DateTimeOffset.FromUnixTimeSeconds(ts).ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture))
            .Append(',').Append(ts)
            .Append(',').Append(loc)
            .Append(',').Append(capacity)
            .Append('\n');
    }

    return Results.File(Encoding.UTF8.GetBytes(body.ToString()), "text/csv", "boulderbar.csv");
});

app.MapGet("/healthz", (Db store, CollectorState state) =>
{
    var coverage = store.GetCoverage();
    var stale = state.LastSuccess is null ||
                DateTimeOffset.UtcNow - state.LastSuccess > TimeSpan.FromMinutes(45);

    var payload = new
    {
        status = stale ? "stale" : "ok",
        lastSuccess = state.LastSuccess,
        lastAttempt = state.LastAttempt,
        lastError = state.LastError,
        consecutiveFailures = state.ConsecutiveFailures,
        knownLocations = state.KnownLocations,
        rows = coverage.Count,
        firstReading = coverage.MinTs,
        latestReading = coverage.MaxTs
    };

    return stale ? Results.Json(payload, statusCode: 503) : Results.Ok(payload);
});

app.Run();

static List<int>? ParseLocations(string? raw)
{
    if (string.IsNullOrWhiteSpace(raw))
        return null;

    var result = raw
        .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .Select(part => int.TryParse(part, out var id) ? id : -1)
        .Where(id => id > 0)
        .Distinct()
        .ToList();

    return result.Count == 0 ? null : result;
}
