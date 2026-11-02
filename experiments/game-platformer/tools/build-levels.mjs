#!/usr/bin/env node
// Writes the authored levels as plain .excalidraw files. The files are the source
// of truth for the game, and each opens in excalidraw.com for editing by hand.
// This script only saves typing coordinates into JSON.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'levels');

const INK = '#343a40', HATCH = '#ced4da';
const ROSE = ['#c92a2a', '#ffe3e3'], AMBER = ['#a35200', '#fff3bf'], GREEN = ['#2b8a3e', '#d3f9d8'], BLUE = ['#1864ab', '#d0ebff'];

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 2000000000 + 1;
}

function makeBuilder(prefix) {
  const elements = [];
  let n = 0;
  const base = (type, x, y, w, h, o = {}) => {
    const id = `${prefix}-${type}-${++n}`;
    const el = {
      id, type, x, y, width: w, height: h, angle: 0, strokeColor: INK, backgroundColor: 'transparent', fillStyle: 'solid',
      strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null,
      seed: hash(id), version: 1, versionNonce: hash(`${id}!`), isDeleted: false, boundElements: [], updated: 1, link: null, locked: false, ...o,
    };
    elements.push(el);
    return el;
  };
  const b = {
    elements,
    // Solid ground, a block of hatching with a rounded top.
    ground: (x, y, w, h, o = {}) => base('rectangle', x, y, w, h, { backgroundColor: HATCH, fillStyle: 'hachure', roundness: { type: 3, value: 14 }, ...o }),
    slab: (x, y, w, h = 34, o = {}) => base('rectangle', x, y, w, h, { backgroundColor: '#f1f3f5', roundness: { type: 3, value: 10 }, ...o }),
    // A drawn line you can walk on. Points are absolute.
    path: (pts, o = {}) => {
      const [ox, oy] = pts[0];
      const local = pts.map(([x, y]) => [x - ox, y - oy]);
      const xs = local.map((p) => p[0]), ys = local.map((p) => p[1]);
      return base('line', ox, oy, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), { points: local, lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null, polygon: false, ...o });
    },
    curve: (pts, o = {}) => b.path(pts, { roundness: { type: 2 }, strokeWidth: 3, ...o }),
    dashed: (x0, x1, y, o = {}) => b.path([[x0, y], [x1, y]], { strokeStyle: 'dashed', strokeWidth: 2, ...o }),
    spikes: (x, y, w, teeth = Math.round(w / 34), o = {}) => {
      const pts = [[x, y]];
      for (let i = 0; i < teeth; i++) pts.push([x + ((i + 0.5) * w) / teeth, y - 34], [x + ((i + 1) * w) / teeth, y]);
      return b.path(pts, { strokeColor: ROSE[0], strokeWidth: 3, ...o });
    },
    blob: (x, y, w, h, o = {}) => base('ellipse', x, y, w, h, { strokeColor: ROSE[0], backgroundColor: ROSE[1], ...o }),
    coin: (x, y) => base('ellipse', x - 17, y - 17, 34, 34, { strokeColor: AMBER[0], backgroundColor: AMBER[1] }),
    coins: (pts) => pts.forEach(([x, y]) => b.coin(x, y)),
    goal: (x, y) => base('diamond', x, y, 84, 104, { strokeColor: GREEN[0], backgroundColor: GREEN[1], roundness: null }),
    checkpoint: (x, y) => base('diamond', x, y, 54, 72, { strokeColor: AMBER[0], backgroundColor: AMBER[1], roundness: null }),
    spring: (x, y, w = 110, h = 34) => base('ellipse', x, y, w, h, { strokeColor: BLUE[0], backgroundColor: BLUE[1], strokeWidth: 3 }),
    water: (x, y, w, h) => base('rectangle', x, y, w, h, { strokeColor: BLUE[0], backgroundColor: BLUE[1], opacity: 70, roundness: null }),
    // An arrow from a shape carries that shape along the arrow's path.
    moves: (target, pts, o = {}) => {
      const [ox, oy] = pts[0];
      const local = pts.map(([x, y]) => [x - ox, y - oy]);
      const xs = local.map((p) => p[0]), ys = local.map((p) => p[1]);
      const arrow = base('arrow', ox, oy, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), {
        points: local, lastCommittedPoint: null, strokeColor: '#868e96', strokeStyle: 'dashed', strokeWidth: 2, elbowed: false,
        startBinding: { elementId: target.id, focus: 0, gap: 4 }, endBinding: null, startArrowhead: null, endArrowhead: 'arrow', ...o,
      });
      target.boundElements.push({ id: arrow.id, type: 'arrow' });
      return arrow;
    },
    text: (x, y, words, o = {}) => {
      const size = o.size ?? 30;
      const lines = String(words).split('\n');
      const { size: _s, ...rest } = o;
      return base('text', x, y, Math.max(...lines.map((l) => l.length)) * size * 0.52, lines.length * size * 1.25, {
        text: words, originalText: words, fontSize: size, fontFamily: 5, textAlign: 'left', verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: 1.25, strokeColor: '#1B2547', ...rest,
      });
    },
    sign: (x, y, words, o = {}) => b.text(x, y, words, { strokeColor: '#7A776E', size: 30, ...o }),
    start: (x, y) => b.text(x, y, 'start', { strokeColor: '#7A776E', size: 24 }),
    cloud: (x, y, s = 1) => {
      for (const [dx, dy, w, h] of [[0, 20, 150, 60], [50, 0, 130, 74], [120, 22, 120, 54]]) {
        base('ellipse', x + dx * s, y + dy * s, w * s, h * s, { strokeColor: '#adb5bd', opacity: 35, strokeWidth: 1 });
      }
    },
    tree: (x, y, s = 1) => {
      b.path([[x, y], [x + 2, y - 70 * s]], { strokeColor: GREEN[0], strokeWidth: 3 });
      base('ellipse', x - 44 * s, y - 150 * s, 92 * s, 96 * s, { strokeColor: GREEN[0], backgroundColor: GREEN[1], fillStyle: 'hachure' });
    },
    pointer: (x0, y0, x1, y1, o = {}) => {
      // A free arrow touches nothing, so it is only a sign.
      const arrow = base('arrow', x0, y0, Math.abs(x1 - x0), Math.abs(y1 - y0), {
        points: [[0, 0], [x1 - x0, y1 - y0]], lastCommittedPoint: null, strokeColor: '#7A776E', elbowed: false, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: 'arrow', ...o,
      });
      return arrow;
    },
  };
  return b;
}

