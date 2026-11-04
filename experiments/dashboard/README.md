# Dashboards you draw

Draw your system, and the shapes show live numbers. A dashboard is a plain `.excalidraw`
file. Everything that binds it to data is label text you can type in Excalidraw, so it can
be edited there and diffed in git. Open it at `/experiments/dashboard/`. To feed a board from
another project and keep its history, see [Connecting another project](#connecting-another-project).

    api
    demo: api.rate
    demo: api.errors
    warn above 1 for 20s
    critical above 3 for 20s

That label in a rectangle is a box with two numbers, a status and two alerts. Add `chart` on
its own line and it is a chart. An arrow can carry a source line too, and `flow` makes dots
travel along it at that rate.

## What is on the page

| Where | What |
|---|---|
| Left | Undo, save and open. Panels and every source's metrics to drag on. A metric dropped on a shape joins it |
| Middle | The board, and along the bottom the alert states over time, which you drag to look back |
| Right | What the shape is bound to, what it understood, its values, what changed, and what else it can say |
| Top | What is firing, the time range, the last update, and a line saying what moment the shapes show |

A mistake gets a message on the drawing with a fix to click. Hints appear as you type a label.
**What can I draw?** is the reference. It and the hints, the inspector's lists and the palette
are built from `vocab.js`, the table the parser reads, and a test checks that every word parses
from its own example. **table** lists every number on the drawing. `d` is dark mode. `f` is the
wall view: no controls, one large line saying what is firing, and `NOT UPDATING` if the data stops.

The gallery has six example dashboards. `This machine` opens first, and needs no setup.

## Scenes and tabs

`scenes/scenes.json` lists the dashboards in the gallery, and each one's drawing is `scenes/<id>.excalidraw` beside it.

```json
[
  { "id": "overview", "group": "screeps", "title": "Overview", "summary": "What the gallery says about it.", "span": "7d" },
  { "id": "energy", "group": "screeps", "title": "Energy", "summary": "...", "span": 86400 }
]
```

| Field | What |
|---|---|
| `id` | The file name and the address, `#overview` |
| `group` | Scenes with the same group show as tabs across the top, in this file's order. The gallery shows it too |
| `title` | The tab's words and the gallery card's title |
| `summary` | The gallery card's words |
| `span` | Optional. The range when it is opened from a link or the gallery, as seconds or words such as `7d`, up to 30 days |

A tab is a link, so it can be sent to someone, and back and forward walk through the tabs you visited.
Switching keeps the range, the pause and any moment you were looking at, rather than the next scene's
`span`. A tab you changed stays changed until the page reloads.

## Sources

| Name | What | Setup |
|---|---|---|
| `machine` | CPU, memory, load, disk and network on this computer, sampled from when the server started. Kept for 2 hours | None |
| `demo` | A made-up checkout service with six parts. Its values are a pure function of the time, a seed and the incidents, so it has history at once. **start an incident** changes it | None |
| `push` | Numbers a script sends | None |
| Yours | Prometheus, any JSON URL, more push sources | Below |

### Adding a source

Copy `sources.example.json` to `experiments/dashboard/.sources.json`, or point `DASHBOARD_SOURCES`
at a file anywhere. It is read again when it changes, so there is nothing to restart.

```json
{
  "sources": {
    "prod": { "type": "prometheus", "url": "http://127.0.0.1:9090", "every": "15s", "bearer": "a-token" },
    "orders": {
      "type": "json", "url": "http://127.0.0.1:8080/stats", "every": "5s",
      "headers": { "X-Api-Key": "a-key" },
      "fields": { "qps": { "path": "requests.perSecond", "name": "requests", "unit": "req/s" } }
    },
    "deploys": { "type": "push", "every": "30s", "token": "a-long-random-string" }
  }
}
```

Then write `prod: sum(rate(http_requests_total[1m])) in req/s` in a label. Other fields are
`user` and `password` for basic auth, `headers`, and `timeoutSeconds`. Charts and boxes use
`query_range`, and a `table` uses an instant `query`, at the moment you are looking at. A JSON
source is polled on the server only while a page is using it, and a drawing can name a declared
field or any path to a number, such as `a.b[0].c`.

To push a number:

```sh
curl -X POST http://localhost:4173/dashboard/push \
  -H 'Origin: http://localhost:4173' -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer a-long-random-string' \
  -d '{"source": "deploys", "metrics": {"count": 3}}'
```

The `Origin` header is required because this route has the same checks as every other route here.

## Connecting another project

To put another project on a board and keep its history, have the project publish its numbers at
`/metrics`, let Prometheus scrape and store them, and declare Prometheus as a source. History then
survives restarts of all three programs, and collecting doesn't need this server or an open page.

### Choosing how to expose the numbers

| Way | Where history lives | Survives a restart | Adding past data | Use it for |
|---|---|---|---|---|
| `/metrics`, scraped by Prometheus | Prometheus's data folder, 15 days unless you change it | Yes | With `promtool` | The default |
| Your own store answering Prometheus's query routes | A SQLite file you own | Yes | Insert rows | One process with no Prometheus, or data with its own timestamps |
| A JSON URL | This server's memory, 3,600 samples per number | No | No | A temporary board. Polling stops 2 minutes after the page stops asking |
| Pushing to this server | This server's memory, 3,600 samples per number | No | No | Numbers from a script while you debug |

### 1. Write the collector

If the project is already a long-running process, add `/metrics` to it and skip this file.
Otherwise run this beside it and change `collect()`:

```js
// collector.mjs: publishes this project's numbers for Prometheus to scrape.
import http from 'node:http';
import { readFile } from 'node:fs/promises';

// Replace this with whatever reads your project: a file, a database, an API.
async function collect() {
  const state = JSON.parse(await readFile(new URL('./state.json', import.meta.url)));
  return {
    jobs_waiting: { type: 'gauge', help: 'Jobs in the queue', value: state.waiting },
    jobs_done_total: { type: 'counter', help: 'Jobs finished since the project began', value: state.done },
  };
}

http.createServer(async (req, res) => {
  if (req.url !== '/metrics') return res.writeHead(404).end();
  try {
    const lines = [];
    for (const [name, m] of Object.entries(await collect())) {
      if (!Number.isFinite(m.value)) continue;
      lines.push(`# HELP ${name} ${m.help}`, `# TYPE ${name} ${m.type}`, `${name} ${m.value}`);
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' }).end(lines.join('\n') + '\n');
  } catch (err) {
    res.writeHead(500).end(String(err.message));
  }
}).listen(9200, '127.0.0.1');
```

- A gauge can go up and down. A counter only goes up, ends in `_total`, and is read with `rate()`.
- Publish base units, such as seconds and bytes. `in ms`, `in s`, `in bytes` and `in bytes/s` change scale by themselves.
- Leave out a number you can't read. A 0 looks like a real value, and a missing number shows `NO DATA`.
- Keep label values to a small set, so no user IDs. Each value is a new series, and a chart colors only its 8 largest.

### 2. Run Prometheus

Get it from [prometheus.io/download](https://prometheus.io/download/), and write `prometheus.yml`:

```yaml
global:
  scrape_interval: 15s
