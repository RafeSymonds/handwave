// Run a graph. Both simulators step on a fixed clock with a seeded random number
// generator, so a given drawing and seed always gives the same run. Neither one
// knows about the screen. Each keeps its state by node id, so editing the drawing
// changes what happens next without losing what is already in progress.

import { pathOf } from './graph.js';

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
    this.finished = 0;
    this.durations = [];
    this.history = [];
    this.nextSample = 0;
    this.drops = [];               // recent drops, for the screen
    this.setGraph(graph);
  }

  setGraph(graph) {
    this.graph = graph;
    for (const node of graph.nodes.values()) {
      const st = this.states.get(node.id) ?? { queue: [], busy: [], reserved: 0, arrivals: [], rr: 0, done: 0, dropped: 0, rate: null, nextArrival: Infinity };
      this.states.set(node.id, st);
      const rate = node.kind === 'source' ? node.params.rate : null;
      if (rate !== st.rate) {
        st.rate = rate;
        st.nextArrival = rate > 0 ? this.time + this._gap(rate) : Infinity;
      }
    }
    // A token on an arrow that no longer exists is gone. It must give back any slot it held.
    this.moving = this.moving.filter((token) => {
      if (graph.edges.has(token.edge)) return true;
      this._release(token);
      return false;
    });
  }

  state(id) { return this.states.get(id); }

  _gap(rate) { return -Math.log(1 - this.random()) / rate; }

  _release(token) {
    if (!token.reservedAt) return;
    const st = this.states.get(token.reservedAt);
    if (st) st.reserved--;
    token.reservedAt = null;
  }

  _launch(token, edge) {
    token.edge = edge.id;
    token.t = 0;
    token.dur = Math.max(0.25, Math.min(1.4, pathOf(edge.el).total / 450));
    this.moving.push(token);
  }

  // Choose an arrow out: by percent when any is labelled, otherwise in turn.
  _choose(node, st) {
    const out = node.out.filter((e) => e.to);
    if (!out.length) return null;
    const weighted = out.filter((e) => e.percent !== undefined);
    if (!weighted.length) return out[st.rr++ % out.length];
    const plain = out.filter((e) => e.percent === undefined);
    const named = weighted.reduce((sum, e) => sum + e.percent, 0);
    const share = plain.length ? Math.max(0, 100 - named) / plain.length : 0;
    const total = named + share * plain.length || 1;
    let r = this.random() * total;
    for (const e of out) {
      r -= e.percent ?? share;
      if (r <= 0) return e;
    }
    return out[out.length - 1];
  }

  _send(token, node, st) {
    const edge = this._choose(node, st);
    if (edge) this._launch(token, edge);
    else this._finish(token, st);
  }

  _finish(token, st) {
    st.done++;
    this.finished++;
    this.durations.push(this.time - token.born);
    if (this.durations.length > 100) this.durations.shift();
  }

  _canTake(node) {
    const st = this.states.get(node.id);
    if (node.kind === 'workers') return st.busy.length + st.reserved < (node.params.workers ?? 1);
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
    while (used.has(slot) && slot < count + st.busy.length) slot++;
    const total = takes * (0.7 + 0.6 * this.random());
    st.busy.push({ token, slot, left: Math.max(0.02, total - travelled), total });
  }

  _arrive(token, edge) {
    const node = this.graph.nodes.get(edge.to);
    const pulled = !!token.reservedAt;
    this._release(token);
    if (!node) return;
    const st = this.states.get(node.id);
    switch (node.kind) {
      case 'sink':
      case 'idle':
        this._finish(token, st);
        break;
      case 'workers':
        if (!pulled) st.arrivals.push(this.time);
        if (st.busy.length < (node.params.workers ?? 1)) this._start(node, st, token, pulled ? token.dur : 0);
        else st.queue.push(token);
        break;
      case 'router':
      case 'source':
        this._send(token, node, st);
        break;
      default:
        st.arrivals.push(this.time);
        if (token.seen.has(node.id)) token.retries++;
        token.seen.add(node.id);
        if (node.params.limit !== undefined && st.queue.length >= node.params.limit) {
          st.dropped++;
          this.drops.push({ node: node.id, time: this.time });
        } else st.queue.push(token);
    }
  }

  step(dt = STEP) {
    this.time += dt;
    const nodes = [...this.graph.nodes.values()];

    for (const node of nodes) {
      if (node.kind !== 'source') continue;
      const st = this.states.get(node.id);
      while (st.nextArrival <= this.time) {
        st.nextArrival += this._gap(st.rate);
        const edge = this._choose(node, st);
        if (edge) this._launch({ id: this.nextToken++, born: this.time, retries: 0, seen: new Set(), reservedAt: null }, edge);
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
      if (edge) this._arrive(token, edge); else this._release(token);
    }

    for (const node of nodes) {
      const st = this.states.get(node.id);
      if (node.kind === 'workers') {
        const finished = [];
        for (const job of st.busy) {
          job.left -= dt;
          if (job.left <= 0) finished.push(job);
        }
        if (finished.length) st.busy = st.busy.filter((job) => job.left > 0);
        for (const job of finished) this._send(job.token, node, st);
        while (st.queue.length && st.busy.length < (node.params.workers ?? 1)) this._start(node, st, st.queue.shift());
      }
    }

    // Held work moves on only when a shape further along has room.
    for (const node of nodes) {
      if (node.kind !== 'queue') continue;
      const st = this.states.get(node.id);
      const out = node.out.filter((e) => e.to);
      while (st.queue.length && out.length) {
        let edge = null;
        for (let i = 0; i < out.length; i++) {
          const candidate = out[(st.rr + i) % out.length];
          const target = this.graph.nodes.get(candidate.to);
          if (this._canTake(target)) { edge = candidate; st.rr = (st.rr + i + 1) % out.length; break; }
        }
        if (!edge) break;
        const token = st.queue.shift();
        const target = this.graph.nodes.get(edge.to);
        if (target.kind === 'workers' || target.params.limit !== undefined) {
          this.states.get(target.id).reserved++;
          token.reservedAt = target.id;
        }
        this._launch(token, edge);
      }
    }

    if (this.time >= this.nextSample) {
      this.nextSample += 0.5;
      this.history.push({ t: this.time, waiting: this.waiting() });
      if (this.history.length > 240) this.history.shift();
      for (const st of this.states.values()) while (st.arrivals.length && st.arrivals[0] < this.time - 15) st.arrivals.shift();
      while (this.drops.length && this.drops[0].time < this.time - 10) this.drops.shift();
    }
  }

  waiting() {
    let n = 0;
    for (const st of this.states.values()) n += st.queue.length;
    return n;
  }

  _rate(st) { return st.arrivals.length / Math.max(3, Math.min(15, this.time)); }

  // The workers closest to their limit, with the work headed for them.
  bottleneck() {
    let worst = null;
    for (const node of this.graph.nodes.values()) {
      if (node.kind !== 'workers') continue;
      const count = node.params.workers ?? 1;
      const takes = node.params.takes ?? 1;
      let demand = this._rate(this.states.get(node.id));
      for (const edge of node.in) {
        const from = this.graph.nodes.get(edge.from);
        if (from?.kind === 'queue') demand += this._rate(this.states.get(from.id)) / (from.out.filter((e) => e.to).length || 1);
      }
      const capacity = count / takes;
      const load = capacity > 0 ? demand / capacity : Infinity;
      if (!worst || load > worst.load) worst = { id: node.id, name: node.name, count, takes, demand, capacity, load };
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
    const verdict = this.drops.length ? 'turning away'
      : (waiting >= 8 && slope > 0.2) || (overloaded && waiting >= 3) ? 'backing up'
        : waiting >= 8 && slope < -0.2 ? 'draining' : 'keeping up';
    const sinks = [...this.graph.nodes.values()].filter((n) => n.kind === 'sink').map((n) => ({ id: n.id, name: n.name, done: this.states.get(n.id).done }));
    const average = this.durations.length ? this.durations.reduce((a, b) => a + b, 0) / this.durations.length : 0;
    let dropped = 0;
    for (const st of this.states.values()) dropped += st.dropped;
    return { time: this.time, waiting, slope, verdict, finished: this.finished, average, sinks, dropped, bottleneck: b };
  }

  /** Everything that decides the future, for comparing two runs. */
  snapshot() {
    const nodes = {};
    for (const [id, st] of this.states) nodes[id] = { queue: st.queue.map((t) => t.id), busy: st.busy.map((b) => [b.token.id, +b.left.toFixed(6)]), done: st.done, dropped: st.dropped };
    return { time: +this.time.toFixed(6), moving: this.moving.map((t) => [t.id, +t.t.toFixed(6)]), nodes };
  }
}

// ---------------------------------------------------------------------------

export class StateSim {
  constructor(graph) {
    this.mode = 'states';
    this.reset(graph);
  }

  reset(graph) {
    this.graph = graph;
    this.time = 0;
    this.current = this._initial(graph);
    this.entered = 0;
    this.counts = new Map();
    this.moving = null;
    this.trail = this.current ? [graph.nodes.get(this.current).name] : [];
    this.note = '';
  }

  // An arrow from nowhere marks the start, as in a state diagram. Otherwise, the
  // first shape nothing points to, and then simply the first shape.
  _initial(graph) {
    for (const edge of graph.edges.values()) if (!edge.from && edge.to) return edge.to;
    const nodes = [...graph.nodes.values()];
    const linked = nodes.filter((n) => n.out.length || n.in.length);
    return (linked.find((n) => !n.in.length) ?? linked[0] ?? nodes[0])?.id ?? null;
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
  enabled(name) { return this.outgoing().some((e) => e.event === name && e.to); }

  fire(name) {
    if (this.moving) this._land();
    const edge = this.outgoing().find((e) => e.event === name && e.to);
    // Only the same event in a row counts towards `fail x3`.
    for (const e of this.outgoing()) if (e.event !== name) this.counts.delete(e.id);
    if (!edge) {
      this.note = `${this.nameOf(this.current)} ignores ${name}`;
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
  }

  /** How far a timed arrow has got, from 0 to 1. */
  progress(edge) {
    if (edge.after === undefined) return 0;
    return edge.after > 0 ? Math.min(1, (this.time - this.entered) / edge.after) : 1;
  }

  step(dt = STEP) {
    this.time += dt;
    if (this.moving) {
      this.moving.t += dt / this.moving.dur;
      if (this.moving.t >= 1) this._land();
      return;
    }
    for (const edge of this.outgoing()) {
      if (edge.after !== undefined && edge.to && this.time - this.entered >= edge.after) {
        this._leave(edge);
        break;
      }
    }
  }

  snapshot() {
    return { time: +this.time.toFixed(6), current: this.current, moving: this.moving?.edge ?? null, counts: Object.fromEntries(this.counts) };
  }
}
