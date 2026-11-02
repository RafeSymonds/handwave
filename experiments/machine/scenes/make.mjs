#!/usr/bin/env node
// Writes the demo drawings as plain Excalidraw documents. Open any of them in
// excalidraw.com and edit it there. `node scenes/make.mjs` regenerates them, and
// `scenes/demos.json`, which is what the gallery reads.
// Labels are placed from an estimate of the font's width, which is close enough for
// Excalidraw, and the page measures them with the real font when it loads them.

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
  id, type: 'text', x: o.x ?? 0, y: o.y ?? 0, width: words.split('\n').reduce((m, l) => Math.max(m, l.length), 0) * (o.fontSize ?? 28) * 0.5, height: words.split('\n').length * (o.fontSize ?? 28) * 1.25, boundElements: null,
  text: words, originalText: words, fontSize: o.fontSize ?? 28, fontFamily: o.fontFamily ?? 5, textAlign: o.textAlign ?? 'center', verticalAlign: o.verticalAlign ?? 'middle', containerId: o.containerId ?? null, autoResize: true, lineHeight: 1.25, strokeColor: o.color ?? tone.ink, ...(o.customData ? { customData: o.customData } : {}),
});

function build(fn) {
  const out = [];
  const shapes = new Map();
  const api = {
    title: (words) => out.push(textEl('title', words, { x: 40, y: 16, fontSize: 36, fontFamily: 6, textAlign: 'left', verticalAlign: 'top', customData: { machine: { note: true } } })),
    // What to do first. A note, so it never attaches to an arrow near it.
    tryThis: (words) => out.push(textEl('try', `Try: ${words}`, { x: 40, y: 66, fontSize: 26, fontFamily: 5, textAlign: 'left', verticalAlign: 'top', color: tone.muted, customData: { machine: { note: true } } })),
    shape(id, type, x, y, width, height, words, { color = tone.gray, valign = 'middle', fontSize = 28 } = {}) {
      const el = base({ id, type, x, y, width, height, strokeColor: color[0], backgroundColor: color[1], roundness: type === 'rectangle' ? { type: 3 } : { type: 2 } });
      const label = textEl(`${id}-t`, words, { containerId: id, verticalAlign: valign, fontSize, color: color[0] });
      el.boundElements.push({ type: 'text', id: label.id });
      shapes.set(id, el);
      out.push(el, label);
    },
    // Ends may be left rough: the page routes bound ends to the edges of their shapes.
    arrow(id, from, to, points, words, { fontSize = 26 } = {}) {
      const [ox, oy] = points[0];
      const local = points.map(([x, y]) => [x - ox, y - oy]);
      const xs = local.map((p) => p[0]), ys = local.map((p) => p[1]);
      const el = base({
        id, type: 'arrow', x: ox, y: oy, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), points: local,
        startBinding: from ? { elementId: from, focus: 0, gap: 8 } : null, endBinding: to ? { elementId: to, focus: 0, gap: 8 } : null, startArrowhead: null, endArrowhead: 'arrow', lastCommittedPoint: null, elbowed: false,
        roundness: points.length > 2 ? { type: 2 } : null,
      });
      if (from) shapes.get(from).boundElements.push({ id, type: 'arrow' });
      if (to && to !== from) shapes.get(to).boundElements.push({ id, type: 'arrow' });
      out.push(el);
      if (words) {
        const label = textEl(`${id}-t`, words, { containerId: id, fontSize });
        el.boundElements.push({ type: 'text', id: label.id });
        out.push(label);
      }
    },
  };
  fn(api);
  placeLabels(out);
  return out;
}

// A bound label stores its own position, and Excalidraw draws it there when it opens the file.
function placeLabels(elements) {
  const byId = new Map(elements.map((el) => [el.id, el]));
  for (const text of elements) {
    if (text.type !== 'text' || !text.containerId) continue;
    const owner = byId.get(text.containerId);
    const lines = text.text.split('\n');
    text.width = Math.max(...lines.map((l) => l.length)) * text.fontSize * 0.55;
    text.height = lines.length * text.fontSize * 1.25;
    if (owner.type === 'arrow') {
      const [mx, my] = owner.points[Math.floor((owner.points.length - 1) / 2)];
      const [nx, ny] = owner.points.length === 2 ? owner.points[1] : [mx, my];
      const px = owner.points.length === 2 ? nx / 2 : mx, py = owner.points.length === 2 ? ny / 2 : my;
      text.x = owner.x + px - text.width / 2;
      text.y = owner.y + py - text.height / 2;
    } else {
      text.x = owner.x + (owner.width - text.width) / 2;
      const top = owner.type === 'ellipse' ? owner.y + owner.height * 0.2 : owner.y + 10;
      text.y = text.verticalAlign === 'top' ? top : owner.y + (owner.height - text.height) / 2;
    }
  }
}

