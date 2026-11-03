// Draws the data on top of the drawing, in a stage layer. The stage draws the hand-drawn
// frames and titles. Everything here is exact: numbers in a plain font and lines through
// the values themselves, with no rough.js, no smoothing and no element per point.
//
// Sizes are CSS pixels, multiplied by `u` (stage units per CSS pixel), so words stay
// readable at any zoom and a small panel drops detail instead of shrinking it.

import { LEVELS, worse } from './alerts.js';
import { axisLabels, clock, fmtAgo, fmtValue, niceScale, showLevel, showValue, timeTicks } from './format.js';
import { nameOf, worstOfEach } from './data.js';
import { gaps, trace } from './series.js';

const SANS = 'Nunito, system-ui, sans-serif';

// The tokens: chart colors from the data-viz reference palette, validated against both
// surfaces, and status colors from lib/draw.js. The lib palette's four hues fail the
// colorblind check as series colors (rose and green are 3.2 apart), so they are kept for
// state, which always has a word and an icon as well.
export const THEMES = {
  light: {
    name: 'light', surface: '#ffffff', ink: '#1B2547', text2: '#52514e', muted: '#6d6a62', grid: '#e9e8e2', axis: '#c3c2b7', gapFill: 'rgba(122,119,110,0.10)',
    series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'], other: '#b5b3aa',
    ok: '#2b8a3e', okFill: '#d3f9d8', warn: '#a35200', warnFill: '#fff3bf', critical: '#c92a2a', criticalFill: '#ffe3e3', quiet: '#343a40', quietFill: '#f1f3f5', select: '#1864ab', selectFill: '#d0ebff',
  },
  dark: {
    name: 'dark', surface: '#1a1a19', ink: '#f0efec', text2: '#c3c2b7', muted: '#a8a69e', grid: '#2c2c2a', axis: '#4a4a46', gapFill: 'rgba(195,194,183,0.10)',
    series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'], other: '#6b6a64',
    ok: '#69db7c', okFill: '#14301b', warn: '#ffd43b', warnFill: '#3a2e06', critical: '#ff8787', criticalFill: '#431a1a', quiet: '#ced4da', quietFill: '#2a2a28', select: '#74c0fc', selectFill: '#14324a',
  },
};

export const levelColor = (T, level) => ({ ok: T.ok, pending: T.warn, warn: T.warn, critical: T.critical, nodata: T.quiet, failed: T.critical, none: T.ink }[level]);
export const levelFill = (T, level) => ({ ok: T.okFill, pending: null, warn: T.warnFill, critical: T.criticalFill, nodata: T.quietFill, failed: T.quietFill, none: null }[level]);

// A rule's level as a strip along a chart.
const STRIP_ORDER = ['nodata', 'pending', 'warn', 'critical'];

/** The part of a shape that text and charts can use. */
export function innerRect(el, u) {
  const pad = 12 * u;
  if (el.type === 'ellipse') {
    const w = el.width * 0.72, h = el.height * 0.72;
    return { x: el.x + (el.width - w) / 2, y: el.y + (el.height - h) / 2, w, h };
  }
  if (el.type === 'diamond') {
    const w = el.width * 0.52, h = el.height * 0.52;
    return { x: el.x + (el.width - w) / 2, y: el.y + (el.height - h) / 2, w, h };
  }
  return { x: el.x + pad, y: el.y + 8 * u, w: Math.max(0, el.width - pad * 2), h: Math.max(0, el.height - 8 * u - 8 * u) };
}

// The top row of a panel. The title comes first, because it says what you are looking at, so
// the status gives way to it: a meter or a stat moves its status to the row of its number, and
// anything else keeps the icon and says the word beside its reason. A number beside a chart's
// title moves below it, judged by the widest status it could ever show, so an alert firing
// does not rearrange the chart. A title that still doesn't fit gets smaller, down to a size you
// can read, and only one too long even then is ever cut.
const headerMetrics = document.createElement('canvas').getContext('2d');
const widthIn = (words, font) => { headerMetrics.font = font; return headerMetrics.measureText(words).width; };
const badgeWidth = (level, u) => (LEVELS[level]?.word ? widthIn(LEVELS[level].word, `bold ${12 * u}px ${SANS}`) + 19.2 * u : 0);

const TITLE_SIZE = 18, SMALLEST_TITLE = 14;

// Below this much height (CSS pixels, inside the frame) a panel can't draw its usual layout.
const FULL_HEIGHT = { chart: 80, stat: 52, meter: 66, table: 44, box: 44, alerts: 0, plain: 0 };

/** Too small to hold a title at all: it shows its state and its number. */
export const tooSmall = (panel, u) => { const r = innerRect(panel.el, u); return r.w / u < 110 || r.h / u < 26; };
/** Room for a title and one number, and nothing else. */
const isShort = (panel, u) => innerRect(panel.el, u).h / u < (FULL_HEIGHT[panel.kind] ?? 0);
/** So short that the number has to sit beside the title. */
const isVeryShort = (panel, u) => isShort(panel, u) && innerRect(panel.el, u).h / u < 44;

function sizeTitle(plan) {
  if (plan.title > plan.room && plan.room > 0) {
    plan.size = Math.max(SMALLEST_TITLE, Math.floor(((TITLE_SIZE * plan.room) / plan.title) * 2) / 2);
    plan.title = (plan.title * plan.size) / TITLE_SIZE;
  }
  return plan;
}

export function headerPlan(panel, u) {
  const inner = innerRect(panel.el, u);
  const r = { ...inner, w: inner.w - (isVeryShort(panel, u) ? 60 * u : 0) };
  const status = panel.status ?? { level: 'none', why: '' };
  const title = widthIn(panel.title ?? '', `${TITLE_SIZE * u}px Excalifont`);
  const gap = 8 * u, iconW = 16 * u;
  const full = badgeWidth(status.level, u);
  const plan = { room: r.w, compact: false, below: false, valueBelow: false, title, size: TITLE_SIZE };
  if (panel.kind === 'chart' && !isShort(panel, u)) {
    const inHeader = (panel.lineCount ?? panel.bindings.length) <= 1;
    const worst = Math.max(badgeWidth('nodata', u), badgeWidth('failed', u), ...panel.bindings.flatMap((b) => b.rules.map((rule) => badgeWidth(rule.level, u))));
    const valueW = 92 * u;
    plan.valueBelow = inHeader && (r.w / u < 240 || title + valueW + worst + gap * 2 > r.w);
    const beside = inHeader && !plan.valueBelow ? valueW + gap : 0;
    plan.compact = !!full && title + beside + full + gap > r.w;
    plan.room = r.w - beside - (!full ? 0 : plan.compact ? iconW + gap : full + gap);
    return sizeTitle(plan);
  }
  if (!full) return sizeTitle(plan);
  if (title + full + gap <= r.w) { plan.room = r.w - full - gap; return plan; }
  const hasNumberRow = status.level !== 'nodata' && status.level !== 'failed' && !status.why?.startsWith('waiting');
  if ((panel.kind === 'stat' || panel.kind === 'meter') && hasNumberRow && !isShort(panel, u)) { plan.below = true; return sizeTitle(plan); }
  plan.compact = true;
  plan.room = r.w - iconW - gap;
  return sizeTitle(plan);
}

// When the status shows only its icon, the sentence beside it carries the word.
const withWord = (plan, status) => (plan.compact && LEVELS[status.level]?.word && status.why ? `${LEVELS[status.level].word}: ${status.why}` : status.why);