storage:
  tsdb:
    retention:
      time: 1y
scrape_configs:
  - job_name: myproject
    static_configs:
      - targets: ['127.0.0.1:9200']
```

```sh
promtool check config prometheus.yml
prometheus --config.file=prometheus.yml --storage.tsdb.path=data --web.listen-address=127.0.0.1:9090
```

Keep the listen address, because the default is every interface with no login. Prometheus's
[storage docs](https://prometheus.io/docs/prometheus/latest/storage/) put disk use at 1 to 2 bytes
per sample, so 10 numbers every 15 seconds for a year is at most about 40 MB. Keep `data` out of git.

Run the collector and Prometheus under launchd, systemd or whatever the project already uses. Time
either one is down shows as a gap.

### 3. Declare the source

Write `sources.json` in the project, with `every` equal to `scrape_interval`, because a number goes
stale after three times `every`:

```json
{ "sources": { "myproject": { "type": "prometheus", "url": "http://127.0.0.1:9090", "every": "15s" } } }
```

Then stop any server already on port 4173 and start this one from the handwave folder:

```sh
DASHBOARD_SOURCES=/path/to/project/sources.json npm start
```

### 4. Draw the board

Open `http://localhost:4173/experiments/dashboard/#blank`, drag on a **box** or **chart**, double-click
it and type its label. Shift+Enter starts a new line and Enter finishes. Prometheus's metrics aren't
listed in the palette, so type their names.

    queue
    myproject: jobs_waiting in jobs
    warn above 10 for 30s

    jobs per minute
    chart
    myproject: rate(jobs_done_total[2m]) * 60 in jobs/min

