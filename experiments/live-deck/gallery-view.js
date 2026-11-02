// The gallery as drawn: the wall of approved drawings, the phone's drawing pad, and
// the presenter's review list. Drawings come from strangers, so they only ever reach
// a page as numbers drawn on a canvas.

import { color, rect, text } from '/lib/draw.js';
import { drawElement } from '/lib/render.js';
import { BOX, LIMITS } from './gallery.js';
import { pointers } from './touch.js';
import { wrap } from './words.js';

const ghost = (extra = {}) => ({ customData: { handwave: { ghost: true, ...extra } } });
const WALL = { x: 60, y: 168, w: 1480, h: 705 };

/** A drawing's strokes as freehand elements inside a box. */
export function strokeElements(strokes, prefix, x, y, w, h, extra = () => ({})) {
  const scale = Math.min(w / BOX.width, h / BOX.height);
  const ox = x + (w - BOX.width * scale) / 2, oy = y + (h - BOX.height * scale) / 2;
  return strokes.map((stroke, k) => {
    const [x0, y0] = stroke[0];
    return {
      id: `${prefix}-${k}`, type: 'freedraw', x: ox + x0 * scale, y: oy + y0 * scale, width: 0, height: 0, angle: 0, seed: 1, opacity: 100,
      strokeColor: color.ink, backgroundColor: 'transparent', strokeWidth: Math.max(0.9, scale * 1.6), simulatePressure: true,
      points: stroke.length > 1 ? stroke.map(([px, py]) => [(px - x0) * scale, (py - y0) * scale]) : [[0, 0], [0.5, 0.5]],
      ...extra(k),
    };
  });
}

// The largest frames that fit this many drawings on the wall.
function wallLayout(count) {
  let best = null;
  for (let cols = 1; cols <= 8; cols++) {
    const rows = Math.ceil(count / cols);
    const w = Math.min(WALL.w / cols, (WALL.h / rows) * (BOX.width / BOX.height));
    if (!best || w > best.w) best = { cols, rows, w, h: w * (BOX.height / BOX.width) };
  }
  return best;
}

function slide(step, { slide: s, state, info }) {
  const live = state.live[s.id] ?? {};
  const shown = live.shown ?? [];
  const waiting = live.waiting ?? 0;
  const out = [text(`${s.id}-title`, 80, 44, s.title, { size: 56, font: 6 })];
  out.push(text(`${s.id}-count`, 1520, 118, waiting ? `${waiting} waiting for the presenter` : `${shown.length} on the wall`, { size: 30, align: 'right', color: color.muted, ...ghost({ enter: 'fade', change: 'none' }) }));
  out.push(text(`${s.id}-join`, 84, 118, `Join: ${info.joinUrl}`, { size: 28, color: color.muted, ...ghost({ enter: 'fade', change: 'none' }) }));
  if (!shown.length) {
    out.push(text(`${s.id}-empty`, 800, 480, 'Draw on your phone.\nThe presenter picks what appears here.', { size: 44, align: 'center', valign: 'middle', color: color.muted, ...ghost({ enter: 'fade' }) }));
    return out;
  }
  const { cols, w, h } = wallLayout(shown.length);
  const gap = 12;
  const left = WALL.x + (WALL.w - cols * w) / 2;
  shown.forEach((item, i) => {
    const x = left + (i % cols) * w, y = WALL.y + Math.floor(i / cols) * h;
    out.push(rect(`fr-${item.id}`, x + gap / 2, y + gap / 2, w - gap, h - gap, { tone: { fill: '#ffffff', stroke: color.muted }, roundness: null, ...ghost() }));
    // A replay keeps the place of a drawing that was taken down, without the drawing.
    if (!item.strokes.length) out.push(text(`fr-${item.id}-t`, x + w / 2, y + h / 2, 'Taken down', { size: Math.min(36, w / 8), align: 'center', valign: 'middle', color: color.muted, ...ghost({ enter: 'fade' }) }));
    // A new drawing arrives stroke by stroke, in the order it was drawn. The stroke ids
    // carry the layout because the renderer keeps a freehand shape per id.
    const newest = i === shown.length - 1;
    out.push(...strokeElements(item.strokes, `dr-${item.id}-${cols}`, x + gap, y + gap, w - gap * 2, h - gap * 2, (k) => ghost(newest ? { enter: 'fade', seconds: 0.06, delay: Math.min(0.9, k * 0.05) } : { enter: 'none', change: 'none' })));
  });
  return out;
}

// ---------------------------------------------------------------------------
// The presenter's list. Only the presenter's page ever holds what is in it.

