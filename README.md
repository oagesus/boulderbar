# boulderbar.net stats

![.NET](https://img.shields.io/badge/.NET-10.0-512BD4?logo=dotnet&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black)
![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)
[![ci](https://github.com/oagesus/boulderbar/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/oagesus/boulderbar/actions/workflows/docker-publish.yml)

Records how busy the seven [boulderbar](https://boulderbar.net) climbing gyms are, every
15 minutes, and plots it over time.

Live at **[boulderbar.mstubenvoll.com](https://boulderbar.mstubenvoll.com)**.

## How it works

One container does both jobs: a background service collects the data, a web server shows it.

Numbers come from boulderbar's own open JSON endpoint, so no HTML scraping is involved:

```
GET https://boulderbar.net/wp-json/boulderbar/v1/capacity?locations=262,265,263,264,261,260,284
```

Readings are stored in a single SQLite file, roughly 10 MB per year. Timestamps are UTC and
snapped to the quarter hour; the browser converts them to local time.

## License

MIT. Covers this code, not boulderbar's data.
