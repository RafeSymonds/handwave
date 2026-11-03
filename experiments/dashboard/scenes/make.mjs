#!/usr/bin/env node
// Writes the example dashboards as plain Excalidraw documents, and `scenes.json`, which is
// what the gallery reads. Everything that binds a shape to data is its label. Open any of
// these in excalidraw.com and edit it there. `node scenes/make.mjs` regenerates them.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

const tone = {
  ink: '#1B2547', muted: '#7A776E',
  blue: ['#1864ab', '#d0ebff'], amber: ['#a35200', '#fff3bf'], green: ['#2b8a3e', '#d3f9d8'], rose: ['#c92a2a', '#ffe3e3'], gray: ['#343a40', '#f1f3f5'], none: ['#1B2547', 'transparent'],
};

const seedOf = (id) => { let h = 2166136261; for (const c of id) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) % 2000000000 + 1; };

const base = (o) => ({
  angle: 0, strokeColor: tone.ink, backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100,
  groupIds: [], frameId: null, roundness: null, seed: seedOf(o.id), version: 1, versionNonce: seedOf(o.id) + 1, isDeleted: false, boundElements: [], updated: 1, link: null, locked: false, ...o,
});

const textEl = (id, words, o) => base({
  id, type: 'text', x: o.x ?? 0, y: o.y ?? 0,
  width: words.split('\n').reduce((m, l) => Math.max(m, l.length), 0) * (o.fontSize ?? 20) * 0.5, height: words.split('\n').length * (o.fontSize ?? 20) * 1.25,
  boundElements: null, text: words, originalText: words, fontSize: o.fontSize ?? 20, fontFamily: o.fontFamily ?? 5, textAlign: o.textAlign ?? 'center', verticalAlign: o.verticalAlign ?? 'middle',
  containerId: o.containerId ?? null, autoResize: true, lineHeight: 1.25, strokeColor: o.color ?? tone.ink, ...(o.customData ? { customData: o.customData } : {}),
});

function build(fn) {
  const out = [];
  const shapes = new Map();
  const api = {
    note(id, x, y, words, { size = 20, color = tone.muted, font = 5 } = {}) {
      out.push(textEl(id, words, { x, y, fontSize: size, fontFamily: font, textAlign: 'left', verticalAlign: 'top', color, customData: { machine: { note: true } } }));
    },
    shape(id, type, x, y, width, height, words, { color = tone.none } = {}) {
      const el = base({ id, type, x, y, width, height, strokeColor: color[0], backgroundColor: color[1], roundness: type === 'rectangle' ? { type: 3 } : { type: 2 } });
      const label = textEl(`${id}-t`, words, { containerId: id, fontSize: 16, color: color[0] });
      el.boundElements.push({ type: 'text', id: label.id });
      shapes.set(id, el);
      out.push(el, label);
    },
    panel(id, x, y, width, height, words, options) { api.shape(id, 'rectangle', x, y, width, height, words, options); },
    arrow(id, from, to, words = '', { bend = 0 } = {}) {
      const a = shapes.get(from), b = shapes.get(to);
      const ac = [a.x + a.width / 2, a.y + a.height / 2], bc = [b.x + b.width / 2, b.y + b.height / 2];
      const points = bend ? [ac, [(ac[0] + bc[0]) / 2, (ac[1] + bc[1]) / 2 + bend], bc] : [ac, bc];
      const [ox, oy] = points[0];
      const local = points.map(([x, y]) => [x - ox, y - oy]);
      const xs = local.map((p) => p[0]), ys = local.map((p) => p[1]);
      const el = base({
        id, type: 'arrow', x: ox, y: oy, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), points: local,
        startBinding: { elementId: from, focus: 0, gap: 8 }, endBinding: { elementId: to, focus: 0, gap: 8 }, startArrowhead: null, endArrowhead: 'arrow', lastCommittedPoint: null, elbowed: false,
        roundness: points.length > 2 ? { type: 2 } : null,
      });
      a.boundElements.push({ id, type: 'arrow' });
      b.boundElements.push({ id, type: 'arrow' });
      out.push(el);
      if (words) {
        const label = textEl(`${id}-t`, words, { containerId: id, fontSize: 14 });
        el.boundElements.push({ type: 'text', id: label.id });
        out.push(label);
      }
    },
  };
  fn(api);
  return { type: 'excalidraw', version: 2, source: 'handwave', elements: out, appState: { viewBackgroundColor: '#ffffff', gridSize: null }, files: {} };
}