function thumbnail(item, width) {
  const dpr = window.devicePixelRatio || 1;
  const height = Math.round((width * BOX.height) / BOX.width);
  const canvas = document.createElement('canvas');
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  for (const el of strokeElements(item.strokes, `th-${item.id}-${width}`, 2, 2, width - 4, height - 4)) drawElement(ctx, el);
  return canvas;
}

// A presenter who mirrors their screen would show the room this panel, so unreviewed
// drawings stay hidden until the presenter says the room cannot see this window.
let revealed = false;

function panel(root, context) {
  const { slide: s, state, commit } = context;
  const waiting = state.review[s.id] ?? [];
  const shown = state.live[s.id]?.shown ?? [];
  root.replaceChildren();
  const heading = document.createElement('h2');
  heading.textContent = `Drawings waiting: ${waiting.length}`;
  root.append(heading);
  const button = (label, action, act) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.action = action;
    b.addEventListener('click', () => { act(); b.blur(); });
    return b;
  };
  if (!revealed) {
    const warn = document.createElement('p');
    warn.className = 'warn';
    warn.textContent = 'Unreviewed drawings appear here. If this window is on the projector, the room sees them too.';
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(button('The room cannot see this window', 'reveal', () => { revealed = true; panel(root, context); }));
    root.append(warn, actions);
  } else if (waiting.length) {
    const first = waiting[0];
    const card = document.createElement('div');
    card.className = 'review-card';
    card.dataset.drawing = first.id;
    card.append(thumbnail(first, 284));
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(button('Approve (A)', 'approve', () => commit({ t: 'gal-ok', id: first.id })), button('Reject (R)', 'reject', () => commit({ t: 'gal-no', id: first.id })));
    card.append(actions);
    root.append(card);
    const rest = document.createElement('div');
    rest.className = 'thumbs';
    for (const item of waiting.slice(1, 13)) rest.append(thumbnail(item, 92));
    root.append(rest);
    if (waiting.length > 13) {
      const more = document.createElement('p');
      more.textContent = `and ${waiting.length - 13} more`;
      root.append(more);
    }
  }
  if (shown.length) {
    const label = document.createElement('h2');
    label.textContent = `On the wall: ${shown.length}. Click one to take it down.`;
    root.append(label);
    const wall = document.createElement('div');
    wall.className = 'thumbs';
    for (const item of shown) {
      const b = button('', 'pull', () => commit({ t: 'gal-pull', id: item.id }));
      b.className = 'thumb-button';
      b.append(thumbnail(item, 92));
      wall.append(b);
    }
    root.append(wall);
  }
}

const panelKey = (state, s) => JSON.stringify([revealed, (state.review[s.id] ?? []).map((k) => k.id), (state.live[s.id]?.shown ?? []).map((k) => k.id)]);

/** A and R act on the drawing at the top of the list. */
function key(e, { slide: s, state, commit }) {
  const first = state.review[s.id]?.[0];
  // Cmd-R reloads a page. It must not also reject a drawing.
  if (!first || !revealed || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.key === 'a') { commit({ t: 'gal-ok', id: first.id }); return true; }
  if (e.key === 'r') { commit({ t: 'gal-no', id: first.id }); return true; }
  return false;
}

// ---------------------------------------------------------------------------
// The phone.