const demos = [];

const scene = (id, group, title, tryWords, summary, fn) => {
  const elements = build((api) => { api.title(title); api.tryThis(tryWords); fn(api); });
  const doc = { type: 'excalidraw', version: 2, source: 'https://excalidraw.com', elements, appState: { viewBackgroundColor: '#ffffff', gridSize: null }, files: {} };
  fs.writeFileSync(path.join(here, `${id}.excalidraw`), JSON.stringify(doc, null, 2) + '\n');
  demos.push({ id, group, title, try: tryWords, summary });
};

// ------------------------------------------------------------------ work

scene('queue', 'work', 'Work piles up when it arrives faster than the workers finish',
  'change "workers 3" to "workers 2", or click a worker to kill it.',
  'A queue, workers and a retry loop. One worker fewer and the line never stops growing.',
  ({ shape, arrow }) => {
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
    arrow('retry', 'check', 'queue', [[1190, 378], [850, 575], [570, 414]], '10%');
  });

scene('lines', 'work', 'One shared line beats one line per worker',
  'watch the chart. Both rows have the same work and the same four workers. Then click a worker in each row to kill it.',
  'Same load, same workers, different lines. The chart shows the wait each row gets.',
  ({ shape, arrow }) => {
    shape('a-src', 'ellipse', 30, 150, 170, 100, 'requests\nrate 3/s', { color: tone.blue });
    shape('a-queue', 'rectangle', 290, 130, 230, 140, 'line', { color: tone.amber, valign: 'top' });
    shape('a-work', 'rectangle', 620, 120, 300, 160, 'workers 4\ntakes 1s', { valign: 'top' });
    shape('a-done', 'ellipse', 1010, 150, 150, 100, 'shared line', { color: tone.green, fontSize: 24 });
    arrow('a1', 'a-src', 'a-queue', [[208, 200], [282, 200]]);
    arrow('a2', 'a-queue', 'a-work', [[528, 200], [612, 200]]);
    arrow('a3', 'a-work', 'a-done', [[928, 200], [1002, 200]]);

    shape('b-src', 'ellipse', 30, 520, 170, 100, 'requests\nrate 3/s', { color: tone.blue });
    shape('b-pick', 'diamond', 280, 505, 190, 130, 'random', { fontSize: 26 });
    shape('b-done', 'ellipse', 1010, 520, 150, 100, 'own lines', { color: tone.rose, fontSize: 24 });
    for (const [i, y] of [340, 450, 560, 670].entries()) {
      shape(`b-w${i}`, 'rectangle', 590, y, 330, 76, 'workers 1, takes 1s', { fontSize: 22, valign: 'top' });
      arrow(`b-in${i}`, 'b-pick', `b-w${i}`, [[478, 570], [582, y + 38]]);
      arrow(`b-out${i}`, `b-w${i}`, 'b-done', [[928, y + 38], [1002, 570]]);
    }
    arrow('b1', 'b-src', 'b-pick', [[208, 570], [272, 570]]);

    shape('compare', 'rectangle', 1220, 280, 350, 230, 'chart', { color: tone.none, valign: 'top', fontSize: 24 });
    arrow('w1', 'compare', 'a-done', [[1290, 272], [1130, 240]]);
    arrow('w2', 'compare', 'b-done', [[1212, 450], [1140, 530]]);
  });

