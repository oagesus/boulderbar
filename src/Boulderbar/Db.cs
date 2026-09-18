using Microsoft.Data.Sqlite;

namespace Boulderbar;

public sealed record Location(int Id, string Title, string? Url, int Sort);

public sealed record Reading(int Loc, int Capacity, long Ts);

public sealed record Coverage(long? MinTs, long? MaxTs, long Count);

public sealed class Db
{
    public const int SlotSeconds = 900;

    private readonly string _connectionString;

    public Db(string path)
    {
        var dir = Path.GetDirectoryName(Path.GetFullPath(path));
        if (!string.IsNullOrEmpty(dir))
            Directory.CreateDirectory(dir);

        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Pooling = true
        }.ToString();
    }

    private SqliteConnection Open()
    {
        var connection = new SqliteConnection(_connectionString);
        connection.Open();
        using var pragma = connection.CreateCommand();
        pragma.CommandText = "PRAGMA busy_timeout=5000;";
        pragma.ExecuteNonQuery();
        return connection;
    }

    public void Initialize()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=NORMAL;

            CREATE TABLE IF NOT EXISTS readings (
              ts       INTEGER NOT NULL,
              loc      INTEGER NOT NULL,
              capacity INTEGER NOT NULL,
              PRIMARY KEY (ts, loc)
            ) WITHOUT ROWID;

            CREATE TABLE IF NOT EXISTS locations (
              id    INTEGER PRIMARY KEY,
              title TEXT NOT NULL,
              url   TEXT,
              seen  INTEGER NOT NULL,
              sort  INTEGER NOT NULL DEFAULT 999
            );
            """;
        command.ExecuteNonQuery();

        using var probe = connection.CreateCommand();
        probe.CommandText = "SELECT COUNT(*) FROM pragma_table_info('locations') WHERE name = 'sort';";
        if (Convert.ToInt64(probe.ExecuteScalar()) == 0)
        {
            using var migrate = connection.CreateCommand();
            migrate.CommandText = "ALTER TABLE locations ADD COLUMN sort INTEGER NOT NULL DEFAULT 999;";
            migrate.ExecuteNonQuery();
        }
    }

    public int SaveReadings(long slotTs, IReadOnlyList<(int Loc, int Capacity)> values)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using var command = connection.CreateCommand();
        command.CommandText =
            "INSERT OR IGNORE INTO readings (ts, loc, capacity) VALUES ($ts, $loc, $capacity);";
        command.Parameters.AddWithValue("$ts", slotTs);
        var loc = command.Parameters.Add("$loc", SqliteType.Integer);
        var capacity = command.Parameters.Add("$capacity", SqliteType.Integer);

        var written = 0;
        foreach (var value in values)
        {
            loc.Value = value.Loc;
            capacity.Value = value.Capacity;
            written += command.ExecuteNonQuery();
        }

        transaction.Commit();
        return written;
    }

    public void SaveLocations(IReadOnlyList<Location> locations, long now)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO locations (id, title, url, seen, sort) VALUES ($id, $title, $url, $seen, $sort)
            ON CONFLICT(id) DO UPDATE SET title = excluded.title, url = excluded.url,
                                          seen = excluded.seen, sort = excluded.sort;
            """;
        var id = command.Parameters.Add("$id", SqliteType.Integer);
        var title = command.Parameters.Add("$title", SqliteType.Text);
        var url = command.Parameters.Add("$url", SqliteType.Text);
        var sort = command.Parameters.Add("$sort", SqliteType.Integer);
        command.Parameters.AddWithValue("$seen", now);

        foreach (var location in locations)
        {
            id.Value = location.Id;
            title.Value = location.Title;
            url.Value = (object?)location.Url ?? DBNull.Value;
            sort.Value = location.Sort;
            command.ExecuteNonQuery();
        }

        transaction.Commit();
    }

    public List<Location> GetLocations()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT id, title, url, sort FROM locations ORDER BY sort, title;";

        var result = new List<Location>();
        using var reader = command.ExecuteReader();
        while (reader.Read())
            result.Add(new Location(reader.GetInt32(0), reader.GetString(1),
                reader.IsDBNull(2) ? null : reader.GetString(2), reader.GetInt32(3)));
        return result;
    }

    public List<Reading> GetLatest()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT r.loc, r.capacity, r.ts
            FROM readings r
            JOIN (SELECT loc, MAX(ts) AS ts FROM readings GROUP BY loc) m
              ON m.loc = r.loc AND m.ts = r.ts
            ORDER BY r.loc;
            """;

        var result = new List<Reading>();
        using var reader = command.ExecuteReader();
        while (reader.Read())
            result.Add(new Reading(reader.GetInt32(0), reader.GetInt32(1), reader.GetInt64(2)));
        return result;
    }

    public Coverage GetCoverage()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT MIN(ts), MAX(ts), COUNT(*) FROM readings;";
        using var reader = command.ExecuteReader();
        if (!reader.Read())
            return new Coverage(null, null, 0);

        return new Coverage(
            reader.IsDBNull(0) ? null : reader.GetInt64(0),
            reader.IsDBNull(1) ? null : reader.GetInt64(1),
            reader.GetInt64(2));
    }

    public (long[] Ts, Dictionary<int, double?[]> Series) GetSeries(
        long from, long to, int bucketSeconds, IReadOnlyList<int> locations)
    {
        var start = from / bucketSeconds * bucketSeconds;
        var count = (int)Math.Max(0, (to - start + bucketSeconds - 1) / bucketSeconds);

        var axis = new long[count];
        for (var i = 0; i < count; i++)
            axis[i] = start + (long)i * bucketSeconds;

        var series = new Dictionary<int, double?[]>();
        foreach (var location in locations)
            series[location] = new double?[count];

        if (count == 0)
            return (axis, series);

        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT ts / $bucket * $bucket AS slot, loc, AVG(capacity)
            FROM readings
            WHERE ts >= $from AND ts < $to
            GROUP BY slot, loc;
            """;
        command.Parameters.AddWithValue("$bucket", bucketSeconds);
        command.Parameters.AddWithValue("$from", start);
        command.Parameters.AddWithValue("$to", to);

        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            var index = (int)((reader.GetInt64(0) - start) / bucketSeconds);
            if (index < 0 || index >= count)
                continue;
            if (series.TryGetValue(reader.GetInt32(1), out var target))
                target[index] = Math.Round(reader.GetDouble(2), 1);
        }

        return (axis, series);
    }

    public IEnumerable<(long Ts, int Loc, int Capacity)> ExportAll()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT ts, loc, capacity FROM readings ORDER BY ts, loc;";
        using var reader = command.ExecuteReader();
        while (reader.Read())
            yield return (reader.GetInt64(0), reader.GetInt32(1), reader.GetInt32(2));
    }

    public static long FloorToSlot(DateTimeOffset moment)
    {
        var seconds = moment.ToUnixTimeSeconds();
        return seconds / SlotSeconds * SlotSeconds;
    }
}
