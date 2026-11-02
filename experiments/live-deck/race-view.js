// The race as drawn: the slide, a crowd of figures, and the phone's controller.
//
// Figures use the platformer's rig for their limbs, but are painted on a layer with
// plain strokes. A hand-drawn line regenerates when its points change, and a crowd
// of 200 changes 1400 lines a frame. Only the heads stay rough, since they only move.

import { arrow, box, color, line, rect, text } from '/lib/draw.js';
import { qrElement } from './qr.js';
import { drawElement, fontString } from '/lib/render.js';
import { Rig } from '../game-platformer/rig.js';
import { FLAG } from './race.js';
import { pointers } from './touch.js';
import { wrap } from './words.js';

const TONES = [color.blue, color.green, color.amber, { fill: color.gray.fill, stroke: color.ink }];
export const toneOf = (number) => TONES[(number - 1) % TONES.length];

const seconds = (ms) => (ms / 1000).toFixed(1);
const ordinal = (n) => { const r = n % 100; return `${n}${r >= 11 && r <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`; };
const fixed = { customData: { handwave: { enter: 'fade', change: 'none' } } };

function words(step, frame) {
  const done = frame?.done ?? [];
  const racers = frame?.racers?.length ?? 0;
  if (step === 0) return { line: 'Find your number. Try left, right and jump on your phone.', side: `${racers} ${racers === 1 ? 'figure' : 'figures'}` };
  const clock = frame?.clock ?? 0;
  if (step === 1) return { line: 'Get to the flag. The second gap is too wide to jump.', side: `${Math.floor(clock / 1000)} s, ${done.length} at the flag` };
  const first = done[0];
  return {
    line: first ? `${done.length} of ${racers} reached the flag. First was ${first[0]} in ${seconds(first[1])} s.` : `Nobody reached the flag in ${seconds(clock)} s.`,
    side: `${seconds(clock)} s`,
  };
}

function slide(step, { slide: s, state, info }) {
  const { ground, goal } = s.activity;
  const frame = state.live[s.id];
  const said = words(step, frame);
  const out = [
    text(`${s.id}-title`, 80, 44, s.title, { size: 60, font: 6 }),
    text(`${s.id}-side`, 1520, 62, said.side, { size: 38, align: 'right', color: color.muted, ...fixed }),
    text(`${s.id}-line`, 84, 128, said.line, { size: 36, color: step === 1 ? color.ink : color.muted, ...fixed }),
  ];
  const tones = [color.amber, color.blue, color.green];
  ground.forEach((g, i) => out.push(...box(g.id, g.x, g.y, g.width, g.height, g.words, { tone: tones[i % tones.length], size: 38 })));
  const [a, b] = ground;
  out.push(arrow('race-link', [[a.x + a.width + 12, a.y + 90], [b.x - 12, b.y + 90]], { strokeColor: color.muted, customData: { live: { from: a.id, to: b.id }, handwave: { ghost: true } } }));
  // The pole stands on the last box, with the cloth at the height a figure touches.
  const cx = goal.x + goal.size / 2;
  const base = ground.at(-1).y;
  const withFlag = { customData: { live: { with: goal.id } } };
  out.push(line(`${goal.id}-pole`, [[cx, base], [cx, base - 150]], { strokeWidth: 3, ...withFlag }));
  out.push(rect(`${goal.id}-cloth`, cx, base - 150, 70, 44, { tone: color.green, roundness: null, ...withFlag }));
  // Someone will always arrive late and want in.
  out.push(text(`${s.id}-join`, 1560, 864, `Join: ${info.joinUrl}`, { size: 26, align: 'right', color: color.muted, ...fixed }));
  if (info.qr) out.push(qrElement(`${s.id}-qr`, 1400, 680, 160));
  return out;
}

const sceneKey = (frame) => JSON.stringify([frame.step, frame.racers.length, frame.done.length, Math.floor((frame.clock ?? 0) / 1000)]);

// ---------------------------------------------------------------------------

/** Figures between the last frames, drawn a little behind them so motion stays smooth. */
export class Crowd {
  constructor(stage, { behindMs = 70, driven = false } = {}) {
    this.stage = stage;
    this.behindMs = behindMs;
    this.buffer = [];
    this.figures = new Map();
    // A replay chooses the time itself. A live screen follows the frames as they arrive.
    this.stopFrame = driven ? () => {} : stage.onFrame((dt) => this.update(dt));
    this.stopLayer = stage.layer('over', (ctx) => this.draw(ctx));
  }

