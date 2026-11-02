// The runtime. A Stage holds a scene and moves it to whatever scene it is given
// next, starting from what is on screen right now, so input can interrupt any
// animation. Every experiment is a different driver of `stage.show(elements)`:
// a slider, a simulator, a voice track, a socket, a model, or a game loop.
//
//   const stage = await createStage(canvas, { width: 1600, height: 900 });
//   stage.show(view(state));                 // diff by id: enter, morph, leave
//   stage.show(view(state), { instant: true });
//   stage.on('click', 'box-3', () => ...);   // or '*' for any element
//   stage.on('drag', 'knob', ({ x, y }) => ...);
//
// An element's entrance, change and exit can be chosen per element in
// `customData.handwave`: {enter, change, exit, seconds, delay, ghost, cursor}.
// Enter effects are draw, write, type, fade, pop and none. `change: 'none'` and
// `exit: 'none'` snap. `ghost` lets input pass through. Defaults follow excalive's house style:
// shapes trace then fill, arrows grow after the shapes they join, hand-drawn text
// writes on, code types, other text fades.

import { drawElement, loadFonts, fontString, onImageLoad } from './render.js';

const ease = {
  linear: (t) => t,
  out: (t) => 1 - (1 - t) ** 3,
  inOut: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
};

const clamp01 = (t) => Math.max(0, Math.min(1, t));
const lerp = (a, b, t) => a + (b - a) * t;

function parseColor(c) {
  if (!c || c === 'transparent') return null;
  let m = /^#([0-9a-f]{6})$/i.exec(c);
  if (m) { const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
  m = /^#([0-9a-f]{3})$/i.exec(c);
  if (m) return [...m[1]].map((h) => parseInt(h + h, 16));
  return null;
}

function mixColor(a, b, t) {
  if (a === b) return b;
  const ca = parseColor(a), cb = parseColor(b);
  if (!ca || !cb) return t < 0.5 ? a : b;
  const hex = ca.map((v, i) => Math.round(lerp(v, cb[i], t)).toString(16).padStart(2, '0')).join('');
  return `#${hex}`;
}

function resample(points, count) {
  if (points.length === count) return points;
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths[i] = lengths[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  const total = lengths[lengths.length - 1] || 1;
  const out = [];
  for (let k = 0; k < count; k++) {
    const at = (k / (count - 1)) * total;
    let i = 1;
    while (i < points.length - 1 && lengths[i] < at) i++;
    const span = lengths[i] - lengths[i - 1] || 1;
    const t = (at - lengths[i - 1]) / span;
    out.push([lerp(points[i - 1][0], points[i][0], t), lerp(points[i - 1][1], points[i][1], t)]);
  }
  return out;
}

// What a changing element looks like part-way between two states.
function mix(from, to, t) {
  const out = { ...to };
  for (const key of ['x', 'y', 'width', 'height', 'angle', 'opacity', 'fontSize']) {
    if (from[key] !== undefined && to[key] !== undefined && from[key] !== to[key]) out[key] = lerp(from[key], to[key], t);
  }
  out.strokeColor = mixColor(from.strokeColor, to.strokeColor, t);
  out.backgroundColor = mixColor(from.backgroundColor, to.backgroundColor, t);
  if (from.points && to.points) {
    const count = Math.max(from.points.length, to.points.length);
    const a = resample(from.points, count), b = resample(to.points, count);
    out.points = a.map((p, i) => [lerp(p[0], b[i][0], t), lerp(p[1], b[i][1], t)]);
  }
  return out;
}

function defaultEnter(el) {
  if (el.type === 'text') {
    if (el.fontFamily === 3) return 'type';
    if (el.fontFamily === 5 || el.fontFamily === 1) return 'write';
    return 'fade';
  }
  if (el.type === 'image') return 'fade';
  return 'draw';
}

const settings = (el) => el.customData?.handwave ?? {};

// How long an entrance runs. Interactive scenes should answer quickly, so these
// are shorter than a narrated video's and scale gently with the size of the thing.
function enterSeconds(el, effect, speed) {
  const given = settings(el).seconds;
  if (given !== undefined) return given;
  if (effect === 'none') return 0;
  if (effect === 'fade' || effect === 'pop') return 0.18 * speed;
  if (effect === 'write' || effect === 'type') return clamp01(0.12 + String(el.text ?? '').length * 0.014) * speed;
  const size = el.points ? el.points.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - el.points[i - 1][0], p[1] - el.points[i - 1][1]) : 0), 0) : (el.width ?? 0) + (el.height ?? 0);
  return Math.min(0.55, 0.16 + size / 2400) * speed;
}