export function createPainter(m) {
  let ctx, T, u;
  const cache = new Map();
  const sparks = new Map();
  const ranks = new Map();
  let readouts = new Map();
  let reading = null;

  // ---------------------------------------------------------------- small pieces

  function setFont(size, weight = '') {
    ctx.font = `${weight ? `${weight} ` : ''}${size * u}px ${SANS}`;
  }

  function label(words, x, y, { size = 12, color = T.ink, align = 'left', base = 'alphabetic', weight = '', keep = true } = {}) {
    setFont(size, weight);
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = base;
    ctx.fillText(words, x, y);
    if (keep && reading) reading.push(words);
    return ctx.measureText(words).width;
  }

  function fit(words, width, size, weight = '') {
    setFont(size, weight);
    if (ctx.measureText(words).width <= width) return words;
    let lo = 0, hi = words.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(`${words.slice(0, mid)}...`).width <= width) lo = mid; else hi = mid - 1;
    }
    return lo ? `${words.slice(0, lo)}...` : '';
  }

  function wrap(words, width, size, most = 3) {
    setFont(size);
    const lines = [];
    let line = '';
    for (const word of words.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= width || !line) line = next;
      else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
    if (lines.length > most) {
      const kept = lines.slice(0, most);
      kept[most - 1] = fit(lines.slice(most - 1).join(' '), width, size);
      return kept;
    }
    return lines.map((l) => fit(l, width, size));
  }

  /** The icon that goes with a level. A shape on its own says what the color says. */
  function icon(name, x, y, size, color) {
    const s = size * u;
    ctx.save();
    ctx.translate(x, y);
    ctx.lineWidth = Math.max(1.5 * u, s * 0.14);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    if (name === 'check') {
      ctx.moveTo(-s * 0.42, s * 0.02); ctx.lineTo(-s * 0.12, s * 0.34); ctx.lineTo(s * 0.44, -s * 0.34);
      ctx.stroke();
    } else if (name === 'triangle') {
      ctx.moveTo(0, -s * 0.46); ctx.lineTo(s * 0.5, s * 0.42); ctx.lineTo(-s * 0.5, s * 0.42); ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = T.surface;
      ctx.lineWidth = s * 0.12;
      ctx.beginPath(); ctx.moveTo(0, -s * 0.12); ctx.lineTo(0, s * 0.14); ctx.moveTo(0, s * 0.29); ctx.lineTo(0, s * 0.3); ctx.stroke();
    } else if (name === 'octagon') {
      const a = s * 0.5, b = s * 0.21;
      ctx.moveTo(-b, -a); ctx.lineTo(b, -a); ctx.lineTo(a, -b); ctx.lineTo(a, b); ctx.lineTo(b, a); ctx.lineTo(-b, a); ctx.lineTo(-a, b); ctx.lineTo(-a, -b); ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = T.surface;
      ctx.lineWidth = s * 0.13;
      ctx.beginPath(); ctx.moveTo(0, -s * 0.24); ctx.lineTo(0, s * 0.08); ctx.moveTo(0, s * 0.27); ctx.lineTo(0, s * 0.28); ctx.stroke();
    } else if (name === 'question') {
      ctx.arc(0, 0, s * 0.46, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = s * 0.12;
      ctx.beginPath(); ctx.arc(0, -s * 0.09, s * 0.15, Math.PI, Math.PI * 2.5); ctx.lineTo(0, s * 0.12); ctx.moveTo(0, s * 0.27); ctx.lineTo(0, s * 0.28); ctx.stroke();
    } else if (name === 'cross') {
      ctx.moveTo(-s * 0.36, -s * 0.36); ctx.lineTo(s * 0.36, s * 0.36); ctx.moveTo(s * 0.36, -s * 0.36); ctx.lineTo(-s * 0.36, s * 0.36);
      ctx.stroke();
    } else if (name === 'clock') {
      ctx.arc(0, 0, s * 0.46, 0, Math.PI * 2); ctx.moveTo(0, -s * 0.26); ctx.lineTo(0, 0); ctx.lineTo(s * 0.2, s * 0.12);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** An icon and a word, ending at x. Returns how wide it was. */
  function badge(level, x, y, size = 12, compact = false) {
    const info = LEVELS[level];
    if (!info.word) return 0;
    const color = levelColor(T, level);
    if (compact) { icon(info.icon, x - 7 * u, y, size + 3, color); return 16 * u; }
    const width = label(info.word, x, y, { size, color, align: 'right', base: 'middle', weight: 'bold' });
    icon(info.icon, x - width - (size * 0.8) * u, y, size + 2, color);
    return width + (size * 1.6) * u;
  }

  function sentence(words, x, y, width, level, { size = 12, most = 2 } = {}) {
    const color = levelColor(T, level);
    const lines = wrap(words, width, size, most);
    lines.forEach((line, i) => label(line, x, y + i * (size * 1.25) * u, { size, color, base: 'top' }));
    return lines.length * (size * 1.25) * u;
  }

  // ---------------------------------------------------------------- a box

  function paintBox(panel, status, at) {
    const r = innerRect(panel.el, u);
    const head = 30 * u;
    const plan = headerPlan(panel, u);
    if (status.level !== 'none') badge(status.level, r.x + r.w, r.y + 14 * u, 12, plan.compact);
    const quiet = ['warn', 'critical', 'nodata', 'failed', 'pending'].includes(status.level);
    const rowH = 23 * u;
    // The numbers come first, and the reason gets a second line only if they all still fit.
    const spare = r.h - head - panel.bindings.length * rowH;
    const whyH = !quiet ? 0 : spare >= 33 * u ? 32 * u : spare >= 17 * u ? 17 * u : 0;
    const space = r.h - head - whyH;
    const room = Math.max(1, Math.floor(space / rowH));
    const fits = panel.bindings.length > room ? Math.max(1, room - 1) : room;
    const shown = panel.bindings.slice(0, fits);
    shown.forEach((b, i) => {
      const read = m.data.readBinding(b, at, panel.kind);
      const y = r.y + head + rowH * (i + 0.5);
      label(fit(b.name, r.w * 0.5, 13), r.x, y, { size: 13, color: T.text2, base: 'middle' });
      valueAt(read, b, r.x + r.w, y, r.w * 0.5, at);
    });
    if (panel.bindings.length > fits) label(`and ${panel.bindings.length - fits} more: click to see`, r.x, r.y + head + rowH * (fits + 0.5), { size: 12, color: T.muted, base: 'middle' });
    if (whyH && status.why) sentence(withWord(plan, status), r.x, r.y + r.h - whyH, r.w, status.level, { most: whyH > 20 * u ? 2 : 1 });
    // Room left over shows which way the first number is going.
    const rowsEnd = head + rowH * (fits + (panel.bindings.length > fits ? 1 : 0));
    const free = r.h - rowsEnd - whyH;
    const first = panel.bindings[0];
    if (free >= 30 * u && first && status.level !== 'failed' && status.level !== 'nodata') paintSpark(first, r.x, r.y + rowsEnd + 4 * u, r.w, free - 8 * u, panel);
  }

  // A number at the right of a row, or what stands in for one.
  function valueAt(read, binding, right, y, width, at, size = 18) {
    const row = read.rows[0];
    if (read.waiting && !read.rows.length) { label('waiting...', right, y, { size: 13, color: T.muted, align: 'right', base: 'middle' }); return; }
    if (!row || row.value === null || row.stale) {
      const words = read.failed ? 'failed' : at !== null ? 'no data then' : row?.t ? `no data for ${fmtAgo(row.age)}` : 'no data';
      label(fit(words, width, 13), right, y, { size: 13, color: T.quiet, align: 'right', base: 'middle' });
      return;
    }
    const f = fmtValue(row.value, binding.unit);
    const unitW = f.unit ? label(f.unit, right, y + 1 * u, { size: 12, color: T.muted, align: 'right', base: 'middle' }) + 3 * u : 0;
    label(f.text, right - unitW, y, { size, color: T.ink, align: 'right', base: 'middle', weight: 'bold' });
    if (read.rows.length > 1) {
      setFont(size, 'bold');
      const w = ctx.measureText(f.text).width;
      label(`+${read.rows.length - 1}`, right - unitW - w - 4 * u, y, { size: 11, color: T.muted, align: 'right', base: 'middle' });
    }
  }

  // ---------------------------------------------------------------- a chart

  // Colors and legend places go to the largest series in the range, whatever order the source
  // listed them in. A series keeps its color for as long as it holds a place, and a place only
  // changes hands when the newcomer is clearly bigger, so nothing flickers as values wander or
  // the range changes. Only the first look ranks strictly.
  const CLEARLY_BIGGER = 1.25;

  function rankLines(panel, lines, t0, t1) {
    const held = ranks.get(panel.id) ?? { order: [], slots: new Map(), seen: new Map() };
    // Scores compare within a unit, since req/s and % can't be compared with each other.
    const peaks = new Map(), biggest = new Map();
    for (const line of lines) {
      const e = line.series.extent(t0, t1);
      const peak = e ? Math.max(Math.abs(e[0]), Math.abs(e[1])) : 0;
      peaks.set(line.key, { peak, unit: line.unit });
      biggest.set(line.unit, Math.max(biggest.get(line.unit) ?? 0, peak));
    }
    const score = (key) => { const p = peaks.get(key); return p.peak / (biggest.get(p.unit) || 1); };
    const margin = held.order.length ? CLEARLY_BIGGER : 1;
    const order = held.order.filter((key) => peaks.has(key));
    const known = new Set(order);
    for (const line of lines) if (!known.has(line.key)) order.push(line.key);
    for (let i = 1; i < order.length; i++) {
      for (let j = i; j > 0 && score(order[j]) > score(order[j - 1]) * margin; j--) [order[j], order[j - 1]] = [order[j - 1], order[j]];
    }
    // With more series than colors, a series that is zero for the whole range has not earned one.
    // It would only lose it again the moment a real one woke up.
    const earning = lines.length > T.series.length ? order.filter((key) => peaks.get(key).peak > 0) : order;
    const places = (earning.length ? earning : order).slice(0, T.series.length);
    const slots = new Map();
    const taken = new Set();
    const give = (key, slot) => { slots.set(key, slot); taken.add(slot); held.seen.set(key, slot); };
    for (const key of places) if (held.slots.has(key)) give(key, held.slots.get(key));
    for (const key of places) if (!slots.has(key) && held.seen.has(key) && !taken.has(held.seen.get(key))) give(key, held.seen.get(key));
    for (const key of places) {
      if (slots.has(key)) continue;
      let slot = 0;
      while (taken.has(slot)) slot++;
      give(key, slot);
    }
    ranks.set(panel.id, { order, slots, seen: held.seen });
    return { order, slots };
  }

  function collect(panel, t0, t1) {
    const lines = [];
    panel.bindings.forEach((binding) => {
      for (const row of m.data.seriesOf(binding, panel.kind)) lines.push({ ...row, binding, unit: binding.unit, key: `${binding.id}|${row.id}` });
    });
    const { order, slots } = rankLines(panel, lines, t0, t1);
    const byKey = new Map(lines.map((line) => [line.key, line]));
    const ranked = order.map((key) => byKey.get(key));
    ranked.forEach((line, i) => {
      const slot = slots.get(line.key);
      line.color = slot === undefined ? T.other : T.series[slot];
      line.index = i;
      line.other = slot === undefined;
    });
    return ranked;
  }

  // One unit, one axis. Different units get a strip each, never a second axis.
  function stripsOf(lines, panel) {
    const units = [...new Set((lines.length ? lines : panel.bindings).map((l) => l.unit ?? l.binding?.unit ?? ''))];
    return (units.length ? units : ['']).map((unit) => ({ unit, lines: lines.filter((l) => l.unit === unit) }));
  }

  function buildChart(panel, t0, t1, density) {
    const el = panel.el;
    const r = innerRect(el, u);
    const lines = collect(panel, t0, t1);
    panel.lineCount = lines.length;
    const strips = stripsOf(lines, panel);
    const head = 32 * u;
    const manySeries = lines.length > 1;
    const narrow = r.w / u < 240;
    // A chart's number gets a row of its own when its title needs the room.
    const { valueBelow } = headerPlan(panel, u);
    const legendH = manySeries || valueBelow ? 20 * u : 0;
    const axisW = narrow ? 34 * u : 44 * u;
    const bottom = r.h - head - legendH > 120 * u ? 20 * u : 0;
    const plotX = r.x + axisW, plotW = Math.max(10 * u, r.w - axisW - 4 * u);
    const top = r.y + head + legendH;
    const total = Math.max(20 * u, r.h - head - legendH - bottom);
    const gapY = strips.length > 1 ? 18 * u : 14 * u;
    const stripH = (total - gapY * strips.length) / strips.length;

    const X = (t) => plotX + ((t - t0) / (t1 - t0)) * plotW;
    const built = {
      r, lines, head, legendH, valueBelow, plotX, plotW, plotBottom: top + total, X, t0, t1, bottom, strips: [],
      ticks: timeTicks(t0, t1, Math.max(2, Math.floor(plotW / u / 62))).ticks,
    };

    strips.forEach((strip, index) => {
      const y = top + (stripH + gapY) * index + gapY;
      let lo = Infinity, hi = -Infinity;
      for (const line of strip.lines) {
        const e = line.series.extent(t0, t1);
        if (e) { lo = Math.min(lo, e[0]); hi = Math.max(hi, e[1]); }
      }
      const rules = panel.bindings.filter((b) => b.unit === strip.unit).flatMap((b) => b.rules);
      const fixed = panel.axis ?? (panel.bindings.find((b) => b.unit === strip.unit)?.axis ?? null);
      const offScale = [];
      if (hi !== -Infinity && !fixed) {
        for (const rule of rules) {
          if (rule.value > hi && rule.value <= hi * 2) hi = rule.value;
          else if (rule.value < lo && rule.value >= lo / 2) lo = rule.value;
        }
        if (lo > 0 && (lo === hi || lo < (hi - lo) * 4)) lo = 0;
      }
      const hasData = hi !== -Infinity;
      if (!hasData) { lo = fixed?.[0] ?? 0; hi = fixed?.[1] ?? 1; }
      const maxTicks = Math.max(1, Math.floor(stripH / u / 28));
      const scale = fixed ? { min: fixed[0], max: fixed[1], ticks: niceScale(fixed[0], fixed[1], maxTicks).ticks.filter((tick) => tick >= fixed[0] && tick <= fixed[1]) } : niceScale(lo, hi, maxTicks);
      for (const rule of rules) if (rule.value > scale.max || rule.value < scale.min) offScale.push(rule);
      const Y = (v) => y + stripH - ((v - scale.min) / (scale.max - scale.min || 1)) * stripH;
      const { labels, unit: unitShown } = axisLabels(scale.ticks, strip.unit);
      const out = { ...strip, y, h: stripH, Y, scale, hasData, isFixed: !!fixed, labels, unitShown, rules, offScale, marks: [], gaps: [], spans: [] };

      for (const line of strip.lines) {
        const gapAfter = m.data.gapAfterOf(line.st);
        const path = new Path2D();
        const dots = [];
        trace(line.series, t0, t1, { X, Y, density, gapAfter }, {
          move: (a, b) => path.moveTo(a, b),
          line: (a, b) => path.lineTo(a, b),
          dot: (a, b) => dots.push([a, b]),
        });
        out.marks.push({ line, path, dots, gapAfter });
      }
      // Stretches where nothing in this strip had data.
      if (strip.lines.length) {
        const each = strip.lines.map((line) => gaps(line.series, t0, t1, m.data.gapAfterOf(line.st)));
        out.gaps = each.reduce((a, b) => intersect(a, b));
      } else out.gaps = [[t0, t1]];
      for (const b of panel.bindings) if (b.unit === strip.unit) out.spans.push(...m.data.ruleSpans(b, t0, t1));
      out.transitions = m.transitions.filter((tr) => rules.includes(tr.rule) && tr.t >= t0 && tr.t <= t1 && tr.to !== 'pending' && !(tr.to === 'nodata' && tr.from === 'pending'));
      built.strips.push(out);
    });
    return built;
  }

  function intersect(a, b) {
    const out = [];
    for (const [a0, a1] of a) for (const [b0, b1] of b) {
      const from = Math.max(a0, b0), to = Math.min(a1, b1);
      if (to > from) out.push([from, to]);
    }
    return out;
  }

  function chartFor(panel, t0, t1) {
    const density = stageDensity();
    let version = `${t0}|${t1}|${density}|${T.name}|${m.ruleEpoch ?? 0}|${panel.title}|${panel.el.x}|${panel.el.y}|${panel.el.width}|${panel.el.height}`;
    for (const b of panel.bindings) {
      const st = m.data.stateFor(b, panel.kind);
      version += `|${st?.order.length ?? 0}`;
      if (st) for (const s of st.series.values()) version += `,${s.version}`;
    }
    const held = cache.get(panel.id);
    if (held?.version === version) return held;
    const built = buildChart(panel, t0, t1, density);
    built.version = version;
    built.id = panel.id;
    cache.set(panel.id, built);
    return built;
  }

  const stageDensity = () => m.board.view.scale * m.board.camera.zoom;

  function paintChart(panel, status, at) {
    const { t0, t1 } = m.range();
    const c = chartFor(panel, t0, t1);
    const { r, plotX, plotW, head, legendH, X } = c;
    panel.chart = c;
    const plan = headerPlan(panel, u);
    const badgeW = status.level === 'none' ? 0 : badge(status.level, r.x + r.w, r.y + 14 * u, 12, plan.compact);

    // A single series reads out beside its title. Several get a legend, with a value each.
    // A failed or silent chart has no current number to read out.
    const single = c.lines.length === 1;
    const silent = at === null && m.time.cursor === null && (status.level === 'failed' || status.level === 'nodata');
    if (single && !silent) {
      const line = c.lines[0];
      const point = readAtCursor(line, at);
      if (point) {
        const f = fmtValue(point.v, line.unit);
        const right = c.valueBelow ? r.x + r.w : r.x + r.w - (badgeW ? badgeW + 8 * u : 0);
        const y = c.valueBelow ? r.y + head + 8 * u : r.y + 14 * u;
        const unitW = f.unit ? label(f.unit, right, y + u, { size: 12, color: T.muted, align: 'right', base: 'middle' }) + 3 * u : 0;
        label(f.text, right - unitW, y, { size: c.valueBelow ? 15 : 18, align: 'right', base: 'middle', weight: 'bold' });
      }
    } else if (c.lines.length > 1) paintLegend(c, r, head, at);

    ctx.save();
    for (const strip of c.strips) {
      const bottom = strip.y + strip.h;
      // Grid and axis.
      ctx.lineWidth = u;
      ctx.strokeStyle = T.grid;
      ctx.beginPath();
      for (const tick of strip.scale.ticks) {
        const y = strip.Y(tick);
        if (y >= strip.y - 0.5 && y <= bottom + 0.5) { ctx.moveTo(plotX, y); ctx.lineTo(plotX + plotW, y); }
      }
      ctx.stroke();
      if (strip.hasData || strip.isFixed) strip.scale.ticks.forEach((tick, i) => {
        const y = strip.Y(tick);
        if (y >= strip.y - 1 && y <= bottom + 1) label(strip.labels[i], plotX - 6 * u, y, { size: 11, color: T.muted, align: 'right', base: 'middle', keep: false });
      });
      if (strip.unitShown) label(strip.unitShown, plotX - 6 * u, strip.y - 11 * u, { size: 11, color: T.muted, align: 'right', base: 'middle' });
      ctx.strokeStyle = T.axis;
      ctx.beginPath();
      ctx.moveTo(plotX, bottom);
      ctx.lineTo(plotX + plotW, bottom);
      ctx.stroke();

      paintGaps(strip, X, plotX, plotW);

      // Alert levels and when they were crossed.
      let lastLabelY = -Infinity;
      for (const rule of strip.hasData || strip.isFixed ? [...strip.rules].sort((a, b) => b.value - a.value) : []) {
        if (rule.value > strip.scale.max || rule.value < strip.scale.min) continue;
        const y = strip.Y(rule.value);
        const color = levelColor(T, rule.level);
        ctx.setLineDash([5 * u, 4 * u]);
        ctx.strokeStyle = color;
        ctx.lineWidth = u;
        ctx.beginPath(); ctx.moveTo(plotX, y); ctx.lineTo(plotX + plotW, y); ctx.stroke();
        ctx.setLineDash([]);
        // Above its line, unless the label of the level above is already there.
        if (plotW / u < 170 || strip.h / u < 56) continue;
        const labelY = y - 7 * u - lastLabelY < 13 * u || y - 7 * u < strip.y ? y + 8 * u : y - 7 * u;
        lastLabelY = labelY;
        icon(LEVELS[rule.level].icon, plotX + 8 * u, labelY, 10, color);
        label(`${rule.level} ${showLevel(rule.value, strip.unit)}`, plotX + 16 * u, labelY, { size: 11, color, base: 'middle' });
      }
      if (strip.offScale.length && strip.hasData) {
        const words = strip.offScale.map((rule) => `${rule.level} ${showLevel(rule.value, strip.unit)}`).join(', ');
        label(`${words} is off this scale`, plotX + 4 * u, strip.y + 8 * u, { size: 11, color: T.muted, base: 'middle', keep: false });
      }

      // The lines themselves. Clipped, so one point either side can enter and leave.
      ctx.save();
      ctx.beginPath();
      ctx.rect(plotX, strip.y - 2 * u, plotW, strip.h + 4 * u);
      ctx.clip();
      ctx.lineWidth = 2 * u;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      const marks = [...strip.marks].sort((a, b) => (a.line.other === b.line.other ? b.line.index - a.line.index : a.line.other ? -1 : 1));
      for (const { line, path, dots } of marks) {
        ctx.strokeStyle = line.color;
        ctx.stroke(path);
        ctx.fillStyle = line.color;
        for (const [x, y] of dots) { ctx.beginPath(); ctx.arc(x, y, 3 * u, 0, Math.PI * 2); ctx.fill(); }
      }
      ctx.restore();

      paintStrip(strip, X, plotX, plotW, bottom);
      paintTransitionMarks(strip, X, plotX, plotW);

      // The newest point gets a dot with a ring, so you can see the line reaches now.
      if (at === null && m.time.live && strip.hasData) {
        for (const { line, gapAfter } of strip.marks) {
          if (line.other) continue;
          const p = line.series.latest();
          if (!p || p.t < t0 || t1 - p.t > gapAfter) continue;
          endDot(X(p.t), strip.Y(p.v), line.color);
        }
      }
    }
    ctx.restore();

    paintStateOnPlot(panel, c, status, at);

    // Time axis.
    if (c.bottom) {
      const y = c.plotBottom + 13 * u;
      for (const tick of c.ticks) {
        const x = X(tick.t);
        ctx.strokeStyle = T.axis;
        ctx.lineWidth = u;
        ctx.beginPath(); ctx.moveTo(x, c.plotBottom); ctx.lineTo(x, c.plotBottom + 3 * u); ctx.stroke();
        setFont(11);
        const half = ctx.measureText(tick.label).width / 2;
        if (x + half > r.x + r.w || x - half < r.x) continue;
        label(tick.label, x, y, { size: 11, color: T.muted, align: 'center', base: 'middle', keep: false });
      }
    }
    paintCursors(panel, c);
    paintZoomBand(panel, c);
  }

  function readAtCursor(line, at) {
    const when = m.time.cursor ?? at;
    if (when === null || when === undefined) {
      const p = line.series.latest();
      const staleAfter = m.data.gapAfterOf(line.st);
      if (!p) return null;
      if (m.time.live && m.now() - p.t > Math.max(staleAfter, line.binding.stale ?? 0)) return null;
      return p;
    }
    return line.series.at(when, m.data.gapAfterOf(line.st));
  }

  function paintLegend(c, r, head, at) {
    const y = r.y + head + 8 * u;
    let x = r.x + 4 * u;
    const right = r.x + r.w;
    let shown = 0;
    const named = c.lines.filter((l) => !l.other);
    // With no room for every series and its unit, the units go first: the axis has them too.
    const words = (line, withUnit) => {
      const point = readAtCursor(line, at);
      if (!point) return 'no data';
      return withUnit ? showValue(point.v, line.unit) : fmtValue(point.v, line.unit).text;
    };
    const need = (withUnit) => named.reduce((sum, line) => {
      setFont(12);
      const a = ctx.measureText(line.name).width;
      setFont(12, 'bold');
      return sum + 35 * u + a + ctx.measureText(words(line, withUnit)).width;
    }, 0);
    const withUnit = need(true) + r.x + 4 * u <= right;
    for (const line of named) {
      const value = words(line, withUnit);
      setFont(12);
      const nameW = ctx.measureText(line.name).width;
      setFont(12, 'bold');
      const valueW = ctx.measureText(value).width;
      const need = 18 * u + nameW + 5 * u + valueW + 12 * u;
      if (x + need > right && shown) break;
      ctx.strokeStyle = line.color;
      ctx.lineWidth = 2 * u;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 14 * u, y); ctx.stroke();
      x += 18 * u;
      x += label(line.name, x, y, { size: 12, color: T.text2, base: 'middle' }) + 5 * u;
      x += label(value, x, y, { size: 12, base: 'middle', weight: 'bold' }) + 12 * u;
      shown++;
    }
    const dropped = [...new Set(c.lines.map((line) => line.st))].reduce((sum, st) => sum + (st.dropped ?? 0), 0);
    const hidden = c.lines.length - shown + dropped;
    if (hidden > 0) label(`+${hidden} more`, right, y, { size: 11, color: T.muted, align: 'right', base: 'middle' });
  }

  function paintGaps(strip, X, plotX, plotW) {
    if (!strip.hasData) return;
    for (const [a, b] of strip.gaps) {
      const x0 = Math.max(plotX, X(a)), x1 = Math.min(plotX + plotW, X(b));
      const w = x1 - x0;
      if (w < 4 * u) continue;
      ctx.fillStyle = T.gapFill;
      ctx.fillRect(x0, strip.y, w, strip.h);
      const words = a <= c0(strip) && w > 120 * u ? `no data before ${clock(b, false)}` : 'no data';
      if (w > 58 * u && strip.h > 30 * u) label(words, x0 + w / 2, strip.y + strip.h - 14 * u, { size: 11, color: T.muted, align: 'center', base: 'middle', keep: false });
    }
  }

  const c0 = () => m.range().t0;

  function paintStrip(strip, X, plotX, plotW, bottom) {
    if (!strip.spans.length) return;
    const h = 4 * u;
    for (const level of STRIP_ORDER) {
      ctx.fillStyle = levelColor(T, level);
      ctx.globalAlpha = level === 'nodata' || level === 'pending' ? 0.45 : 1;
      for (const span of strip.spans) {
        if (span.level !== level) continue;
        const x0 = Math.max(plotX, X(span.a)), x1 = Math.min(plotX + plotW, X(span.b));
        if (x1 > x0) ctx.fillRect(x0, bottom - h, Math.max(x1 - x0, u), h);
      }
    }
    ctx.globalAlpha = 1;
  }

  function paintTransitionMarks(strip, X, plotX, plotW) {
    if (!strip.transitions.length || strip.transitions.length > 24) return;
    for (const tr of strip.transitions) {
      const x = X(tr.t);
      if (x < plotX || x > plotX + plotW) continue;
      const firing = tr.to === 'firing';
      const level = firing ? tr.rule.level : tr.to === 'ok' ? 'ok' : 'nodata';
      const color = levelColor(T, level);
      ctx.strokeStyle = color;
      ctx.lineWidth = u;
      ctx.beginPath(); ctx.moveTo(x, strip.y); ctx.lineTo(x, strip.y + strip.h); ctx.stroke();
      icon(LEVELS[level].icon, x, strip.y + 2 * u, 10, color);
    }
  }

  function endDot(x, y, color) {
    ctx.fillStyle = T.surface;
    ctx.beginPath(); ctx.arc(x, y, 6 * u, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, 4 * u, 0, Math.PI * 2); ctx.fill();
  }

  // State in words, in the row above the plot, so it never covers the data. A chart with
  // nothing to draw says it in the middle as well.
  function paintStateOnPlot(panel, c, status, at) {
    const { plotX, plotW } = c;
    const strip = c.strips[0];
    const anyData = c.strips.some((s) => s.hasData);
    if (panel.bindings.length && !anyData) {
      const words = status.level === 'pending' && status.why.startsWith('waiting') ? 'waiting for the first numbers...' : status.why && ['failed', 'nodata'].includes(status.level) ? status.why : 'no data in this range';
      const lines = wrap(words, plotW * 0.9, 13, 3);
      lines.forEach((line, i) => label(line, plotX + plotW / 2, strip.y + strip.h / 2 + (i - (lines.length - 1) / 2) * 16 * u, { size: 13, color: T.muted, align: 'center', base: 'middle' }));
      return;
    }
    if (!['warn', 'critical', 'pending', 'nodata', 'failed'].includes(status.level) || !status.why) return;
    const color = levelColor(T, status.level);
    const room = plotW - (strip.unitShown ? 4 * u : 0);
    const y = strip.y - 7 * u;
    label(fit(withWord(headerPlan(panel, u), status), room, 11, 'bold'), plotX + plotW, y, { size: 11, color, align: 'right', base: 'middle', weight: 'bold' });
  }

  function paintCursors(panel, c) {
    const { X, plotX, plotW } = c;
    const top = c.strips[0]?.y ?? 0;
    const line = (t, solid) => {
      const x = X(t);
      if (x < plotX || x > plotX + plotW) return null;
      ctx.strokeStyle = solid ? T.select : T.ink;
      ctx.globalAlpha = solid ? 1 : 0.55;
      ctx.lineWidth = solid ? 2 * u : u;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, c.plotBottom); ctx.stroke();
      ctx.globalAlpha = 1;
      return x;
    };
    if (m.time.at !== null) {
      const x = line(m.time.at, true);
      if (x !== null && m.time.cursor === null) {
        for (const strip of c.strips) {
          for (const { line: l, gapAfter } of strip.marks) {
            if (l.other) continue;
            const p = l.series.at(m.time.at, gapAfter);
            if (p) endDot(X(p.t), strip.Y(p.v), l.color);
          }
        }
      }
    }
    if (m.time.cursor === null) return;
    const hovered = m.hoverChart === panel.id;
    const x = line(m.time.cursor, false);
    if (x === null) return;
    const rows = [];
    for (const strip of c.strips) {
      for (const { line: l, gapAfter } of strip.marks) {
        if (l.other) continue;
        const p = l.series.at(m.time.cursor, gapAfter);
        rows.push({ line: l, point: p });
        if (p) endDot(X(p.t), strip.Y(p.v), l.color);
      }
    }
    if (rows.length) paintTooltip(c, x, top, rows, hovered, panel);
  }

  // One tooltip, every series. On the chart under the pointer it has the time too.
  function paintTooltip(c, x, top, rows, hovered, panel) {
    const shown = hovered ? rows.slice(0, 9) : rows.slice(0, 3);
    const lineH = 16 * u;
    const lines = shown.map(({ line, point }) => ({ value: point ? showValue(point.v, line.unit) : 'no data', name: rows.length > 1 || line.name !== panel.title ? line.name : '', color: line.color }));
    setFont(12, 'bold');
    let width = Math.max(...lines.map((l) => ctx.measureText(l.value).width));
    setFont(12);
    const nameW = Math.max(0, ...lines.map((l) => ctx.measureText(l.name).width));
    width += (nameW ? nameW + 8 * u : 0) + 16 * u;
    if (hovered) { setFont(12, 'bold'); width = Math.max(width, ctx.measureText(clock(m.time.cursor)).width + 4 * u); }
    const w = width + 12 * u, h = shown.length * lineH + (hovered ? lineH : 0) + 8 * u;
    const px = x + w + 10 * u > c.plotX + c.plotW ? x - w - 8 * u : x + 8 * u;
    const py = Math.min(top + 4 * u, c.plotBottom - h);
    ctx.fillStyle = T.surface;
    ctx.strokeStyle = T.axis;
    ctx.lineWidth = u;
    ctx.beginPath();
    ctx.rect(px, py, w, h);
    ctx.fill();
    ctx.stroke();
    let y = py + 4 * u + lineH / 2;
    if (hovered) { label(clock(m.time.cursor), px + 6 * u, y, { size: 12, color: T.text2, base: 'middle', weight: 'bold' }); y += lineH; }
    for (const row of lines) {
      ctx.strokeStyle = row.color;
      ctx.lineWidth = 2 * u;
      ctx.beginPath(); ctx.moveTo(px + 6 * u, y); ctx.lineTo(px + 16 * u, y); ctx.stroke();
      const vw = label(row.value, px + 20 * u, y, { size: 12, base: 'middle', weight: 'bold' });
      if (row.name) label(row.name, px + 20 * u + vw + 8 * u, y, { size: 12, color: T.text2, base: 'middle' });
      y += lineH;
    }
  }

  function paintZoomBand(panel, c) {
    const g = m.gesture;
    if (g?.type !== 'zoom' || g.panel !== panel.id || !g.moved) return;
    const a = Math.max(c.plotX, Math.min(g.x0, g.x1)), b = Math.min(c.plotX + c.plotW, Math.max(g.x0, g.x1));
    const top = c.strips[0].y;
    ctx.fillStyle = T.select;
    ctx.globalAlpha = 0.16;
    ctx.fillRect(a, top, b - a, c.plotBottom - top);
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- a stat

  function paintStat(panel, status, at) {
    const r = innerRect(panel.el, u);
    const plan = headerPlan(panel, u);
    if (status.level !== 'none' && !plan.below) badge(status.level, r.x + r.w, r.y + 14 * u, 12, plan.compact);
    const b = panel.bindings[0];
    if (!b) return;
    const read = m.data.readBinding(b, at, panel.kind);
    const row = read.rows[0];
    const head = 30 * u;
    const big = Math.min(44, Math.max(20, Math.min((r.h - head) / u * 0.42, r.w / u / 5)));
    const quiet = status.level === 'nodata' || status.level === 'failed';
    const sparkRoom = r.h - head - big * u * 1.1 > 34 * u ? Math.min(44 * u, (r.h - head) * 0.34) : 0;
    const y = r.y + head + (r.h - head - sparkRoom) / 2;
    // With no room for the status word beside the number, the word and its reason take the trend's place.
    let wordNeedsRoom = false;
    if (!quiet && row && row.value !== null && !row.stale) {
      const f = fmtValue(row.value, b.unit);
      setFont(big, 'bold');
      const width = ctx.measureText(f.text).width;
      setFont(14);
      const unitW = f.unit ? ctx.measureText(f.unit).width + 5 * u : 0;
      const x = r.x;
      label(f.text, x, y, { size: big, align: 'left', base: 'middle', weight: 'bold' });
      if (f.unit) label(f.unit, x + width + 5 * u, y + big * 0.16 * u, { size: 14, color: T.muted, base: 'middle' });
      if (plan.below) {
        wordNeedsRoom = width + unitW + badgeWidth(status.level, u) + 8 * u > r.w;
        badge(status.level, r.x + r.w, y, 12, wordNeedsRoom);
      }
    } else if (status.why) {
      if (plan.below) badge(status.level, r.x + r.w, r.y + 14 * u, 12, true);
      sentence(withWord(plan, status), r.x, y - 10 * u, r.w, status.level, { size: 13, most: 2 });
    } else label(read.waiting ? 'waiting...' : 'no data', r.x, y, { size: 14, color: T.muted, base: 'middle' });
    const firing = ['warn', 'critical', 'pending'].includes(status.level) && status.why;
    if (firing && wordNeedsRoom) sentence(`${LEVELS[status.level].word}: ${status.why}`, r.x, r.y + r.h - Math.max(sparkRoom, 17 * u), r.w, status.level, { most: sparkRoom > 28 * u ? 2 : 1 });
    else if (firing && !sparkRoom) sentence(status.why, r.x, r.y + r.h - 16 * u, r.w, status.level, { most: 1 });
    else if (sparkRoom) paintSpark(b, r.x, r.y + r.h - sparkRoom, r.w, sparkRoom, panel);
  }

  // A small trend, kept until its data or its place changes. It is read at every frame.
  function paintSpark(binding, x, y, w, h, panel) {
    const line = m.data.seriesOf(binding, panel.kind)[0];
    if (!line) return;
    const { t0, t1 } = m.range();
    const key = `${line.series.version}|${t0}|${t1}|${x}|${y}|${w}|${h}|${stageDensity()}`;
    let held = sparks.get(panel.id);
    if (held?.key !== key) {
      const e = line.series.extent(t0, t1);
      if (!e) { sparks.delete(panel.id); return; }
      const fixed = binding.axis;
      const lo = fixed ? fixed[0] : Math.min(0, e[0]), hi = fixed ? fixed[1] : (e[1] === lo ? lo + 1 : e[1]);
      const X = (t) => x + ((t - t0) / (t1 - t0)) * w;
      const Y = (v) => y + h - 2 * u - ((v - lo) / (hi - lo || 1)) * (h - 4 * u);
      const path = new Path2D();
      const dots = [];
      trace(line.series, t0, t1, { X, Y, density: stageDensity(), gapAfter: m.data.gapAfterOf(line.st) }, { move: (a, b) => path.moveTo(a, b), line: (a, b) => path.lineTo(a, b), dot: (a, b) => dots.push([a, b]) });
      held = { key, path, dots };
      sparks.set(panel.id, held);
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y - 2 * u, w, h + 4 * u); ctx.clip();
    ctx.strokeStyle = T.series[0];
    ctx.lineWidth = 2 * u;
    ctx.lineJoin = 'round';
    ctx.stroke(held.path);
    ctx.fillStyle = T.series[0];
    for (const [a, b] of held.dots) { ctx.beginPath(); ctx.arc(a, b, 3 * u, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }

  // ---------------------------------------------------------------- a meter

  function paintMeter(panel, status, at) {
    const r = innerRect(panel.el, u);
    const plan = headerPlan(panel, u);
    if (status.level !== 'none' && !plan.below) badge(status.level, r.x + r.w, r.y + 14 * u, 12, plan.compact);
    const b = panel.bindings[0];
    if (!b) return;
    const read = m.data.readBinding(b, at, panel.kind);
    const row = read.rows[0];
    const range = panel.range ?? b.axis ?? [0, Math.max(100, ...b.rules.map((x) => x.value * 1.1), (row?.value ?? 0) * 1.2)];
    const barH = 12 * u;
    const y = r.y + r.h - barH - 18 * u;
    const X = (v) => r.x + (Math.max(range[0], Math.min(range[1], v)) - range[0]) / (range[1] - range[0] || 1) * r.w;
    const quiet = status.level === 'nodata' || status.level === 'failed' || !row || row.value === null || row.stale;
    if (!quiet) {
      const f = fmtValue(row.value, b.unit);
      const w = label(f.text, r.x, y - 18 * u, { size: 24, base: 'middle', weight: 'bold' });
      setFont(12);
      const unitW = f.unit ? ctx.measureText(f.unit).width + 4 * u : 0;
      const wordW = plan.below ? badgeWidth(status.level, u) + 8 * u : 0;
      // The bar's ends say the unit too, so the unit gives way to the status word first.
      if (f.unit && w + unitW + wordW <= r.w) label(f.unit, r.x + w + 4 * u, y - 16 * u, { size: 12, color: T.muted, base: 'middle' });
      if (plan.below) badge(status.level, r.x + r.w, y - 18 * u, 12, w + wordW > r.w);
    } else if (status.why) {
      if (plan.below) badge(status.level, r.x + r.w, r.y + 14 * u, 12, true);
      sentence(withWord(plan, status), r.x, y - 34 * u, r.w, status.level === 'none' ? 'nodata' : status.level, { most: 2 });
    } else label(read.waiting ? 'waiting...' : 'no data', r.x, y - 18 * u, { size: 13, color: T.muted, base: 'middle' });
    ctx.fillStyle = T.grid;
    ctx.fillRect(r.x, y, r.w, barH);
    if (!quiet) {
      ctx.fillStyle = status.level === 'none' || status.level === 'ok' || status.level === 'pending' ? T.series[0] : levelColor(T, status.level);
      ctx.fillRect(r.x, y, Math.max(u, X(row.value) - r.x), barH);
      panel.meter = { x: r.x, y, w: r.w, h: barH, range };
    }
    for (const rule of b.rules) {
      const x = X(rule.value);
      ctx.strokeStyle = levelColor(T, rule.level);
      ctx.lineWidth = 2 * u;
      ctx.beginPath(); ctx.moveTo(x, y - 3 * u); ctx.lineTo(x, y + barH + 3 * u); ctx.stroke();
    }
    label(showValue(range[0], b.unit), r.x, y + barH + 10 * u, { size: 11, color: T.muted, base: 'middle', keep: false });
    label(showValue(range[1], b.unit), r.x + r.w, y + barH + 10 * u, { size: 11, color: T.muted, align: 'right', base: 'middle', keep: false });
  }

  // ---------------------------------------------------------------- a table

  function paintTable(panel, status, at) {
    const r = innerRect(panel.el, u);
    const plan = headerPlan(panel, u);
    if (status.level !== 'none') badge(status.level, r.x + r.w, r.y + 14 * u, 12, plan.compact);
    const rows = [];
    for (const b of panel.bindings) {
      const read = m.data.readBinding(b, at, panel.kind);
      if (read.failed || (read.waiting && !read.rows.length)) rows.push({ name: b.name, why: read.failed ? m.data.failure(b, read) : 'waiting...', level: read.failed ? 'failed' : 'pending' });
      if (!read.rows.length && read.st && !read.failed && !read.waiting) rows.push({ name: b.name, why: 'no series', level: 'nodata' });
      for (const row of read.rows) rows.push({ name: m.data.rowName(read, row), value: row.stale ? null : row.value, unit: b.unit, age: row.age, t: row.t, level: b.rules.length ? m.data.status({ bindings: [b], kind: panel.kind }, at).level : 'none' });
    }
    rows.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
    const head = 32 * u, rowH = 22 * u;
    const fits = Math.max(1, Math.floor((r.h - head) / rowH));
    rows.slice(0, fits).forEach((row, i) => {
      const y = r.y + head + rowH * (i + 0.5);
      if (i) { ctx.strokeStyle = T.grid; ctx.lineWidth = u; ctx.beginPath(); ctx.moveTo(r.x, y - rowH / 2); ctx.lineTo(r.x + r.w, y - rowH / 2); ctx.stroke(); }
      const iconSpace = row.level && row.level !== 'none' ? 18 * u : 0;
      if (iconSpace) icon(LEVELS[row.level].icon, r.x + 7 * u, y, 13, levelColor(T, row.level));
      const shown = row.value === null || row.value === undefined ? null : showValue(row.value, row.unit);
      setFont(14, 'bold');
      const valueW = shown ? ctx.measureText(shown).width : r.w * 0.45;
      label(fit(row.name, r.w - iconSpace - valueW - 10 * u, 13), r.x + iconSpace, y, { size: 13, color: T.text2, base: 'middle' });
      if (row.why) label(fit(row.why, r.w * 0.5, 12), r.x + r.w, y, { size: 12, color: T.critical, align: 'right', base: 'middle' });
      else if (row.value === null || row.value === undefined) label(at !== null ? 'no data then' : row.t ? `no data for ${fmtAgo(row.age)}` : 'no data', r.x + r.w, y, { size: 12, color: T.quiet, align: 'right', base: 'middle' });
      else label(shown, r.x + r.w, y, { size: 14, align: 'right', base: 'middle', weight: 'bold' });
    });
    if (rows.length > fits) label(`+${rows.length - fits} more`, r.x + r.w, r.y + 26 * u, { size: 11, color: T.muted, align: 'right', base: 'middle' });
  }

  // ---------------------------------------------------------------- what is firing

  function paintAlerts(panel, at) {
    const r = innerRect(panel.el, u);
    const list = firingAt(at);
    const rowH = 21 * u;
    let y = r.y + 62 * u;
    const silent = at === null ? (m.silentNow?.length ?? 0) : 0;
    const words = list.length ? `${list.length} firing` : silent ? `${silent} can't be checked: no data` : at !== null ? 'nothing was firing' : m.ruleCount ? 'nothing firing' : 'this drawing has no warn or critical lines';
    const color = list.some((f) => f.rule.level === 'critical') ? T.critical : list.length ? T.warn : silent ? T.quiet : T.ok;
    const iconName = list.some((f) => f.rule.level === 'critical') ? 'octagon' : list.length ? 'triangle' : silent ? 'question' : 'check';
    if (m.ruleCount || list.length) icon(iconName, r.x + 8 * u, r.y + 42 * u, 15, color);
    label(words, r.x + (m.ruleCount || list.length ? 22 * u : 0), r.y + 42 * u, { size: 15, color: m.ruleCount || list.length ? color : T.muted, base: 'middle', weight: 'bold' });
    const hot = [];
    const bottom = r.y + r.h;
    for (const f of list) {
      if (y + rowH > bottom) break;
      const level = f.rule.level;
      icon(LEVELS[level].icon, r.x + 8 * u, y, 13, levelColor(T, level));
      const when = at === null && f.since ? `for ${fmtAgo(m.now() - f.since + f.rule.for)}` : f.since ? `since ${clock(f.since, false)}` : '';
      const timeW = label(when, r.x + r.w, y, { size: 12, color: T.muted, align: 'right', base: 'middle' });
      label(fit(`${f.name} ${f.rule.op} ${showLevel(f.rule.value, f.binding.unit)}`, r.w - timeW - 30 * u, 13), r.x + 22 * u, y, { size: 13, base: 'middle' });
      hot.push({ x: r.x, y: y - rowH / 2, w: r.w, h: rowH, select: f.owner, at: f.since ?? null });
      y += rowH;
    }
    const recent = m.transitions.filter((tr) => at === null || tr.t <= at).slice(-12).reverse();
    if (recent.length && y + rowH * 1.2 < bottom) {
      y += 8 * u;
      label('what changed', r.x, y, { size: 11, color: T.muted, base: 'middle', keep: false });
      y += rowH * 0.8;
      for (const tr of recent) {
        if (y + rowH / 2 > bottom) break;
        icon(LEVELS[tr.level].icon, r.x + 8 * u, y, 12, levelColor(T, tr.level));
        const timeW = label(clock(tr.t), r.x + r.w, y, { size: 12, color: T.muted, align: 'right', base: 'middle' });
        label(fit(tr.words, r.w - timeW - 30 * u, 12), r.x + 22 * u, y, { size: 12, color: T.text2, base: 'middle' });
        hot.push({ x: r.x, y: y - rowH / 2, w: r.w, h: rowH, select: tr.owner, at: tr.t });
        y += rowH;
      }
    }
    panel.hot = hot;
  }

  function firingAt(at) {
    if (at === null) return m.firingNow ?? [];
    const out = [];
    const seen = new Set();
    for (const owner of [...m.dash.panels.values(), ...m.dash.edges.values()]) {
      for (const b of owner.own ?? owner.bindings) {
        for (const rule of b.rules) {
          const state = m.data.ruleState(rule, at);
          if (state?.state === 'firing') {
            const sig = `${b.key}|${rule.level}|${rule.op}|${rule.value}`;
            if (seen.has(sig)) continue;
            seen.add(sig);
            out.push({ rule, binding: b, owner: owner.id, name: nameOf(owner, b), since: state.since });
          }
        }
      }
    }
    return worstOfEach(out);
  }

  // ---------------------------------------------------------------- arrows

  function paintEdge(edge, at, dt) {
    const status = m.data.status(edge, at);
    const b = edge.bindings[0];
    const read = m.data.readBinding(b, at);
    const row = read.rows[0];
    const fresh = row && !row.stale && row.value !== null;
    let words;
    if (fresh) words = showValue(row.value, b.unit);
    else if (status.level === 'failed') words = `${b.source} failed`;
    else words = at !== null ? 'no data then' : row?.t ? `no data for ${fmtAgo(row.age)}` : read.waiting ? 'waiting...' : 'no data';
    setFont(13, 'bold');
    const w = ctx.measureText(words).width;
    const show = ['warn', 'critical', 'nodata', 'failed'].includes(status.level);
    const iconW = show ? 17 * u : 0;
    const titleW = edge.title ? (setFont(11), ctx.measureText(edge.title).width) : 0;
    const boxW = Math.max(w + iconW, titleW) + 8 * u;
    const boxH = (edge.title ? 32 : 18) * u;
    // Beside the middle of the line, on the side away from what the arrow joins, so the
    // arrow and its dots stay in view.
    const mid = m.pointOnArrow(edge.el, 0.5);
    const near = m.pointOnArrow(edge.el, 0.55);
    const dx = near[0] - mid[0], dy = near[1] - mid[1];
    const steep = Math.abs(dy) > Math.abs(dx);
    const cx = steep ? mid[0] + boxW / 2 + 8 * u : mid[0];
    const cy = steep ? mid[1] : mid[1] - boxH / 2 - 6 * u;
    ctx.fillStyle = T.surface;
    ctx.globalAlpha = 0.88;
    ctx.fillRect(cx - boxW / 2, cy - boxH / 2, boxW, boxH);
    ctx.globalAlpha = 1;
    const y = cy + (edge.title ? 7 : 0) * u;
    if (edge.title) label(edge.title, cx, cy - 8 * u, { size: 11, color: T.muted, align: 'center', base: 'middle' });
    if (show) icon(LEVELS[status.level].icon, cx - (w + iconW) / 2 + 6 * u, y, 13, levelColor(T, status.level));
    label(words, cx + iconW / 2, y, { size: 13, align: 'center', base: 'middle', weight: 'bold', color: show ? levelColor(T, status.level) : T.ink });
    edge.labelBox = { x: cx - boxW / 2, y: cy - boxH / 2, w: boxW, h: boxH };

    if (edge.flow) paintFlow(edge, fresh ? row.value : null, b, dt);
  }

  // Dots on an arrow. One dot stands for the same amount on every arrow with this unit, and
  // dots are evenly spaced, so a dot's speed is the rate: twice the rate, twice as fast.
  function paintFlow(edge, rate, binding, dt) {
    const flow = m.flows.get(edge.id) ?? { phase: 0 };
    m.flows.set(edge.id, flow);
    const per = m.flowPer(binding.unit, rate);
    const spacing = 80 * u;
    const path = m.arrowPath(edge.el);
    flow.rate = rate;
    flow.per = per;
    flow.dotsPerSecond = rate && per ? rate / per : 0;
    flow.speed = flow.dotsPerSecond * spacing;
    flow.unit = binding.unit;
    if (!rate || !per) return;                        // No number, no motion.
    if (!m.reducedMotion) flow.phase = (flow.phase + flow.dotsPerSecond * dt) % 1;
    const count = Math.max(1, Math.floor(path.total / spacing));
    ctx.fillStyle = T.select;
    for (let i = 0; i <= count; i++) {
      const along = (flow.phase + i) * spacing;
      if (along > path.total) break;
      const p = m.pointOnArrow(edge.el, along / path.total);
      ctx.beginPath();
      ctx.arc(p[0], p[1], 3.5 * u, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---------------------------------------------------------------- messages on the drawing

  function paintProblems(owner, frame) {
    const problems = owner.problems.filter((p) => p.level === 'error');
    if (!problems.length) return;
    const problem = problems[0];
    const width = Math.max(frame.w, 300 * u);
    const lines = wrap(problem.message, width - 30 * u, 12, 4);
    const fixLabel = problem.fix ? `use "${problem.fix.to}"` : null;
    const h = lines.length * 15 * u + (fixLabel ? 26 * u : 0) + 10 * u;
    const x = frame.x, y = frame.y + frame.h + 8 * u;
    ctx.fillStyle = T.surface;
    ctx.strokeStyle = T.critical;
    ctx.lineWidth = 1.5 * u;
    ctx.beginPath();
    ctx.rect(x, y, width, h);
    ctx.fill();
    ctx.stroke();
    icon('octagon', x + 12 * u, y + 13 * u, 13, T.critical);
    lines.forEach((line, i) => label(line, x + 24 * u, y + 5 * u + i * 15 * u, { size: 12, color: T.ink, base: 'top' }));
    m.problemBoxes.push({ owner: owner.id, x, y, w: width, h, problem });
    if (fixLabel) {
      const by = y + lines.length * 15 * u + 7 * u;
      setFont(12, 'bold');
      const w = ctx.measureText(fixLabel).width + 14 * u;
      ctx.fillStyle = T.criticalFill;
      ctx.fillRect(x + 24 * u, by, w, 20 * u);
      label(fixLabel, x + 24 * u + 7 * u, by + 10 * u, { size: 12, base: 'middle', weight: 'bold', color: T.critical });
      m.hot.push({ x: x + 24 * u, y: by, w, h: 20 * u, fix: problem, owner: owner.id });
    }
  }

  // Too small for a title: its state and its first number.
  function paintTiny(panel, status, at) {
    const r = innerRect(panel.el, u);
    if (status.level !== 'none') badge(status.level, r.x + r.w, r.y + r.h / 2, 11, true);
    const b = panel.bindings[0];
    if (!b) return;
    const row = m.data.readBinding(b, at, panel.kind).rows[0];
    if (row?.value !== null && row?.value !== undefined && !row.stale) label(fmtValue(row.value, b.unit).text, r.x, r.y + r.h / 2, { size: 12, base: 'middle', weight: 'bold' });
  }

  // Room for its title, its state and one number.
  function paintShort(panel, status, at) {
    const r = innerRect(panel.el, u);
    const plan = headerPlan(panel, u);
    const badgeW = status.level === 'none' ? 0 : badge(status.level, r.x + r.w, r.y + 14 * u, 12, plan.compact);
    const b = panel.bindings[0];
    if (!b) return;
    const read = m.data.readBinding(b, at, panel.kind);
    const row = read.rows[0];
    const words = read.failed ? 'failed' : row && row.value !== null && !row.stale ? showValue(row.value, b.unit) : 'no data';
    const beside = isVeryShort(panel, u);
    label(words, beside ? r.x + r.w - (badgeW ? badgeW + 6 * u : 0) : r.x + r.w, beside ? r.y + 14 * u : r.y + r.h - 9 * u, { size: 14, align: 'right', base: 'middle', weight: 'bold', color: read.failed ? T.critical : T.ink });
  }

  // ---------------------------------------------------------------- the whole layer

  function paint(context, stage, dt) {
    ctx = context;
    T = m.theme;
    u = m.unit();
    m.hot = [];
    m.problemBoxes = [];
    const at = m.viewAt();
    const next = new Map();

    for (const edge of m.dash.edges.values()) {
      if (!edge.bindings.length) { if (edge.problems.length) { reading = []; const mid = m.pointOnArrow(edge.el, 0.5); paintProblems(edge, { x: mid[0] - 150 * u, y: mid[1], w: 300 * u, h: 0 }); reading = null; } continue; }
      reading = [];
      paintEdge(edge, at, dt);
      paintProblems(edge, edge.labelBox);
      next.set(edge.id, reading);
    }

    for (const panel of m.dash.panels.values()) {
      if (panel.kind === 'plain') { if (panel.problems.length) { reading = []; paintProblems(panel, { x: panel.el.x, y: panel.el.y, w: panel.el.width, h: panel.el.height }); reading = null; } continue; }
      reading = [];
      const status = panel.kind === 'alerts' ? { level: 'none', why: '' } : m.data.status(panel, at);
      panel.status = status;
      if (tooSmall(panel, u)) paintTiny(panel, status, at);
      else if (isShort(panel, u)) paintShort(panel, status, at);
      else if (panel.kind === 'box') paintBox(panel, status, at);
      else if (panel.kind === 'chart') paintChart(panel, status, at);
      else if (panel.kind === 'stat') paintStat(panel, status, at);
      else if (panel.kind === 'meter') paintMeter(panel, status, at);
      else if (panel.kind === 'table') paintTable(panel, status, at);
      else if (panel.kind === 'alerts') paintAlerts(panel, at);
      if (!panel.bindings.length && panel.kind !== 'alerts') {
        const empty = panel.problems.find((p) => p.empty);
        if (empty) {
          const r = innerRect(panel.el, u);
          wrap(empty.message, r.w, 13, 3).forEach((line, i) => label(line, r.x, r.y + 40 * u + i * 16 * u, { size: 13, color: T.muted, base: 'middle' }));
        }
      }
      paintProblems(panel, { x: panel.el.x, y: panel.el.y, w: panel.el.width, h: panel.el.height });
      next.set(panel.id, reading);
      if (panel.hot) m.hot.push(...panel.hot.map((h) => ({ ...h, owner: panel.id })));
    }
    reading = null;
    readouts = next;
    m.readouts = readouts;
    if (m.flows.size) paintFlowLegend();
    paintSelection();
  }

  function paintFlowLegend() {
    const units = new Map();
    for (const flow of m.flows.values()) if (flow.per) units.set(flow.unit, flow.per);
    if (!units.size) return;
    const words = `A dot passing each second is ${[...units].map(([unit, per]) => showLevel(per, unit)).join(', or ')}`;
    const view = m.visibleRect();
    const x = view.x + 14 * u, y = view.y + view.h - 16 * u;
    ctx.fillStyle = T.select;
    ctx.beginPath(); ctx.arc(x, y, 3.5 * u, 0, Math.PI * 2); ctx.fill();
    label(words, x + 9 * u, y, { size: 12, color: T.text2, base: 'middle', keep: false });
  }

  function paintSelection() {
    const g = m.gesture;
    const ghost = g?.type === 'part' && g.at ? g : null;
    if (ghost?.over) {
      const { w, h } = ghost.part;
      ctx.strokeStyle = T.select;
      ctx.lineWidth = 1.5 * u;
      ctx.setLineDash([6 * u, 4 * u]);
      if (ghost.target) {
        const e = ghost.target;
        ctx.strokeRect(e.x - 4 * u, e.y - 4 * u, e.width + 8 * u, e.height + 8 * u);
      } else ctx.strokeRect(ghost.at.x - w / 2, ghost.at.y - h / 2, w, h);
      ctx.setLineDash([]);
    }
    const el = m.selected && m.byId(m.selected);
    if (el && el.type !== 'arrow' && el.type !== 'text' && !m.wall) {
      const pad = 5 * u;
      ctx.strokeStyle = T.select;
      ctx.lineWidth = 1.5 * u;
      ctx.setLineDash([6 * u, 4 * u]);
      ctx.strokeRect(el.x - pad, el.y - pad, el.width + pad * 2, el.height + pad * 2);
      ctx.setLineDash([]);
      const c = m.connectAt(el);
      ctx.fillStyle = T.selectFill;
      ctx.strokeStyle = T.select;
      ctx.beginPath(); ctx.arc(c[0], c[1], 7 * u, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      const s = m.resizeAt(el);
      ctx.fillStyle = T.select;
      ctx.fillRect(s[0] - 5 * u, s[1] - 5 * u, 10 * u, 10 * u);
    }
    if (el && el.type === 'arrow' && !m.wall) {
      const p = m.arrowPath(el);
      ctx.fillStyle = T.selectFill;
      ctx.strokeStyle = T.select;
      ctx.lineWidth = 1.5 * u;
      for (const point of [p.pts[0], p.pts[p.pts.length - 1]]) { ctx.beginPath(); ctx.arc(point[0], point[1], 6 * u, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    }
    if (g?.type === 'connect' && g.at) {
      const c = m.connectAt(m.byId(g.from));
      ctx.strokeStyle = T.select;
      ctx.lineWidth = 2 * u;
      ctx.beginPath(); ctx.moveTo(c[0], c[1]); ctx.lineTo(g.at.x, g.at.y); ctx.stroke();
    }
  }

  return { paint, firingAt, forget: () => { cache.clear(); sparks.clear(); }, forgetRanks: () => ranks.clear(), get readouts() { return readouts; } };
}
