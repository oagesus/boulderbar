using System.Text.Json;
using System.Text.RegularExpressions;

namespace Boulderbar;

public sealed class CollectorState
{
    public DateTimeOffset? LastSuccess { get; set; }
    public DateTimeOffset? LastAttempt { get; set; }
    public string? LastError { get; set; }
    public int ConsecutiveFailures { get; set; }
    public int KnownLocations { get; set; }
}

public sealed partial class Collector : BackgroundService
{
    private const string StandorteUrl = "https://boulderbar.net/standorte/";
    private const string CapacityUrl = "https://boulderbar.net/wp-json/boulderbar/v1/capacity";

    private static readonly int[] FallbackLocations = [262, 265, 263, 264, 261, 260, 284];
    private static readonly TimeSpan RetryDelay = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan DiscoveryInterval = TimeSpan.FromHours(24);
    private const int MaxAttempts = 3;

    private readonly IHttpClientFactory _factory;
    private readonly Db _db;
    private readonly CollectorState _state;
    private readonly ILogger<Collector> _logger;

    private int[] _locations = FallbackLocations;
    private DateTimeOffset _discoveredAt = DateTimeOffset.MinValue;

    public Collector(IHttpClientFactory factory, Db db, CollectorState state, ILogger<Collector> logger)
    {
        _factory = factory;
        _db = db;
        _state = state;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await RunOnce(Db.FloorToSlot(DateTimeOffset.UtcNow), stoppingToken);

        var slot = NextSlot(DateTimeOffset.UtcNow);

        while (!stoppingToken.IsCancellationRequested)
        {
            var jitter = TimeSpan.FromMilliseconds(Random.Shared.Next(-5000, 5001));
            var wait = slot - DateTimeOffset.UtcNow + jitter;

            if (wait > TimeSpan.Zero)
            {
                try
                {
                    await Task.Delay(wait, stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
            }

            await RunOnce(slot.ToUnixTimeSeconds(), stoppingToken);

            var now = DateTimeOffset.UtcNow;
            slot = NextSlot(now > slot ? now : slot);
        }
    }

    private static DateTimeOffset NextSlot(DateTimeOffset now)
    {
        var seconds = now.ToUnixTimeSeconds();
        var next = (seconds / Db.SlotSeconds + 1) * Db.SlotSeconds;
        return DateTimeOffset.FromUnixTimeSeconds(next);
    }

    private async Task RunOnce(long slotTs, CancellationToken stoppingToken)
    {
        await RefreshLocations(stoppingToken);

        for (var attempt = 1; attempt <= MaxAttempts && !stoppingToken.IsCancellationRequested; attempt++)
        {
            _state.LastAttempt = DateTimeOffset.UtcNow;
            try
            {
                var readings = await FetchCapacity(_locations, stoppingToken);
                if (readings.Count == 0)
                    throw new InvalidOperationException("response contained no locations");

                _db.SaveLocations(
                    readings.Select(r =>
                    {
                        var position = Array.IndexOf(_locations, r.Id);
                        return new Location(r.Id, r.Title, r.Url, position < 0 ? 999 : position);
                    }).ToList(),
                    DateTimeOffset.UtcNow.ToUnixTimeSeconds());
                _db.SaveReadings(slotTs, readings.Select(r => (r.Id, r.Capacity)).ToList());

                _state.LastSuccess = DateTimeOffset.UtcNow;
                _state.LastError = null;
                _state.ConsecutiveFailures = 0;
                _state.KnownLocations = readings.Count;

                _logger.LogInformation("Slot {Slot}: stored {Count} locations",
                    DateTimeOffset.FromUnixTimeSeconds(slotTs).ToString("u"), readings.Count);
                return;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                _state.LastError = ex.Message;
                _logger.LogWarning("Attempt {Attempt}/{Max} failed: {Message}",
                    attempt, MaxAttempts, ex.Message);

                if (attempt == MaxAttempts)
                    break;

                try
                {
                    await Task.Delay(RetryDelay, stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
            }
        }

        _state.ConsecutiveFailures++;
        _logger.LogError("Slot {Slot} skipped, nothing stored",
            DateTimeOffset.FromUnixTimeSeconds(slotTs).ToString("u"));
    }

    private async Task<List<Sample>> FetchCapacity(int[] locations, CancellationToken stoppingToken)
    {
        var client = _factory.CreateClient("boulderbar");
        var url = $"{CapacityUrl}?locations={string.Join(',', locations)}";

        using var response = await client.GetAsync(url, stoppingToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(stoppingToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: stoppingToken);

        var result = new List<Sample>();
        if (!document.RootElement.TryGetProperty("data", out var data) ||
            data.ValueKind != JsonValueKind.Array)
            return result;

        foreach (var entry in data.EnumerateArray())
        {
            if (!TryReadInt(entry, "id", out var id) ||
                !TryReadInt(entry, "capacity", out var capacity))
                continue;

            var title = entry.TryGetProperty("title", out var t) ? t.GetString() : null;
            var link = entry.TryGetProperty("url", out var u) ? u.GetString() : null;

            result.Add(new Sample(id, Math.Clamp(capacity, 0, 100), title ?? id.ToString(), link));
        }

        return result;
    }

    private static bool TryReadInt(JsonElement element, string name, out int value)
    {
        value = 0;
        if (!element.TryGetProperty(name, out var property))
            return false;

        return property.ValueKind switch
        {
            JsonValueKind.Number => property.TryGetInt32(out value),
            JsonValueKind.String => int.TryParse(property.GetString(), out value),
            _ => false
        };
    }

    private async Task RefreshLocations(CancellationToken stoppingToken)
    {
        if (DateTimeOffset.UtcNow - _discoveredAt < DiscoveryInterval)
            return;

        try
        {
            var client = _factory.CreateClient("boulderbar");
            var html = await client.GetStringAsync(StandorteUrl, stoppingToken);
            var match = ArchiveIds().Match(html);
            if (match.Success)
            {
                var ids = match.Groups[1].Value
                    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .Select(part => int.TryParse(part, out var id) ? id : -1)
                    .Where(id => id > 0)
                    .Distinct()
                    .ToArray();

                if (ids.Length > 0)
                {
                    if (!ids.SequenceEqual(_locations))
                        _logger.LogInformation("Location list updated: {Ids}", string.Join(',', ids));
                    _locations = ids;
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            return;
        }
        catch (Exception ex)
        {
            _logger.LogWarning("Could not read location list, falling back to known IDs: {Message}", ex.Message);
        }

        _discoveredAt = DateTimeOffset.UtcNow;
    }

    [GeneratedRegex(@"capacityArchive\(\[([\d,\s]+)\]\)")]
    private static partial Regex ArchiveIds();

    private sealed record Sample(int Id, int Capacity, string Title, string? Url);
}