scene('storm', 'work', 'Retries keep a system down after the spike has gone',
  'wait for the burst at 15 seconds. Then change "copy after 5s" to "after 5s" and press restart.',
  'Clients give up and try again, but the abandoned work still gets done. Gray tokens are work nobody wants.',
  ({ shape, arrow }) => {
    shape('clients', 'ellipse', 30, 290, 280, 150, 'clients\nrate 3/s\nburst 40 at 15s', { color: tone.blue, fontSize: 24 });
    shape('line', 'rectangle', 400, 260, 330, 210, 'line\nlimit 150', { color: tone.amber, valign: 'top', fontSize: 24 });
    shape('servers', 'rectangle', 860, 270, 300, 190, 'workers 4\ntakes 1s', { valign: 'top' });
    shape('answered', 'ellipse', 1290, 310, 210, 110, 'answered', { color: tone.green });
    shape('again', 'diamond', 480, 610, 170, 110, 'again', { fontSize: 24 });
    arrow('s1', 'clients', 'line', [[318, 365], [392, 365]]);
    arrow('s2', 'line', 'servers', [[738, 365], [852, 365]]);
    arrow('s3', 'servers', 'answered', [[1168, 365], [1282, 365]]);
    arrow('s4', 'line', 'again', [[738, 445], [800, 590], [658, 665]], 'copy after 5s', { fontSize: 24 });
    arrow('s5', 'again', 'line', [[472, 665], [320, 590], [392, 445]]);
  });

scene('cache', 'work', 'Empty the cache and the database falls behind',
  'click the cache, then press "empty the cache". The database only ever coped because the cache hid most of the work.',
  'A cache that earns its hit rate from what it remembers. Popular items come up most.',
  ({ shape, arrow }) => {
    shape('users', 'ellipse', 40, 200, 200, 120, 'users\nrate 12/s\nkeys 1000', { color: tone.blue, fontSize: 24 });
    shape('memo', 'rectangle', 350, 200, 200, 120, 'cache 200', { color: tone.blue });
    shape('db', 'rectangle', 620, 560, 300, 180, 'database\nworkers 2\ntakes 0.4s', { valign: 'top', fontSize: 26 });
    shape('served', 'ellipse', 1020, 210, 180, 100, 'served', { color: tone.green });
    shape('dbchart', 'rectangle', 1170, 500, 380, 220, 'chart', { color: tone.none, valign: 'top', fontSize: 24 });
    shape('hitchart', 'rectangle', 1270, 130, 280, 200, 'chart', { color: tone.none, valign: 'top', fontSize: 24 });
    arrow('c1', 'users', 'memo', [[248, 260], [342, 260]]);
    arrow('hit', 'memo', 'served', [[558, 260], [1012, 260]], 'hit');
    arrow('miss', 'memo', 'db', [[530, 328], [640, 552]], 'miss');
    arrow('c2', 'db', 'served', [[880, 552], [1070, 318]]);
    arrow('w3', 'dbchart', 'db', [[1162, 640], [928, 650]]);
    arrow('w4', 'hitchart', 'memo', [[1262, 180], [1100, 150], [560, 215]]);
  });

scene('fanout', 'work', 'Fan-out makes rare slowness common',
  'click split, then press compare on "split 8". One slow part in fifty is enough once a job waits for many.',
  'One job becomes many, and it finishes when the slowest part does.',
  ({ shape, arrow }) => {
    shape('asks', 'ellipse', 40, 310, 190, 120, 'requests\nrate 0.8/s', { color: tone.blue, fontSize: 26 });
    shape('fan', 'rectangle', 310, 320, 160, 100, 'split 8');
    shape('shards', 'rectangle', 560, 240, 420, 260, 'workers 16\ntakes 0.2s\nslow 2% x50', { valign: 'top', fontSize: 24 });
    shape('gather', 'rectangle', 1060, 300, 200, 140, 'merge', { valign: 'top' });
    shape('answer', 'ellipse', 1340, 320, 200, 100, 'answered', { color: tone.green, fontSize: 26 });
    arrow('f1', 'asks', 'fan', [[238, 370], [302, 370]]);
    arrow('f2', 'fan', 'shards', [[478, 370], [552, 370]]);
    arrow('f3', 'shards', 'gather', [[988, 370], [1052, 370]]);
    arrow('f4', 'gather', 'answer', [[1268, 370], [1332, 370]]);
  });