  frame(frame) {
    this.buffer.push(frame);
    if (this.buffer.length > 8) this.buffer.shift();
    this.arrived = performance.now();
  }

  /** Forget where figures were, for a jump in time. */
  clear() {
    this.buffer = [];
    this.figures.clear();
  }

  _place(fig, racer, previous, t, dt) {
    const [number, bx, by, vx, vy, gs, nx, flags] = racer;
    const far = previous && Math.hypot(bx - previous[1], by - previous[2]) > 150;
    const x = previous && !far ? previous[1] + (bx - previous[1]) * t : bx;
    const y = previous && !far ? previous[2] + (by - previous[2]) * t : by;
    const ny = -Math.sqrt(Math.max(0, 1 - (nx / 100) ** 2));
    const p = { x, y, vx, vy, gs, nx: nx / 100, ny, grounded: (flags & FLAG.GROUNDED) !== 0, face: flags & FLAG.LEFT ? -1 : 1, dead: (flags & FLAG.DEAD) !== 0, inWater: false };
    const { rig } = fig;
    if (p.dead) {
      if (!fig.dead) rig.breakApart(vx, vy, number);
      rig.updateScatter(dt);
    } else {
      if (fig.dead) { rig.reset(); rig.face = p.face; }
      if (p.grounded && !fig.grounded) rig.land(fig.vy ?? 0);
      rig.update(p, dt, (flags & FLAG.WON) !== 0);
    }
    Object.assign(fig, { dead: p.dead, grounded: p.grounded, vy, x, y, gone: (flags & FLAG.GONE) !== 0, won: (flags & FLAG.WON) !== 0 });
  }

  update(dt) {
    const { buffer } = this;
    if (!buffer.length) return;
    const newest = buffer.at(-1);
    const at = newest.at + (performance.now() - this.arrived) - this.behindMs;
    this.position(at, dt);
  }

  /** Put every figure where it was at a time on the frames' clock. */
  position(at, dt) {
    const { buffer } = this;
    let i = buffer.length - 1;
    while (i > 0 && buffer[i - 1].at > at) i--;
    const b = buffer[i], a = i > 0 ? buffer[i - 1] : null;
    const t = a && b.at > a.at ? Math.max(0, Math.min(1, (at - a.at) / (b.at - a.at))) : 1;
    const before = a ? new Map(a.racers.map((r) => [r[0], r])) : null;
    const seen = new Set();
    for (const racer of b.racers) {
      const number = racer[0];
      seen.add(number);
      let fig = this.figures.get(number);
      if (!fig) {
        fig = { number, rig: new Rig(), tone: toneOf(number), dead: false, grounded: false };
        this.figures.set(number, fig);
      }
      this._place(fig, racer, before?.get(number), t, dt);
    }
    for (const number of this.figures.keys()) if (!seen.has(number)) this.figures.delete(number);
  }

  draw(ctx) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const fig of this.figures.values()) {
      if (!fig.rig.parts) continue;
      ctx.globalAlpha = fig.gone ? 0.3 : 1;
      ctx.strokeStyle = fig.tone.stroke;
      ctx.lineWidth = 3;
      for (const el of fig.rig.elements()) {
        if (el.type === 'line') {
          ctx.beginPath();
          el.points.forEach(([px, py], k) => { if (k) ctx.lineTo(el.x + px, el.y + py); else ctx.moveTo(el.x + px, el.y + py); });
          ctx.stroke();
        } else if (el.id === 'p-head') {
          drawElement(ctx, { ...el, strokeColor: fig.tone.stroke, backgroundColor: fig.tone.fill });
        } else {
          ctx.beginPath();
          ctx.arc(el.x + 2, el.y + 2, 2, 0, Math.PI * 2);
          ctx.fillStyle = color.ink;
          ctx.fill();
        }
      }
      // The number says which figure is whose, and the eye-line of a crowd finds it here.
      if (!fig.dead) {
        const [hx, hy] = fig.rig.parts.head;
        ctx.font = fontString({ fontSize: 24, fontFamily: 5 });
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.lineWidth = 5;
        ctx.strokeStyle = '#ffffff';
        ctx.strokeText(String(fig.number), hx, hy - 18);
        ctx.fillStyle = fig.tone.stroke;
        ctx.fillText(String(fig.number), hx, hy - 18);
        ctx.strokeStyle = fig.tone.stroke;
        ctx.lineWidth = 3;
      }
    }
    ctx.restore();
  }

  stop() {
    this.stopFrame();
    this.stopLayer();
  }
}

