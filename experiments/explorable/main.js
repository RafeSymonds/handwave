// O7. A search you can change while reading it. Every check is on screen at
// once, so moving the target shows how the whole search changes, and raising the
// count shows that doubling the numbers adds only one check.

import { createStage } from '/lib/stage.js';
import { rect, text, line, ellipse, box, color } from '/lib/draw.js';

const stage = await createStage(document.getElementById('stage'), { width: 1600, height: 900 });

const LEFT = 120, RIGHT = 1240, SPAN = RIGHT - LEFT;
const SIZES = [7, 15, 31, 63, 127];
const STEP = 7;
const state = { n: 15, at: 0.62, touched: false };

// Sorted, evenly spread and slightly uneven, the same for a given position.
const valuesFor = (n) => Array.from({ length: n }, (_, i) => Math.round(i * STEP + 3 + ((i * 2654435761) % 5)));
const targetOf = (s) => Math.round(s.at * (s.n * STEP));

function search(values, target) {
  const checks = [];
  let lo = 0, hi = values.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = values[mid];
    const check = { lo, hi, mid, value: v, verdict: v === target ? 'found' : v < target ? 'right' : 'left' };
    checks.push(check);
    if (v === target) break;
    if (v < target) lo = mid + 1; else hi = mid - 1;
  }
  return checks;
}

function scanCount(values, target) {
  const i = values.findIndex((v) => v >= target);
  return i < 0 ? values.length : i + 1;
}

const invisible = { customData: { handwave: { ghost: true } } };