function save(name, b) {
  const doc = { type: 'excalidraw', version: 2, source: 'https://excalidraw.com', elements: b.elements, appState: { gridSize: null, viewBackgroundColor: '#ffffff' }, files: {} };
  fs.writeFileSync(path.join(out, `${name}.excalidraw`), JSON.stringify(doc, null, 1));
  console.log(name, b.elements.length, 'elements');
}

// ---------------------------------------------------------------------------
// 1. Learn the moves, one sign at a time.

{
  const b = makeBuilder('l1');
  b.cloud(300, 90); b.cloud(1500, 60, 1.2); b.cloud(2900, 110); b.cloud(4300, 70, 0.9);
  b.ground(-140, 200, 140, 900);
  b.ground(0, 700, 1000, 320);
  b.start(92, 640);
  b.tree(40 + 220, 700, 0.9);
  b.sign(330, 430, 'arrow keys or A and D to run');
  b.coins([[500, 640], [580, 640], [660, 640]]);
  b.sign(760, 520, 'space to jump');
  b.pointer(830, 570, 960, 620);
  b.coins([[1060, 610], [1110, 560], [1160, 610]]);
  b.ground(1220, 700, 640, 320);
  b.tree(1420, 700, 1.1);
  b.ground(1860, 590, 300, 430);
  b.sign(1560, 450, 'hold jump longer to go higher');
  b.ground(2160, 430, 420, 590);
  b.coin(2370, 370);
  b.curve([[2580, 430], [2800, 520], [3050, 640], [3300, 680], [3560, 620], [3800, 540]]);
  b.sign(2850, 360, 'a line you draw is ground');
  b.coins([[3040, 590], [3180, 620], [3320, 630], [3460, 610]]);
  b.ground(3800, 540, 500, 480);
  b.dashed(3960, 4210, 400);
  b.dashed(4080, 4330, 270);
  b.sign(3820, 150, 'dashed lines let you jump up through them\ndown arrow drops back through');
  b.coin(4220, 215);
  b.ground(4300, 540, 900, 480);
  b.spikes(4520, 540, 150);
  b.sign(4490, 380, 'red hurts');
  b.tree(4760, 540, 0.8);
  b.goal(5030, 436);
  b.sign(4780, 300, 'reach the green diamond');
  b.ground(5200, 100, 140, 920);
  save('1-first-steps', b);
}