// Order in which new elements begin: shapes, then what joins them, then labels.
const entranceRank = (el) => (el.type === 'arrow' || el.type === 'line' ? 1 : el.type === 'text' ? 2 : 0);

export async function createStage(canvas, options = {}) {
  await loadFonts(options.fontBase);
  const stage = new Stage(canvas, options);
  return stage;
}

export class Stage {
  constructor(canvas, { width = 1600, height = 900, background = '#ffffff', fit = 'contain', files = {}, autoplay = true } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = width;
    this.height = height;
    this.background = background;
    this.fit = fit;
    this.files = files;
    this.items = new Map();           // id -> {el, order, anim}
    this.order = [];                  // draw order
    this.time = 0;
    this.camera = { x: 0, y: 0, zoom: 1 };
    this.cameraAnim = null;
    this.handlers = { click: new Map(), drag: new Map(), down: new Map(), up: new Map(), move: new Map(), enter: new Map(), leave: new Map() };
    this.layers = { under: [], over: [] };
    this.frameMs = 0;
    this.listeners = new Set();
    this.dirty = true;
    this.pointer = { x: 0, y: 0, down: false };
    this.hovered = null;
    this.dragging = null;
    this._lastNow = null;
    this._bindInput();
    this.resize();
    this._stopWatchingImages = onImageLoad(() => this.invalidate());
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    if (autoplay) this.play();
  }

  // ------------------------------------------------------------------ the frame

  play() {
    if (this._raf) return;
    const loop = (now) => {
      this._raf = requestAnimationFrame(loop);
      const dt = this._lastNow === null ? 0 : Math.min(0.1, (now - this._lastNow) / 1000);
      this._lastNow = now;
      this.advance(dt);
    };
    this._raf = requestAnimationFrame(loop);
  }

  pause() {
    cancelAnimationFrame(this._raf);
    this._raf = null;
    this._lastNow = null;
  }

  /** Step time by hand. A recorder or a test calls this instead of play(). */
  advance(dt) {
    this.time += dt;
    for (const fn of this.listeners) fn(dt, this.time);
    if (this._busy() || this.dirty) this.render();
  }

  /** Run `fn(dt, time)` once per frame. Returns a function that stops it. */
  onFrame(fn) {
    this.listeners.add(fn);
    this.dirty = true;
    return () => this.listeners.delete(fn);
  }

  invalidate() { this.dirty = true; }

  _busy() {
    if (this.cameraAnim || this.listeners.size) return true;
    for (const item of this.items.values()) if (item.anim) return true;
    return false;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const cw = rect.width || this.width, ch = rect.height || this.height;
    this.canvas.width = Math.round(cw * dpr);
    this.canvas.height = Math.round(ch * dpr);
    const scale = this.fit === 'cover' ? Math.max(cw / this.width, ch / this.height) : Math.min(cw / this.width, ch / this.height);
    this.view = { scale: scale * dpr, ox: ((cw - this.width * scale) / 2) * dpr, oy: ((ch - this.height * scale) / 2) * dpr, css: dpr };
    this.dirty = true;
  }

  // ------------------------------------------------------------------ the scene