function view(s) {
  const values = valuesFor(s.n);
  const target = targetOf(s);
  const checks = search(values, target);
  const out = [];

  out.push(text('title', 60, 22, 'Each check throws away half of what is left', { size: 46, font: 6 }));

  // The count of numbers.
  out.push(text('n-label', 1290, 34, 'numbers', { size: 24, color: color.muted, align: 'right', ...invisible }));
  SIZES.forEach((size, i) => {
    const [b, t] = box(`n${size}`, 1302 + (i % 5) * 54, 26, 50, 42, String(size), { size: 22, tone: size === s.n ? color.amber : color.gray });
    out.push(b, t);
  });

  // The target, on a line that spans the same width as the numbers below it.
  const knobX = LEFT + s.at * SPAN;
  out.push(line('track', [[LEFT, 136], [RIGHT, 136]], { strokeColor: color.muted, ...invisible }));
  out.push(ellipse('knob', knobX - 42, 104, 84, 64, { tone: color.amber, customData: { handwave: { change: 'none', cursor: 'grab' } } }));
  out.push(text('knob-t', knobX, 136, String(target), { size: 30, align: 'center', valign: 'middle', color: color.amber.stroke, customData: { handwave: { change: 'none', ghost: true } } }));
  if (!s.touched) out.push(text('hint', Math.min(knobX + 54, RIGHT - 100), 98, 'drag me', { size: 26, color: color.muted, ...invisible }));

  // One row per check.
  const maxRows = Math.floor(Math.log2(s.n)) + 1;
  const top = 200, rowH = Math.min(78, 430 / maxRows);
  const cell = SPAN / s.n;
  const showNumbers = cell >= 30;
  checks.forEach((c, r) => {
    const y = top + r * rowH;
    const boxH = rowH - 14;
    out.push(text(`row${r}-n`, 92, y + boxH / 2, String(r + 1), { size: 24, align: 'right', valign: 'middle', color: color.muted, ...invisible }));
    for (let i = 0; i < s.n; i++) {
      const inRange = i >= c.lo && i <= c.hi;
      const isMid = i === c.mid;
      const hit = c.verdict === 'found' ? color.green : color.blue;
      // A sliver of a box needs a solid fill to be seen.
      const tone = isMid ? (cell < 16 ? { fill: hit.stroke, stroke: hit.stroke } : hit) : inRange ? { fill: '#ffffff', stroke: color.ink } : color.gray;
      const opacity = inRange ? 100 : 45;
      const id = `r${r}-b${i}`;
      out.push(rect(id, LEFT + i * cell + 1, y, cell - 2, boxH, { tone, opacity, roundness: cell > 24 ? { type: 3 } : null, strokeWidth: cell > 16 ? 2 : 1, roughness: cell > 16 ? 1 : 0.5, customData: { handwave: { enter: 'fade' } } }));
      if (showNumbers) out.push(text(`${id}-t`, LEFT + i * cell + cell / 2, y + boxH / 2, String(values[i]), { size: Math.min(26, cell * 0.42), align: 'center', valign: 'middle', opacity, color: isMid ? tone.stroke : color.ink, customData: { handwave: { enter: 'fade', ghost: true } } }));
    }
    const note = c.verdict === 'found' ? `${c.value}: found it` : c.verdict === 'right' ? `${c.value} is too small, go right` : `${c.value} is too big, go left`;
    out.push(text(`row${r}-note`, RIGHT + 24, y + boxH / 2, note, { size: 25, valign: 'middle', color: c.verdict === 'found' ? color.green.stroke : color.ink, ...invisible }));
  });

  const found = checks.at(-1)?.verdict === 'found';
  if (!found) {
    const y = top + checks.length * rowH;
    out.push(text('missing', LEFT, y + 8, `Nothing left to check, so ${target} is not in the list.`, { size: 26, color: color.rose.stroke, ...invisible }));
  }

  // What it saved, on one scale: the whole bar is every number.
  const scan = scanCount(values, target);
  const barY = 700;
  const bar = (id, y, count, label, tone) => {
    const width = Math.max(10, (count / s.n) * SPAN);
    out.push(rect(`${id}-bar`, LEFT, y, width, 44, { tone, roundness: null, customData: { handwave: { ghost: true } } }));
    // The label sits past the end of the bar, or inside it once there is no room.
    const words = `${label}: ${count} ${count === 1 ? 'check' : 'checks'}`;
    const inside = width > SPAN * 0.55;
    out.push(text(`${id}-label`, inside ? LEFT + width - 16 : LEFT + width + 16, y + 22, words, { size: 28, valign: 'middle', align: inside ? 'right' : 'left', color: tone.stroke, ...invisible }));
  };
  bar('binary', barY, checks.length, 'this search', color.blue);
  bar('scan', barY + 62, scan, 'reading left to right', color.gray);
  out.push(rect('scale', LEFT, barY - 10, SPAN, 126, { strokeColor: color.muted, strokeStyle: 'dashed', strokeWidth: 1, backgroundColor: 'transparent', roundness: null, ...invisible }));
  out.push(text('scale-t', RIGHT, barY + 122, `the dashed box is all ${s.n} numbers`, { size: 22, align: 'right', color: color.muted, ...invisible }));
  return out;
}

const update = (options) => stage.show(view(state), { stagger: 0, morphSeconds: 0.2, ...options });

const setFromX = (x) => {
  state.at = Math.max(0, Math.min(1, (x - LEFT) / SPAN));
  state.touched = true;
  update();
};

stage.on('drag', 'knob', ({ x }) => setFromX(x));
stage.on('click', '*', ({ id, x }) => {
  if (!id) return;
  const size = /^n(\d+)$/.exec(id);
  if (size) { state.n = +size[1]; update(); return; }
  // Clicking a number makes it the target.
  const cell = /^r\d+-b(\d+)$/.exec(id);
  if (cell) {
    state.at = valuesFor(state.n)[+cell[1]] / (state.n * STEP);
    state.touched = true;
    update();
  }
});
addEventListener('keydown', (e) => {
  const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (!delta) return;
  state.at = Math.max(0, Math.min(1, (targetOf(state) + delta) / (state.n * STEP)));
  state.touched = true;
  update();
});

update({ stagger: 0.002 });
window.app = { stage, state, targetOf, search, valuesFor, update };
