// How a number or a time is written. This file has no DOM, so the tests read a value
// back through the same rules the page drew it with.

const pad2 = (n) => String(n).padStart(2, '0');
const sig3 = (v) => String(+v.toPrecision(3));

export function fmtNumber(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return `${sig3(v / 1e9)}G`;
  if (a >= 1e6) return `${sig3(v / 1e6)}M`;
  if (a >= 1e4) return `${sig3(v / 1e3)}K`;
  if (a >= 1000) return Math.round(v).toLocaleString('en-US');
  if (Number.isInteger(v)) return String(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a === 0) return '0';
  if (a >= 0.001) return String(+v.toPrecision(2));
  return v.toExponential(1);
}

// Units that change scale as the number grows. Prefixes are decimal: 1 GB is 1e9 bytes.
const SCALES = {
  bytes: [[1e12, 'TB'], [1e9, 'GB'], [1e6, 'MB'], [1e3, 'KB'], [1, 'B']],
  'bytes/s': [[1e12, 'TB/s'], [1e9, 'GB/s'], [1e6, 'MB/s'], [1e3, 'KB/s'], [1, 'B/s']],
  ms: [[1000, 's'], [1, 'ms']],
  s: [[1, 's'], [0.001, 'ms']],
};

function scaleFor(a, unit) {
  const scale = SCALES[unit];
  if (!scale) return [1, unit];
  for (const row of scale) if (a >= row[0]) return row;
  return scale[scale.length - 1];
}

/** A value as {text, unit}. Words a page draws should come from here. */
export function fmtValue(v, unit = '') {
  const [factor, shown] = scaleFor(Math.abs(v), unit);
  return { text: fmtNumber(v / factor), unit: shown };
}

export const showValue = (v, unit = '') => {
  const f = fmtValue(v, unit);
  return f.unit ? (f.unit === '%' ? `${f.text}%` : `${f.text} ${f.unit}`) : f.text;
};

/** A level someone wrote in a label: exactly as written, with its unit. 85 is 85, not 85.0. */
export const showLevel = (v, unit = '') => {
  const [factor, shown] = scaleFor(Math.abs(v), unit);
  const n = +(v / factor).toPrecision(6);
  return shown === '%' ? `${n}%` : shown ? `${n} ${shown}` : String(n);
};

/** Round axis numbers from low to high, on steps of 1, 2 or 5 times a power of ten. */
export function niceScale(low, high, count = 4) {
  if (!Number.isFinite(low) || !Number.isFinite(high)) return { min: 0, max: 1, step: 0.25, ticks: [0, 0.25, 0.5, 0.75, 1] };
  if (low === high) { const pad = Math.abs(low) * 0.1 || 1; low -= pad; high += pad; }
  const rough = (high - low) / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough * 0.999) ?? 10 * power;
  const min = Math.floor(low / step + 1e-9) * step;
  const max = Math.ceil(high / step - 1e-9) * step;
  const ticks = [];
  for (let i = 0, n = Math.round((max - min) / step); i <= n; i++) ticks.push(+(min + i * step).toPrecision(12));
  return { min, max, step, ticks };
}

/** Labels for axis ticks: one scale and one number of decimals per axis. */
export function axisLabels(ticks, unit = '') {
  const biggest = Math.max(...ticks.map(Math.abs), 0);
  const [factor, shown] = scaleFor(biggest, unit);
  const step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) / factor : 1;
  const compact = biggest / factor >= 10000;
  // Enough decimals to write the step exactly: a step of 2.5 needs one, so 2.5 is never "3".
  let decimals = 0;
  while (!compact && decimals < 6 && Math.abs(step * 10 ** decimals - Math.round(step * 10 ** decimals)) > 1e-6) decimals++;
  const one = (v) => {
    const n = v / factor;
    if (compact) return `${+(n / 1000).toPrecision(3)}K`;
    return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  };
  return { labels: ticks.map(one), unit: shown };
}

// ---------------------------------------------------------------------------
// Time. Everything is seconds since the epoch, shown in this browser's time zone.

export const clock = (t, seconds = true) => {
  const d = new Date(t * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}${seconds ? `:${pad2(d.getSeconds())}` : ''}`;
};

export const dayClock = (t, seconds = true) => {
  const d = new Date(t * 1000);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${clock(t, seconds)}`;
};

/** A time on a range this long. A day or more needs the date to say which one. */
export const whenIn = (t, span, seconds = true) => (span >= 86400 ? dayClock(t, false) : clock(t, seconds));

/** A length of time in the fewest words that are still exact enough: 45s, 2m 13s, 12m, 1h 4m. */
export function fmtAgo(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 259200, 432000, 604800, 864000];

/** Ticks on round clock times, no more than `most` of them. */
export function timeTicks(t0, t1, most = 6) {
  const span = t1 - t0;
  const step = TIME_STEPS.find((s) => span / s <= most) ?? span / most;
  // Days are counted on the calendar, so a tick stays on midnight when the clocks change.
  if (step >= 86400) {
    const days = Math.max(1, Math.round(step / 86400));
    const d = new Date(t0 * 1000);
    d.setHours(0, 0, 0, 0);
    if (d.getTime() / 1000 < t0) d.setDate(d.getDate() + 1);
    const ticks = [];
    for (; d.getTime() / 1000 <= t1 + 1e-6; d.setDate(d.getDate() + days)) ticks.push({ t: d.getTime() / 1000, label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) });
    return { step, ticks };
  }
  const offset = new Date(t0 * 1000).getTimezoneOffset() * 60;
  const first = Math.ceil((t0 - offset) / step) * step + offset;
  const ticks = [];
  for (let t = first; t <= t1 + 1e-6; t += step) ticks.push(t);
  const withDay = span > 86400;
  const label = (t) => (withDay ? dayClock(t, false) : clock(t, step < 60));
  return { step, ticks: ticks.map((t) => ({ t, label: label(t) })) };
}

const FETCH_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

/** How far apart to ask for points, on steps that stay aligned from one fetch to the next. */
export const stepFor = (span, smallest = 1) => {
  const want = Math.max(span / 4000, smallest);
  return FETCH_STEPS.find((s) => s >= want) ?? want;
};