// ---------------------------------------------------------------------------
// 2. Slopes, springs and a pond.

{
  const b = makeBuilder('l2');
  b.cloud(200, 60); b.cloud(1200, 120, 1.2); b.cloud(2400, 40); b.cloud(3600, 90, 1.1); b.cloud(4900, 60);
  b.ground(-140, 100, 140, 1000);
  b.ground(0, 700, 520, 320);
  b.start(80, 640);
  // Rolling hills drawn as one line.
  b.curve([[520, 700], [720, 600], [930, 520], [1140, 610], [1320, 690], [1500, 560], [1680, 450], [1880, 540], [2060, 620]]);
  b.coins([[930, 465], [1320, 635], [1680, 395]]);
  b.tree(1140, 610, 0.8);
  b.ground(2060, 620, 300, 400);
  // The pond: walk in, swim across, leap out.
  b.ground(2360, 920, 760, 100);
  b.water(2360, 620, 760, 300);
  b.ground(3120, 560, 420, 460);
  b.sign(2470, 470, 'blue boxes are water\npress jump to swim');
  b.coins([[2560, 860], [2740, 790], [2920, 860]]);
  b.blob(2700, 880, 70, 40);
  // A spring up to the ledge.
  b.spring(3360, 526);
  b.sign(3160, 390, 'blue circles throw you up');
  b.pointer(3415, 400, 3415, 300);
  b.ground(3540, 170, 300, 850);
  b.coin(3690, 110);
  // Islands with springs over the void.
  b.spring(3990, 590, 130); b.slab(3960, 620, 190, 40);
  b.spring(4420, 480, 130); b.slab(4390, 510, 190, 40);
  b.coins([[4240, 280], [4640, 190]]);
  b.spring(4860, 400, 130); b.slab(4830, 430, 190, 40);
  b.ground(5180, 330, 900, 700);
  b.spikes(5420, 330, 120);
  // A low tunnel, then a long ramp down into the finish.
  b.ground(5740, 40, 340, 190);
  b.coins([[5800, 280], [5900, 280], [6000, 280]]);
  b.curve([[6080, 330], [6300, 400], [6560, 560], [6820, 620], [7100, 620]]);
  b.ground(7100, 620, 500, 400);
  b.tree(7220, 620, 1);
  b.goal(7420, 516);
  b.ground(7600, 200, 140, 820);
  save('2-springs-and-ponds', b);
}

// ---------------------------------------------------------------------------
// 3. Everything here moves, and the page scrolls upward.

{
  const b = makeBuilder('l3');
  b.cloud(500, 200); b.cloud(1500, -300, 1.2); b.cloud(2600, -700); b.cloud(1000, -900, 1.1);
  b.ground(-140, 100, 140, 900);
  b.ground(0, 700, 480, 320);
  b.start(80, 640);
  b.sign(60, 470, 'an arrow on a shape moves it\nalong the arrow');
  // Two ferries over the gap, one slower than the other.
  const ferry = b.slab(520, 700, 200);
  b.moves(ferry, [[724, 717], [1180, 717]]);
  b.coin(1000, 620);
  b.ground(1400, 700, 240, 320);
  const ferry2 = b.slab(1680, 700, 200);
  b.moves(ferry2, [[1884, 717], [2300, 717]], { strokeWidth: 1 });
  b.coin(2100, 620);
  b.ground(2520, 700, 620, 320);
  b.checkpoint(2570, 628);
  // A moving hazard guards the walkway. The thick arrow means it is quick.
  const guard = b.blob(2720, 620, 76, 76);
  b.moves(guard, [[2800, 658], [3070, 658]], { strokeWidth: 4, strokeColor: '#e03131' });
  // A lift up the wall.
  b.ground(3140, 100, 300, 920);
  const lift = b.slab(2940, 460, 170);
  b.moves(lift, [[3025, 456], [3025, 170]]);
  b.path([[2750, 560], [2930, 500]], { strokeStyle: 'dashed' });
  b.sign(2520, 380, 'ride it up');
  b.coin(3290, 40);
  // Up top, the way back over the page on a curved ride.
  b.ground(2780, -330, 240, 90);
  const swing = b.slab(3160, -240, 180);
  b.moves(swing, [[3158, -223], [2980, -40], [2720, 40], [2440, -60], [2300, -220]], { roundness: { type: 2 }, strokeColor: '#868e96' });
  b.checkpoint(2850, -402);
  // The climb: three lifts out of phase.
  b.ground(1900, -220, 330, 90);
  const a = b.slab(1680, -280, 150);
  b.moves(a, [[1755, -284], [1755, -560]]);
  const c = b.slab(1400, -620, 150);
  b.moves(c, [[1475, -624], [1475, -880]], { strokeWidth: 1 });
  b.coins([[1755, -650], [1475, -950]]);
  const d = b.slab(1100, -960, 150);
  b.moves(d, [[1175, -964], [1175, -1200]]);
  // Across the top with a hazard sweep and on to the finish.
  b.ground(330, -1240, 620, 100);
  const sweep = b.blob(560, -1420, 80, 80);
  b.moves(sweep, [[600, -1336], [600, -1200]], { strokeWidth: 2, strokeColor: '#e03131', startBinding: { elementId: sweep.id, focus: 0, gap: 4 } });
  b.goal(380, -1344);
  b.ground(190, -1700, 140, 560);
  save('3-moving-day', b);
}