function startScreen(stage, options) {
  const crowd = new Crowd(stage, options);
  return {
    crowd,
    frame: (f) => crowd.frame(f),
    clear: () => crowd.clear(),
    show: (frames) => { crowd.buffer = frames; },
    position: (at, dt) => { crowd.position(at, dt); stage.invalidate(); },
    stop: () => { crowd.stop(); stage.invalidate(); },
  };
}

// ---------------------------------------------------------------------------
// The phone. Two thumbs at once, so this tracks each pointer itself.

const LEFT = 1, RIGHT = 2, JUMP = 4;

function startPhone({ stage, canvas, link, width, redraw }) {
  let bits = 0;
  let you = null;

  const zones = () => {
    const H = stage.height, top = H * 0.52, h = H - top - 14;
    return [
      { id: 'race-left', bit: LEFT, x: 12, y: top, w: 124, h, words: 'Left' },
      { id: 'race-right', bit: RIGHT, x: 144, y: top, w: 124, h, words: 'Right' },
      { id: 'race-jump', bit: JUMP, x: 276, y: top, w: width - 288, h, words: 'Jump' },
    ];
  };

  const push = (next) => {
    if (next === bits) return;
    bits = next;
    link.sendNow({ t: 'act', i: bits });
    redraw();
  };

  const stopPointers = pointers(canvas, stage, (held) => {
    let next = 0;
    for (const { x, y } of held) for (const z of zones()) if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) next |= z.bit;
    push(next);
  });

  return {
    hideAsk: true,
    you(data) { you = data; redraw(); },
    // Held buttons must not stay down on the server across a drop, and resume on return.
    connected() { if (bits) link.sendNow({ t: 'act', i: bits }); },
    get bits() { return bits; },
    get state() { return you; },
    stop() { stopPointers(); },
    elements() {
      const out = [];
      if (!you || you.full) {
        out.push(text('race-wait', 24, 60, you?.full ? 'The race is full.\nWatch the big screen.' : 'Joining the race…', { size: 34 }));
        return out;
      }
      const tone = toneOf(you.number);
      out.push(rect('race-you', 24, 60, 150, 130, { tone }));
      out.push(text('race-you-n', 99, 125, String(you.number), { size: 72, align: 'center', valign: 'middle', color: tone.stroke, customData: { handwave: { ghost: true, enter: 'fade', change: 'none' } } }));
      out.push(text('race-you-k', 190, 72, 'This is you.', { size: 30, customData: { handwave: { ghost: true, enter: 'fade' } } }));
      out.push(text('race-you-f', 190, 112, 'Find it on the\nbig screen.', { size: 30, color: color.muted, customData: { handwave: { ghost: true, enter: 'fade' } } }));
      const status = you.step === 0 ? 'Warm up. Try the buttons.'
        : you.place ? `You reached the flag: ${ordinal(you.place)}, in ${seconds(you.ms)} s.`
        : you.step === 2 ? `Race over. ${you.finished} reached the flag.`
        : you.out ? 'You fell. Back to the start.' : 'Go! Get to the flag.';
      out.push(text('race-status', 24, 220, wrap(status, width - 48, 34), { size: 34, color: you.place ? color.green.stroke : color.ink, customData: { handwave: { ghost: true, enter: 'none', change: 'none' } } }));
      for (const z of zones()) {
        const held = (bits & z.bit) !== 0;
        // A press fills at once. It is the phone's only sign that the touch landed.
        out.push(rect(z.id, z.x, z.y, z.w, z.h, { tone: held ? color.blue : { fill: '#ffffff', stroke: color.ink }, strokeWidth: held ? 3 : 2, customData: { handwave: { ghost: true, change: 'none' } } }));
        out.push(text(`${z.id}-t`, z.x + z.w / 2, z.y + z.h / 2, z.words, { size: 36, align: 'center', valign: 'middle', color: held ? color.blue.stroke : color.ink, customData: { handwave: { ghost: true, change: 'none' } } }));
      }
      return out;
    },
  };
}

export const raceView = { slide, sceneKey, startScreen, startPhone };
