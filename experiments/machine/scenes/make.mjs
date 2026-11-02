#!/usr/bin/env node
// Writes the two demo drawings as plain Excalidraw documents. Open either one in
// excalidraw.com and edit it there. `node scenes/make.mjs` regenerates them.
// Labels get their final position from the real font when the page loads them.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

const tone = {
  ink: '#1B2547',
  blue: ['#1864ab', '#d0ebff'], amber: ['#a35200', '#fff3bf'], green: ['#2b8a3e', '#d3f9d8'], rose: ['#c92a2a', '#ffe3e3'], gray: ['#343a40', '#f1f3f5'],
};

const seedOf = (id) => { let h = 2166136261; for (const c of id) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) % 2000000000 + 1; };

const base = (o) => ({
  angle: 0, strokeColor: tone.ink, backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100,
  groupIds: [], frameId: null, roundness: null, seed: seedOf(o.id), version: 1, versionNonce: seedOf(o.id) + 1, isDeleted: false, boundElements: [], updated: 1, link: null, locked: false, ...o,
});

const textEl = (id, words, o) => base({
  id, type: 'text', x: o.x ?? 0, y: o.y ?? 0, width: words.length * (o.fontSize ?? 28) * 0.5, height: words.split('\n').length * (o.fontSize ?? 28) * 1.25, boundElements: null,
  text: words, originalText: words, fontSize: o.fontSize ?? 28, fontFamily: o.fontFamily ?? 5, textAlign: o.textAlign ?? 'center', verticalAlign: o.verticalAlign ?? 'middle', containerId: o.containerId ?? null, autoResize: true, lineHeight: 1.25, strokeColor: o.color ?? tone.ink,
});

function build(fn) {
  const out = [];
  const shapes = new Map();
  const api = {
    title: (words) => out.push(textEl('title', words, { x: 40, y: 16, fontSize: 36, fontFamily: 6, textAlign: 'left', verticalAlign: 'top' })),
    shape(id, type, x, y, width, height, words, { color = tone.gray, valign = 'middle', fontSize = 28 } = {}) {
      const el = base({ id, type, x, y, width, height, strokeColor: color[0], backgroundColor: color[1], roundness: type === 'rectangle' ? { type: 3 } : { type: 2 } });
      const label = textEl(`${id}-t`, words, { containerId: id, verticalAlign: valign, fontSize, color: color[0] });
      el.boundElements.push({ type: 'text', id: label.id });
      shapes.set(id, el);
      out.push(el, label);
    },
    arrow(id, from, to, points, words) {
      const [ox, oy] = points[0];
      const local = points.map(([x, y]) => [x - ox, y - oy]);
      const xs = local.map((p) => p[0]), ys = local.map((p) => p[1]);
      const el = base({
        id, type: 'arrow', x: ox, y: oy, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), points: local,
        startBinding: from ? { elementId: from, focus: 0, gap: 8 } : null, endBinding: to ? { elementId: to, focus: 0, gap: 8 } : null, startArrowhead: null, endArrowhead: 'arrow', lastCommittedPoint: null, elbowed: false,
        roundness: points.length > 2 ? { type: 2 } : null,
      });
      if (from) shapes.get(from).boundElements.push({ id, type: 'arrow' });
      if (to) shapes.get(to).boundElements.push({ id, type: 'arrow' });
      out.push(el);
      if (words) {
        const label = textEl(`${id}-t`, words, { containerId: id, fontSize: 26 });
        el.boundElements.push({ type: 'text', id: label.id });
        out.push(label);
      }
    },
  };
  fn(api);
  return out;
}

const write = (name, elements) => {
  const doc = { type: 'excalidraw', version: 2, source: 'https://excalidraw.com', elements, appState: { viewBackgroundColor: '#ffffff', gridSize: null }, files: {} };
  fs.writeFileSync(path.join(here, `${name}.excalidraw`), JSON.stringify(doc, null, 2) + '\n');
};

write('queue', build(({ title, shape, arrow }) => {
  title('Work piles up when it arrives faster than the workers finish');
  shape('requests', 'ellipse', 40, 250, 190, 120, 'requests\nrate 3/s', { color: tone.blue });
  shape('queue', 'rectangle', 340, 215, 270, 190, 'queue', { color: tone.amber, valign: 'top' });
  shape('workers', 'rectangle', 720, 200, 300, 220, 'workers 3\ntakes 0.75s', { valign: 'top' });
  shape('check', 'diamond', 1110, 250, 160, 120, 'ok?', { fontSize: 26 });
  shape('done', 'ellipse', 1370, 130, 180, 100, 'done', { color: tone.green });
  shape('failed', 'ellipse', 1370, 480, 180, 100, 'failed', { color: tone.rose });
  arrow('in', 'requests', 'queue', [[238, 310], [331, 310]]);
  arrow('take', 'queue', 'workers', [[619, 310], [711, 310]]);
  arrow('out', 'workers', 'check', [[1029, 310], [1101, 310]]);
  arrow('pass', 'check', 'done', [[1244, 272], [1384, 205]], '90%');
  arrow('retry', 'check', 'queue', [[1190, 378], [800, 575], [475, 414]], '10%');
}));

write('breaker', build(({ title, shape, arrow }) => {
  title('A circuit breaker stops calling a service that keeps failing');
  shape('closed', 'rectangle', 170, 210, 300, 140, 'closed\ncalls go through');
  shape('open', 'rectangle', 1130, 210, 300, 140, 'open\ncalls fail at once');
  shape('half-open', 'rectangle', 640, 450, 320, 140, 'half-open\none trial call');
  arrow('begin', null, 'closed', [[50, 280], [161, 280]]);
  arrow('trip', 'closed', 'open', [[479, 280], [1121, 280]], 'fail x3');
  arrow('cool', 'open', 'half-open', [[1150, 359], [969, 480]], 'after 5s');
  arrow('reopen', 'half-open', 'open', [[969, 560], [1330, 359]], 'fail');
  arrow('reset', 'half-open', 'closed', [[631, 520], [320, 359]], 'ok');
}));