scene('balance', 'work', 'Taking turns keeps feeding a dead worker',
  'click every box in one row to kill that worker. Then change "round robin" to "least busy".',
  'A load balancer with three workers. How it chooses decides what a failure costs.',
  ({ shape, arrow }) => {
    shape('traffic', 'ellipse', 40, 310, 190, 120, 'traffic\nrate 3/s', { color: tone.blue, fontSize: 26 });
    shape('lb', 'diamond', 320, 290, 230, 160, 'round robin', { fontSize: 24 });
    shape('w-a', 'rectangle', 700, 110, 280, 130, 'workers 2\ntakes 1s', { valign: 'top', fontSize: 24 });
    shape('w-b', 'rectangle', 700, 310, 280, 130, 'workers 2\ntakes 1s', { valign: 'top', fontSize: 24 });
    shape('w-c', 'rectangle', 700, 510, 280, 130, 'workers 2\ntakes 1s', { valign: 'top', fontSize: 24 });
    shape('fin', 'ellipse', 1180, 320, 180, 100, 'done', { color: tone.green });
    arrow('l0', 'traffic', 'lb', [[238, 370], [312, 370]]);
    arrow('la', 'lb', 'w-a', [[520, 330], [692, 175]]);
    arrow('lb1', 'lb', 'w-b', [[558, 370], [692, 375]]);
    arrow('lc', 'lb', 'w-c', [[520, 410], [692, 575]]);
    arrow('oa', 'w-a', 'fin', [[988, 175], [1190, 330]]);
    arrow('ob', 'w-b', 'fin', [[988, 375], [1172, 370]]);
    arrow('oc', 'w-c', 'fin', [[988, 575], [1190, 410]]);
  });

scene('batch', 'work', 'Batches too small back up, and batches too big wait for nothing',
  'click batch, then press compare on the 4. There is a best size, and it isn\'t the biggest.',
  'A worker does a whole batch in the time of one job, so batching buys capacity and costs waiting.',
  ({ shape, arrow }) => {
    shape('items', 'ellipse', 40, 300, 190, 120, 'items\nrate 3/s', { color: tone.blue, fontSize: 26 });
    shape('group', 'rectangle', 340, 280, 280, 160, 'batch 4', { valign: 'top' });
    shape('press', 'rectangle', 760, 270, 300, 180, 'workers 1\ntakes 1s', { valign: 'top' });
    shape('ok', 'ellipse', 1200, 310, 180, 100, 'done', { color: tone.green });
    arrow('b0', 'items', 'group', [[238, 360], [332, 360]]);
    arrow('b1', 'group', 'press', [[628, 360], [752, 360]]);
    arrow('b2', 'press', 'ok', [[1068, 360], [1192, 360]]);
  });

scene('priority', 'work', 'A priority lane lets other work wait forever',
  'watch the two chart lines split apart. Then delete "priority gold" from the queue\'s label.',
  'Named work takes the front of the line. The chart shows what that costs everything else.',
  ({ shape, arrow }) => {
    shape('jobs', 'ellipse', 40, 290, 220, 130, 'jobs\nrate 4.4/s\nmix gold 30%', { color: tone.blue, fontSize: 24 });
    shape('lane', 'rectangle', 350, 260, 300, 190, 'queue\npriority gold', { color: tone.amber, valign: 'top', fontSize: 26 });
    shape('crew', 'rectangle', 750, 270, 260, 170, 'workers 4\ntakes 1s', { valign: 'top', fontSize: 26 });
    shape('which', 'diamond', 1080, 290, 160, 130, 'gold?', { fontSize: 24 });
    shape('gold-done', 'ellipse', 1370, 100, 190, 100, 'gold done', { color: tone.amber, fontSize: 24 });
    shape('rest-done', 'ellipse', 1370, 520, 190, 100, 'others done', { color: tone.green, fontSize: 24 });
    shape('waits', 'rectangle', 1300, 270, 275, 185, 'chart', { color: tone.none, valign: 'top', fontSize: 22 });
    arrow('p0', 'jobs', 'lane', [[268, 355], [342, 355]]);
    arrow('p1', 'lane', 'crew', [[658, 355], [742, 355]]);
    arrow('p2', 'crew', 'which', [[1018, 355], [1072, 355]]);
    arrow('p3', 'which', 'gold-done', [[1190, 325], [1362, 165]], 'if gold', { fontSize: 22 });
    arrow('p4', 'which', 'rest-done', [[1190, 385], [1362, 555]], 'else', { fontSize: 22 });
    arrow('w5', 'waits', 'gold-done', [[1535, 262], [1532, 196]]);
    arrow('w6', 'waits', 'rest-done', [[1465, 463], [1465, 512]]);
  });