const scenes = [];
const scene = (id, group, title, summary, fn, extra = {}) => {
  fs.writeFileSync(path.join(here, `${id}.excalidraw`), `${JSON.stringify(build(fn), null, 1)}\n`);
  scenes.push({ id, group, title, summary, ...extra });
};

// ---------------------------------------------------------------------- this computer

scene('this-machine', 'real data, no setup', 'This machine', 'Your CPU, memory, load, disk and network, read from the operating system since the server started.', (d) => {
  d.note('title', 40, 16, 'This machine', { size: 32, color: tone.ink });
  d.panel('computer', 40, 80, 370, 290, 'this computer\nmachine: cpu\nwarn above 85 for 2m\ncritical above 97 for 2m\nmachine: memory\nwarn above 92 for 2m\nmachine: load\nmachine: disk\nwarn above 92', { color: tone.gray });
  d.panel('alerts', 40, 400, 370, 450, 'alerts');
  d.panel('cpu', 470, 80, 500, 370, 'chart CPU');
  d.panel('memory', 1000, 80, 500, 370, 'memory\nchart\nmachine: memory\nwarn above 92 for 2m');
  d.panel('load', 470, 480, 500, 370, 'load\nchart\nmachine: load');
  d.panel('network', 1000, 480, 500, 370, 'network\nchart\nmachine: net.in\nmachine: net.out');
  d.arrow('to-cpu', 'computer', 'cpu');
}, { span: 300 });

// ---------------------------------------------------------------------- a system

const checkout = (d, { wall = false } = {}) => {
  d.note('title', 40, 16, 'Checkout', { size: 32, color: tone.ink });
  d.note('hint', 210, 28, 'A made-up service. Its numbers are not real.', { size: 18 });
  d.shape('web', 'rectangle', 40, 110, 310, 210, 'web\ndemo: web.rate\ndemo: web.errors\nwarn above 2 for 20s\ncritical above 5 for 20s\ndemo: web.latency', { color: tone.gray });
  d.shape('api', 'rectangle', 450, 110, 320, 210, 'api\ndemo: api.rate\ndemo: api.errors\nwarn above 1 for 20s\ncritical above 3 for 20s\ndemo: api.latency\nwarn above 150 for 20s', { color: tone.gray });
  d.shape('cache', 'rectangle', 950, 70, 300, 130, 'cache\ndemo: cache.hitrate\nwarn below 80 for 30s', { color: tone.blue });
  d.shape('db', 'rectangle', 950, 230, 300, 220, 'database\ndemo: db.latency\nwarn above 40 for 20s\ncritical above 100 for 20s\ndemo: db.connections\nwarn above 70 for 20s\ncritical above 90 for 20s\ndemo: db.rate', { color: tone.gray });
  d.shape('queue', 'rectangle', 450, 440, 320, 150, 'queue\ndemo: queue.depth\nwarn above 300 for 20s\ncritical above 1000 for 20s', { color: tone.gray });
  d.shape('worker', 'rectangle', 950, 480, 300, 170, 'worker\ndemo: worker.rate\ndemo: worker.busy', { color: tone.gray });
  d.arrow('web-api', 'web', 'api', 'demo: edge.web-api\nflow');
  d.arrow('api-cache', 'api', 'cache', 'demo: edge.api-cache\nflow');
  d.arrow('api-db', 'api', 'db', 'demo: edge.api-db\nflow');
  d.arrow('api-queue', 'api', 'queue', 'demo: edge.api-queue\nflow');
  d.arrow('queue-worker', 'queue', 'worker', 'demo: edge.queue-worker\nflow');
  d.panel('connections', 1280, 70, 270, 170, 'db connections\nmeter 0 to 100\ndemo: db.connections\nwarn above 70 for 20s\ncritical above 90 for 20s');
  d.panel('backlog', 1280, 270, 270, 170, 'jobs waiting\nstat\ndemo: queue.depth\nwarn above 300 for 20s');
  d.panel('errors', 40, 680, 490, 310, 'api errors\nchart\ndemo: api.errors\nwarn above 1 for 20s\ncritical above 3 for 20s');
  d.panel('latency', 550, 680, 490, 310, 'latency\nchart\napi = demo: api.latency\ndatabase = demo: db.latency');
  d.panel('alerts', 1060, 680, 480, 310, 'alerts');
};

