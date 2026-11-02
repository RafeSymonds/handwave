// The slide is the level. Each phone runs a figure with the platformer's physics.
// The slide's boxes and the presenter's ink are compiled into one level, so a line
// drawn across a gap is ground for everyone a tenth of a second later.
//
// All figures share one compiled level. Sim marks the segments it has gathered with
// a counter, so every Sim draws from one shared counter or they would skip each
// other's segments and fall through the floor.

import { compileLevel } from '../game-platformer/level.js';
import { Sim, STEP, R, CIRCLES } from '../game-platformer/sim.js';

const MAX_RACERS = 200;
const GONE_SECONDS = 12;       // How long a dropped phone's figure stays on screen. It reappears if the phone returns.
const REBUILD_SECONDS = 0.1;   // New ink becomes ground at most this often.
const BOTTOM = 300;            // Sim kills a figure 700 below the level. This puts that just under the slide.
const INK = '#000000';         // The level reads color as meaning. This color means solid.

const LEFT = 1, RIGHT = 2, JUMP = 4;
export const FLAG = { GROUNDED: 1, DEAD: 2, WON: 4, GONE: 8, LEFT: 16 };

const solid = (id, type, x, y, rest) => ({ id, type, x, y, strokeColor: INK, backgroundColor: 'transparent', ...rest });

/** Compile the slide's shapes as moved by the presenter, plus the presenter's ink. */
export function raceLevel(spec, offsets = {}, ink = []) {
  const shifted = (id) => offsets[id] ?? [0, 0];
  const elements = spec.ground.map((g) => {
    const [dx, dy] = shifted(g.id);
    return solid(g.id, 'rectangle', g.x + dx, g.y + dy, { width: g.width, height: g.height, roundness: { type: 3 } });
  });
  // Walls hold figures on the slide, just outside the first and last boxes so nobody
  // can drop down behind them.
  elements.push(solid('race-wall-l', 'line', 25, -1000, { points: [[0, 0], [0, 2000]] }));
  elements.push(solid('race-wall-r', 'line', 1575, -1000, { points: [[0, 0], [0, 2000]] }));
  const [gx, gy] = shifted(spec.goal.id);
  elements.push({ id: spec.goal.id, type: 'diamond', x: spec.goal.x + gx, y: spec.goal.y + gy, width: spec.goal.size, height: spec.goal.size, backgroundColor: '#d3f9d8', strokeColor: '#2b8a3e' });
  for (const stroke of ink) {
    if (stroke.pts.length < 2) continue;
    const [x0, y0] = stroke.pts[0];
    elements.push(solid(`ink-${stroke.id}`, 'freedraw', x0, y0, { points: stroke.pts.map(([x, y]) => [x - x0, y - y0]) }));
  }
  const level = compileLevel({ elements });
  level.extent.maxY = BOTTOM;
  return level;
}

export class Race {
  static tickHz = 60;
  static frameHz = 30;
  static youHz = 4;
  static logEverySeconds = 0.2;

  constructor(slide, host) {
    this.slide = slide;
    this.spec = slide.activity;
    this.host = host;
    this.racers = new Map();   // phone id -> racer. Kept when a phone drops, so it can return.
    this.nextNumber = 1;
    this.time = 0;
    this.lag = 0;
    this.stamp = 0;
    this.step = 0;
    this.startedAt = null;
    this.endedAt = null;
    this.done = [];            // [number, milliseconds] in the order they reached the flag
    this.level = this._compile();
    this.rebuildIn = 0;
    this.dirty = false;
    this.lastKey = '';
  }

  _compile() {
    const { offsets, ink } = this.host.state;
    return raceLevel(this.spec, offsets[this.slide.id] ?? {}, ink[this.slide.id] ?? []);
  }

  // Figures start spread along the first box, in an order that keeps neighbors apart.
  _spawnFor(number) {
    const { on, from, to } = this.spec.spawn;
    const box = this.spec.ground.find((g) => g.id === on);
    const [dx, dy] = this.host.state.offsets[this.slide.id]?.[on] ?? [0, 0];
    const share = (number * 0.618034) % 1;
    return { x: from + (to - from) * share + dx, y: box.y + dy - R };
  }

  _place(racer) {
    const sim = new Sim(this.level);
    sim.quiet = true;
    sim.spawn = this._spawnFor(racer.number);
    sim.player = sim._newPlayer(sim.spawn);
    racer.sim = sim;
  }

  join(id) {
    const known = this.racers.get(id);
    if (known) { known.goneAt = null; return; }
    if (this.racers.size >= MAX_RACERS) return;
    const racer = { id, number: this.nextNumber++, bits: 0, goneAt: null, sim: null };
    this._place(racer);
    this.racers.set(id, racer);
  }