**save** writes an `.excalidraw` file to commit in the project. A board outside `scenes/` has no URL,
so bring it back with **open** or by dropping it on the page.

### 5. Check it

```sh
curl -s http://127.0.0.1:9200/metrics
curl -s 'http://127.0.0.1:9090/api/v1/query?query=up'
```

`up` should read `"1"`, and the box should show its number and `OK`. After a few minutes, drag along
the bottom to an earlier moment and the box should show the number from then. If you stop the
collector, the box should show `NO DATA` in about 45 seconds.

### Using the history

- **Alerts while nobody watched.** Rules are replayed from stored data, so a rule that fired with no
  page open appears when you open one. Nothing notifies you when it happens.
- **How far back.** The presets reach 30 days. To go further, drag to the oldest moment and press
  **30d** again, which centers the range there. On a 30 day range the samples are 15 minutes apart, so a
  `for 30s` rule is judged on those.
- **Adding past data.** Write an OpenMetrics file, with times in seconds, then restart Prometheus.
  Its docs warn against backfilling the last 3 hours, and retention still removes anything too old.

```text
# TYPE jobs_waiting gauge
jobs_waiting 40 1793462480
jobs_waiting 41 1793462780
# EOF
```

```sh
promtool tsdb create-blocks-from openmetrics history.om data
```

### Without Prometheus

One process can both collect and store. Declare it with `"type": "prometheus"` and its own address,
because this page only ever calls `POST /api/v1/query` and `POST /api/v1/query_range` on that source:

```json
{ "sources": { "myproject": { "type": "prometheus", "url": "http://127.0.0.1:9200", "every": "15s" } } }
```

```js
// store.mjs: reads the project every 15 seconds, keeps the numbers in SQLite, and
// answers the two routes that this page's prometheus source uses.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(new URL('./history.db', import.meta.url).pathname);
db.exec('CREATE TABLE IF NOT EXISTS samples (name TEXT, t REAL, v REAL, PRIMARY KEY (name, t)) WITHOUT ROWID');
const save = db.prepare('INSERT OR REPLACE INTO samples VALUES (?, ?, ?)');
const near = db.prepare('SELECT t, v FROM samples WHERE name = ? AND t BETWEEN ? AND ? ORDER BY t DESC LIMIT 1');
const range = db.prepare('SELECT MAX(t) AS t, v FROM samples WHERE name = ? AND t BETWEEN ? AND ? GROUP BY CAST(t / ? AS INTEGER) ORDER BY t');

// Replace this with whatever reads your project.
async function collect() {
  const state = JSON.parse(await readFile(new URL('./state.json', import.meta.url)));
  return { jobs_waiting: state.waiting, jobs_per_min: state.perMin };
}

async function sample() {
  try {
    const t = Date.now() / 1000;
    for (const [name, v] of Object.entries(await collect())) if (Number.isFinite(v)) save.run(name, t, v);
  } catch (err) {
    console.error('collect failed:', err.message);
  }
}
setInterval(sample, 15000);
sample();

function answer(path, form) {
  const name = form.get('query');
  const metric = { __name__: name };
  if (path === '/api/v1/query') {
    const time = Number(form.get('time') ?? Date.now() / 1000);
    const row = near.get(name, time - 60, time);
    return { resultType: 'vector', result: row ? [{ metric, value: [row.t, String(row.v)] }] : [] };
  }
  const rows = range.all(name, Number(form.get('start')), Number(form.get('end')), Number(form.get('step')));
  return { resultType: 'matrix', result: rows.length ? [{ metric, values: rows.map((r) => [r.t, String(r.v)]) }] : [] };
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const path = req.url.split('?')[0];
    if (path !== '/api/v1/query' && path !== '/api/v1/query_range') return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', data: answer(path, new URLSearchParams(body)) }));
  });
}).listen(9200, '127.0.0.1');
```

