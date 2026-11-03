// One line of data, and how it reaches the screen. This file has no DOM.
//
// Two rules keep a chart honest, and both live here:
// - A gap is a gap. Points further apart than `gapAfter` never join up, and a value that
//   is not a number breaks the line. A lone point between gaps is drawn as a dot.
// - Thinning keeps the extremes. When more than one point lands in a pixel column, that
//   column draws from its lowest to its highest value, so a one-sample spike survives at
//   any zoom. Nothing is averaged, smoothed or fitted.

export function lowerBound(t, n, value) {
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export class Series {
  constructor(name = '', labels = {}, cap = 20000) {
    this.name = name;
    this.labels = labels;
    this.cap = cap;
    this.t = new Float64Array(256);
    this.v = new Float64Array(256);
    this.n = 0;
    this.version = 0;
  }

  /** Drop everything at or after `from`, then append. Times must increase. */
  merge(times, values, from = times[0]) {
    this.n = lowerBound(this.t, this.n, from ?? Infinity);
    const need = this.n + times.length;
    if (need > this.t.length) {
      const size = Math.max(need, this.t.length * 2);
      const t = new Float64Array(size), v = new Float64Array(size);
      t.set(this.t.subarray(0, this.n));
      v.set(this.v.subarray(0, this.n));
      this.t = t;
      this.v = v;
    }
    for (let i = 0; i < times.length; i++) {
      const value = values[i];
      this.t[this.n] = times[i];
      this.v[this.n] = value === null || value === undefined ? NaN : value;
      this.n++;
    }
    if (this.n > this.cap) this.trim(this.t[this.n - this.cap]);
    this.version++;
  }

  /** Forget points before a time. */
  trim(before) {
    const cut = lowerBound(this.t, this.n, before);
    if (cut <= 0) return;
    this.t.copyWithin(0, cut, this.n);
    this.v.copyWithin(0, cut, this.n);
    this.n -= cut;
    this.version++;
  }

  /** The point in force at time `t`: the last one at or before it, if it is near enough. */
  at(t, gapAfter = Infinity) {
    const i = lowerBound(this.t, this.n, t + 1e-6) - 1;
    if (i < 0) return null;
    const value = this.v[i];
    if (!Number.isFinite(value) || t - this.t[i] > gapAfter) return null;
    return { t: this.t[i], v: value };
  }

  /** The newest point with a number in it. */
  latest() {
    for (let i = this.n - 1; i >= 0; i--) if (Number.isFinite(this.v[i])) return { t: this.t[i], v: this.v[i] };
    return null;
  }

  /** Lowest and highest values between two times, or null if there are none. */
  extent(t0, t1) {
    let lo = Infinity, hi = -Infinity;
    const start = lowerBound(this.t, this.n, t0);
    for (let i = start; i < this.n && this.t[i] <= t1; i++) {
      const v = this.v[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return lo === Infinity ? null : [lo, hi];
  }
}

/**
 * Walk a series through a sink with move(x, y), line(x, y) and dot(x, y). `X` and `Y` map
 * time and value to the plot, and `density` is pixels per unit of `X`.
 */
export function trace(series, t0, t1, { X, Y, density = 1, gapAfter = Infinity }, sink) {
  const { t, v, n } = series;
  if (!n) return;
  let i = lowerBound(t, n, t0);
  if (i > 0) i--;                       // One point before, so the line enters the plot.
  let end = lowerBound(t, n, t1 + 1e-6);
  if (end < n) end++;                   // And one after, so it leaves.

  let inRun = false, held = null, prevT = null;
  let col = null, count = 0, colX = 0, first = 0, last = 0, lo = 0, hi = 0, lowFirst = true;

  const put = (x, value) => {
    const y = Y(value);
    if (!inRun) { inRun = true; held = [x, y]; return; }
    if (held) { sink.move(held[0], held[1]); held = null; }
    sink.line(x, y);
  };
  const flush = () => {
    if (!count) return;
    if (count === 1 || lo === hi) put(colX, first);
    else {
      put(colX, first);
      put(colX, lowFirst ? lo : hi);
      put(colX, lowFirst ? hi : lo);
      put(colX, last);
    }
    count = 0;
    col = null;
  };
  const endRun = () => {
    flush();
    if (held) sink.dot(held[0], held[1]);
    held = null;
    inRun = false;
  };

  for (; i < end; i++) {
    const tt = t[i], value = v[i];
    if (!Number.isFinite(value)) { endRun(); prevT = null; continue; }
    if (prevT !== null && tt - prevT > gapAfter) endRun();
    prevT = tt;
    const x = X(tt);
    const c = Math.floor(x * density);
    if (c !== col) {
      flush();
      col = c;
      colX = x;
      first = lo = hi = value;
      lowFirst = true;
    } else {
      if (value < lo) { lo = value; lowFirst = false; }
      if (value > hi) { hi = value; lowFirst = true; }
    }
    last = value;
    count++;
  }
  endRun();
}

/** The stretches between t0 and t1 with no data, as [from, to] pairs. */
export function gaps(series, t0, t1, gapAfter) {
  const { t, v, n } = series;
  const out = [];
  let i = lowerBound(t, n, t0);
  if (i > 0) i--;
  let edge = null;                      // Where the last data stopped counting.
  for (; i < n && t[i] <= t1; i++) {
    if (!Number.isFinite(v[i])) continue;
    if (edge === null) { if (t[i] > t0) out.push([t0, t[i]]); } else if (t[i] - edge > gapAfter) out.push([edge, t[i]]);
    edge = t[i];
  }
  if (edge === null) return [[t0, t1]];
  if (t1 - edge > gapAfter) out.push([edge, t1]);
  return out;
}