scene('checkout', 'a system', 'Checkout', 'The drawing is the dashboard: six parts of a made-up service and the traffic between them. Press "start an incident", then go back and look at it.', checkout);

scene('look-back', 'a system', 'An incident 18 minutes ago', 'The same drawing over the last hour. The database slowed down 18 minutes before the server started. Drag along the bottom to watch it happen on the whole system.', checkout, { span: 3600 });

// ---------------------------------------------------------------------- a grid

scene('grid', 'a grid, if you want one', 'A grid of charts', 'Nine charts in a plain grid. Shapes snap to a grid as you drag, so this is quick to draw.', (d) => {
  d.note('title', 20, 4, 'A grid of charts', { size: 28, color: tone.ink });
  const cells = [
    'CPU\nchart\nmachine: cpu\nwarn above 85 for 2m', 'memory\nchart\nmachine: memory', 'load\nchart\nmachine: load',
    'network\nchart\nmachine: net.in\nmachine: net.out', 'disk\nchart\nmachine: disk', 'requests\nchart\ndemo: web.rate',
    'errors\nchart\ndemo: api.errors\nwarn above 1 for 20s', 'latency\nchart\ndemo: api.latency', 'queue\nchart\ndemo: queue.depth',
  ];
  cells.forEach((words, i) => d.panel(`cell-${i}`, 20 + (i % 3) * 520, 50 + Math.floor(i / 3) * 280, 500, 260, words));
});

// ---------------------------------------------------------------------- a wall of boxes

scene('wall', 'for a wall', 'Everything at a glance', 'Boxes and one list. Press wall for full screen. Dark mode is one key: d.', (d) => {
  d.note('title', 20, 4, 'Everything at a glance', { size: 28, color: tone.ink });
  const boxes = [
    ['web', 'web\ndemo: web.rate\ndemo: web.errors\ncritical above 3 for 20s'],
    ['api', 'api\ndemo: api.rate\ndemo: api.errors\ncritical above 3 for 20s'],
    ['database', 'database\ndemo: db.latency\ncritical above 100 for 20s\ndemo: db.connections\nwarn above 70 for 20s'],
    ['cache', 'cache\ndemo: cache.hitrate\nwarn below 80 for 30s'],
    ['queue', 'queue\ndemo: queue.depth\ncritical above 1000 for 20s'],
    ['worker', 'worker\ndemo: worker.rate\nwarn below 5 for 30s'],
    ['this computer', 'this computer\nmachine: cpu\nwarn above 85 for 2m\nmachine: memory\nwarn above 92 for 2m'],
    ['disk', 'disk\nmachine: disk\nwarn above 92\nmachine: disk.free'],
  ];
  boxes.forEach(([name, words], i) => d.panel(`box-${i}`, 20 + (i % 4) * 380, 60 + Math.floor(i / 4) * 210, 360, 190, words, { color: tone.gray }));
  d.panel('alerts', 20, 480, 750, 330, 'alerts');
  d.panel('errors', 790, 480, 730, 330, 'api errors\nchart\ndemo: api.errors\ncritical above 3 for 20s');
});

// ---------------------------------------------------------------------- your own

scene('prometheus', 'needs a source', 'Your Prometheus', 'This drawing names a source called prom, so it fails until you declare one in .sources.json. It shows what a missing source looks like, and every word it needs.', (d) => {
  d.note('title', 20, 4, 'Your Prometheus', { size: 28, color: tone.ink });
  d.note('how', 20, 44, 'Declare a source called prom in experiments/dashboard/.sources.json. sources.example.json shows how.', { size: 18 });
  d.panel('up', 20, 90, 320, 150, 'targets up\nstat\nprom: count(up == 1) in targets');
  d.panel('rate', 360, 90, 620, 300, 'requests\nchart\nprom: sum(rate(http_requests_total[1m])) in req/s\nwarn above 1000 for 2m');
  d.panel('jobs', 1000, 90, 380, 300, 'targets by job\ntable\nprom: count by (job) (up) in targets');
  d.panel('alerts', 20, 260, 320, 130, 'alerts');
});

fs.writeFileSync(path.join(here, 'scenes.json'), `${JSON.stringify(scenes, null, 1)}\n`);
console.log(`wrote ${scenes.length} dashboards`);
