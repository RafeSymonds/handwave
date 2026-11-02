// Run a graph. Every simulator steps on a fixed clock with a seeded random number
// generator, so a given drawing and seed always gives the same run. None of them knows
// about the screen. Each keeps its state by node id, so editing the drawing changes
// what happens next without losing what is already in progress.
//
//   sim.step(dt)         move time on
//   sim.setGraph(graph)  the drawing changed
//   sim.poke(id, what)   something on the screen did this to a shape
//   sim.series(id)       samples over time for charting one shape
//   sim.snapshot()       everything that decides the future, for comparing two runs

import { pathOf } from './graph.js';
import { evaluate, runActions } from './expr.js';

export function randomFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const STEP = 1 / 60;

/** The right simulator for a graph, or null if there is nothing to run. */
export function simFor(graph, seed = 1) {
  if (graph.mode === 'flow') return new FlowSim(graph, seed);
  if (graph.mode === 'states') return new StateSim(graph, seed);
  if (graph.mode === 'chain') return new ChainSim(graph, seed);
  if (graph.mode === 'logic') return new LogicSim(graph);
  return null;
}

const SERIES_MAX = 240;
const SAMPLE_EVERY = 0.5;

// A drawing can come from anywhere and can ask for anything, so no label may freeze the
// page. Past these, work is turned away, where it counts and shows, instead of piling up.
const MAX_TOKENS = 5000;
const MAX_MADE_PER_STEP = 200;
const MAX_PARTS = 1000;
const MAX_WALKERS = 20000;
const MIN_WALK_STEP = 0.05;

