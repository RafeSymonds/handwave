// The replay slide: what the room has recorded so far, from the server's log.

import { color, rect, text } from '/lib/draw.js';
import { SLIDES } from './meta.js';

const ghost = (extra = {}) => ({ customData: { handwave: { ghost: true, ...extra } } });
const TRACK = { x: 80, y: 560, w: 1440, h: 90 };

function slide(step, { slide: s, state }) {
  const out = [text(`${s.id}-title`, 80, 52, s.title, { size: 60, font: 6 })];
  const log = state.live[s.id];
  out.push(text(`${s.id}-sub`, 84, 146, 'Not a video. The same changes, played back through the same code.', { size: 38, color: color.muted, ...ghost({ enter: 'fade' }) }));
  if (!log) return out;
  const rows = [
    [`${log.changes}`, 'changes logged'],
    [`${log.votes}`, 'vote counts'],
    [`${log.strokes}`, 'ink strokes'],
    [`${log.drawings}`, 'approved drawings'],
    [`${log.frames}`, 'activity frames'],
  ];
  rows.forEach(([n, label], i) => {
    const x = 80 + i * 292;
    out.push(text(`log-n-${i}`, x, 250, n, { size: 76, font: 6, color: color.amber.stroke, ...ghost({ enter: 'fade', change: 'none' }) }));
    out.push(text(`log-k-${i}`, x, 348, label, { size: 30, color: color.muted, ...ghost({ enter: 'fade' }) }));
  });
  const total = Math.max(1, log.spans.at(-1)?.[2] ?? 1);
  const first = log.spans[0]?.[1] ?? 0;
  out.push(text('log-track-k', TRACK.x, TRACK.y - 50, 'Time on each slide', { size: 30, color: color.muted, ...ghost({ enter: 'fade' }) }));
  log.spans.forEach(([index, from, to], i) => {
    const x = TRACK.x + ((from - first) / (total - first)) * TRACK.w;
    const w = Math.max(3, ((to - from) / (total - first)) * TRACK.w);
    const live = Boolean(SLIDES[index]?.activity);
    out.push(rect(`log-span-${i}`, x, TRACK.y, w, TRACK.h, { tone: live ? color.amber : color.gray, roundness: null, ...ghost({ enter: 'fade', change: 'none' }) }));
    if (w > 28) out.push(text(`log-span-${i}-t`, x + w / 2, TRACK.y + TRACK.h / 2, String(index + 1), { size: 26, align: 'center', valign: 'middle', color: live ? color.amber.stroke : color.muted, ...ghost({ enter: 'fade', change: 'none' }) }));
  });
  out.push(text('log-track-note', TRACK.x, TRACK.y + TRACK.h + 18, 'Numbers are slides. Amber slides are the ones you took part in.', { size: 30, color: color.muted, ...ghost({ enter: 'fade' }) }));
  return out;
}

export const logView = { slide, stagger: 0 };