scene('limit', 'work', 'A rate limit keeps the line short by saying no',
  'click the rate limit and press compare on the 3, or delete its label to see what it was holding back.',
  'Too much work arrives. Without a limit the wait grows without end. With one, the cost moves to work turned away.',
  ({ shape, arrow }) => {
    shape('calls', 'ellipse', 40, 300, 200, 120, 'calls\nrate 6/s', { color: tone.blue, fontSize: 26 });
    shape('gate', 'rectangle', 330, 300, 230, 120, 'rate limit 3/s');
    shape('wait', 'rectangle', 650, 270, 240, 180, 'line', { color: tone.amber, valign: 'top' });
    shape('team', 'rectangle', 990, 270, 230, 180, 'workers 2\ntakes 0.5s', { valign: 'top', fontSize: 26 });
    shape('done2', 'ellipse', 1330, 310, 180, 100, 'done', { color: tone.green });
    shape('sorry', 'ellipse', 340, 540, 220, 100, 'sorry, later', { color: tone.rose, fontSize: 26 });
    arrow('r0', 'calls', 'gate', [[248, 360], [322, 360]]);
    arrow('r1', 'gate', 'wait', [[568, 360], [642, 360]]);
    arrow('r2', 'wait', 'team', [[898, 360], [982, 360]]);
    arrow('r3', 'team', 'done2', [[1228, 360], [1322, 360]]);
    arrow('r4', 'gate', 'sorry', [[445, 428], [450, 532]], 'over');
  });

// ------------------------------------------------------------------ states

scene('breaker', 'states', 'A circuit breaker stops calling a service that keeps failing',
  'press 1 three times to trip it, then wait five seconds.',
  'A state machine: its arrows are the events and timers it obeys.',
  ({ shape, arrow }) => {
    shape('closed', 'rectangle', 170, 210, 300, 140, 'closed\ncalls go through');
    shape('open', 'rectangle', 1130, 210, 300, 140, 'open\ncalls fail at once');
    shape('half-open', 'rectangle', 640, 450, 320, 140, 'half-open\none trial call');
    arrow('begin', null, 'closed', [[50, 280], [161, 280]]);
    arrow('trip', 'closed', 'open', [[479, 280], [1121, 280]], 'fail x3');
    arrow('cool', 'open', 'half-open', [[1150, 359], [969, 480]], 'after 5s');
    arrow('reopen', 'half-open', 'open', [[969, 560], [1330, 359]], 'fail');
    arrow('reset', 'half-open', 'closed', [[631, 520], [320, 359]], 'ok');
  });

scene('backoff', 'states', 'Waiting twice as long after each failure gives a service room to recover',
  'press fail again and again. The wait doubles each time, then it gives up.',
  'Guards, counters and actions, written on arrows the way a state diagram writes them.',
  ({ shape, arrow }) => {
    shape('calling', 'rectangle', 400, 190, 240, 120, 'calling');
    shape('waiting', 'rectangle', 1180, 190, 240, 120, 'waiting');
    shape('finished', 'ellipse', 410, 500, 220, 110, 'it worked', { color: tone.green });
    shape('gave-up', 'ellipse', 800, 560, 220, 110, 'gave up', { color: tone.rose });
    shape('waits-chart', 'rectangle', 1130, 440, 400, 240, 'chart wait', { color: tone.none, valign: 'top', fontSize: 24 });
    arrow('go', null, 'calling', [[50, 250], [392, 250]], '/ wait = 1; tries = 0', { fontSize: 20 });
    arrow('fail', 'calling', 'waiting', [[648, 225], [1172, 225]], 'fail [tries < 4] / tries += 1; wait *= 2', { fontSize: 20 });
    arrow('retry', 'waiting', 'calling', [[1172, 285], [910, 350], [648, 285]], 'after wait', { fontSize: 22 });
    arrow('ok', 'calling', 'finished', [[520, 318], [520, 492]], 'ok', { fontSize: 22 });
    arrow('stop', 'calling', 'gave-up', [[610, 318], [860, 552]], 'fail [tries >= 4]', { fontSize: 20 });
  });

// ------------------------------------------------------------------ chance

