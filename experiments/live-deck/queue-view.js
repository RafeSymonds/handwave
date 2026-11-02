// The queue as drawn. A job keeps its id from the line to a worker's desk, so the
// stage moves it there, and the whole line steps forward when the front leaves.

import { arrow, color, line, rect, text } from '/lib/draw.js';
import { pointers } from './touch.js';
import { wrap } from './words.js';

const ghost = (extra = {}) => ({ customData: { handwave: { ghost: true, ...extra } } });
const fixed = ghost({ enter: 'fade', change: 'none' });

const JOB = 22, PITCH = 30, PER_ROW = 32, LINE_RIGHT = 1030, LINE_BOTTOM = 470;
const GRID = { x: 1110, y: 214, w: 450, h: 280 };
const CHART = { x: 90, y: 600, w: 1450, h: 250 };
const WORDS = [
  'Jobs arrive at 50% of what this room can finish. Tap your phone to finish one.',
  'Now 90%. That leaves little room for anyone to slow down. Watch the line.',
  'Stop tapping. Everyone count to ten.',
  'Start tapping again. Back to 50%. How long until the line clears?',
];
const STATES = [color.gray, color.green, color.rose, { fill: '#ffffff', stroke: color.muted }];

function jobPlace(index) {
  const row = Math.floor(index / PER_ROW);
  return [LINE_RIGHT - (index % PER_ROW) * PITCH - JOB, LINE_BOTTOM - row * PITCH - JOB];
}

const jobBox = (id, x, y) => rect(`job-${id}`, x, y, JOB, JOB, { tone: color.amber, roundness: null, strokeWidth: 1.5, seed: (id % 7) + 1, ...ghost({ enter: 'fade', seconds: 0.1 }) });

function gridOf(count) {
  const ratio = GRID.w / GRID.h;
  const cols = Math.max(1, Math.ceil(Math.sqrt(count * ratio)));
  const rows = Math.max(1, Math.ceil(count / cols));
  const cell = Math.min(GRID.w / cols, GRID.h / rows, 92);
  return { cols, cell };
}

function chart(frame) {
  const out = [];
  const { history = [], marks = [] } = frame;
  const { x, y, w, h } = CHART;
  out.push(line('q-axis-y', [[x, y], [x, y + h]], { strokeColor: color.muted, ...fixed }));
  out.push(line('q-axis-x', [[x, y + h], [x + w, y + h]], { strokeColor: color.muted, ...fixed }));
  out.push(text('q-axis-k', x + w, y - 34, 'Jobs waiting over time', { size: 26, align: 'right', color: color.muted, ...fixed }));
  if (history.length < 2) return out;
  const t0 = history[0][0], t1 = Math.max(t0 + 60, history.at(-1)[0]);
  const peak = Math.max(20, ...history.map((p) => p[1]));
  const sx = (t) => x + ((t - t0) / (t1 - t0)) * w;
  const sy = (v) => y + h - (v / peak) * (h - 16);
  out.push(text('q-peak', x - 10, sy(peak), String(peak), { size: 26, align: 'right', valign: 'middle', color: color.muted, ...fixed }));
  marks.forEach(([at, label], i) => {
    if (at < t0) return;
    // Labels sit above the plot, where the line can never reach them.
    out.push(line(`q-mark-${i}`, [[sx(at), y - 8], [sx(at), y + h]], { strokeColor: color.muted, strokeStyle: 'dashed', strokeWidth: 1, roughness: 0, ...fixed }));
    out.push(text(`q-mark-${i}-t`, sx(at) + 8, y - 34, label, { size: 28, color: color.muted, ...fixed }));
  });
  // Roughness zero: a rough line would redraw itself each time a point is added.
  out.push(line('q-history', history.map(([t, v]) => [sx(t), sy(v)]), { strokeColor: color.rose.stroke, strokeWidth: 3, roughness: 0, ...ghost({ enter: 'none', change: 'none' }) }));
  return out;
}