  /**
   * Move to a new scene. Elements are matched by id: new ones enter, shared ones
   * change from wherever they are now, and missing ones leave. Anything running
   * is interrupted at its current look, so this can be called on every input.
   */
  show(elements, { instant = false, speed = 1, morphSeconds = 0.32, stagger = 0.03, exit = 0.16 } = {}) {
    const incoming = new Map();
    for (const el of elements) if (!el.isDeleted) incoming.set(el.id, el);

    // Leaving
    for (const [id, item] of this.items) {
      if (incoming.has(id) || item.leaving) continue;
      if (instant || settings(item.el).exit === 'none') { this.items.delete(id); continue; }
      item.anim = { kind: 'exit', from: this._look(item), t0: this.time, dur: exit * speed, delay: 0 };
      item.leaving = true;
    }

    // Entering, in order: shapes, then arrows, then labels.
    const fresh = elements.filter((el) => !this.items.has(el.id) || this.items.get(el.id).leaving);
    const ranked = [...fresh].sort((a, b) => entranceRank(a) - entranceRank(b));
    const rankOf = new Map(ranked.map((el, i) => [el.id, i]));

    for (const el of elements) {
      if (el.isDeleted) continue;
      const item = this.items.get(el.id);
      if (!item || item.leaving) {
        const effect = settings(el).enter ?? defaultEnter(el);
        const dur = enterSeconds(el, effect, speed);
        const next = { el, anim: null };
        if (!instant && effect !== 'none' && dur > 0) next.anim = { kind: 'enter', effect, t0: this.time, dur, delay: (settings(el).delay ?? 0) + rankOf.get(el.id) * stagger * speed };
        this.items.set(el.id, next);
      } else if (!sameLook(item.el, el)) {
        const snap = instant || settings(el).change === 'none';
        item.anim = snap ? null : { kind: 'change', from: this._look(item), t0: this.time, dur: morphSeconds * speed, delay: settings(el).delay ?? 0 };
        item.el = el;
      } else {
        item.el = el;
      }
    }

    this.order = elements.filter((el) => !el.isDeleted).map((el) => el.id);
    // Leaving elements keep their place behind the new scene.
    const leaving = [...this.items.keys()].filter((id) => !incoming.has(id));
    this.order = [...leaving, ...this.order];
    this.dirty = true;
    return this;
  }

  /** Set one element's look at once, for things moved every frame (games, drags). */
  set(id, patch) {
    const item = this.items.get(id);
    if (!item) return;
    item.el = { ...item.el, ...patch };
    item.anim = null;
    this.dirty = true;
  }

  get(id) { return this.items.get(id)?.el; }
  elements() { return this.order.map((id) => this.items.get(id)?.el).filter(Boolean); }

  // An element's current look, including where any running animation has got to.
  _look(item) {
    const a = item.anim;
    if (!a) return item.el;
    const t = clamp01((this.time - a.t0 - a.delay) / (a.dur || 1));
    if (a.kind === 'change') return mix(a.from, item.el, ease.out(t));
    if (a.kind === 'exit') return { ...a.from, opacity: (a.from.opacity ?? 100) * (1 - t) };
    return item.el;
  }

  /** Draw a callback beneath or above the elements, in stage coordinates. */
  layer(where, fn) {
    this.layers[where].push(fn);
    this.dirty = true;
    return () => { this.layers[where] = this.layers[where].filter((f) => f !== fn); };
  }

  // ------------------------------------------------------------------ the camera

  /** Move the camera to show a region. `box` is {x, y, width, height}; null is the whole stage. */
  look(box, { seconds = 0.6, padding = 40, instant = false } = {}) {
    let target = { x: 0, y: 0, zoom: 1 };
    if (box) {
      const zoom = Math.min(this.width / (box.width + padding * 2), this.height / (box.height + padding * 2));
      target = { x: box.x + box.width / 2 - this.width / (2 * zoom), y: box.y + box.height / 2 - this.height / (2 * zoom), zoom };
    }
    if (instant) { this.camera = target; this.cameraAnim = null; } else this.cameraAnim = { from: { ...this.camera }, to: target, t0: this.time, dur: seconds };
    this.dirty = true;
  }

  // ------------------------------------------------------------------ drawing

