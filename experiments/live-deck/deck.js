// The slides. Each view is a function from (step, live data) to elements, with
// stable ids, so moving between steps morphs what stays and draws what is new.
// scene() then lays the off-script layer on top: offsets, ink and any question.

import { qrElement } from './qr.js';
import { arrow, box, color, diamond, ellipse, line, rect, text } from '/lib/draw.js';
import { measure } from '/lib/stage.js';
import { SLIDES } from './meta.js';

const INK = color.rose.stroke;

const titled = (slide, size = 60) => text(`${slide.id}-title`, 80, 52, slide.title, { size, font: 6 });
const quiet = { customData: { handwave: { ghost: true } } };

/** Break words into lines that fit a width. A word too long for a line is split. */
export function wrap(words, width, size, font = 5) {
  const lines = [];
  let current = '';
  const fits = (s) => measure(s, size, font).width <= width;
  for (let word of String(words).split(/\s+/).filter(Boolean)) {
    while (!fits(word)) {
      let cut = word.length - 1;
      while (cut > 1 && !fits((current ? `${current} ` : '') + word.slice(0, cut))) cut--;
      lines.push((current ? `${current} ` : '') + word.slice(0, cut));
      current = '';
      word = word.slice(cut);
    }
    const next = current ? `${current} ${word}` : word;
    if (fits(next)) current = next;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines.join('\n');
}

/** An arrow that follows the shapes it joins when they are dragged off script. */
const link = (id, from, to, points, o = {}) => arrow(id, points, { ...o, customData: { live: { from, to } } });
/** Words on an arrow, which keep halfway between what the arrow joins. */
const linkLabel = (id, owner, between, x, y, words, o = {}) => text(id, x, y, words, { size: 28, align: 'center', ...o, customData: { live: { with: owner, between } } });

// ---------------------------------------------------------------------------

const VIEWS = {
  title(step, { slide, info, state }) {
    const phones = state.counts.phones;
    return [
      text('title-title', 80, 150, slide.title, { size: 84, font: 6 }),
      text('title-sub', 84, 268, 'Hand-drawn, live, and your phone is part of it.', { size: 40, color: color.muted }),
      // With a code to scan, the card makes room for it and the address fits what is left.
      rect('join', 80, 400, info.qr ? 990 : 1130, 250, { tone: color.amber }),
      text('join-label', 124, 428, info.qr ? 'Scan this, or open the address' : 'Open this on your phone', { size: 40, color: color.amber.stroke, customData: { live: { with: 'join' } } }),
      text('join-url', 124, 500, info.joinUrl, { size: info.qr ? Math.min(46, 900 / (info.joinUrl.length * 0.6)) : 52, font: 3, color: color.ink, customData: { live: { with: 'join' }, handwave: { seconds: 0.5 } } }),
      info.reachable
        ? text('join-note', 124, 582, 'Same wifi as this laptop.', { size: 28, color: color.muted, customData: { live: { with: 'join' } } })
        : text('join-note', 124, 582, 'Phones cannot reach this yet. Restart with: HOST=0.0.0.0 npm start', { size: 28, color: color.rose.stroke, customData: { live: { with: 'join' } } }),
      ...(info.qr ? [qrElement('join-qr', 1100, 262, 460)] : []),
      text('join-count', 84, 700, `${phones} ${phones === 1 ? 'phone' : 'phones'} connected`, { size: 44, color: phones ? color.green.stroke : color.muted }),
    ];
  },

  states(step, { slide, state }) {
    const out = [titled(slide)];
    out.push(...box('state', 80, 200, 360, 170, `state\nslide ${state.index + 1}, step ${state.step + 1}`, { tone: color.amber, size: 36 }));
    if (step >= 1) {
      out.push(link('state-view', 'state', 'view', [[452, 285], [588, 285]], { strokeColor: color.muted }));
      out.push(...box('view', 600, 200, 360, 170, 'view(state)\nbuilds the drawing', { tone: color.blue, size: 36 }));
    }
    if (step >= 2) {
      out.push(link('view-show', 'view', 'show', [[972, 285], [1108, 285]], { strokeColor: color.muted }));
      out.push(...box('show', 1120, 200, 400, 170, 'stage.show(drawing)\nmoves it into place', { tone: color.green, size: 36 }));
      out.push(text('rules', 80, 430, 'Between two states, the ids decide what happens:', { size: 38 }));
      const moved = step >= 3;
      out.push(...box('demo', moved ? 520 : 120, 540, 280, 170, moved ? 'same id:\nit moved' : 'same id', { tone: moved ? color.green : color.blue, size: 36 }));
    }
    if (step === 2) {
      out.push(ellipse('old', 880, 530, 300, 190, { tone: color.gray }));
      out.push(text('old-t', 1030, 625, 'gone next', { size: 36, align: 'center', valign: 'middle', color: color.gray.stroke, ...quiet }));
    }
    if (step >= 3) {
      out.push(diamond('fresh', 1110, 500, 410, 250, { tone: color.amber }));
      out.push(text('fresh-t', 1315, 625, 'new id:\nit drew on', { size: 36, align: 'center', valign: 'middle', color: color.amber.stroke, customData: { live: { with: 'fresh' }, handwave: { ghost: true } } }));
    }
    return out;
  },

  survive: votingSlide((slide) => [text('survive-answer', 80, 710, 'All of it. The phone only holds a copy,\nand the server keeps the original.', { size: 44, color: color.green.stroke })]),

  room(step, { slide, state }) {
    const connected = state.counts.phones + state.counts.screens;
    const out = [titled(slide)];
    out.push(...box('hall', 620, 230, 360, 360, `Room\n\n${connected} connected`, { tone: color.blue, size: 40 }));
    out.push(...box('speaker', 80, 330, 300, 160, 'Presenter', { tone: color.amber, size: 40 }));
    out.push(link('speaker-hall', 'speaker', 'hall', [[392, 410], [608, 410]], { strokeColor: color.amber.stroke }));
    out.push(linkLabel('speaker-hall-t', 'speaker-hall', ['speaker', 'hall'], 500, 362, 'next, drag, ink', { color: color.amber.stroke }));
    if (step >= 1) {
      out.push(...box('screen', 1220, 230, 300, 130, 'Screen', { tone: color.gray, size: 40 }));
      out.push(...box('phones', 1220, 460, 300, 130, 'Phones', { tone: color.green, size: 40 }));
      out.push(link('hall-screen', 'hall', 'screen', [[992, 295], [1208, 295]], { strokeColor: color.blue.stroke }));
      out.push(link('hall-phones', 'hall', 'phones', [[992, 495], [1208, 495]], { strokeColor: color.blue.stroke }));
      out.push(linkLabel('hall-screen-t', 'hall-screen', ['hall', 'screen'], 1100, 248, 'each change', { color: color.blue.stroke }));
      out.push(linkLabel('hall-phones-t', 'hall-phones', ['hall', 'phones'], 1100, 448, 'each change', { color: color.blue.stroke }));
    }
    if (step >= 2) {
      out.push(link('phones-hall', 'phones', 'hall', [[1208, 555], [992, 555]], { strokeColor: color.green.stroke }));
      out.push(linkLabel('phones-hall-t', 'phones-hall', ['hall', 'phones'], 1100, 566, 'votes, questions', { size: 25, color: color.green.stroke }));
    }
    if (step >= 3) {
      out.push(...box('late', 1220, 690, 300, 120, 'Late or back\nonline', { tone: color.gray, size: 36, strokeStyle: 'dashed' }));
      out.push(link('hall-late', 'hall', 'late', [[800, 602], [800, 750], [1208, 750]], { strokeColor: color.blue.stroke }));
      out.push(linkLabel('hall-late-t', 'hall-late', ['hall', 'late'], 1010, 702, 'a full copy first', { color: color.blue.stroke }));
      out.push(text('room-point', 80, 700, 'Nobody has to catch up\nby replaying the talk.', { size: 40, color: color.amber.stroke }));
    }
    return out;
  },

  layer(step, { slide, state }) {
    const HOME = [140, 250];
    const [dx, dy] = state.offsets[slide.id]?.['drag-me'] ?? [0, 0];
    const round = (v) => Math.round(v);
    const out = [titled(slide)];
    out.push(rect('home-mark', HOME[0], HOME[1], 340, 190, { strokeColor: color.muted, strokeStyle: 'dashed', strokeWidth: 1, backgroundColor: 'transparent', ...quiet }));
    const rows = [['scripted', `${HOME[0]}, ${HOME[1]}`, color.muted], ['+ offset', `${round(dx)}, ${round(dy)}`, dx || dy ? INK : color.muted], ['= shown', `${HOME[0] + round(dx)}, ${HOME[1] + round(dy)}`, color.ink]];
    rows.forEach(([label, value, ink], i) => {
      out.push(text(`calc-${i}`, 760, 250 + i * 66, label, { size: 40, font: 3, color: color.muted, customData: { live: { with: 'calc' }, handwave: { enter: 'fade' } } }));
      out.push(text(`calc-${i}-v`, 1050, 250 + i * 66, value, { size: 40, font: 3, color: ink, customData: { live: { with: 'calc' }, handwave: { enter: 'fade', change: 'none' } } }));
    });
    if (step >= 1) out.push(text('layer-esc', 140, 620, 'Esc clears the layer. Everything morphs home and the ink leaves.', { size: 40 }));
    if (step >= 2) out.push(text('layer-next', 140, 700, 'Next leaves the layer with its slide. Come back and it is still there.', { size: 40 }));
    // On top of the rest, so it can be dragged anywhere and still be seen.
    out.push(...box('drag-me', HOME[0], HOME[1], 340, 190, 'Drag me', { tone: color.amber, size: 44 }));
    return out;
  },

  end: votingSlide(() => [text('end-floor', 80, 690, 'Questions?', { size: 84, font: 6, color: color.amber.stroke }), text('end-floor-note', 84, 800, 'Send yours from your phone.', { size: 38, color: color.muted })], { rowHeight: 120 }),
};

// The chart a voting slide is built around. The bars share a scale that only
// shrinks when the longest would run out of room, so each vote visibly adds length.
function votingSlide(afterClose, { rowHeight = 125 } = {}) {
  return (step, ctx) => {
    const { slide, state, info } = ctx;
    const { options, closeAt, answer } = slide.vote;
    const counts = state.tallies[slide.id] ?? options.map(() => 0);
    const total = counts.reduce((a, b) => a + b, 0);
    const closed = step >= closeAt;
    const X = 540, MAX = 860, TOP = 190, BAR = 74;
    const unit = Math.min(76, MAX / Math.max(1, ...counts));
    const out = [titled(slide)];
    const totalId = `${slide.id}-total`;
    out.push(text(totalId, 1520, 74, `${total} ${total === 1 ? 'vote' : 'votes'}`, { size: 38, align: 'right', color: color.muted }));
    out.push(line(`${slide.id}-axis`, [[X, TOP - 10], [X, TOP + options.length * rowHeight - 20]], { strokeColor: color.muted, ...quiet }));
    options.forEach((option, i) => {
      const owner = `${slide.id}-row${i}`;
      const tone = closed && answer !== undefined ? (i === answer ? color.green : color.gray) : color.blue;
      const y = TOP + i * rowHeight;
      const width = Math.max(4, counts[i] * unit);
      const row = { customData: { live: { with: owner } } };
      out.push(text(`${owner}-label`, X - 24, y + BAR / 2, option, { size: 40, align: 'right', valign: 'middle', color: tone === color.gray ? color.muted : color.ink, ...row }));
      out.push(rect(`${owner}-bar`, X, y, width, BAR, { tone, roundness: null, ...row }));
      out.push(text(`${owner}-count`, X + width + 18, y + BAR / 2, String(counts[i]), { size: 44, valign: 'middle', color: tone.stroke, customData: { live: { with: owner }, handwave: { enter: 'fade' } } }));
    });
    if (closed) out.push(...afterClose(slide));
    else {
      out.push(text(`${slide.id}-join`, 80, 800, `Vote on your phone: ${info.joinUrl}`, { size: 32, color: color.muted }));
      if (info.qr) out.push(qrElement(`${slide.id}-qr`, 1340, 670, 220));
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// The off-script layer.

/** What an element moves with when dragged: its own id, or the thing it belongs to. */
export function ownerOf(el) {
  return el.customData?.live?.with ?? (el.id.endsWith('-t') ? el.id.slice(0, -2) : el.id);
}

function applyOffsets(elements, offsets) {
  const of = (id) => offsets[id] ?? [0, 0];
  return elements.map((el) => {
    const live = el.customData?.live ?? {};
    if (live.from) {
      const [ox, oy] = of(el.id);
      const absolute = el.points.map(([x, y]) => [x + el.x + ox, y + el.y + oy]);
      const [fx, fy] = of(live.from), [tx, ty] = of(live.to);
      absolute[0][0] += fx; absolute[0][1] += fy;
      absolute[absolute.length - 1][0] += tx; absolute[absolute.length - 1][1] += ty;
      const [x0, y0] = absolute[0];
      const points = absolute.map(([x, y]) => [x - x0, y - y0]);
      const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
      return { ...el, x: x0, y: y0, points, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    }
    const [ox, oy] = of(ownerOf(el));
    let dx = ox, dy = oy;
    if (live.between) {
      const [a, b] = live.between.map(of);
      dx += (a[0] + b[0]) / 2;
      dy += (a[1] + b[1]) / 2;
    }
    return dx || dy ? { ...el, x: el.x + dx, y: el.y + dy } : el;
  });
}

function inkElement(stroke) {
  const [x0, y0] = stroke.pts[0];
  return {
    id: `ink-${stroke.id}`, type: 'freedraw', x: x0, y: y0, width: 0, height: 0, angle: 0, seed: 1, opacity: 100,
    strokeColor: INK, backgroundColor: 'transparent', strokeWidth: 1.5, simulatePressure: true,
    points: stroke.pts.map(([x, y]) => [x - x0, y - y0]),
    // Ink lands where the pen is, and stays out of the way of input.
    customData: { handwave: { ghost: true, enter: 'none', change: 'none' } },
  };
}

function questionNote(q) {
  const id = `note-${q.id}`;
  const X = 1040, W = 500, BOTTOM = 880;
  const words = wrap(q.text, W - 56, 34);
  const lines = words.split('\n').length;
  const H = Math.max(130, 74 + lines * 43);
  const Y = BOTTOM - H;
  return [
    rect(id, X, Y, W, H, { tone: color.amber }),
    text(`${id}-k`, X + 28, Y + 14, 'From the audience', { size: 24, color: color.amber.stroke, customData: { live: { with: id }, handwave: { ghost: true } } }),
    text(`${id}-t`, X + 28, Y + 50, words, { size: 34, customData: { handwave: { ghost: true } } }),
  ];
}

/** Everything on the shared screen for a state of the room. */
export function scene(state, { info }) {
  const slide = SLIDES[state.index];
  const scripted = VIEWS[slide.id](state.step, { slide, state, info });
  const note = state.shown ? questionNote(state.shown) : [];
  const moved = applyOffsets([...scripted, ...note], state.offsets[slide.id] ?? {});
  return [...moved, ...(state.ink[slide.id] ?? []).map(inkElement)];
}
