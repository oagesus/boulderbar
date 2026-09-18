(function () {
  "use strict";

  var COLORS_LIGHT = ["#0072b2", "#d55e00", "#009e73", "#cc0066", "#7a3fa8", "#8c5a2b", "#00a0b0"];
  var COLORS_DARK = ["#5ab4ea", "#ff9440", "#2bd79e", "#ff6fa8", "#b98ce8", "#d19a63", "#3fd3e0"];
  var MONTH_LONG = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  var MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  var DAY_MIN = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  var BUCKETS = { day: 900, week: 1800, month: 3600 };
  var ENFORCE_DATA_RANGE = true;

  var el = {
    updated: document.getElementById("updated"),
    locs: document.getElementById("locs"),
    dateBtn: document.getElementById("date-btn"),
    popup: document.getElementById("popup"),
    calPrev: document.getElementById("cal-prev"),
    calNext: document.getElementById("cal-next"),
    calTitle: document.getElementById("cal-title"),
    calBody: document.getElementById("cal-body"),
    views: document.getElementById("views"),
    chart: document.getElementById("chart"),
    empty: document.getElementById("empty")
  };

  var state = { view: "day", anchor: startOfDay(new Date()), hidden: new Set() };
  var cal = { year: 0, month: 0 };

  var locations = [];
  var coverage = { minTs: null, maxTs: null, count: 0 };
  var plot = null;
  var rows = null;
  var tip = null;
  var pointsOn = false;
  var lastSuccess = null;
  var collectorStale = false;
  var requestToken = 0;
  var booted = false;

  function pad(n) { return n < 10 ? "0" + n : String(n); }
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
  function secs(d) { return Math.floor(d.getTime() / 1000); }
  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function mondayOf(d) {
    var offset = (d.getDay() + 6) % 7;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset);
  }

  function isoKey(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }

  function windowFor(view, anchor) {
    var y = anchor.getFullYear(), m = anchor.getMonth(), d = anchor.getDate();
    if (view === "day") return [new Date(y, m, d), new Date(y, m, d + 1)];
    if (view === "week") {
      var mon = mondayOf(anchor);
      return [mon, new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 7)];
    }
    return [new Date(y, m, 1), new Date(y, m + 1, 1)];
  }

  function regionOf(loc) {
    return /\/standorte\/wien-/.test(loc.url || "") ? "Wien" : "";
  }

  function displayName(loc) {
    var region = regionOf(loc);
    return region ? region + ": " + loc.title : loc.title;
  }

  function isDark() { return window.matchMedia("(prefers-color-scheme: dark)").matches; }
  function palette() { return isDark() ? COLORS_DARK : COLORS_LIGHT; }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function hasData(start, end) {
    if (coverage.minTs === null) return false;
    return secs(end) > coverage.minTs && secs(start) <= coverage.maxTs;
  }

  function dayHasData(y, m, d) { return hasData(new Date(y, m, d), new Date(y, m, d + 1)); }

  function readHash() {
    var raw = location.hash.replace(/^#/, "");
    if (!raw) return;
    var params = new URLSearchParams(raw);

    var view = params.get("view");
    if (view === "day" || view === "week" || view === "month") state.view = view;

    var date = params.get("date");
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      var p = date.split("-");
      var parsed = new Date(+p[0], +p[1] - 1, +p[2]);
      if (!isNaN(parsed.getTime())) state.anchor = parsed;
    }

    var hide = params.get("hide");
    if (hide !== null) state.hidden = new Set(hide.split(",").filter(Boolean).map(Number));
  }

  function writeHash() {
    if (!booted) return;
    var params = new URLSearchParams();
    params.set("view", state.view);
    params.set("date", isoKey(state.anchor));
    if (state.hidden.size) params.set("hide", Array.from(state.hidden).join(","));
    history.replaceState(null, "", "#" + params.toString());
  }

  function persistHidden() {
    try { localStorage.setItem("bb.hidden", JSON.stringify(Array.from(state.hidden))); } catch (e) { }
  }

  function restoreHidden() {
    if (location.hash.indexOf("hide=") !== -1) return;
    try {
      var stored = JSON.parse(localStorage.getItem("bb.hidden") || "[]");
      if (Array.isArray(stored)) state.hidden = new Set(stored.map(Number));
    } catch (e) { }
  }

  function json(url) {
    return fetch(url, { headers: { accept: "application/json" } })
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .catch(function () { return null; });
  }

  function loadStatus() {
    json("/healthz").then(function (health) {
      if (!health) return;
      var when = health.lastSuccess ? new Date(health.lastSuccess) : null;
      var fresh = when && !isNaN(when.getTime()) ? when : null;
      var advanced = fresh && lastSuccess && fresh.getTime() > lastSuccess.getTime();

      lastSuccess = fresh;
      collectorStale = health.status !== "ok";
      renderUpdated();

      if (advanced && secs(windowFor(state.view, state.anchor)[1]) > Date.now() / 1000)
        loadSeries();
    });
  }

  function renderUpdated() {
    if (!lastSuccess) {
      el.updated.textContent = "waiting for first reading";
      el.updated.className = "updated stale";
      return;
    }

    var minutes = Math.max(0, Math.round((Date.now() - lastSuccess.getTime()) / 60000));
    var ago;

    if (minutes < 1) ago = "just now";
    else if (minutes < 60) ago = minutes + " min ago";
    else ago = Math.floor(minutes / 60) + " h " + (minutes % 60) + " min ago";

    el.updated.textContent = "last update: " + ago;
    el.updated.className = collectorStale ? "updated stale" : "updated";
  }

  function buttonLabel() {
    var a = state.anchor;

    if (state.view === "day")
      return DAY_SHORT[(a.getDay() + 6) % 7] + " " + pad(a.getDate()) + " "
        + MONTH_SHORT[a.getMonth()] + " " + a.getFullYear();

    if (state.view === "week") {
      var mon = mondayOf(a);
      var sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
      var head;

      if (mon.getFullYear() !== sun.getFullYear())
        head = pad(mon.getDate()) + " " + MONTH_SHORT[mon.getMonth()] + " " + mon.getFullYear();
      else if (mon.getMonth() !== sun.getMonth())
        head = pad(mon.getDate()) + " " + MONTH_SHORT[mon.getMonth()];
      else
        head = pad(mon.getDate());

      return head + " – " + pad(sun.getDate()) + " " + MONTH_SHORT[sun.getMonth()] + " "
        + sun.getFullYear();
    }

    return MONTH_LONG[a.getMonth()] + " " + a.getFullYear();
  }

  function renderCalendar() {
    var y = cal.year, m = cal.month;
    el.calTitle.textContent = MONTH_LONG[m] + " " + y;
    el.calBody.parentNode.className = state.view === "week" ? "cal cal--week" : "cal";
    el.calBody.innerHTML = "";

    var head = document.createElement("tr");
    DAY_MIN.forEach(function (name) { head.appendChild(makeCell("th", name, "")); });
    el.calBody.appendChild(head);

    var today = startOfDay(new Date());
    var cursor = mondayOf(new Date(y, m, 1));
    var last = new Date(y, m + 1, 0);

    while (cursor <= last) {
      var monday = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate());
      var row = document.createElement("tr");

      for (var i = 0; i < 7; i++) {
        var date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
        var cell = document.createElement("td");
        cell.appendChild(dayButton(date, m, today));
        row.appendChild(cell);
      }

      el.calBody.appendChild(row);
      cursor.setDate(cursor.getDate() + 7);
    }
  }

  function makeCell(tagName, text, className) {
    var node = document.createElement(tagName);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function daySelectable(date) {
    if (!ENFORCE_DATA_RANGE) return true;

    var y = date.getFullYear(), m = date.getMonth();
    if (state.view === "week") {
      var mon = mondayOf(date);
      return hasData(mon, new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 7));
    }
    if (state.view === "month")
      return hasData(new Date(y, m, 1), new Date(y, m + 1, 1));
    return dayHasData(y, m, date.getDate());
  }

  function inSelection(date) {
    if (state.view === "day") return sameDay(date, state.anchor);
    if (state.view === "week") return mondayOf(date).getTime() === mondayOf(state.anchor).getTime();
    return date.getFullYear() === state.anchor.getFullYear() && date.getMonth() === state.anchor.getMonth();
  }

  function dayButton(date, activeMonth, today) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = date.getDate();

    var classes = [];
    if (date.getMonth() !== activeMonth) classes.push("out");
    if (sameDay(date, today)) classes.push("today");
    if (sameDay(date, state.anchor)) classes.push("on");
    else if (inSelection(date)) classes.push("range");
    btn.className = classes.join(" ");

    btn.disabled = !daySelectable(date);
    btn.title = isoKey(date);
    btn.addEventListener("click", function () {
      state.anchor = date;
      closePopup();
      refresh();
    });
    return btn;
  }

  function openPopup() {
    cal.year = state.anchor.getFullYear();
    cal.month = state.anchor.getMonth();
    renderCalendar();
    el.popup.hidden = false;
    el.dateBtn.setAttribute("aria-expanded", "true");
  }

  function closePopup() {
    el.popup.hidden = true;
    el.dateBtn.setAttribute("aria-expanded", "false");
  }

  function syncViewRadio() {
    var input = el.views.querySelector('input[value="' + state.view + '"]');
    if (input) input.checked = true;
  }

  function stepBy(delta) {
    var y = state.anchor.getFullYear(), m = state.anchor.getMonth(), d = state.anchor.getDate();
    if (state.view === "day") state.anchor = new Date(y, m, d + delta);
    else if (state.view === "week") state.anchor = new Date(y, m, d + 7 * delta);
    else state.anchor = new Date(y, m + delta, Math.min(d, daysInMonth(y, m + delta)));
    refresh();
  }

  function updateNav() {
    el.dateBtn.textContent = buttonLabel();
  }

  function buildPicker() {
    var colors = palette();
    el.locs.innerHTML = "";

    locations.forEach(function (loc, i) {
      if (i > 0 && regionOf(loc) !== regionOf(locations[i - 1])) {
        var brk = document.createElement("span");
        brk.className = "brk";
        el.locs.appendChild(brk);
      }

      var item = document.createElement("label");
      item.className = "item";

      var box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !state.hidden.has(loc.id);
      box.addEventListener("change", function () {
        if (box.checked) state.hidden.delete(loc.id); else state.hidden.add(loc.id);
        item.classList.toggle("off", !box.checked);
        if (plot) plot.setSeries(i + 1, { show: box.checked });
        persistHidden();
        writeHash();
      });

      var swatch = document.createElement("span");
      swatch.className = "sw";
      swatch.style.background = colors[i % colors.length];

      item.appendChild(box);
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(displayName(loc)));
      item.classList.toggle("off", !box.checked);
      el.locs.appendChild(item);
    });
  }

  function fmtTipTime(ts) {
    var d = new Date(ts * 1000);
    var clock = pad(d.getHours()) + ":" + pad(d.getMinutes());
    if (state.view === "day") return clock;
    return DAY_SHORT[(d.getDay() + 6) % 7] + " " + d.getDate() + " " + MONTH_SHORT[d.getMonth()] + ", " + clock;
  }

  function updateTip(u) {
    var idx = u.cursor.idx;
    if (idx === null || idx === undefined || !rows) { tip.hidden = true; return; }

    var colors = palette();
    var html = "";
    locations.forEach(function (loc, i) {
      if (state.hidden.has(loc.id)) return;
      var v = rows[i + 1] ? rows[i + 1][idx] : null;
      if (v === null || v === undefined) return;
      html += '<div class="row"><i style="background:' + colors[i % colors.length] + '"></i>'
        + "<span>" + displayName(loc) + "</span><b>" + Math.round(v) + "%</b></div>";
    });

    if (!html) { tip.hidden = true; return; }

    tip.innerHTML = '<div class="when">' + fmtTipTime(rows[0][idx]) + "</div>" + html;
    tip.hidden = false;

    var left = u.cursor.left + 14;
    var top = u.cursor.top + 14;
    if (left + tip.offsetWidth > u.over.clientWidth) left = u.cursor.left - tip.offsetWidth - 14;
    if (top + tip.offsetHeight > u.over.clientHeight) top = u.cursor.top - tip.offsetHeight - 14;
    tip.style.left = Math.max(0, left) + "px";
    tip.style.top = Math.max(0, top) + "px";
  }

  function axisSplits(min, max) {
    var out = [];
    var a = new Date(min * 1000);
    var y = a.getFullYear(), m = a.getMonth(), d = a.getDate(), i;

    if (state.view === "day") { for (i = 0; i <= 24; i += 2) out.push(secs(new Date(y, m, d, i))); }
    else if (state.view === "week") { for (i = 0; i <= 7; i++) out.push(secs(new Date(y, m, d + i))); }
    else {
      var total = daysInMonth(y, m);
      for (i = 0; i < total; i += 3) out.push(secs(new Date(y, m, 1 + i)));
    }

    return out.filter(function (t) { return t >= min && t <= max; });
  }

  function fmtTick(t) {
    var d = new Date(t * 1000);
    if (state.view === "day") return pad(d.getHours()) + ":" + pad(d.getMinutes());
    if (state.view === "week") return DAY_SHORT[(d.getDay() + 6) % 7] + " " + d.getDate();
    return String(d.getDate());
  }

  function chartSize() {
    var width = el.chart.clientWidth || document.getElementById("app").clientWidth - 34;
    var height = Math.max(240, Math.min(430, Math.round(window.innerHeight * 0.46)));
    return { width: width, height: height };
  }

  function buildPlot() {
    if (plot) { plot.destroy(); plot = null; }

    tip = document.createElement("div");
    tip.className = "tip";
    tip.hidden = true;

    var colors = palette();
    var axisColor = cssVar("--fg-dim");
    var gridColor = cssVar("--grid");
    var font = '11px "DejaVu Sans Mono", "Liberation Mono", monospace';

    var series = [{}];
    locations.forEach(function (loc, i) {
      series.push({
        label: displayName(loc),
        stroke: colors[i % colors.length],
        width: 1.5,
        show: !state.hidden.has(loc.id),
        spanGaps: false,
        points: pointsOn ? { show: true, size: 6 } : { show: false }
      });
    });

    var size = chartSize();

    plot = new uPlot({
      width: size.width,
      height: size.height,
      padding: [8, 26, 0, 0],
      cursor: { y: false, drag: { x: false, y: false }, points: { show: false } },
      legend: { show: false },
      scales: { x: { time: true }, y: { range: [0, 100] } },
      axes: [
        {
          stroke: axisColor,
          font: font,
          grid: { stroke: gridColor, width: 1 },
          ticks: { stroke: gridColor, width: 1, size: 4 },
          splits: function (u, ai, min, max) { return axisSplits(min, max); },
          values: function (u, splits) { return splits.map(fmtTick); }
        },
        {
          stroke: axisColor,
          font: font,
          size: 46,
          grid: { stroke: gridColor, width: 1 },
          ticks: { stroke: gridColor, width: 1, size: 4 },
          splits: function () { return [0, 25, 50, 75, 100]; },
          values: function (u, splits) { return splits.map(function (v) { return v + "%"; }); }
        }
      ],
      series: series,
      hooks: {
        init: [function (u) { u.over.appendChild(tip); }],
        setCursor: [function (u) { updateTip(u); }]
      }
    }, [[]].concat(locations.map(function () { return []; })), el.chart);
  }

  function loadSeries() {
    var bounds = windowFor(state.view, state.anchor);
    var from = secs(bounds[0]);
    var to = secs(bounds[1]);
    var token = ++requestToken;

    var url = "/api/series?from=" + from + "&to=" + to + "&bucket=" + BUCKETS[state.view]
      + "&locations=" + locations.map(function (l) { return l.id; }).join(",");

    return json(url).then(function (data) {
      if (token !== requestToken || !data || !data.ts) return;

      var next = [data.ts];
      var filled = 0;
      locations.forEach(function (loc) {
        var values = data.series[String(loc.id)] || [];
        for (var k = 0; k < values.length; k++) {
          if (values[k] !== null && values[k] !== undefined) filled++;
        }
        next.push(values);
      });

      var sparse = filled > 0 && filled <= locations.length * 3;
      if (sparse !== pointsOn) {
        pointsOn = sparse;
        buildPlot();
      }

      rows = next;
      tip.hidden = true;
      plot.setData(rows);
      plot.setScale("x", { min: from, max: to });
      el.empty.hidden = filled > 0;
    });
  }

  function refresh() {
    writeHash();
    updateNav();
    if (!el.popup.hidden) renderCalendar();
    loadSeries();
  }

  function bind() {
    el.dateBtn.addEventListener("click", function (event) {
      event.stopPropagation();
      if (el.popup.hidden) openPopup(); else closePopup();
    });

    el.popup.addEventListener("click", function (event) { event.stopPropagation(); });
    document.addEventListener("click", function () { if (!el.popup.hidden) closePopup(); });

    el.calPrev.addEventListener("click", function () {
      if (--cal.month < 0) { cal.month = 11; cal.year--; }
      renderCalendar();
    });

    el.calNext.addEventListener("click", function () {
      if (++cal.month > 11) { cal.month = 0; cal.year++; }
      renderCalendar();
    });

    el.views.addEventListener("change", function (event) {
      if (!event.target.name) return;
      state.view = event.target.value;
      refresh();
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !el.popup.hidden) { closePopup(); return; }
      if (event.target && (event.target.tagName === "INPUT" || event.target.tagName === "BUTTON")) return;
      if (event.key === "ArrowLeft") stepBy(-1);
      if (event.key === "ArrowRight" && secs(windowFor(state.view, state.anchor)[1]) < Date.now() / 1000) stepBy(1);
    });

    window.addEventListener("resize", function () { if (plot) plot.setSize(chartSize()); });

    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
      buildPlot();
      buildPicker();
      loadSeries();
    });
  }

  function init() {
    restoreHidden();
    readHash();
    syncViewRadio();

    Promise.all([json("/api/locations"), json("/api/coverage")]).then(function (res) {
      locations = res[0] || [];
      coverage = res[1] || coverage;

      if (!locations.length) {
        el.empty.hidden = false;
        el.empty.textContent = "no locations recorded yet — the collector is starting up";
        el.updated.textContent = "waiting for first reading";
        el.updated.className = "updated stale";
        setTimeout(init, 20000);
        return;
      }

      el.empty.textContent = "no data in this range";

      buildPlot();
      buildPicker();
      bind();
      updateNav();
      loadSeries();
      loadStatus();
      booted = true;

      setInterval(loadStatus, 60000);
      setInterval(renderUpdated, 20000);
      setInterval(function () {
        json("/api/coverage").then(function (c) {
          if (!c) return;
          coverage = c;
          updateNav();
          if (!el.popup.hidden) renderCalendar();
        });
      }, 300000);
    });
  }

  init();
})();