  // A dropped phone must not keep running into the pit, so its figure stops where it is.
  leave(id) {
    const racer = this.racers.get(id);
    if (racer) { racer.goneAt = this.time; racer.bits = 0; }
  }

  input(id, msg) {
    const racer = this.racers.get(id);
    if (racer && Number.isInteger(msg.i) && msg.i >= 0 && msg.i <= 7) racer.bits = msg.i;
  }

  /** Step 0 warms up. Arriving at step 1 always starts a fresh race. The last step stops the clock. */
  setStep(step) {
    if (step === this.step) return;
    this.step = step;
    if (step === 0) this._reset();
    else if (step === 1) this._start();
    else if (this.startedAt === null) { this._start(); this.endedAt = this.time; }
    else this.endedAt = this.time;
  }

  _reset() {
    this.startedAt = null;
    this.endedAt = null;
    this.done = [];
    for (const racer of this.racers.values()) this._place(racer);
  }

  _start() {
    this._reset();
    this.startedAt = this.time;
  }

  layout() { this.dirty = true; }

  _rebuild() {
    this.level = this._compile();
    for (const racer of this.racers.values()) {
      const { sim } = racer;
      sim.level = this.level;
      sim.spawn = this._spawnFor(racer.number);
      // A shape dragged onto a figure would trap it inside the outline, so lift it onto the top.
      const p = sim.player;
      for (const body of this.level.closedSolids) {
        if (p.x <= body.minX || p.x >= body.maxX) continue;
        if (!CIRCLES.every((h) => p.y - h > body.minY && p.y - h < body.maxY)) continue;
        p.y = body.minY - R - 1;
        p.vy = 0;
        p.grounded = false;
        p.body = null;
      }
    }
  }

  tick(dt) {
    this.time += dt;
    this.rebuildIn -= dt;
    if (this.dirty && this.rebuildIn <= 0) {
      this.dirty = false;
      this.rebuildIn = REBUILD_SECONDS;
      this._rebuild();
    }
    this.lag = Math.min(this.lag + dt, 0.25);
    const steps = Math.floor(this.lag / STEP);
    this.lag -= steps * STEP;
    const racing = this.startedAt !== null && this.endedAt === null;
    for (const racer of this.racers.values()) {
      if (racer.goneAt !== null && this.time - racer.goneAt > GONE_SECONDS) continue;
      const { sim, bits } = racer;
      const input = { left: (bits & LEFT) !== 0, right: (bits & RIGHT) !== 0, jump: (bits & JUMP) !== 0, down: false };
      const wonBefore = sim.won;
      for (let k = 0; k < steps; k++) {
        sim._stamp = this.stamp;
        sim.step(input);
        this.stamp = sim._stamp;
      }
      if (sim.won && !wonBefore && racing) this.done.push([racer.number, Math.round((this.time - this.startedAt) * 1000)]);
    }
  }

  clock() {
    if (this.startedAt === null) return null;
    return Math.round(((this.endedAt ?? this.time) - this.startedAt) * 1000);
  }

  frame() {
    const racers = [];
    for (const racer of this.racers.values()) {
      if (racer.goneAt !== null && this.time - racer.goneAt > GONE_SECONDS) continue;
      const p = racer.sim.player;
      const flags = (p.grounded ? FLAG.GROUNDED : 0) | (p.dead ? FLAG.DEAD : 0) | (racer.sim.won ? FLAG.WON : 0) | (racer.goneAt !== null ? FLAG.GONE : 0) | (p.face < 0 ? FLAG.LEFT : 0);
      racers.push([racer.number, Math.round(p.x), Math.round(p.y), Math.round(p.vx), Math.round(p.vy), Math.round(p.gs), Math.round(p.nx * 100), flags]);
    }
    const clock = this.clock();
    // Figures standing still send nothing. The clock's seconds still tick.
    const key = JSON.stringify([racers, this.done.length, this.step, clock === null ? null : Math.floor(clock / 1000)]);
    if (key === this.lastKey) return null;
    this.lastKey = key;
    return { at: Math.round(this.time * 1000), step: this.step, clock, racers, done: this.done.slice(0, 200) };
  }

  you(id) {
    const racer = this.racers.get(id);
    if (!racer) return { full: this.racers.size >= MAX_RACERS };
    const place = this.done.findIndex(([n]) => n === racer.number);
    return {
      number: racer.number,
      step: this.step,
      out: racer.sim.player.dead,
      place: place < 0 ? null : place + 1,
      ms: place < 0 ? null : this.done[place][1],
      finished: this.done.length,
      won: racer.sim.won,
    };
  }
}