// Popular items come up far more often than others, as they do in real traffic. This
// is a Zipf distribution, sampled by searching its running total.
const zipfTables = new Map();
function zipfTable(n) {
  let table = zipfTables.get(n);
  if (table) return table;
  table = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) { sum += 1 / (i + 1); table[i] = sum; }
  for (let i = 0; i < n; i++) table[i] /= sum;
  zipfTables.set(n, table);
  return table;
}
function zipfPick(n, random) {
  const table = zipfTable(n);
  const r = random();
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (table[mid] < r) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------

export class FlowSim {
  constructor(graph, seed = 1) {
    this.mode = 'flow';
    this.seed = seed;
    this.reset(graph);
  }

  reset(graph) {
    this.random = randomFrom(this.seed);
    this.time = 0;
    this.moving = [];              // tokens on arrows
    this.states = new Map();
    this.nextToken = 1;
    this.nextGroup = 1;
    this.finished = 0;
    this.durations = [];
    this.history = [];
    this.nextSample = 0;
    this.nextCheck = 0;
    this.drops = [];               // recent drops, for the screen
    this.setGraph(graph);
  }

  _fresh() {
    return { kind: null, queue: [], busy: [], reserved: 0, inbound: 0, arrivals: [], rr: 0, done: 0, dropped: 0, wasted: 0, through: 0, rate: null, nextArrival: Infinity, pending: 0, nextPending: 0, burstAt: new Map(), dead: new Set(), lru: new Map(), recent: [], hits: 0, misses: 0, closed: new Set(), bucket: 1, series: [], marks: [], times: [] };
  }

  setGraph(graph) {
    this.graph = graph;
    for (const node of graph.nodes.values()) {
      const st = this.states.get(node.id) ?? this._fresh();
      this.states.set(node.id, st);
      const steady = !!node.params.steady;
      const rate = node.kind === 'source' ? (node.params.rate ?? null) : null;
      if (rate !== st.rate || steady !== st.steady) {
        st.rate = rate;
        st.steady = steady;
        st.nextArrival = rate > 0 ? this.time + this._gap(rate, steady) : Infinity;
      }
      if (st.kind && st.kind !== node.kind) this._kindChanged(node, st);
      st.kind = node.kind;
    }
    // A token on an arrow that no longer exists is gone. It must give back any slot it held.
    this.moving = this.moving.filter((token) => {
      if (graph.edges.has(token.edge) && !graph.edges.get(token.edge).watch) return true;
      this._release(token);
      this._unaim(token);
      return false;
    });
  }

  // A shape became something else, so what it held has to go somewhere.
  _kindChanged(node, st) {
    const held = [...st.busy.map((b) => b.token), ...st.queue];
    st.busy = [];
    st.queue = [];
    st.reserved = 0;
    for (const token of held) this._dispatch(token, node, false);
  }

  state(id) { return this.states.get(id); }

  _gap(rate, steady) { return steady ? 1 / rate : -Math.log(1 - this.random()) / rate; }

  _release(token) {
    if (!token.reservedAt) return;
    const st = this.states.get(token.reservedAt);
    if (st) st.reserved--;
    token.reservedAt = null;
  }

  _unaim(token) {
    if (!token.aimedAt) return;
    const st = this.states.get(token.aimedAt);
    if (st) st.inbound--;
    token.aimedAt = null;
  }

  _launch(token, edge) {
    token.edge = edge.id;
    token.t = 0;
    token.dur = Math.max(0.25, Math.min(1.4, pathOf(edge.el).total / 450));
    token.aimedAt = edge.to;
    const st = this.states.get(edge.to);
    if (st) st.inbound++;
    this.moving.push(token);
  }

  _newToken(from, fields = {}) {
    return { id: this.nextToken++, born: this.time, retries: 0, seen: new Set(), reservedAt: null, kind: from?.kind ?? null, key: from?.key ?? null, ...fields };
  }

  // Arrows work leaves by normally. The others have a job of their own.
  _normalOut(node) {
    return node.out.filter((e) => e.to && !e.exit && e.after === undefined && !e.afterExpr);
  }

  _exit(node, name) { return node.out.find((e) => e.to && e.exit === name) ?? null; }

  _scope(token) {
    const scope = { retries: token.retries, age: this.time - token.born };
    if (token.kind) scope[token.kind] = 1;
    return scope;
  }

  _load(id) {
    const st = this.states.get(id);
    if (!st) return 0;
    return st.queue.length + st.busy.length + st.inbound;
  }

  // Choose an arrow out for a token. Guards first, then shares, then the shape's way of
  // choosing, which is taking turns unless a word says otherwise.
  _choose(node, st, token) {
    const out = this._normalOut(node);
    if (!out.length) return null;
    const guarded = out.filter((e) => e.when);
    if (guarded.length) {
      const scope = this._scope(token);
      const first = guarded.find((e) => evaluate(e.when, scope, this.random));
      if (first) return first;
    }
    const open = guarded.length ? out.filter((e) => !e.when) : out;
    if (!open.length) return null;
    const weighted = open.filter((e) => e.percent !== undefined);
    if (weighted.length) {
      const plain = open.filter((e) => e.percent === undefined);
      const named = weighted.reduce((sum, e) => sum + e.percent, 0);
      const share = plain.length ? Math.max(0, 100 - named) / plain.length : 0;
      const total = named + share * plain.length || 1;
      let r = this.random() * total;
      for (const e of open) {
        r -= e.percent ?? share;
        if (r <= 0) return e;
      }
      return open[open.length - 1];
    }
    const policy = node.params.policy;
    if (policy === 'random') return open[Math.floor(this.random() * open.length)];
    if (policy === 'least busy') {
      let best = open[st.rr++ % open.length], load = this._load(best.to);
      for (const e of open) {
        const l = this._load(e.to);
        if (l < load) { best = e; load = l; }
      }
      return best;
    }
    if (policy === 'two choices' && open.length > 1) {
      const a = Math.floor(this.random() * open.length);
      const b = (a + 1 + Math.floor(this.random() * (open.length - 1))) % open.length;
      return this._load(open[a].to) <= this._load(open[b].to) ? open[a] : open[b];
    }
    return open[st.rr++ % open.length];
  }

  _send(token, node, st) {
    st.through += token.count ?? 1;
    const edge = this._choose(node, st, token);
    if (edge) return this._launch(token, edge);
    // Arrows exist but none would take it. Saying so beats quietly finishing it.
    if (this._normalOut(node).length) this._drop(token, node, st);
    else this._finish(token, st);
  }

  _drop(token, node, st) {
    st.dropped += token.count ?? 1;
    this.drops.push({ node: node.id, time: this.time });
  }

  _finish(token, st) {
    const count = token.count ?? 1;
    st.done += count;
    if (token.stale) {
      st.wasted += count;
      return;
    }
    this.finished += count;
    const borns = token.parts ? token.parts.map((p) => p.born) : [token.born];
    for (const born of borns) {
      this.durations.push(this.time - born);
      st.times.push(this.time - born);
    }
    while (this.durations.length > 200) this.durations.shift();
    while (st.times.length > 50) st.times.shift();
  }

  _alive(node, st) {
    const count = node.params.workers ?? 1;
    let alive = count;
    for (const slot of st.dead) if (slot < count) alive--;
    return alive;
  }

  _canTake(node) {
    const st = this.states.get(node.id);
    if (node.kind === 'workers') return st.busy.length + st.reserved < this._alive(node, st);
    if (node.params.limit !== undefined) return st.queue.length + st.reserved < node.params.limit;
    return true;
  }

  // A pulled token holds its worker while it travels, so that time comes off the job.
  // Otherwise the walk would count as work and `workers 3, takes 0.75s` would finish
  // fewer than the 4 a second it says.
  _start(node, st, token, travelled = 0) {
    const takes = node.params.takes ?? 1;
    const count = node.params.workers ?? 1;
    const used = new Set(st.busy.map((b) => b.slot));
    let slot = 0;
    while ((used.has(slot) || st.dead.has(slot)) && slot < count + st.busy.length + st.dead.size) slot++;
    let total = takes * (0.7 + 0.6 * this.random());
    const slow = node.params.slow;
    if (slow && this.random() * 100 < slow.share) total *= slow.factor;
    st.busy.push({ token, slot, left: Math.max(0.02, total - travelled), total });
  }

  _freeWorker(node, st) {
    return st.busy.filter((b) => b.slot < (node.params.workers ?? 1)).length < this._alive(node, st);
  }

  // Take the next job from a line: named work first if the shape says so.
  _next(node, st) {
    const name = node.params.priority;
    if (name) {
      const i = st.queue.findIndex((t) => t.kind === name);
      if (i > 0) return st.queue.splice(i, 1)[0];
    }
    return st.queue.shift();
  }

  _wait(token, node, st) {
    if (node.params.limit !== undefined && st.queue.length >= node.params.limit) {
      this._drop(token, node, st);
      return;
    }
    token.arrivedAt = this.time;
    st.queue.push(token);
  }

  _arrive(token, edge) {
    const node = this.graph.nodes.get(edge.to);
    const pulled = !!token.reservedAt;
    this._release(token);
    this._unaim(token);
    if (!node) return;
    this._dispatch(token, node, pulled);
  }

  _dispatch(token, node, pulled) {
    const st = this.states.get(node.id);
    switch (node.kind) {
      case 'sink':
      case 'idle':
      case 'chart':
        this._finish(token, st);
        break;
      case 'workers':
        if (!pulled) {
          st.arrivals.push(this.time);
          if (token.seen.has(node.id)) token.retries++;
          token.seen.add(node.id);
        }
        if (this._freeWorker(node, st)) this._start(node, st, token, pulled ? token.dur : 0);
        else this._wait(token, node, st);
        break;
      case 'router':
      case 'source':
        this._send(token, node, st);
        break;
      case 'delay': {
        const total = node.params.delay ?? 1;
        st.busy.push({ token, left: Math.max(0.01, total), total, slot: -1 });
        break;
      }
      case 'batch':
        st.arrivals.push(this.time);
        token.arrivedAt = this.time;
        st.queue.push(token);
        this._batchReady(node, st);
        break;
      case 'split': {
        const out = this._normalOut(node);
        if (!out.length) { this._finish(token, st); break; }
        const size = Math.min(MAX_PARTS, node.params.split || out.length);
        const group = { id: this.nextGroup++, size, parent: token, arrived: 0 };
        st.through += size;
        for (let i = 0; i < size; i++) this._launch(this._newToken(token, { born: token.born, retries: token.retries, group }), out[i % out.length]);
        break;
      }
      case 'merge':
        this._merge(token, node, st);
        break;
      case 'cache':
        this._cache(token, node, st);
        break;
      case 'limiter': {
        if (st.bucket >= 1) {
          st.bucket -= 1;
          this._send(token, node, st);
        } else {
          const over = this._exit(node, 'over');
          if (over) this._launch(token, over);
          else this._drop(token, node, st);
        }
        break;
      }
      default:
        st.arrivals.push(this.time);
        if (token.seen.has(node.id)) token.retries++;
        token.seen.add(node.id);
        this._wait(token, node, st);
    }
  }

  _merge(token, node, st) {
    const group = token.group;
    if (!group) return this._send(token, node, st);
    group.arrived++;
    if (st.closed.has(group.id)) {
      // A late part of a job that has already gone on.
      if (group.arrived >= group.size) st.closed.delete(group.id);
      return;
    }
    token.arrivedAt = this.time;
    st.queue.push(token);
    const need = Math.min(node.params.first ?? group.size, group.size);
    if (group.arrived < need) return;
    st.queue = st.queue.filter((t) => t.group !== group);
    if (group.arrived < group.size) st.closed.add(group.id);
    this._send(group.parent, node, st);
  }

  _cache(token, node, st) {
    let hit;
    if (node.params.hitRate !== undefined) hit = this.random() * 100 < node.params.hitRate;
    else {
      const size = node.params.cache ?? 0;
      token.key ??= zipfPick(1000, this.random);
      hit = st.lru.has(token.key);
      if (hit) st.lru.delete(token.key);
      st.lru.set(token.key, true);
      while (st.lru.size > size) st.lru.delete(st.lru.keys().next().value);
    }
    st.recent.push(hit ? 1 : 0);
    if (st.recent.length > 100) st.recent.shift();
    if (hit) st.hits++; else st.misses++;
    if (hit) {
      const way = this._exit(node, 'hit');
      st.through += token.count ?? 1;
      if (way) this._launch(token, way);
      else this._finish(token, st);
    } else {
      const way = this._exit(node, 'miss');
      if (way) { st.through += token.count ?? 1; this._launch(token, way); } else this._send(token, node, st);
    }
  }

  _batchReady(node, st) {
    const size = Math.max(1, node.params.batch ?? 1);
    while (st.queue.length >= size) this._sendBatch(node, st, st.queue.splice(0, size));
    const wait = node.params.batchWait;
    if (wait !== undefined && st.queue.length && this.time - st.queue[0].arrivedAt >= wait) this._sendBatch(node, st, st.queue.splice(0));
  }

  _sendBatch(node, st, tokens) {
    const first = tokens[0];
    const count = tokens.reduce((n, t) => n + (t.count ?? 1), 0);
    const parts = tokens.flatMap((t) => t.parts ?? [t]);
    this._send(this._newToken(first, { born: first.born, count, parts }), node, st);
  }

  step(dt = STEP) {
    this.time += dt;
    const nodes = this.graph.nodes;

    for (const node of nodes.values()) {
      if (node.kind !== 'source') continue;
      const st = this.states.get(node.id);
      for (let made = 0; st.nextArrival <= this.time; made++) {
        st.nextArrival += this._gap(st.rate, st.steady);
        if (made >= MAX_MADE_PER_STEP) { st.nextArrival = this.time + this._gap(st.rate, st.steady); break; }
        this._emit(node, st);
      }
      for (const burst of node.params.burst ?? []) {
        const key = `${burst.count}@${burst.at ?? `e${burst.every}`}`;
        const next = st.burstAt.get(key) ?? burst.at ?? burst.every;
        if (next > this.time) { st.burstAt.set(key, next); continue; }
        st.pending += burst.count;
        st.burstAt.set(key, burst.every ? next + burst.every : Infinity);
      }
      // A burst comes out as a fast stream, so its tokens can be told apart.
      while (st.pending > 0 && st.nextPending <= this.time) {
        st.nextPending = Math.max(st.nextPending + 0.03, this.time - 0.1);
        st.pending--;
        this._emit(node, st);
      }
    }

    const still = [];
    const landed = [];
    for (const token of this.moving) {
      token.t += dt / token.dur;
      if (token.t >= 1) landed.push(token); else still.push(token);
    }
    this.moving = still;
    for (const token of landed) {
      const edge = this.graph.edges.get(token.edge);
      if (edge) this._arrive(token, edge);
      else { this._release(token); this._unaim(token); }
    }

    for (const node of nodes.values()) {
      const st = this.states.get(node.id);
      if (node.kind === 'workers') {
        const finished = [];
        for (const job of st.busy) {
          job.left -= dt;
          if (job.left <= 0) finished.push(job);
        }
        if (finished.length) st.busy = st.busy.filter((job) => job.left > 0);
        for (const job of finished) this._send(job.token, node, st);
        while (st.queue.length && this._freeWorker(node, st)) this._start(node, st, this._next(node, st));
      } else if (node.kind === 'delay') {
        const finished = [];
        for (const job of st.busy) {
          job.left -= dt;
          if (job.left <= 0) finished.push(job);
        }
        if (finished.length) st.busy = st.busy.filter((job) => job.left > 0);
        for (const job of finished) this._send(job.token, node, st);
      } else if (node.kind === 'batch') {
        this._batchReady(node, st);
      } else if (node.kind === 'limiter') {
        st.bucket = Math.min(Math.max(1, node.params.allow ?? 1), st.bucket + (node.params.allow ?? 0) * dt);
      }
    }

    if (this.time >= this.nextCheck) {
      this.nextCheck += 0.1;
      for (const node of nodes.values()) if (node.kind === 'queue' || node.kind === 'workers') this._timeouts(node);
    }

    // Held work moves on only when a shape further along has room.
    for (const node of nodes.values()) {
      if (node.kind !== 'queue') continue;
      const st = this.states.get(node.id);
      const out = this._normalOut(node);
      while (st.queue.length && out.length) {
        let edge = null;
        const token = this._peek(node, st);
        const guarded = out.some((e) => e.when);
        const allowed = guarded ? out.filter((e) => (e.when ? evaluate(e.when, this._scope(token), this.random) : true)) : out;
        for (let i = 0; i < allowed.length; i++) {
          const candidate = allowed[(st.rr + i) % allowed.length];
          const target = nodes.get(candidate.to);
          if (this._canTake(target)) { edge = candidate; st.rr = (st.rr + i + 1) % allowed.length; break; }
        }
        if (!edge) break;
        this._next(node, st);
        st.through += token.count ?? 1;
        const target = nodes.get(edge.to);
        if (target.kind === 'workers' || target.params.limit !== undefined) {
          this.states.get(target.id).reserved++;
          token.reservedAt = target.id;
        }
        this._launch(token, edge);
      }
    }

    if (this.time >= this.nextSample) {
      this.nextSample += SAMPLE_EVERY;
      let wasted = 0;
      for (const id of nodes.keys()) wasted += this.states.get(id)?.wasted ?? 0;
      this.history.push({ t: this.time, waiting: this.waiting(), finished: this.finished, wasted });
      if (this.history.length > SERIES_MAX) this.history.shift();
      for (const node of nodes.values()) {
        const st = this.states.get(node.id);
        while (st.arrivals.length && st.arrivals[0] < this.time - 30) st.arrivals.shift();
        st.marks.push({ t: this.time, through: st.through, done: st.done });
        if (st.marks.length > 11) st.marks.shift();
        st.series.push({ t: this.time, ...this.metrics(node) });
        if (st.series.length > SERIES_MAX) st.series.shift();
      }
      while (this.drops.length && this.drops[0].time < this.time - 10) this.drops.shift();
    }
  }

  _peek(node, st) {
    const name = node.params.priority;
    if (name) {
      const found = st.queue.find((t) => t.kind === name);
      if (found) return found;
    }
    return st.queue[0];
  }

  _emit(node, st) {
    const mix = node.params.mix ?? [];
    let kind = null;
    if (mix.length) {
      let r = this.random() * 100;
      for (const m of mix) {
        r -= m.share;
        if (r < 0) { kind = m.kind; break; }
      }
    }
    const key = node.params.keys ? zipfPick(node.params.keys, this.random) : null;
    const token = this._newToken(null, { kind, key });
    if (this.moving.length + this.waiting() >= MAX_TOKENS) { this._drop(token, node, st); return; }
    this._send(token, node, st);
  }

  // Work that has waited too long leaves by an `after` arrow. `copy after` leaves the
  // original where it is, so a client's retry and the abandoned first try both get done.
  _timeouts(node) {
    const timed = node.out.filter((e) => e.to && e.after !== undefined);
    if (!timed.length) return;
    const st = this.states.get(node.id);
    for (const edge of timed) {
      const kept = edge.copy ? null : [];
      for (const token of st.queue) {
        const late = !token.stale && this.time - (token.arrivedAt ?? this.time) >= edge.after;
        if (!late) { kept?.push(token); continue; }
        if (edge.copy) {
          if (token.copied || this.moving.length + this.waiting() >= MAX_TOKENS) continue;
          token.copied = true;
          token.stale = true;
          this._launch(this._newToken(token, { born: token.born, retries: token.retries + 1 }), edge);
        } else this._launch(token, edge);
      }
      if (kept) st.queue = kept;
    }
  }

  /** Something on the screen did this. Returns words for the screen, or null. */
  poke(id, what, slot) {
    const node = this.graph.nodes.get(id);
    const st = this.states.get(id);
    if (!node || !st) return null;
    if (what === 'kill') {
      if (st.dead.has(slot)) { st.dead.delete(slot); return 'worker back'; }
      st.dead.add(slot);
      const job = st.busy.find((b) => b.slot === slot);
      if (job) {
        st.busy = st.busy.filter((b) => b !== job);
        job.token.retries++;
        st.queue.unshift(job.token);
      }
      return 'worker killed';
    }
    if (what === 'burst') { st.pending += 20; st.nextPending = this.time; return 'sent 20'; }
    if (what === 'flush') { st.lru.clear(); st.recent = []; return 'cache emptied'; }
    return null;
  }

  waiting() {
    let n = 0;
    for (const id of this.graph.nodes.keys()) {
      const st = this.states.get(id);
      // Work held by a batch or a merge is waiting for company, not for capacity.
      if (st && st.kind !== 'merge' && st.kind !== 'batch') n += st.queue.length;
    }
    return n;
  }

  // What can be read from one shape. A chart's expression sees these names.
  metrics(node) {
    const st = this.states.get(node.id);
    const marks = st.marks;
    const old = marks[0];
    const span = old ? this.time - old.t : 0;
    const rate = span > 0 ? (st.through - old.through) / span : 0;
    const doneRate = span > 0 ? (st.done - old.done) / span : 0;
    return {
      waiting: st.queue.length,
      busy: st.busy.length,
      inside: st.queue.length + st.busy.length,
      done: st.done,
      rate: node.kind === 'sink' ? doneRate : rate,
      dropped: st.dropped,
      wasted: st.wasted,
      hitrate: st.recent.length ? (st.recent.reduce((a, b) => a + b, 0) / st.recent.length) * 100 : 0,
      time: st.times.length ? st.times.reduce((a, b) => a + b, 0) / st.times.length : 0,
    };
  }

  /** The number a chart shows for a shape unless it asks for another. */
  defaultMetric(node) {
    switch (node?.kind) {
      case 'cache': return { key: 'hitrate', label: 'hit %' };
      case 'workers': return { key: 'inside', label: 'jobs inside' };
      case 'sink': return { key: 'time', label: 'seconds each' };
      case 'source': case 'router': case 'limiter': case 'split': return { key: 'rate', label: 'per second' };
      case 'delay': return { key: 'inside', label: 'jobs inside' };
      default: return { key: 'waiting', label: 'waiting' };
    }
  }

  series(id) { return this.states.get(id)?.series ?? []; }

  _rate(st) { return st.arrivals.length / Math.max(3, Math.min(30, this.time)); }

  _meanTakes(node) {
    const takes = node.params.takes ?? 1;
    const slow = node.params.slow;
    return slow ? takes * (1 + (slow.share / 100) * (slow.factor - 1)) : takes;
  }

  // The workers closest to their limit, with the work headed for them.
  bottleneck() {
    let worst = null;
    for (const node of this.graph.nodes.values()) {
      if (node.kind !== 'workers') continue;
      const st = this.states.get(node.id);
      const count = this._alive(node, st);
      const takes = this._meanTakes(node);
      let demand = this._rate(st);
      for (const edge of node.in) {
        const from = this.graph.nodes.get(edge.from);
        if (from?.kind === 'queue') demand += this._rate(this.states.get(from.id)) / (this._normalOut(from).length || 1);
      }
      const capacity = count / takes;
      // A dead shape nothing is arriving at isn't the limit on anything.
      if (capacity <= 0 && demand < 0.2) continue;
      const load = capacity > 0 ? demand / capacity : Infinity;
      if (!worst || load > worst.load) worst = { id: node.id, name: node.name, count, total: node.params.workers ?? 1, takes, demand, capacity, load };
    }
    return worst;
  }

  // How fast the waiting line is changing, per second, over about ten seconds.
  slope() {
    const h = this.history;
    if (h.length < 20) return 0;
    const mean = (from, to) => { const part = h.slice(from, to); return part.reduce((s, p) => s + p.waiting, 0) / part.length; };
    return (mean(h.length - 4, h.length) - mean(h.length - 20, h.length - 16)) / 8;
  }

  stats() {
    const waiting = this.waiting();
    const slope = this.slope();
    const b = this.bottleneck();
    const overloaded = b && b.demand > b.capacity * 1.1;
    const h = this.history;
    const past = h[Math.max(0, h.length - 21)];
    const span = past ? this.time - past.t : 0;
    const latest = h[h.length - 1];
    const goodRate = span > 0 ? (latest.finished - past.finished) / span : 0;
    const wasteRate = span > 0 ? (latest.wasted - past.wasted) / span : 0;
    const verdict = wasteRate > 0.2 && wasteRate > goodRate ? 'wasting' : this.drops.length ? 'turning away'
      : (waiting >= 8 && slope > 0.2) || (overloaded && waiting >= 3) ? 'backing up'
        : waiting >= 8 && slope < -0.2 ? 'draining' : 'keeping up';
    const sinks = [...this.graph.nodes.values()].filter((n) => n.kind === 'sink').map((n) => ({ id: n.id, name: n.name, done: this.states.get(n.id).done }));
    const list = [...this.durations].sort((a, b2) => a - b2);
    const average = list.length ? list.reduce((a, b2) => a + b2, 0) / list.length : 0;
    const slowest = list.length ? list[Math.min(list.length - 1, Math.floor(list.length * 0.95))] : 0;
    let dropped = 0, wasted = 0;
    for (const id of this.graph.nodes.keys()) {
      const st = this.states.get(id);
      if (!st) continue;
      dropped += st.dropped;
      wasted += st.wasted;
    }
    return { time: this.time, waiting, slope, verdict, finished: this.finished, average, slowest, sinks, dropped, wasted, goodRate, wasteRate, bottleneck: b };
  }

  snapshot() {
    const nodes = {};
    for (const [id, st] of this.states) nodes[id] = { queue: st.queue.map((t) => t.id), busy: st.busy.map((b) => [b.token.id, +b.left.toFixed(6)]), done: st.done, dropped: st.dropped };
    return { time: +this.time.toFixed(6), moving: this.moving.map((t) => [t.id, +t.t.toFixed(6)]), nodes };
  }
}

// ---------------------------------------------------------------------------

export class StateSim {
  constructor(graph, seed = 1) {
    this.mode = 'states';
    this.seed = seed;
    this.reset(graph);
  }

  reset(graph) {
    this.graph = graph;
    this.random = randomFrom(this.seed);
    this.time = 0;
    this.vars = Object.create(null);
    this.current = this._initial(graph);
    this.entered = 0;
    this.counts = new Map();
    this.moving = null;
    this.trail = this.current ? [graph.nodes.get(this.current).name] : [];
    this.note = '';
    this.samples = [];
    this.nextSample = 0;
    for (const edge of graph.edges.values()) if (!edge.from && edge.to && edge.action) runActions(edge.action, this.vars, this.random);
    if (this.current) this._enter(this.current);
  }

  // An arrow from nowhere marks the start, as in a state diagram. Otherwise, the
  // first shape nothing points to, and then simply the first shape.
  _initial(graph) {
    for (const edge of graph.edges.values()) if (!edge.watch && !edge.from && edge.to) return edge.to;
    const nodes = [...graph.nodes.values()].filter((n) => n.kind !== 'chart');
    const linked = nodes.filter((n) => n.out.length || n.in.length);
    return (linked.find((n) => !n.in.some((e) => e.from)) ?? linked[0] ?? nodes[0])?.id ?? null;
  }

  _enter(id) {
    const enter = this.graph.nodes.get(id)?.params.enter;
    if (enter) runActions(enter, this.vars, this.random);
  }

  setGraph(graph) {
    this.graph = graph;
    if (!graph.nodes.has(this.current)) this.reset(graph);
    if (this.moving && !graph.edges.has(this.moving.edge)) this.moving = null;
  }

  nameOf(id) { return this.graph.nodes.get(id)?.name || 'this state'; }

  /** Every event any arrow listens for, in drawing order. */
  events() {
    const names = [];
    for (const edge of this.graph.edges.values()) if (edge.from && edge.event && !names.includes(edge.event)) names.push(edge.event);
    return names;
  }

  outgoing() { return this.graph.nodes.get(this.current)?.out ?? []; }

  _guardOk(edge) { return !edge.guard || !!evaluate(edge.guard, this.vars, this.random); }

  enabled(name) { return this.outgoing().some((e) => e.event === name && e.to && this._guardOk(e)); }

  canFire(edge) { return edge.from === this.current && !!edge.event && !!edge.to && this._guardOk(edge); }

  fire(name) {
    if (this.moving) this._land();
    const options = this.outgoing().filter((e) => e.event === name && e.to);
    // Only the same event in a row counts towards `fail x3`.
    for (const e of this.outgoing()) if (e.event !== name) this.counts.delete(e.id);
    if (!options.length) {
      this.note = `${this.nameOf(this.current)} ignores ${name}`;
      return false;
    }
    const edge = options.find((e) => this._guardOk(e));
    if (!edge) {
      this.note = `${name} is blocked: ${options[0].params.guardText} is not true`;
      return false;
    }
    this.note = '';
    const count = (this.counts.get(edge.id) ?? 0) + 1;
    if (count < edge.times) {
      this.counts.set(edge.id, count);
      return true;
    }
    this._leave(edge);
    return true;
  }

  _leave(edge) {
    this.counts.clear();
    if (edge.action) runActions(edge.action, this.vars, this.random);
    this.moving = { edge: edge.id, t: 0, dur: 0.4 };
  }

  _land() {
    const edge = this.graph.edges.get(this.moving.edge);
    this.moving = null;
    if (!edge?.to) return;
    this.current = edge.to;
    this.entered = this.time;
    this.trail.push(this.nameOf(this.current));
    if (this.trail.length > 7) this.trail.shift();
    this._enter(this.current);
  }

  _afterOf(edge) {
    if (edge.after !== undefined) return edge.after;
    if (edge.afterExpr) return evaluate(edge.afterExpr, this.vars, this.random);
    return undefined;
  }

  /** How long a timed arrow waits, or undefined if it isn't timed. */
  waitOf(edge) { return this._afterOf(edge); }

  /** How far a timed arrow has got, from 0 to 1. */
  progress(edge) {
    const wait = this._afterOf(edge);
    if (wait === undefined) return 0;
    return wait > 0 ? Math.min(1, (this.time - this.entered) / wait) : 1;
  }

  step(dt = STEP) {
    this.time += dt;
    if (this.time >= this.nextSample) {
      this.nextSample += 0.25;
      this.samples.push({ t: this.time, ...this.vars });
      if (this.samples.length > SERIES_MAX) this.samples.shift();
    }
    if (this.moving) {
      this.moving.t += dt / this.moving.dur;
      if (this.moving.t >= 1) this._land();
      return;
    }
    for (const edge of this.outgoing()) {
      if (!edge.to) continue;
      const wait = this._afterOf(edge);
      if (wait !== undefined && this.time - this.entered >= wait && this._guardOk(edge)) {
        this._leave(edge);
        break;
      }
      // An arrow with only a guard moves as soon as the guard is true.
      if (wait === undefined && !edge.event && edge.guard && this._guardOk(edge)) {
        this._leave(edge);
        break;
      }
    }
  }

  poke() { return null; }

  series() { return this.samples; }

  snapshot() {
    return { time: +this.time.toFixed(6), current: this.current, moving: this.moving?.edge ?? null, counts: Object.fromEntries(this.counts), vars: { ...this.vars } };
  }
}

// ---------------------------------------------------------------------------
// A chance walk. Many walkers stand on the shapes and each takes an arrow out by its %
// on every step. A share that adds up to less than 100% means staying put.

const WALK_MOVE = 0.6;

export class ChainSim {
  constructor(graph, seed = 1) {
    this.mode = 'chain';
    this.seed = seed;
    this.reset(graph);
  }

  _starter(graph) { return [...graph.edges.values()].find((e) => !e.watch && !e.from && e.to) ?? null; }

  reset(graph) {
    this.graph = graph;
    this.random = randomFrom(this.seed);
    this.time = 0;
    this.steps = 0;
    this.moving = [];
    this.flying = new Map();
    this.samples = [];
    const starter = this._starter(graph);
    const places = [...graph.nodes.values()].filter((n) => n.kind === 'place');
    this.startId = starter?.to ?? places[0]?.id ?? null;
    this.total = Math.min(MAX_WALKERS, starter?.params.walkers ?? 300);
    this.every = Math.max(MIN_WALK_STEP, starter?.params.every ?? 1);
    this.counts = new Map(places.map((n) => [n.id, n.id === this.startId ? this.total : 0]));
    this.nextTurn = this.every;
    this.longRun = this._solve(graph);
    this._sample();
  }

  setGraph(graph) {
    const starter = this._starter(graph);
    const nextStart = starter?.to ?? this.startId;
    const places = [...graph.nodes.values()].filter((n) => n.kind === 'place');
    // Moving the start arrow is the whole point of this drawing, so it starts again.
    if (nextStart !== this.startId || !graph.nodes.has(this.startId) || Math.min(MAX_WALKERS, starter?.params.walkers ?? 300) !== this.total) return this.reset(graph);
    this.graph = graph;
    this.every = Math.max(MIN_WALK_STEP, starter?.params.every ?? 1);
    for (const n of places) if (!this.counts.has(n.id)) this.counts.set(n.id, 0);
    for (const id of [...this.counts.keys()]) {
      if (graph.nodes.has(id)) continue;
      this.counts.set(this.startId, (this.counts.get(this.startId) ?? 0) + this.counts.get(id));
      this.counts.delete(id);
    }
    this.longRun = this._solve(graph);
  }

  // Each arrow's share of a shape's walkers, with unlabelled arrows splitting the rest.
  _shares(node) {
    const out = node.out.filter((e) => e.to);
    const named = out.filter((e) => e.percent !== undefined);
    const sum = named.reduce((s, e) => s + e.percent, 0);
    const plain = out.length - named.length;
    const each = plain ? Math.max(0, 100 - sum) / plain : 0;
    const scale = sum + each * plain > 100 ? 100 / (sum + each * plain) : 1;
    return out.map((e) => ({ edge: e, share: (e.percent ?? each) * scale / 100 }));
  }

  // Where the walkers end up in the long run, found by walking the shares many times.
  _solve(graph) {
    const places = [...graph.nodes.values()].filter((n) => n.kind === 'place');
    let now = new Map(places.map((n) => [n.id, n.id === this.startId ? 1 : 0]));
    const shares = new Map(places.map((n) => [n.id, this._shares(n)]));
    for (let i = 0; i < 400; i++) {
      const next = new Map(places.map((n) => [n.id, 0]));
      for (const n of places) {
        let left = now.get(n.id);
        const had = left;
        for (const { edge, share } of shares.get(n.id)) {
          next.set(edge.to, next.get(edge.to) + had * share);
          left -= had * share;
        }
        next.set(n.id, next.get(n.id) + left);
      }
      now = next;
    }
    return now;
  }

  _turn() {
    this.steps++;
    for (const node of this.graph.nodes.values()) {
      if (node.kind !== 'place') continue;
      const shares = this._shares(node);
      const here = this.counts.get(node.id) ?? 0;
      const leaving = new Map();
      for (let i = 0; i < here; i++) {
        let r = this.random();
        for (const { edge, share } of shares) {
          r -= share;
          if (r < 0) { leaving.set(edge, (leaving.get(edge) ?? 0) + 1); break; }
        }
      }
      for (const [edge, n] of leaving) {
        this.counts.set(node.id, this.counts.get(node.id) - n);
        this.flying.set(edge.to, (this.flying.get(edge.to) ?? 0) + n);
        // A few tokens stand for the crowd on each arrow.
        const shown = Math.min(n, 14);
        for (let k = 0; k < shown; k++) this.moving.push({ edge: edge.id, t: -k * 0.04, id: this.steps * 100 + k });
      }
    }
    this.landAt = this.time + this.every * WALK_MOVE;
  }

  _sample() {
    const sample = { t: this.time, steps: this.steps };
    for (const [id, n] of this.counts) sample[id] = this.total ? n / this.total : 0;
    this.samples.push(sample);
    if (this.samples.length > SERIES_MAX) this.samples.shift();
  }

  step(dt = STEP) {
    this.time += dt;
    const speed = dt / (this.every * WALK_MOVE * 0.75);
    this.moving = this.moving.filter((token) => { token.t += speed; return token.t < 1 && this.graph.edges.has(token.edge); });
    if (this.landAt !== undefined && this.time >= this.landAt) {
      this.landAt = undefined;
      for (const [id, n] of this.flying) this.counts.set(id, (this.counts.get(id) ?? 0) + n);
      this.flying.clear();
      this._sample();
    }
    if (this.time >= this.nextTurn) {
      this.nextTurn += this.every;
      this._turn();
    }
  }

  // Walkers on an arrow count where they are going, so the shares always add up.
  share(id) { return this.total ? ((this.counts.get(id) ?? 0) + (this.flying.get(id) ?? 0)) / this.total : 0; }

  poke() { return null; }

  series() { return this.samples; }

  defaultMetric(node) { return { key: node?.id, label: 'share of walkers' }; }

  snapshot() {
    return { time: +this.time.toFixed(6), steps: this.steps, counts: Object.fromEntries(this.counts) };
  }
}

// ---------------------------------------------------------------------------
// A logic circuit. A change travels along a wire at a speed you can see, so a loop of
// gates has a delay in it, which is what makes a latch hold and a ring of inverters
// oscillate. Switches stay set when you edit the drawing.

const WIRE_SPEED = 620;  // stage units a second

const compute = {
  and: (v) => (v.length && v.every(Boolean) ? 1 : 0),
  or: (v) => (v.some(Boolean) ? 1 : 0),
  not: (v) => (v[0] ? 0 : 1),
  xor: (v) => v.reduce((a, b) => a ^ b, 0),
  nand: (v) => (v.length && v.every(Boolean) ? 0 : 1),
  nor: (v) => (v.some(Boolean) ? 0 : 1),
  lamp: (v) => (v.some(Boolean) ? 1 : 0),
  wire: (v) => (v.some(Boolean) ? 1 : 0),
};

export class LogicSim {
  constructor(graph) {
    this.mode = 'logic';
    this.reset(graph);
  }

  reset(graph) {
    this.graph = graph;
    this.time = 0;
    this.output = new Map();
    this.wires = new Map();
    this.held = new Set();
    this.flips = new Map();
    this.clocks = new Map();
    this.samples = [];
    this.nextSample = 0;
    this._sync();
    this._settle();
  }

  setGraph(graph) {
    this.graph = graph;
    this._sync();
  }

  // New shapes and wires pick up from what is already there.
  _sync() {
    for (const node of this.graph.nodes.values()) {
      if (!this.output.has(node.id)) this.output.set(node.id, node.kind === 'switch' && node.params.startsOn ? 1 : 0);
      if (node.kind === 'clock' && !this.clocks.has(node.id)) this.clocks.set(node.id, this.time + (node.params.clock ?? 1));
      if (node.kind !== 'clock') this.clocks.delete(node.id);
    }
    for (const edge of this.graph.edges.values()) {
      if (edge.watch || !edge.from || !edge.to) { this.wires.delete(edge.id); continue; }
      const dur = Math.max(0.15, Math.min(0.9, pathOf(edge.el).total / WIRE_SPEED));
      const was = this.wires.get(edge.id);
      if (was) was.dur = dur;
      else this.wires.set(edge.id, { value: this.output.get(edge.from) ?? 0, pulses: [], dur });
    }
    for (const id of [...this.wires.keys()]) if (!this.graph.edges.has(id)) this.wires.delete(id);
  }

  // At the start, gates take their values one at a time with no delay. Otherwise two
  // gates that feed each other can both change at once, forever.
  _settle() {
    for (let pass = 0; pass < 8; pass++) {
      for (const node of this.graph.nodes.values()) {
        const value = this._value(node);
        this.output.set(node.id, value);
        for (const edge of node.out) {
          const wire = this.wires.get(edge.id);
          if (wire) wire.value = value;
        }
      }
    }
  }

  _inputs(node) {
    const values = [];
    for (const edge of node.in) {
      const wire = this.wires.get(edge.id);
      if (wire) values.push(wire.value);
    }
    return values;
  }

  _value(node) {
    switch (node.kind) {
      case 'switch': case 'clock': case 'button': return this.output.get(node.id) ?? 0;
      case 'flip': return this.flips.get(node.id)?.state ?? 0;
      case 'chart': return 0;
      default: return (compute[node.kind] ?? compute.wire)(this._inputs(node));
    }
  }

  _send(node, value) {
    this.output.set(node.id, value);
    for (const edge of node.out) this.wires.get(edge.id)?.pulses.push({ t: 0, value });
  }

  /** A click on a switch, or a press on a button. */
  poke(id, what) {
    const node = this.graph.nodes.get(id);
    if (!node) return null;
    if (node.kind === 'switch' && what === 'click') { this._send(node, this.output.get(id) ? 0 : 1); return this.output.get(id) ? 'on' : 'off'; }
    if (node.kind === 'button' && what === 'press') { this._send(node, 1); return 'pressed'; }
    if (node.kind === 'button' && what === 'release') { this._send(node, 0); return 'released'; }
    return null;
  }

  step(dt = STEP) {
    this.time += dt;
    for (const wire of this.wires.values()) {
      if (!wire.pulses.length) continue;
      for (const p of wire.pulses) p.t += dt / wire.dur;
      while (wire.pulses.length && wire.pulses[0].t >= 1) wire.value = wire.pulses.shift().value;
    }
    for (const node of this.graph.nodes.values()) {
      if (node.kind === 'clock') {
        let next = this.clocks.get(node.id);
        if (next !== undefined && next <= this.time) {
          const every = Math.max(0.05, node.params.clock ?? 1);
          while (next <= this.time) next += every;
          this.clocks.set(node.id, next);
          this._send(node, this.output.get(node.id) ? 0 : 1);
        }
        continue;
      }
      if (node.kind === 'switch' || node.kind === 'button' || node.kind === 'chart') continue;
      if (node.kind === 'flip') {
        const st = this.flips.get(node.id) ?? { last: 0, state: 0 };
        const input = this._inputs(node).some(Boolean) ? 1 : 0;
        if (!input && st.last) st.state = st.state ? 0 : 1;
        st.last = input;
        this.flips.set(node.id, st);
        if (st.state !== this.output.get(node.id)) this._send(node, st.state);
        continue;
      }
      const value = this._value(node);
      if (value !== this.output.get(node.id)) this._send(node, value);
    }
    if (this.time >= this.nextSample) {
      this.nextSample += 0.1;
      const sample = { t: this.time };
      for (const [id, v] of this.output) sample[id] = v;
      this.samples.push(sample);
      if (this.samples.length > 400) this.samples.shift();
    }
  }

  value(id) { return this.output.get(id) ?? 0; }

  series() { return this.samples; }

  defaultMetric(node) { return { key: node?.id, label: '1 or 0' }; }

  snapshot() {
    const wires = {};
    for (const [id, w] of this.wires) wires[id] = [w.value, w.pulses.length];
    return { time: +this.time.toFixed(6), output: Object.fromEntries(this.output), wires };
  }
}
