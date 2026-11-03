# Dashboards you draw

Draw your system, and the shapes show live numbers. A dashboard is a plain `.excalidraw`
file. Everything that binds it to data is label text you can type in Excalidraw, so it can
be edited there and diffed in git. Open it at `/experiments/dashboard/`.

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
- **More than 8 series.** The 8 largest in the range get colors and legend places, largest first,
  and the rest are one gray. A series that is zero for the whole range does not get a color, and the
  legend says how many it left out. A series keeps its color while it holds a place, and a place
  changes hands only when a newcomer is 1.25 times bigger. A query returning more than 200 series keeps
  the largest 200 of each answer, and the inspector says so.

## Alerts

A rule is one line, under the number it watches: `warn above 80 for 2m`, `critical below 5`,
`warn errors above 1 for 30s`. A rule is `ok`, `pending`, `firing` or `no data`, and no data is
never reported as ok. A gap resets `for`. How long a rule has been firing is counted from what is
loaded, so a rule firing since before the range on screen shows at least that long, not all of it.

The states come from replaying the data through `alerts.js`, which is a pure function with no
DOM. That is why looking back shows what a rule said then, and why a reload shows the same
history. The strip along a chart and the marks on it show every change.

**Adding notifications.** Nothing is sent today. `m.onFiring` in `data.js` fires for each rule that
starts firing, which is the place for a page-side notifier. For one that works with no page open,
run `replay` from `alerts.js` on the server, over the same rings `sources.mjs` keeps, and send
its transitions. Alerts only evaluate while a page is open until someone does that.

## Time

Live moves once a second. `pause` stops the range. Presets are 5m, 15m, 1h, 6h and 24h, and a drag
across a chart zooms. Hovering a chart puts a line at that time on every chart, with the values.

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
- A real Prometheus has been queried only by hand, in one session: 3.15.1 on macOS, not in the test
  suite. The test uses a fake one returning the same shapes. Basic auth is untested.
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