// ---------------------------------------------------------------------------
// 4. The whole page: everything at once, on one long doodle.

{
  const b = makeBuilder('l4');
  b.cloud(400, 20); b.cloud(1800, -40, 1.2); b.cloud(3400, 60); b.cloud(5200, 0, 1.2); b.cloud(7000, 40);
  b.ground(-140, 0, 140, 1100);
  b.ground(0, 700, 400, 320);
  b.start(70, 640);
  b.curve([[400, 700], [640, 620], [860, 660], [1080, 560], [1300, 600]]);
  b.coins([[640, 565], [860, 605], [1080, 505]]);
  b.spikes(740, 642, 60, 2);
  // Over a gap with a ferry and a guard riding the far bank.
  const ferry = b.slab(1340, 600, 180);
  b.moves(ferry, [[1524, 617], [1900, 617]]);
  b.ground(2120, 600, 560, 420);
  const guard = b.blob(2260, 520, 70, 70);
  b.moves(guard, [[2334, 555], [2600, 555]], { strokeWidth: 4, strokeColor: '#e03131' });
  b.checkpoint(2140, 528);
  // Spring onto dashed shelves, then up over the wall.
  b.spring(2560, 566);
  b.dashed(2340, 2540, 300);
  b.coin(2440, 250);
  b.ground(2680, 130, 260, 890);
  b.coin(2810, 70);
  // A pond with a hazard riding through it.
  b.ground(2940, 900, 900, 120);
  b.water(2940, 560, 900, 340);
  const eel = b.blob(3080, 760, 90, 50);
  b.moves(eel, [[3174, 785], [3700, 785]], { strokeWidth: 2, strokeColor: '#e03131' });
  b.coins([[3200, 860], [3500, 860], [3760, 860]]);
  b.ground(3840, 500, 320, 520);
  b.checkpoint(3880, 428);
  // A lift, then a dashed staircase out of reach of the spikes below.
  const lift = b.slab(4190, 500, 150);
  b.moves(lift, [[4265, 496], [4265, 120]]);
  b.ground(4360, 760, 700, 260);
  b.spikes(4360, 760, 700);
  b.dashed(4400, 4610, 170);
  b.dashed(4680, 4880, 110);
  b.dashed(4950, 5150, 170);
  b.coin(4780, 60);
  // A long slide with coins, ending in a jump to a bouncing ferry.
  b.curve([[5170, 170], [5400, 240], [5700, 420], [6000, 560], [6240, 590], [6420, 540]]);
  b.coins([[5400, 190], [5700, 370], [6000, 510]]);
  b.tree(6130, 584, 0.9);
  const spring = b.spring(6640, 620, 130, 36);
  b.moves(spring, [[6776, 638], [7200, 638]], { strokeColor: '#1971c2' });
  b.slab(6640, 656, 130, 30, {});
  b.elements[b.elements.length - 1].groupIds = ['ride'];
  spring.groupIds = ['ride'];
  b.coin(7050, 310);
  b.ground(7500, 330, 700, 690);
  b.spikes(7620, 330, 110);
  b.goal(7980, 226);
  b.ground(8200, 0, 140, 1020);
  save('4-the-whole-page', b);
}