  render() {
    const started = performance.now();
    const { ctx, canvas, view } = this;
    this.dirty = false;

    if (this.cameraAnim) {
      const c = this.cameraAnim;
      const t = clamp01((this.time - c.t0) / (c.dur || 1));
      const e = ease.inOut(t);
      this.camera = { x: lerp(c.from.x, c.to.x, e), y: lerp(c.from.y, c.to.y, e), zoom: lerp(c.from.zoom, c.to.zoom, e) };
      if (t >= 1) this.cameraAnim = null;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(view.scale, 0, 0, view.scale, view.ox, view.oy);
    const cam = this.camera;
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);

    for (const fn of this.layers.under) fn(ctx, this);
    for (const id of this.order) {
      const item = this.items.get(id);
      if (!item) continue;
      this._drawItem(ctx, id, item);
    }
    for (const fn of this.layers.over) fn(ctx, this);
    this.frameMs = performance.now() - started;
  }

  _drawItem(ctx, id, item) {
    const a = item.anim;
    if (!a) return drawElement(ctx, item.el, null, this.files);
    const t = clamp01((this.time - a.t0 - a.delay) / (a.dur || 1));
    if (a.kind === 'exit') {
      drawElement(ctx, { ...a.from, opacity: (a.from.opacity ?? 100) * (1 - t) }, null, this.files);
      if (t >= 1) {
        this.items.delete(id);
        this.order = this.order.filter((other) => other !== id);
        this.dirty = true;
      }
      return;
    }
    if (a.kind === 'change') {
      drawElement(ctx, mix(a.from, item.el, ease.out(t)), null, this.files);
      if (t >= 1) { item.anim = null; this.dirty = true; }
      return;
    }
    // Entering.
    if (this.time < a.t0 + a.delay) return;
    let draw = null, el = item.el;
    if (a.effect === 'draw') {
      const hasFill = el.backgroundColor && el.backgroundColor !== 'transparent';
      draw = hasFill ? { outline: clamp01(t / 0.7), fill: clamp01((t - 0.6) / 0.4) } : { outline: t };
    } else if (a.effect === 'write') draw = { write: t };
    else if (a.effect === 'type') draw = { type: t };
    else if (a.effect === 'fade') el = { ...el, opacity: (el.opacity ?? 100) * t };
    else if (a.effect === 'pop') {
      const s = ease.out(t);
      const w = el.width ?? 0, h = el.height ?? 0;
      ctx.save();
      ctx.translate(el.x + w / 2, el.y + h / 2);
      ctx.scale(s, s);
      ctx.translate(-(el.x + w / 2), -(el.y + h / 2));
      drawElement(ctx, el, null, this.files);
      ctx.restore();
      if (t >= 1) { item.anim = null; this.dirty = true; }
      return;
    }
    drawElement(ctx, el, draw, this.files);
    if (t >= 1) { item.anim = null; this.dirty = true; }
  }

  // ------------------------------------------------------------------ input

  /** Screen (CSS px relative to the canvas) to stage coordinates. */
  toStage(px, py) {
    const { view, camera: c } = this;
    const sx = (px * view.css - view.ox) / view.scale;
    const sy = (py * view.css - view.oy) / view.scale;
    return { x: sx / c.zoom + c.x, y: sy / c.zoom + c.y };
  }

