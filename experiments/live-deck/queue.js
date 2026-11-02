// The audience is the system. Each phone is a worker. Jobs arrive at a share of what
// the room could finish, and each job needs one tap. A worker who stops tapping loses
// their job back to the line, so the line grows exactly when people stop.

const PER_WORKER = 0.6;        // What one attentive person can finish per second. 100% load is this, times the phones connected.
const REST_SECONDS = 1.2;      // A worker's shortest time per job. With a tap's reaction time, that gives about PER_WORKER.
const STALL_SECONDS = 5;       // A job held this long goes back to the front of the line.
const MAX_LINE = 400;          // Past this, arriving jobs are turned away and counted.
const MAX_WORKERS = 200;
const MAX_HISTORY = 300;       // One point a second.
const GONE_SECONDS = 12;       // How long a dropped phone's desk stays on screen. It reappears if the phone returns.

// A small repeatable random source, so a test of the model can assert exact behavior.
function randomFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class QueueModel {
  constructor({ seed = 1 } = {}) {
    this.random = randomFrom(seed);
    this.now = 0;
    this.load = 0.5;
    this.line = [];          // Jobs waiting, oldest first: {id, at}
    this.workers = new Map();
    this.nextJob = 1;
    this.nextWorker = 1;
    this.untilNext = 0;
    this.arrived = 0;
    this.finished = 0;
    this.turnedAway = 0;
    this.returned = 0;
    this.history = [];
    this.nextSample = 0;
    this.marks = [];
  }

  join(id) {
    const known = this.workers.get(id);
    if (known) { known.gone = false; known.stalled = false; known.heldSince = this.now; return known; }
    if (this.workers.size >= MAX_WORKERS) return null;
    const worker = { id, number: this.nextWorker++, job: null, heldSince: 0, restUntil: 0, stalled: false, gone: false, finished: 0 };
    this.workers.set(id, worker);
    return worker;
  }

  // The job a dropped phone was holding goes back to the front of the line.
  leave(id) {
    const worker = this.workers.get(id);
    if (!worker) return;
    this._giveBack(worker);
    worker.gone = true;
    worker.goneAt = this.now;
  }

  _giveBack(worker) {
    if (!worker.job) return;
    this.line.unshift(worker.job);
    worker.job = null;
    this.returned++;
  }

  connected() {
    let n = 0;
    for (const w of this.workers.values()) if (!w.gone) n++;
    return n;
  }

  /** Jobs a second arriving now. It follows who is connected, not who is tapping. */
  rate() { return this.load * PER_WORKER * this.connected(); }

  setLoad(load, label) {
    this.load = load;
    this.marks.push({ at: this.now, label });
    if (this.marks.length > 40) this.marks.shift();
  }

  /** A tap names the job, so a late tap cannot finish the next one by accident. */
  tap(id, job) {
    const worker = this.workers.get(id);
    if (!worker || worker.gone) return false;
    worker.stalled = false;
    if (!worker.job || worker.job.id !== job) return false;
    this.finished++;
    worker.finished++;
    worker.job = null;
    worker.restUntil = this.now + REST_SECONDS;
    return true;
  }

  /** A tap with no job clears a worker's stopped state. */
  wake(id) {
    const worker = this.workers.get(id);
    if (worker) worker.stalled = false;
  }

  advance(dt) {
    this.now += dt;
    this.untilNext -= dt;
    const rate = this.rate();
    // Exponential gaps between arrivals, which is what makes 90% lumpy instead of smooth.
    while (rate > 0 && this.untilNext <= 0) {
      this.untilNext += -Math.log(1 - this.random()) / rate;
      this.arrived++;
      if (this.line.length >= MAX_LINE) this.turnedAway++;
      else this.line.push({ id: this.nextJob++, at: this.now });
    }
    if (rate <= 0) this.untilNext = 0;

    const ready = [];
    for (const w of this.workers.values()) {
      if (w.gone) continue;
      if (w.job && this.now - w.heldSince >= STALL_SECONDS) {
        this._giveBack(w);
        w.stalled = true;
      }
      if (!w.job && !w.stalled && this.now >= w.restUntil) ready.push(w);
    }
    // Whoever has rested longest goes first, so nobody starves.
    ready.sort((a, b) => a.restUntil - b.restUntil || a.number - b.number);
    for (const w of ready) {
      if (!this.line.length) break;
      w.job = this.line.shift();
      w.heldSince = this.now;
    }

    if (this.now >= this.nextSample) {
      this.nextSample = this.now + 1;
      this.history.push([Math.round(this.now), this.line.length]);
      if (this.history.length > MAX_HISTORY) this.history.shift();
    }
  }

  /** How long the job at the front of the line has waited. Finished jobs would hide a growing wait. */
  oldestWait() {
    return this.line.length ? this.now - this.line[0].at : 0;
  }

  held() {
    let n = 0;
    for (const w of this.workers.values()) if (w.job) n++;
    return n;
  }
}

export class QueueActivity {
  static tickHz = 20;
  static frameHz = 10;
  static youHz = 5;
  static logEverySeconds = 0.5;

  constructor(slide, host) {
    this.slide = slide;
    this.host = host;
    this.model = new QueueModel();
    this.step = -1;
    this.lastKey = '';
    this.setStep(0);
  }

  join(id) { this.model.join(id); }
  leave(id) { this.model.leave(id); }

  input(id, msg) {
    if (msg.job === 0) this.model.wake(id);
    else if (Number.isInteger(msg.job)) this.model.tap(id, msg.job);
  }

  setStep(step) {
    if (step === this.step) return;
    this.step = step;
    const { load, label } = this.slide.activity.loads[step];
    this.model.setLoad(load, label);
  }

  tick(dt) { this.model.advance(dt); }

  frame() {
    const m = this.model;
    const workers = [...m.workers.values()].filter((w) => !w.gone || m.now - w.goneAt < GONE_SECONDS).map((w) => [w.number, w.job?.id ?? 0, w.gone ? 3 : w.stalled ? 2 : w.job ? 1 : 0]);
    const line = m.line.slice(0, 240).map((j) => j.id);
    const key = JSON.stringify([workers, line, m.finished, m.turnedAway, m.line.length, m.history.length, this.step]);
    if (key === this.lastKey) return null;
    this.lastKey = key;
    return {
      at: Math.round(m.now * 1000), step: this.step, load: m.load, waiting: m.line.length, line, workers,
      arrived: m.arrived, finished: m.finished, turnedAway: m.turnedAway, oldest: Math.round(m.oldestWait()),
      history: m.history, marks: m.marks.map((k) => [Math.round(k.at), k.label]),
    };
  }

  you(id) {
    const m = this.model;
    const w = m.workers.get(id);
    if (!w) return { full: true };
    return { number: w.number, job: w.job?.id ?? 0, stalled: w.stalled, resting: !w.job && m.now < w.restUntil, finished: w.finished, waiting: m.line.length, step: this.step };
  }
}