function startPhone({ stage, canvas, link, width, redraw, slide: s }) {
  let you = null;
  let strokes = [];
  let current = null;
  let serial = 0;      // Stroke ids stay unique across clears, as the renderer keeps a shape per id.
  let total = 0;
  let note = '';

  const pad = () => {
    const w = width - 32, h = (w * BOX.height) / BOX.width;
    return { x: 16, y: 130, w, h };
  };
  // The buttons sit at the bottom, where a thumb is.
  const buttons = () => {
    const y = stage.height - 104;
    return { clear: { x: 16, y, w: 130, h: 88 }, send: { x: 162, y, w: width - 178, h: 88 } };
  };
  const inside = (z, p) => p.x >= z.x && p.x <= z.x + z.w && p.y >= z.y && p.y <= z.y + z.h;

  const say = (words) => { note = words; redraw(); };

  const send = () => {
    if (!strokes.length) { say('Draw something first.'); return; }
    link.send({ t: 'act-submit', slide: s.id, strokes: strokes.filter((k) => k.points.length).map((k) => k.points) });
    say(link.status === 'live' ? 'Sending…' : 'Saved. It will send when the connection returns.');
  };

  const stopPointers = pointers(canvas, stage, (held, e) => {
    if (!e) return;
    const p = held[0];
    const z = pad();
    if (e.type === 'pointerdown' && p) {
      const b = buttons();
      if (inside(b.clear, p)) { strokes = []; total = 0; say(''); return; }
      if (inside(b.send, p)) { send(); return; }
      if (inside(z, p) && total < LIMITS.points && strokes.length < LIMITS.strokes) {
        current = { key: serial++, points: [] };
        strokes.push(current);
      }
    }
    if (e.type === 'pointerup' || e.type === 'pointercancel') { current = null; redraw(); return; }
    if (!current || !p) return;
    const scale = BOX.width / z.w;
    const point = [Math.round(Math.max(0, Math.min(BOX.width, (p.x - z.x) * scale))), Math.round(Math.max(0, Math.min(BOX.height, (p.y - z.y) * scale)))];
    const last = current.points.at(-1);
    if (last && Math.hypot(point[0] - last[0], point[1] - last[1]) < 4) return;
    if (total >= LIMITS.points) { current = null; say('That is all the ink a drawing can hold. Send it.'); return; }
    current.points.push(point);
    total++;
    redraw();
  });

  return {
    hideAsk: true,
    you(data) { you = data; redraw(); },
    ack(op, ack) {
      if (op.t !== 'act-submit') return;
      if (ack.duplicate || ack.result === 'ok') { strokes = []; total = 0; say(''); return; }
      say({ 'too soon': 'Wait a moment, then send it again.', closed: 'This slide has moved on.', full: 'Too many are waiting. Try again in a moment.' }[ack.result] ?? 'That could not be sent.');
    },
    stop() { stopPointers(); },
    get strokes() { return strokes; },
    get state() { return you; },
    get note() { return note; },
    elements() {
      const z = pad();
      const b = buttons();
      const live = ghost({ enter: 'none', change: 'none' });
      const prompt = wrap(s.activity.prompt, width - 48, 32, 6);
      const out = [text(`gal-prompt`, 24, 20, prompt, { size: 32, font: 6, customData: { handwave: { ghost: true, enter: 'fade' } } })];
      out.push(rect('gal-pad', z.x, z.y, z.w, z.h, { tone: { fill: '#ffffff', stroke: color.ink }, roundness: null, ...ghost() }));
      const kept = strokes.filter((k) => k.points.length);
      const [ox, oy] = [z.x, z.y];
      const scale = z.w / BOX.width;
      for (const stroke of kept) {
        const [x0, y0] = stroke.points[0];
        out.push({ id: `gal-s-${stroke.key}`, type: 'freedraw', x: ox + x0 * scale, y: oy + y0 * scale, width: 0, height: 0, angle: 0, seed: 1, opacity: 100, strokeColor: color.ink, backgroundColor: 'transparent', strokeWidth: 1.2, simulatePressure: true, points: stroke.points.length > 1 ? stroke.points.map(([px, py]) => [(px - x0) * scale, (py - y0) * scale]) : [[0, 0], [0.5, 0.5]], ...live });
      }
      out.push(rect('gal-clear', b.clear.x, b.clear.y, b.clear.w, b.clear.h, { tone: { fill: '#ffffff', stroke: color.ink }, ...ghost() }));
      out.push(text('gal-clear-t', b.clear.x + b.clear.w / 2, b.clear.y + b.clear.h / 2, 'Clear', { size: 34, align: 'center', valign: 'middle', ...ghost({ enter: 'fade' }) }));
      out.push(rect('gal-send', b.send.x, b.send.y, b.send.w, b.send.h, { tone: color.green, ...ghost() }));
      out.push(text('gal-send-t', b.send.x + b.send.w / 2, b.send.y + b.send.h / 2, 'Send', { size: 40, align: 'center', valign: 'middle', color: color.green.stroke, ...ghost({ enter: 'fade' }) }));
      const told = note || (you?.said === 'shown' ? (you.onWall ? 'Your drawing is on the big screen.' : 'Your drawing had its turn on the big screen.') : you?.said === 'declined' ? 'The presenter passed on that one. You can send another.' : you?.said === 'removed' ? 'The presenter took your drawing down.' : you?.waiting ? 'Sent. The presenter decides what goes on screen. You can draw another.' : 'Draw with your finger.');
      out.push(text('gal-note', 24, z.y + z.h + 16, wrap(told, width - 48, 30), { size: 30, color: you?.said === 'shown' && !note ? color.green.stroke : color.muted, ...ghost({ enter: 'fade', change: 'none' }) }));
      return out;
    },
  };
}

export const galleryView = { slide, startPhone, panel, panelKey, key, stagger: 0 };