function slide(step, { slide: s, state, info }) {
  const frame = state.live[s.id];
  const out = [
    text(`${s.id}-title`, 80, 44, s.title, { size: 60, font: 6 }),
    text(`${s.id}-join`, 1520, 66, `Join: ${info.joinUrl}`, { size: 28, align: 'right', color: color.muted, ...fixed }),
    text(`${s.id}-line`, 84, 126, WORDS[step], { size: 34, color: step === 2 ? color.rose.stroke : color.ink, ...fixed }),
  ];
  if (!frame) return out;
  const { workers, line: waiting } = frame;
  const beyond = frame.waiting - waiting.length;
  const oldest = frame.oldest ? `, the oldest for ${frame.oldest} s` : '';
  out.push(text('q-waiting', 80, 180, `${frame.waiting} waiting${oldest}${beyond > 0 ? `. ${beyond} more do not fit here.` : ''}`, { size: 40, color: frame.waiting > 40 ? color.rose.stroke : color.ink, ...fixed }));
  out.push(text('q-done', 1110, 170, `Finished ${frame.finished}. Turned away ${frame.turnedAway}.`, { size: 28, color: color.muted, ...fixed }));
  // The line has a place even when it is empty, so its growth has something to start from.
  out.push(line('q-floor', [[80, LINE_BOTTOM + 8], [LINE_RIGHT, LINE_BOTTOM + 8]], { strokeColor: color.muted, strokeStyle: 'dashed', strokeWidth: 1, ...fixed }));
  out.push(text('q-floor-k', 80, LINE_BOTTOM + 16, 'The line. New jobs join on the left, and the front is on the right.', { size: 26, color: color.muted, ...fixed }));
  out.push(arrow('q-arrow', [[LINE_RIGHT + 8, LINE_BOTTOM - JOB / 2], [GRID.x - 8, LINE_BOTTOM - JOB / 2]], { strokeColor: color.muted, ...ghost() }));
  waiting.forEach((id, i) => { const [x, y] = jobPlace(i); out.push(jobBox(id, x, y)); });

  const { cols, cell } = gridOf(workers.length);
  workers.forEach(([number, job, kind], i) => {
    const x = GRID.x + (i % cols) * cell, y = GRID.y + Math.floor(i / cols) * cell;
    const tone = STATES[kind];
    const size = cell - 6;
    out.push(rect(`w-${number}`, x, y, size, size, { tone, roundness: null, strokeStyle: kind === 3 ? 'dashed' : 'solid', opacity: kind === 3 ? 50 : 100, ...ghost({ enter: 'fade' }) }));
    if (cell >= 40) out.push(text(`w-${number}-t`, x + 6, y + 4, String(number), { size: Math.min(24, cell * 0.36), color: tone.stroke, ...fixed }));
    if (job) out.push(jobBox(job, x + size - JOB - 4, y + size - JOB - 4));
  });
  out.push(text('q-key', GRID.x, 500, 'Green has a job. Gray is idle.\nRed has stopped tapping.', { size: 24, color: color.muted, ...fixed }));
  out.push(...chart(frame));
  return out;
}

// ---------------------------------------------------------------------------

function startPhone({ stage, canvas, link, width, redraw }) {
  let you = null;

  const zone = () => ({ x: 16, y: 230, w: width - 32, h: stage.height - 246 });

  const stopPointers = pointers(canvas, stage, (held, e) => {
    if (!you || !e || e.type !== 'pointerdown') return;
    const z = zone();
    const p = held.at(-1);
    if (!p || p.x < z.x || p.x > z.x + z.w || p.y < z.y || p.y > z.y + z.h) return;
    if (you.job) {
      link.sendNow({ t: 'act', job: you.job });
      // Show it at once. The server's next word replaces this.
      you = { ...you, job: 0, resting: true, finished: you.finished + 1 };
      redraw();
    } else if (you.stalled) {
      link.sendNow({ t: 'act', job: 0 });
      you = { ...you, stalled: false };
      redraw();
    }
  });

  return {
    hideAsk: true,
    you(data) { you = data; redraw(); },
    stop() { stopPointers(); },
    get state() { return you; },
    elements() {
      if (!you || you.full) return [text('q-wait', 24, 60, you?.full ? 'All the desks are taken.\nWatch the big screen.' : 'Finding you a desk…', { size: 34 })];
      const z = zone();
      const stopping = you.step === 2;
      // While the room is asked to stop, nothing on the card says to tap.
      const card = you.job ? { tone: color.green, words: stopping ? `Job ${you.job}\nLeave it.` : `Job ${you.job}\nTap to finish` }
        : you.stalled ? { tone: color.rose, words: stopping ? 'You stopped.\nThe line is growing.' : 'You stopped. Tap to start again.' }
        : you.resting ? { tone: color.blue, words: 'Done.\nNext job soon.' }
        : { tone: color.gray, words: 'Nothing to do.\nThe line is empty.' };
      return [
        text('q-you', 24, 26, `Worker ${you.number}`, { size: 44, font: 6, ...fixed }),
        text('q-stats', 24, 88, `Finished ${you.finished}. In line: ${you.waiting}.`, { size: 30, color: color.muted, ...fixed }),
        text('q-order', 24, 150, stopping ? 'Stop tapping now.' : ' ', { size: 44, color: color.rose.stroke, ...fixed }),
        rect('q-tap', z.x, z.y, z.w, z.h, { tone: card.tone, strokeWidth: 3, ...ghost({ change: 'none' }) }),
        text('q-tap-t', z.x + z.w / 2, z.y + z.h / 2, card.words.split('\n').map((l) => wrap(l, z.w - 40, 46)).join('\n'), { size: 46, align: 'center', valign: 'middle', color: card.tone.stroke, ...ghost({ enter: 'none', change: 'none' }) }),
      ];
    },
  };
}

export const queueView = { slide, startPhone, morphSeconds: 0.12, drawEveryFrame: true, stagger: 0 };