A label here names one stored number, such as `myproject: jobs_per_min in jobs/min`. There is no
PromQL and there are no labels, so work out rates in `collect()`. To add past data, insert rows with
`save.run(name, t, v)`, with `t` in seconds. The file grows until you delete old rows. A store that
stops shows `FAILED` and the source's reason, because it is also what the page asks. These two routes
are what `askPrometheus` in `sources.mjs` calls today, not a published interface. It needs a Node
with `node:sqlite`.

### What has been checked

Both versions were run by hand on 2026-11-03 on macOS, with Prometheus 3.15.1, Node 26.8.1 and a
made-up project that was a JSON file. Labels like those above were typed on the page and the board was
saved and reopened. A rise with no page open showed up afterwards, and history survived a restart of
every program. A number left out, an unreadable project and a stopped collector each gave `NO DATA`.
Past data added 3 days back could be looked back at. None of this is in `tests/dashboard.mjs`. A real
project, a run lasting days, launchd or systemd, and a collector on another machine have not been tried.

## What a shape says

A shape's state is its worst number. It has a word and an icon, and the frame changes too, so
state never rests on color. `OK`, `PENDING`, `WARN` with a thicker frame, `CRITICAL` with a thicker
one still, and `NO DATA` and `FAILED` dashed.

- **Stale.** A number older than three times its source's interval, and at least 5 seconds, or
  `stale after 30s`, is not shown as current. The panel says `no data for 2m`.
- **Failed.** The panel names the source and the reason: `prod failed: connection refused`.
- **A gap** is drawn as a gap, and shaded once it is wide. Points further apart than three
  times the interval never join, a `NaN` breaks the line, and a lone point is a dot.
- **Dense data.** When several points land in one pixel column, that column draws from its
  lowest value to its highest, so a one-sample spike survives. Nothing is averaged or smoothed.
- **Axes** have a unit and ticks on round numbers. Different units get separate strips,
  never a second axis. An axis starts at zero unless the data is far from zero or `axis 0 to 100`
  says otherwise. A number with no unit gets a note in the inspector.
- **More than 8 series.** The 8 largest in the range get colors and legend places, and the rest are one
  gray. A series that is zero for the whole range does not get a color, and the legend says how many it
  left out. A series keeps its color while it holds a place, and a place changes hands only when a
  newcomer is 1.25 times bigger. A query returning more than 200 series keeps the largest 200 of each
  answer, and the inspector says so.
- **Order.** The legend lists series biggest first by the number at this moment, and the tooltip by the
  number under the pointer. Different units keep their own groups, because they can't be compared.

## Alerts

A rule is one line, under the number it watches: `warn above 80 for 2m`, `critical below 5`,
`warn errors above 1 for 30s`. A rule is `ok`, `pending`, `firing` or `no data`, and no data is
never reported as ok. A gap resets `for`. How long a rule has been firing is counted from what is
loaded, so a rule firing since before the range on screen shows at least that long, not all of it.

