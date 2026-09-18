# boulderbar

Zeichnet alle 15 Minuten die Auslastung der sieben boulderbar-Standorte auf und zeigt sie als
Zeitreihe — umschaltbar zwischen Tag, Woche und Monat, mit Monatswahl bis zurück zum ersten
Messwert.

Läuft unter <https://boulderbar.mstubenvoll.com>.

## Aufbau

Ein einziger Container enthält beides: einen Hintergrunddienst, der die Daten sammelt, und den
Webserver, der sie ausliefert.

| Teil      | Technik                                                    |
|-----------|------------------------------------------------------------|
| Backend   | C# / .NET 10 Minimal API, ein NuGet (`Microsoft.Data.Sqlite`) |
| Speicher  | SQLite, eine Datei unter `/data/boulderbar.db`              |
| Frontend  | HTML, CSS und JavaScript ohne Build-Schritt, Graph mit uPlot |

## Datenquelle

Die Auslastung kommt aus einer offenen REST-Schnittstelle von boulderbar.net, nicht aus dem HTML:

```
GET https://boulderbar.net/wp-json/boulderbar/v1/capacity?locations=260,261,262,263,264,265,284
```

Die Standort-IDs werden einmal täglich aus <https://boulderbar.net/standorte/> nachgelesen, damit
eine neue Halle automatisch mitgetrackt wird. Schlägt das fehl, greift die bekannte Liste.

Abgefragt wird jeweils mit einer zufälligen Abweichung von bis zu fünf Sekunden um den
Viertelstunden-Takt, gespeichert wird aber auf den geplanten Slot gerundet. Schlägt ein Abruf
dreimal hintereinander fehl, wird der Slot übersprungen und **nichts** geschrieben — eine Lücke
im Graph ist keine Auslastung von null.

## Speicherung

```sql
readings(ts INTEGER, loc INTEGER, capacity INTEGER, PRIMARY KEY (ts, loc)) WITHOUT ROWID
locations(id INTEGER PRIMARY KEY, title TEXT, url TEXT, seen INTEGER)
```

Zeitstempel sind Unix-Sekunden in UTC. Die Umrechnung auf Wiener Zeit passiert erst im Browser,
dadurch braucht der Container keine Zeitzonendaten und die Zeitumstellung kollidiert nicht mit dem
Primärschlüssel.

Rund 245.000 Zeilen pro Jahr, etwa 10 MB. Es wird nichts gelöscht.

## Lokal starten

```bash
dotnet run --project src/Boulderbar
```

Läuft dann auf <http://localhost:8080>, die Datenbank landet in `src/Boulderbar/data/`.

Den Container testen:

```bash
docker compose -f compose.local.yaml up --build
```

Erreichbar unter <http://localhost:8081>. Der Host-Port ist bewusst nicht 8080, weil dieser auf dem
Entwicklungsrechner bereits von einem Apache-Dienst belegt ist.

Die Daten liegen dabei in einem Named Volume statt in einem Bind-Mount, weil SQLite-Dateisperren
auf durchgereichten Windows-Laufwerken unzuverlässig sind.

## Auf dem Server

```bash
mkdir -p ~/docker/boulderbar/data
cd ~/docker/boulderbar
docker compose -f compose.boulderbar.yaml pull
docker compose -f compose.boulderbar.yaml up -d
```

Der Container veröffentlicht keinen Port; der Nginx Proxy Manager erreicht ihn über das
`shared-network` unter `http://boulderbar:8080`.

`user: "1000:1000"` im Compose-File sorgt dafür, dass der Container als der eigene Benutzer
schreibt und die Datenbank ohne `sudo` lesbar bleibt. Mit `id -u` prüfen, falls die UID abweicht.

Ein bestimmter Stand lässt sich mit `TAG=<commit-sha> docker compose … up -d` starten.

## Sicherung

Nicht mit `cp` kopieren — im WAL-Modus besteht die Datenbank aus mehreren Dateien:

```bash
sqlite3 ~/docker/boulderbar/data/boulderbar.db "VACUUM INTO '/pfad/bb-$(date +%F).db'"
```

## Schnittstellen

| Route | Zweck |
|-------|-------|
| `GET /api/locations` | Standorte mit ID und Namen |
| `GET /api/latest` | jüngste Messung je Standort |
| `GET /api/series` | Zeitreihe, Parameter `from`, `to`, `bucket`, `locations` |
| `GET /api/coverage` | erster und letzter Messwert, Zeilenzahl |
| `GET /api/export.csv` | alle Rohdaten |
| `GET /healthz` | Status, liefert 503 wenn länger als 45 Minuten nichts ankam |

`bucket` ist die Auflösung in Sekunden und akzeptiert 900, 1800, 3600, 21600 und 86400. Die Antwort
von `/api/series` ist spaltenweise aufgebaut, fehlende Messungen stehen als `null`.

## Konfiguration

| Variable | Vorgabe | Bedeutung |
|----------|---------|-----------|
| `BB_DB` | `./data/boulderbar.db` | Pfad zur Datenbank |
| `ASPNETCORE_URLS` | `http://localhost:8080` | Adresse des Webservers |

## Lizenz

MIT. Die Lizenz gilt für diesen Code, nicht für die Daten von boulderbar.net.