  /** The top element under a stage point. Set customData.handwave.ghost to let input pass through. */
  hit(x, y) {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const item = this.items.get(this.order[i]);
      if (!item || item.leaving) continue;
      const el = item.el;
      if (settings(el).ghost || el.opacity === 0) continue;
      if (hits(el, x, y)) return el;
    }
    return null;
  }

  /** Listen to `click`, `drag`, `down`, `up`, `enter`, `leave` or `move` on an id. '*' matches anything. */
  on(event, id, fn) {
    this.handlers[event].set(id, fn);
    return this;
  }

  off(event, id) { this.handlers[event].delete(id); return this; }

  _fire(event, el, info) {
    const table = this.handlers[event];
    const fn = (el && table.get(el.id)) || table.get('*');
    if (fn) { fn({ ...info, el, id: el?.id }); return true; }
    return false;
  }

  _bindInput() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    const pos = (e) => { const r = c.getBoundingClientRect(); return this.toStage(e.clientX - r.left, e.clientY - r.top); };
    c.addEventListener('pointerdown', (e) => {
      const p = pos(e);
      const el = this.hit(p.x, p.y);
      this.pointer = { ...p, down: true };
      this.dragging = { el, start: p, last: p, moved: false, button: e.button, shift: e.shiftKey };
      c.setPointerCapture?.(e.pointerId);
      this._fire('down', el, { ...p, event: e });
    });
    c.addEventListener('pointermove', (e) => {
      const p = pos(e);
      this.pointer = { ...p, down: this.pointer.down };
      const d = this.dragging;
      if (d) {
        const far = Math.hypot(p.x - d.start.x, p.y - d.start.y) > 3;
        if (far) d.moved = true;
        if (d.moved) this._fire('drag', d.el, { ...p, dx: p.x - d.last.x, dy: p.y - d.last.y, start: d.start, event: e });
        d.last = p;
      } else {
        const el = this.hit(p.x, p.y);
        if ((el?.id ?? null) !== this.hovered) {
          const was = this.hovered ? this.items.get(this.hovered)?.el : null;
          if (was) this._fire('leave', was, { ...p });
          if (el) this._fire('enter', el, { ...p });
          this.hovered = el?.id ?? null;
        }
        const clickable = el && (this.handlers.click.has(el.id) || this.handlers.drag.has(el.id));
        c.style.cursor = settings(el ?? {}).cursor ?? (clickable ? 'pointer' : '');
      }
      this._fire('move', null, { ...p, event: e });
    });
    const up = (e) => {
      const p = pos(e);
      const d = this.dragging;
      this.pointer = { ...p, down: false };
      this.dragging = null;
      this._fire('up', d?.el, { ...p, event: e, moved: d?.moved });
      if (d && !d.moved) this._fire('click', d.el, { ...p, event: e });
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', () => { this.dragging = null; this.pointer.down = false; });
  }

  destroy() {
    this.pause();
    window.removeEventListener('resize', this._onResize);
    this._stopWatchingImages();
  }
}

function sameLook(a, b) {
  if (a === b) return true;
  for (const key of ['x', 'y', 'width', 'height', 'angle', 'opacity', 'strokeColor', 'backgroundColor', 'strokeWidth', 'strokeStyle', 'fillStyle', 'text', 'fontSize', 'roughness', 'seed']) {
    if ((a[key] ?? null) !== (b[key] ?? null)) return false;
  }
  if (a.points || b.points) {
    if (a.points?.length !== b.points?.length) return false;
    for (let i = 0; i < a.points.length; i++) if (a.points[i][0] !== b.points[i][0] || a.points[i][1] !== b.points[i][1]) return false;
  }
  return true;
}

/** Whether a stage point falls on an element. */
export function hits(el, x, y) {
  const w = el.width ?? 0, h = el.height ?? 0;
  const cx = el.x + w / 2, cy = el.y + h / 2;
  const cos = Math.cos(-(el.angle ?? 0)), sin = Math.sin(-(el.angle ?? 0));
  const lx = cx + (x - cx) * cos - (y - cy) * sin - el.x;
  const ly = cy + (x - cx) * sin + (y - cy) * cos - el.y;
  if (el.points?.length > 1) {
    const reach = Math.max(10, (el.strokeWidth ?? 2) * 3);
    for (let i = 1; i < el.points.length; i++) if (segDistance(lx, ly, el.points[i - 1], el.points[i]) <= reach) return true;
    return false;
  }
  if (lx < 0 || ly < 0 || lx > w || ly > h) return false;
  if (el.type === 'ellipse') return ((lx - w / 2) / (w / 2 || 1)) ** 2 + ((ly - h / 2) / (h / 2 || 1)) ** 2 <= 1;
  if (el.type === 'diamond') return Math.abs(lx - w / 2) / (w / 2 || 1) + Math.abs(ly - h / 2) / (h / 2 || 1) <= 1;
  return true;
}

function segDistance(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = clamp01(((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy || 1));
  return Math.hypot(px - a[0] - dx * t, py - a[1] - dy * t);
}

/** The drawn width and height of a text element's words, for layout. */
const measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
export function measure(text, fontSize = 28, fontFamily = 5, lineHeight = 1.25) {
  measureCtx.font = fontString({ fontSize, fontFamily });
  const lines = String(text).split('\n');
  return { width: Math.max(...lines.map((l) => measureCtx.measureText(l).width)), height: lines.length * fontSize * lineHeight };
}