The states come from replaying the data through `alerts.js`, which is a pure function with no
DOM. That is why looking back shows what a rule said then, and why a reload shows the same
history. The strip along a chart and the marks on it show every change.

**A rule covers the series that exist.** When a query has several series and one stops while others
keep reporting, as a room's does after a world reset, that series drops out. It doesn't count as no
data, and it doesn't mark the time strip. One that stops while firing gets one line in what changed.
The rule only says no data when none is left, and then it counts once, however many series it had.

So a rule can't tell a series that ended from one that died. If that matters, put a rule on the count,
such as `prod: count(up == 1) in targets` with `critical below 3`.

**Adding notifications.** Nothing is sent today. `m.onFiring` in `data.js` fires for each rule that
starts firing, which is the place for a page-side notifier. For one that works with no page open,
run `replay` from `alerts.js` on the server, over the same rings `sources.mjs` keeps, and send
its transitions. Alerts only evaluate while a page is open until someone does that.

## Time

Live moves once a second. `pause` stops the range. Presets are 5m, 15m, 1h, 6h, 24h, 3d, 7d and 30d, and
a drag across a chart zooms. Hovering a chart puts a line at that time on every chart, with the values.
On a long range a chart's points are far apart, but numbers and states still come from the source's own
pace, so data that stops is noticed as quickly as on a short one.

Click a chart, or drag along the bottom, and **every shape, arrow and list shows that moment**,
including dots on arrows, states and what was firing. A line at the top says which moment it is,
and what is firing now, so looking at last night can't hide today. Esc goes back to live. `This
machine` can only look back as far as its 2 hours, and says `no data before` that.

`An incident 18 minutes ago` in the gallery has one ready to find.

## Security

The root server can listen on every interface for the live deck, and it serves the repository as
static files. So:

- Every route here is a POST with the same checks as the tutor's `refusal()`: from this machine,
  from this server's own page, with a Host that names this machine.
- A drawing can't name an address. A source is a name. A label with a URL gets a message and
  binds to nothing, and the server would refuse it anyway: a source that isn't declared doesn't
  exist, and any other field in a request is ignored. A shared file can only ask your declared
  sources about what they already hold, and has nowhere to send it.
- `.sources.json` holds the addresses and credentials, and nothing else does. It is not committed,
  and its name starts with a dot because the root server refuses to serve dot-files. `/dashboard/sources`
  gives the page names and states only. Error messages have addresses and secrets removed.
- A redirect from a source is an error rather than being followed, so credentials can't travel.
- The page's CSP allows connections only to this server. An image in a drawing is kept only if it is
  embedded in the file. A label is text, never HTML.

`node tests/dashboard.mjs` checks each of these, with a fake internal service that nothing may reach.

## Motion

The only motion is data. Charts step once a second rather than crawl. Dots appear only on
arrows that say `flow`, are evenly spaced, and stand for the same amount on every arrow with
that unit, as a line on the board says, so twice the rate moves twice as fast. A dot only ever
changes what it stands for by growing, so its speed stays comparable. No number stops them, and
`prefers-reduced-motion` keeps them still.

Hand-drawn lines are the frames, titles and arrows. Numbers, axes and lines through data are exact.

## Colors

Series colors are the data-viz reference palette, not `lib/draw.js`: its four hues fail the colorblind
check as series (rose and green are 3.2 apart, and 8 is the target). They are kept for frames and
for state, which always has a word and an icon. The series palette passes on `#ffffff` and on `#1a1a19`.
Three light-mode series are under 3:1, which the legend and the table view make up for.

A name has one color on every chart of a drawing and on the other tabs of its group, so `hauler` looks the
same side by side. The first chart to show a name picks its color, and a new name takes a color no other
has while any are left. Past 8 names a color can repeat between charts, but never within one, because telling
lines apart comes first. A chart with one line stays the first color unless its name already has one. Colors
are chosen as you browse, so reloading on a different tab can hand them out differently.