scene('weather', 'chance', 'Where you start stops mattering',
  'drag the start arrow onto rainy. The bars end up in the same place.',
  'A chance walk with 300 walkers. Each black tick is where that shape settles in the long run.',
  ({ shape, arrow }) => {
    shape('sunny', 'ellipse', 240, 190, 260, 170, 'sunny', { color: tone.amber, valign: 'top' });
    shape('cloudy', 'ellipse', 840, 190, 260, 170, 'cloudy', { color: tone.gray, valign: 'top' });
    shape('rainy', 'ellipse', 540, 520, 260, 170, 'rainy', { color: tone.blue, valign: 'top' });
    arrow('begin-walk', null, 'sunny', [[60, 275], [232, 275]], 'start 300', { fontSize: 22 });
    arrow('s-c', 'sunny', 'cloudy', [[488, 240], [832, 240]], '25%');
    arrow('c-s', 'cloudy', 'sunny', [[832, 310], [488, 310]], '40%');
    arrow('c-r', 'cloudy', 'rainy', [[890, 358], [720, 520]], '30%');
    arrow('r-c', 'rainy', 'cloudy', [[770, 560], [980, 358]], '50%');
    arrow('r-s', 'rainy', 'sunny', [[560, 520], [400, 358]], '10%');
    arrow('s-r', 'sunny', 'rainy', [[330, 358], [535, 560]], '5%');
    shape('share-chart', 'rectangle', 1160, 330, 400, 240, 'chart', { color: tone.none, valign: 'top', fontSize: 22 });
    arrow('sc1', 'share-chart', 'sunny', [[1200, 322], [1160, 170], [430, 195]]);
    arrow('sc2', 'share-chart', 'cloudy', [[1152, 400], [1050, 330]]);
    arrow('sc3', 'share-chart', 'rainy', [[1152, 500], [788, 590]]);
  });

// ------------------------------------------------------------------ logic

scene('latch', 'logic', 'Two gates that feed each other remember',
  'turn "set" on and off. The lamp stays lit. Then turn "reset" on and off.',
  'The smallest memory there is. Changes travel along wires at a speed you can see.',
  ({ shape, arrow }) => {
    shape('set', 'rectangle', 120, 190, 170, 90, 'set\nswitch', { fontSize: 24 });
    shape('reset', 'rectangle', 120, 520, 170, 90, 'reset\nswitch', { fontSize: 24 });
    shape('nor-b', 'rectangle', 560, 510, 170, 110, 'nor');
    shape('nor-a', 'rectangle', 560, 180, 170, 110, 'nor');
    shape('lamp-q', 'ellipse', 1040, 175, 170, 120, 'stored\nlamp', { fontSize: 24 });
    arrow('w-s', 'set', 'nor-b', [[298, 240], [420, 480], [552, 540]]);
    arrow('w-r', 'reset', 'nor-a', [[298, 560], [420, 320], [552, 260]]);
    arrow('w-a', 'nor-a', 'nor-b', [[700, 298], [790, 400], [700, 502]]);
    arrow('w-b', 'nor-b', 'nor-a', [[590, 502], [500, 400], [590, 298]]);
    arrow('w-q', 'nor-a', 'lamp-q', [[738, 235], [1032, 235]]);
  });

scene('counter', 'logic', 'Chained flip-flops count in binary',
  'watch the lamps count up. Each one runs at half the speed of the one before.',
  'A clock and four flip-flops. Delete a wire and the higher bits stop.',
  ({ shape, arrow }) => {
    shape('tick', 'rectangle', 60, 280, 170, 100, 'clock 0.5s', { fontSize: 26 });
    const bits = [1, 2, 4, 8];
    bits.forEach((bit, i) => {
      const x = 340 + i * 300;
      shape(`flip-${bit}`, 'rectangle', x, 280, 160, 100, 'flip');
      shape(`lamp-${bit}`, 'ellipse', x + 10, 500, 140, 110, `${bit}\nlamp`, { fontSize: 24 });
      arrow(`to-lamp-${bit}`, `flip-${bit}`, `lamp-${bit}`, [[x + 80, 388], [x + 80, 492]]);
    });
    arrow('t0', 'tick', 'flip-1', [[238, 330], [332, 330]]);
    bits.slice(0, -1).forEach((bit, i) => {
      arrow(`next-${bit}`, `flip-${bit}`, `flip-${bits[i + 1]}`, [[340 + i * 300 + 168, 330], [340 + (i + 1) * 300 - 8, 330]]);
    });
  });

fs.writeFileSync(path.join(here, 'demos.json'), JSON.stringify(demos, null, 2) + '\n');
console.log(`${demos.length} scenes written`);
