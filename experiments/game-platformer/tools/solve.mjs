#!/usr/bin/env node
// Finds an input sequence that beats a level, by searching over held keys on the
// game's own fixed-step simulation. Saves it to solutions/<level>.json, which the
// browser test replays through the real keyboard.
//
//   node tools/solve.mjs [level-name ...]
//   node tools/solve.mjs --coins [level-name ...]    also check every coin can be reached

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { compileLevel } from '../level.js';
import { Sim } from '../sim.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dirs = ['R', 'L', ''];
const ACTIONS = [];
for (const d of dirs) for (const j of ['', 'J']) for (const n of [10, 26]) ACTIONS.push({ keys: d + j, n });

const toInput = (keys) => ({ left: keys.includes('L'), right: keys.includes('R'), jump: keys.includes('J'), down: keys.includes('D') });

class Heap {
  constructor() { this.a = []; }
  push(item) { const a = this.a; a.push(item); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= a[i].f) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a; const top = a[0]; const last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { let m = i; const l = 2 * i + 1, r = l + 1; if (l < a.length && a[l].f < a[m].f) m = l; if (r < a.length && a[r].f < a[m].f) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; }
  get size() { return this.a.length; }
}

/** Search from the start until `done(sim)`. `waypoints` is a list of [x, y, radius] to pass in order. */
export function solve(level, done, target, waypoints = [], { maxNodes = 400000, seconds = 120 } = {}) {
  const sim = new Sim(level);
  sim.quiet = true;
  const route = [...waypoints, [target[0], target[1], 0]];
  const remaining = route.map((_, i) => {
    let sum = 0;
    for (let k = i; k + 1 < route.length; k++) sum += Math.hypot(route[k + 1][0] - route[k][0], route[k + 1][1] - route[k][1]);
    return sum;
  });
  const h = (x, y, wp) => Math.hypot(route[wp][0] - x, (route[wp][1] - y)) + remaining[wp];
  const heap = new Heap();
  const seen = new Set();
  const moving = level.movers.length > 0;
  const keyOf = (p, t, wp) => {
    const vy = p.grounded ? 0 : p.vy < -300 ? 1 : p.vy < 200 ? 2 : 3;
    const phase = moving ? Math.floor((t % 16) / 0.5) : 0;
    return `${Math.round(p.x / 26)},${Math.round(p.y / 26)},${vy},${p.jumpHeld ? 1 : 0},${phase},${wp}`;
  };
  const rootSnap = sim.snapshot();
  heap.push({ f: h(rootSnap.player.x, rootSnap.player.y, 0), snap: rootSnap, wp: 0, parent: null, act: null, depth: 0 });
  let nodes = 0;
  const started = Date.now();
  let bestH = Infinity;
  while (heap.size) {
    const node = heap.pop();
    if (++nodes > maxNodes || Date.now() - started > seconds * 1000) return { found: false, nodes, bestH };
    for (const action of ACTIONS) {
      sim.restore(node.snap);
      const input = toInput(action.keys);
      let finished = false, dead = false;
      for (let i = 0; i < action.n; i++) {
        sim.step(input);
        if (sim.player.dead) { dead = true; break; }
        if (done(sim)) { finished = true; break; }
      }
      if (dead) continue;
      const p = sim.player;
      if (finished) {
        const steps = [];
        steps.unshift([action.n, action.keys]);
        for (let n = node; n?.act; n = n.parent) steps.unshift([n.act.n, n.act.keys]);
        const merged = [];
        for (const [n, keys] of steps) {
          if (merged.length && merged[merged.length - 1][1] === keys) merged[merged.length - 1][0] += n;
          else merged.push([n, keys]);
        }
        return { found: true, nodes, steps: merged, time: sim.time };
      }
      let wp = node.wp;
      while (wp < route.length - 1 && Math.hypot(route[wp][0] - p.x, route[wp][1] - p.y) < route[wp][2]) wp++;
      const key = keyOf(p, sim.time, wp);
      if (seen.has(key)) continue;
      seen.add(key);
      const dist = h(p.x, p.y, wp);
      bestH = Math.min(bestH, dist);
      heap.push({ f: dist + (node.depth + 1) * 3, snap: sim.snapshot(), wp, parent: node, act: action, depth: node.depth + 1 });
    }
  }
  return { found: false, nodes, bestH, exhausted: true };
}

// Hints for levels whose path doubles back. The search still finds the inputs.
const WAYPOINTS = {
  '3-moving-day': [[1500, 680, 90], [2600, 680, 90], [3000, 420, 120], [3300, 60, 110], [2900, -340, 110], [2100, -240, 130], [1755, -320, 150], [1475, -660, 170], [1175, -1000, 170], [800, -1260, 120]],
  '4-the-whole-page': [[2200, 590, 90], [2560, 550, 90], [2810, 110, 90], [3900, 490, 90], [4265, 140, 110], [5170, 150, 90], [6420, 530, 90], [7000, 600, 240], [7600, 320, 90]],
  '2-springs-and-ponds': [[2200, 610, 90], [3200, 550, 90], [3400, 500, 80], [3690, 160, 90], [4050, 570, 120], [4480, 470, 120], [4900, 390, 120], [5300, 320, 70], [5900, 320, 70], [7100, 610, 80]],
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const checkCoins = args.includes('--coins');
  const names = args.filter((a) => !a.startsWith('--'));
  const all = fs.readdirSync(path.join(here, '../levels')).filter((f) => f.endsWith('.excalidraw')).map((f) => f.replace('.excalidraw', ''));
  for (const name of names.length ? names : all) {
    const doc = JSON.parse(fs.readFileSync(path.join(here, `../levels/${name}.excalidraw`), 'utf8'));
    const level = compileLevel(doc);
    const goal = level.goals[0];
    const t0 = Date.now();
    const result = solve(level, (sim) => sim.won, [goal.cx, goal.cy], WAYPOINTS[name] ?? []);
    if (result.found) {
      fs.writeFileSync(path.join(here, `../solutions/${name}.json`), JSON.stringify({ steps: result.steps }));
      console.log(`${name}: solved in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${result.nodes} nodes, ${result.time.toFixed(1)}s of play, ${result.steps.length} input changes`);
    } else {
      console.log(`${name}: NOT SOLVED`, JSON.stringify(result));
    }
    if (checkCoins) {
      const route = WAYPOINTS[name] ?? [];
      let reached = 0;
      for (const coin of level.coins) {
        // Follow the level's route up to the point nearest this coin, then go for it.
        let nearest = -1, best = Infinity;
        route.forEach(([x, y], i) => { const d = Math.hypot(x - coin.cx, y - coin.cy); if (d < best) { best = d; nearest = i; } });
        const r = solve(level, (sim) => sim.collected.has(coin.id), [coin.cx, coin.cy], route.slice(0, nearest + 1), { seconds: 40 });
        if (r.found) reached++; else console.log(`  coin ${coin.id} at ${coin.cx},${coin.cy}: NOT REACHED`);
      }
      console.log(`  coins reachable: ${reached} of ${level.coins.length}`);
    }
  }
}