## Measured

On an M3 Pro in headless Chrome, with 30 charts of 3,609 points each (108,270 in all), each
updating every second, while other work was running on the machine:

| | |
|---|---|
| Frame interval, every frame redrawn | 16.7 ms at the 95th percentile, and 16.8 at worst |
| Drawing a frame, not counting raster | 1 ms at the 95th percentile, and about 6 at worst |
| A whole frame, forced through raster by reading a pixel | 12 ms |
| With a crosshair moving across all 30 | 6 ms at the 95th percentile, not counting raster |
| Elements on the stage | 60, because data is in a layer and never one element per point |

## What Grafana still does better

Use Grafana if you need most of this. These are real gaps, not a to-do list.

- **Data sources.** Dozens of them, including logs and traces. Here it is Prometheus, JSON and push.
- **Queries.** A query builder, autocomplete against your metrics, variables and templating, and
  transformations. Here you type PromQL into a label.
- **Alerting.** Alerts that run with nobody watching, on-call routing, silences and grouping. Here
  rules evaluate only while a page is open, with no notifications and no hysteresis.
- **Long ranges.** Downsampling and caching built for months of data. Past about 4,000 points per
  chart this asks Prometheus for a coarser step, so a `for 20s` rule on a 24h view is judged on 30s samples.
- **People.** Logins, permissions, folders, sharing a link, annotations from your deploys, and a
  community of dashboards. This answers one machine only.
- **Panel types.** Heatmaps, histograms, logs, traces, maps. Here there are six.

What this does that a grid of panels does not: the layout is the architecture, so the arrow into the
red box says what is probably upstream, and going back shows the whole system at one moment.

## What does not work yet

- No file drawn by hand on excalidraw.com has been run here, only one from Excalidraw's converter and
  files shaped like its output, including its wrapped labels.
- A real Prometheus has been queried only by hand: 3.15.1 on macOS, not in the test suite. The test
  uses a fake one returning the same shapes. Basic auth is untested.
- Excalidraw's own window shows the whole label, source lines and all, since it knows nothing of this.
- A selection of more than one shape, and changing a shape's type or color on the page. Do those in
  Excalidraw. Elbow arrows and frames are untested.
- Machine history is lost when the server restarts, and is drawn as a gap. `memory` on Windows and
  network on anything but macOS and Linux have not been run. Only macOS has been run at all.
- A long soak. Memory is bounded by design, but nothing has run for days.
- Phones fit with no sideways scroll, but this is for screens. Small panels drop to a number and an icon.

## Files

| Path | What |
|---|---|
| `vocab.js` | Every word and panel in one table, and the label parser. No DOM |
| `read.js` | Drawing to dashboard: what each shape and arrow is bound to. No DOM |
| `series.js` | A line of data, how it is thinned without losing extremes, and where its gaps are. No DOM |
| `alerts.js` | Replays a rule over data. No DOM |
| `format.js` | How numbers and times are written, axes and ticks. No DOM |
| `sim.js` | The simulated service, as a pure function. No DOM |
| `server.mjs` | The routes and their checks |
| `sources.mjs` | Every source, the config file and what the page may know. The only code that opens a connection |
| `data.js` | The page's side: what to ask for, what came back, what a shape says at a moment |
| `panels.js` | Draws data in a stage layer: box, chart, stat, meter, table, alerts, arrows |
| `main.js` | State and input |
| `ui.js` | The palette, bar, inspector, reference, gallery, hints and table view |
| `scenes/make.mjs` | Writes the example dashboards and `scenes/scenes.json` |

Editing and reading a drawing use `edit.js` and `graph.js` from the runnable diagrams.

`node tests/dashboard.mjs` drives all of this in a real browser with real mouse and keyboard input,
against a fake Prometheus and a fake internal service inside the test, in about 4 minutes.
