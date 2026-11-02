// O13. A platformer whose levels are Excalidraw drawings. Draw on excalidraw.com,
// drop the file on this page and play it. Press E to drag things around and retry.

import { createStage } from '/lib/stage.js';
import { drawElement } from '/lib/render.js';
import { rect, ellipse, text, color, parseScene, toExcalidraw } from '/lib/draw.js';
import { compileLevel, roleOf, familyOfElement } from './level.js';
import { Sim, STEP, CIRCLES, R } from './sim.js';
import { Rig } from './rig.js';

const LEVELS = [
  { file: 'levels/1-first-steps.excalidraw', name: 'First steps' },
  { file: 'levels/2-springs-and-ponds.excalidraw', name: 'Springs and ponds' },
  { file: 'levels/3-moving-day.excalidraw', name: 'Moving day' },
  { file: 'levels/4-the-whole-page.excalidraw', name: 'The whole page' },
];

const VIEW_H = 900;
const canvas = document.getElementById('stage');
const aspect = () => (innerWidth || 16) / (innerHeight || 9);
const stage = await createStage(canvas, { width: Math.round(VIEW_H * aspect()), height: VIEW_H, autoplay: false });

const ROLE_WORDS = {
  solid: 'ground', oneway: 'ground you can jump up through', hazard: 'hurts', coin: 'a coin', checkpoint: 'a checkpoint',
  goal: 'the goal', water: 'water', bounce: 'a spring', start: 'where you start', scenery: 'scenery', arrow: 'a sign',
};

// Parse rotated lines into plain points, so the drawing and the collisions agree
// about where a turned line is (the renderer pivots lines differently).
function bakeRotation(el) {
  if (!el.angle || !['line', 'arrow', 'freedraw'].includes(el.type) || !el.points?.length) return el;
  const xs = el.points.map((p) => p[0]), ys = el.points.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const cos = Math.cos(el.angle), sin = Math.sin(el.angle);
  const points = el.points.map(([x, y, ...rest]) => [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos, ...rest]);
  const nx = points.map((p) => p[0]), ny = points.map((p) => p[1]);
  return { ...el, angle: 0, points, width: Math.max(...nx) - Math.min(...nx), height: Math.max(...ny) - Math.min(...ny) };
}

class Game {
  constructor() {
    this.mode = 'play';
    this.doc = null;
    this.original = null;
    this.levelIndex = 0;
    this.name = '';
    this.input = { left: false, right: false, jump: false, down: false };
    this.accumulator = 0;
    this.rig = new Rig();
    this.camera = { x: 0, y: 0, zoom: 1 };
    this.lockY = null;
    this.look = 0;
    this.fx = [];
    this.message = '';
    this.messageUntil = 0;
    this.clock = 0;
    this.hudKey = '';
    this.hud = [];
    this.selected = null;
    this.hovered = null;
    this.frameMs = [];
    this.deathsCarried = 0;
    this.pan = { x: 0, y: 0 };
  }

  // ------------------------------------------------------------------ loading

  load(doc, name, index = -1) {
    this.original = JSON.parse(JSON.stringify(doc));
    this.doc = doc;
    this.name = name;
    this.levelIndex = index;
    this.edited = false;
    this.mode = 'play';
    this.message = '';
    this.startPlay();
    const { goals, bodies } = this.level;
    if (!bodies.some((b) => b.role === 'solid' || b.role === 'oneway')) this.say('Nothing here to stand on. Draw a gray box or line.', 6);
    else if (!goals.length) this.say('No goal yet. Draw a green diamond to finish this page.', 6);
  }

  async loadIndex(i) {
    const entry = LEVELS[i];
    if (!entry) return;
    const doc = await (await fetch(entry.file)).json();
    this.load(doc, `${i + 1}. ${entry.name}`, i);
  }

  startPlay() {
    this.level = compileLevel(this.doc);
    this.sim = new Sim(this.level);
    this.accumulator = 0;
    this.fx = [];
    this.rig.reset();
    this.rig.update(this.sim.player, 0, false);
    this.rigIds = new Set(this.rig.elements().map((e) => e.id));
    this.base = new Map();
    this.collectedShown = new Set();
    const scene = parseScene(this.doc);
    stage.files = scene.files;
    const paths = [], back = [], front = [];
    for (const raw of scene.elements) {
      let el = bakeRotation(raw);
      const role = roleOf(el);
      // A mover's arrow is its track: faint, and behind what rides on it.
      const track = el.type === 'arrow' && this.level.moverArrows.has(el.id);
      if (track) el = { ...el, opacity: Math.min(el.opacity ?? 100, 45) };
      // Water sits over the player, so it must always be see-through.
      if (role === 'water') el = { ...el, opacity: Math.min(el.opacity ?? 100, 60) };
      this.base.set(el.id, el);
      // The start word marks a place. It only shows while editing.
      if (role === 'start') continue;
      (track ? paths : role === 'water' ? front : back).push(el);
    }
    stage.show([...paths, ...back, ...this.rig.elements(), ...front], { instant: true });
    this.camera.zoom = 1;
    this.lockY = this.sim.player.y;
    this.look = 0;
    this._cameraTo(true);
    this.syncMovers();
  }

  restart() {
    if (this.mode !== 'play') return;
    this.startPlay();
  }

  say(words, seconds = 3) {
    this.message = words;
    this.messageUntil = this.clock + seconds;
    this.hudKey = '';
  }

  // ------------------------------------------------------------------ one frame

  /** Called with real elapsed time. Physics runs in fixed steps inside it. */
  frame(dt) {
    this.clock += dt;
    if (this.mode === 'edit') { this.editFrame(dt); this.drawCamera(); return; }
    this.accumulator = Math.min(this.accumulator + dt, 0.2);
    let steps = 0;
    while (this.accumulator >= STEP) { this.sim.step(this.input); this.accumulator -= STEP; steps++; }
    this.afterSteps(steps * STEP);
  }

  /** Advance exactly n physics steps, for tests that replay real key presses. */
  stepFixed(n) {
    this.clock += n * STEP;
    for (let i = 0; i < n; i++) this.sim.step(this.input);
    this.afterSteps(n * STEP);
    stage.render();
  }

  afterSteps(dt) {
    const p = this.sim.player;
    for (const e of this.sim.events) this.handle(e, p);
    this.sim.events.length = 0;
    this.syncMovers();
    if (p.dead) this.rig.updateScatter(dt);
    else if (dt > 0) this.rig.update(p, dt, this.sim.won);
    this.syncRig(p);
    this.updateFx(dt);
    if (dt > 0) this._cameraTo(false, dt);
    this.drawCamera();
  }

  handle(e, p) {
    switch (e.type) {
      case 'land': this.rig.land(e.speed); break;
      case 'coin': {
        const el = stage.get(e.id);
        if (el) this.fx.push({ id: e.id, t: 0, dur: 0.28, run: (u) => ({ y: el.y - 46 * u, opacity: 100 * (1 - u) }) });
        break;
      }
      case 'bounce': {
        const el = this.base.get(e.id);
        // The pad gives under the foot, which shows it fired.
        if (el) this.fx.push({ id: e.id, t: 0, dur: 0.2, run: (u) => { const body = this.bodyOf(e.id); const squeeze = Math.sin(u * Math.PI) * 0.45; return { height: el.height * (1 - squeeze), y: el.y + (body?.mover?.oy ?? 0) + el.height * squeeze }; } });
        break;
      }
      case 'checkpoint': stage.set(e.id, { backgroundColor: color.green.fill, strokeColor: color.green.stroke }); this.say('Checkpoint', 1.4); break;
      case 'die': this.rig.breakApart(p.vx, p.vy, this.sim.deaths); break;
      case 'respawn': {
        this.rig.reset();
        this.rig.update(this.sim.player, 0, false);
        this.lockY = this.sim.player.y;
        break;
      }
      case 'win': this.hudKey = ''; break;
      default:
    }
  }

  bodyOf(id) { return this.level.bodies.find((b) => b.id === id); }

  // Moving elements follow their mover, unless an effect is playing on them.
  syncMovers() {
    const fxIds = new Set(this.fx.map((f) => f.id));
    for (const m of this.level.movers) {
      for (const id of m.ids) {
        const base = this.base.get(id);
        if (!base || fxIds.has(id) || this.sim.collected.has(id)) continue;
        stage.set(id, { x: base.x + m.ox, y: base.y + m.oy });
      }
    }
  }

  syncRig() {
    for (const el of this.rig.elements()) stage.set(el.id, el);
  }

  updateFx(dt) {
    this.fx = this.fx.filter((f) => {
      f.t += dt;
      const u = Math.min(1, f.t / f.dur);
      stage.set(f.id, f.run(u));
      return u < 1;
    });
  }

  // ------------------------------------------------------------------ camera

  _cameraTo(instant, dt = 0) {
    const p = this.sim.player;
    const { extent } = this.level;
    const W = stage.width, H = stage.height;
    if (p.grounded || this.lockY === null) this.lockY = p.y;
    // Follow in the air only once the player nears the edge of the view.
    const screenY = p.y - this.camera.y;
    if (screenY < H * 0.3 || screenY > H * 0.82) this.lockY = p.y;
    this.look += ((p.dead ? 0 : p.face * 150) - this.look) * (instant ? 1 : 1 - Math.exp(-dt * 2.2));
    let tx = p.x + this.look - W / 2;
    let ty = this.lockY - H * 0.66;
    const minX = extent.minX - 120, maxX = extent.maxX + 120, minY = extent.minY - 260, maxY = extent.maxY + 80;
    tx = maxX - minX < W ? (minX + maxX - W) / 2 : Math.max(minX, Math.min(maxX - W, tx));
    ty = maxY - minY < H ? (minY + maxY - H) / 2 : Math.max(minY, Math.min(maxY - H, ty));
    if (instant) { this.camera.x = tx; this.camera.y = ty; return; }
    this.camera.x += (tx - this.camera.x) * (1 - Math.exp(-dt * 7));
    this.camera.y += (ty - this.camera.y) * (1 - Math.exp(-dt * 5));
  }

  drawCamera() {
    stage.camera = { ...this.camera };
    stage.cameraAnim = null;
  }

  // ------------------------------------------------------------------ edit mode

  toggleEdit() {
    if (this.mode === 'play') this.enterEdit(); else this.exitEdit();
  }

  enterEdit() {
    this.mode = 'edit';
    this.selected = null;
    this.input = { left: false, right: false, jump: false, down: false };
    // Everything goes home to where it was drawn. The figure steps off the page.
    const scene = parseScene(this.doc);
    const back = [], front = [];
    for (const raw of scene.elements) {
      const el = bakeRotation(raw);
      this.base.set(el.id, el);
      (roleOf(el) === 'water' ? front : back).push(el);
    }
    stage.show([...back, ...front], { morphSeconds: 0.25 });
    this.hudKey = '';
  }

  exitEdit() {
    this.mode = 'play';
    this.selected = null;
    this.hovered = null;
    this.startPlay();
    this.hudKey = '';
  }

  editFrame(dt) {
    const speed = 900 * dt / this.camera.zoom;
    if (this.input.left) this.camera.x -= speed;
    if (this.input.right) this.camera.x += speed;
    if (this.input.jump) this.camera.y -= speed;
    if (this.input.down) this.camera.y += speed;
  }

  // The element, and whatever moves with it: its group, its bound text, its arrows.
  moveSet(id) {
    const el = this.doc.elements.find((e) => e.id === id);
    if (!el) return [];
    const ids = new Set([id]);
    const group = el.groupIds?.[el.groupIds.length - 1];
    for (const other of this.doc.elements) {
      if (other.isDeleted) continue;
      if (group && other.groupIds?.includes(group)) ids.add(other.id);
    }
    for (const other of this.doc.elements) {
      if (other.containerId && ids.has(other.containerId)) ids.add(other.id);
      if (other.type === 'arrow' && other.startBinding && ids.has(other.startBinding.elementId)) ids.add(other.id);
    }
    return this.doc.elements.filter((e) => ids.has(e.id));
  }

  dragElement(id, dx, dy) {
    for (const raw of this.moveSet(id)) {
      raw.x += dx;
      raw.y += dy;
      const shown = stage.get(raw.id);
      if (shown) stage.set(raw.id, { x: shown.x + dx, y: shown.y + dy });
    }
    this.edited = true;
  }

  deleteSelected() {
    if (!this.selected) return;
    const gone = new Set(this.moveSet(this.selected).map((e) => e.id));
    this.doc.elements = this.doc.elements.filter((e) => !gone.has(e.id));
    this.selected = null;
    this.edited = true;
    const scene = parseScene(this.doc);
    stage.show(scene.elements.map(bakeRotation), { exit: 0.14 });
    this.hudKey = '';
  }

  revert() {
    this.doc = JSON.parse(JSON.stringify(this.original));
    this.edited = false;
    this.selected = null;
    const scene = parseScene(this.doc);
    stage.show(scene.elements.map(bakeRotation), { morphSeconds: 0.25 });
    this.say('Back to the drawing as it was loaded', 2);
  }

  saveFile() {
    const blob = new Blob([toExcalidraw(this.doc.elements, this.doc.files ?? {})], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.name.replace(/^\d+\.\s*/, '').replace(/\W+/g, '-').toLowerCase() || 'level'}.excalidraw`;
    a.click();
    URL.revokeObjectURL(a.href);
    this.say(`Saved ${a.download}`, 2);
  }

  describe(id) {
    const el = this.doc.elements.find((e) => e.id === id);
    if (!el) return '';
    const role = roleOf(el);
    if (role === 'arrow') return this.level.moverArrows.has(id) ? 'moves the shape it starts on' : ROLE_WORDS.arrow;
    return ROLE_WORDS[role] ?? role;
  }

  // ------------------------------------------------------------------ the heads-up display

  buildHud() {
    const W = stage.width;
    const ghost = { customData: { handwave: { ghost: true } } };
    const coins = this.level.coins.length;
    const won = this.sim.won && this.mode === 'play';
    const parts = [];
    const shownTime = this.sim.won ? this.sim.wonAt : this.sim.time;
    if (this.mode === 'edit') {
      parts.push(rect('h-band', 30, 22, W - 60, 62, { tone: color.amber, ...ghost }));
      parts.push(text('h-edit', 56, 53, 'Editing: drag anything.  E plays it.  Del removes.  R reverts.  S saves the file.', { size: 28, valign: 'middle', color: color.amber.stroke, ...ghost }));
      if (this.hovered ?? this.selected) parts.push(text('h-role', W - 56, 118, `this is ${this.describe(this.hovered ?? this.selected)}`, { size: 28, align: 'right', color: color.muted, ...ghost }));
    } else {
      parts.push(text('h-name', 36, 26, this.name, { size: 34, font: 6, ...ghost }));
      if (coins) {
        parts.push(ellipse('h-coin', 38, 82, 28, 28, { tone: color.amber, ...ghost }));
        parts.push(text('h-count', 76, 78, `${this.sim.collected.size} of ${coins}`, { size: 28, color: color.amber.stroke, ...ghost }));
      }
      parts.push(text('h-keys', W - 36, 30, 'E edit   R restart   1-4 pages', { size: 24, align: 'right', color: color.muted, ...ghost }));
      parts.push(text('h-drop', W - 36, 62, 'drop an .excalidraw file to play it', { size: 24, align: 'right', color: color.muted, ...ghost }));
    }
    if (won) {
      const seconds = Math.round(shownTime);
      const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      const hasNext = this.levelIndex >= 0 && this.levelIndex < LEVELS.length - 1;
      const line1 = `Done in ${clock}${coins ? ` with ${this.sim.collected.size} of ${coins} coins` : ''}${this.sim.deaths ? `, ${this.sim.deaths} ${this.sim.deaths === 1 ? 'fall' : 'falls'}` : ''}`;
      const line2 = hasNext ? 'Enter for the next page' : this.levelIndex === LEVELS.length - 1 ? 'That is every page. Draw your own and drop it here.' : 'R plays it again';
      const box = 980;
      parts.push(rect('h-win', (W - box) / 2, 300, box, 190, { tone: color.green, ...ghost }));
      parts.push(text('h-win-1', W / 2, 356, line1, { size: 42, align: 'center', valign: 'middle', color: color.green.stroke, ...ghost }));
      parts.push(text('h-win-2', W / 2, 430, line2, { size: 32, align: 'center', valign: 'middle', color: color.ink, ...ghost }));
    }
    if (this.message && this.clock < this.messageUntil) {
      parts.push(text('h-msg', W / 2, 150, this.message, { size: 32, align: 'center', valign: 'middle', color: color.blue.stroke, ...ghost }));
    }
    return parts;
  }

  drawHud(ctx) {
    const key = [this.mode, this.sim?.collected.size, this.sim?.won, this.sim?.deaths, this.name, this.message && this.clock < this.messageUntil ? this.message : '', this.hovered, this.selected, stage.width].join('|');
    if (key !== this.hudKey) { this.hudKey = key; this.hud = this.buildHud(); }
    const v = stage.view;
    ctx.save();
    ctx.setTransform(v.scale, 0, 0, v.scale, v.ox, v.oy);
    for (const el of this.hud) drawElement(ctx, el);
    ctx.restore();
  }

  drawSelection(ctx) {
    if (this.mode !== 'edit') return;
    for (const id of [this.selected, this.hovered]) {
      const el = id && stage.get(id);
      if (!el) continue;
      const w = el.width ?? 0, h = el.height ?? 0;
      let x = el.x, y = el.y, bw = w, bh = h;
      if (el.points?.length) {
        const xs = el.points.map((p) => el.x + p[0]), ys = el.points.map((p) => el.y + p[1]);
        x = Math.min(...xs); y = Math.min(...ys); bw = Math.max(...xs) - x; bh = Math.max(...ys) - y;
      }
      ctx.save();
      ctx.setLineDash([8, 6]);
      ctx.lineWidth = 2 / this.camera.zoom;
      ctx.strokeStyle = id === this.selected ? color.blue.stroke : '#adb5bd';
      ctx.strokeRect(x - 6, y - 6, bw + 12, bh + 12);
      ctx.restore();
    }
  }
}

const game = new Game();

// -------------------------------------------------------------------- input

const KEYS = {
  ArrowLeft: 'left', a: 'left', A: 'left',
  ArrowRight: 'right', d: 'right', D: 'right',
  ArrowUp: 'jump', w: 'jump', W: 'jump', ' ': 'jump',
  ArrowDown: 'down', s: 'down', S: 'down',
};

addEventListener('keydown', (e) => {
  const action = KEYS[e.key];
  if (e.key.startsWith('Arrow') || e.key === ' ') e.preventDefault();
  if (e.repeat) return;
  if (game.mode === 'edit') {
    if (e.key === 's' || e.key === 'S') { game.saveFile(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { game.deleteSelected(); return; }
    if (e.key === 'r' || e.key === 'R') { game.revert(); return; }
  }
  if (action) { game.input[action] = true; return; }
  if (e.key === 'e' || e.key === 'E') game.toggleEdit();
  else if (e.key === 'r' || e.key === 'R') game.restart();
  else if (e.key === 'Enter' && game.sim?.won && game.levelIndex >= 0 && game.levelIndex < LEVELS.length - 1) game.loadIndex(game.levelIndex + 1);
  else if (/^[1-9]$/.test(e.key) && LEVELS[+e.key - 1]) game.loadIndex(+e.key - 1);
});
addEventListener('keyup', (e) => {
  const action = KEYS[e.key];
  if (action) game.input[action] = false;
});
addEventListener('blur', () => { game.input = { left: false, right: false, jump: false, down: false }; });

// Edit mode: grab an element, or the page itself to pan.
let lastClient = null;
stage.on('down', '*', ({ id, event }) => {
  if (game.mode !== 'edit') return;
  game.selected = id ?? null;
  lastClient = { x: event.clientX, y: event.clientY };
});
stage.on('drag', '*', ({ id, dx, dy, event }) => {
  if (game.mode !== 'edit') return;
  if (id) { game.dragElement(id, dx, dy); return; }
  if (!lastClient) lastClient = { x: event.clientX, y: event.clientY };
  const scale = (stage.view.scale / stage.view.css) * game.camera.zoom;
  game.camera.x -= (event.clientX - lastClient.x) / scale;
  game.camera.y -= (event.clientY - lastClient.y) / scale;
  lastClient = { x: event.clientX, y: event.clientY };
});
stage.on('enter', '*', ({ id }) => { if (game.mode === 'edit') game.hovered = id; });
stage.on('leave', '*', () => { if (game.mode === 'edit') game.hovered = null; });

canvas.addEventListener('wheel', (e) => {
  if (game.mode !== 'edit') return;
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const before = stage.toStage(e.clientX - r.left, e.clientY - r.top);
  game.camera.zoom = Math.max(0.2, Math.min(1.6, game.camera.zoom * Math.exp(-e.deltaY * 0.0012)));
  game.drawCamera();
  const after = stage.toStage(e.clientX - r.left, e.clientY - r.top);
  game.camera.x += before.x - after.x;
  game.camera.y += before.y - after.y;
}, { passive: false });

// Dropping a drawing plays it.
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  try {
    const doc = JSON.parse(await file.text());
    if (!Array.isArray(doc.elements)) throw new Error('no elements');
    game.load(doc, file.name.replace(/\.excalidraw(\.json)?$/i, ''));
  } catch {
    game.say(`${file.name} is not an Excalidraw drawing`, 4);
  }
});

addEventListener('resize', () => {
  stage.width = Math.round(VIEW_H * aspect());
  stage.resize();
  game.hudKey = '';
});

// -------------------------------------------------------------------- start

stage.layer('over', (ctx) => game.drawSelection(ctx));
stage.layer('over', (ctx) => game.drawHud(ctx));
stage.onFrame((dt) => game.frame(dt));

const wanted = new URLSearchParams(location.search).get('level');
await game.loadIndex(wanted ? Math.max(0, Math.min(LEVELS.length - 1, +wanted - 1)) : 0);
stage.play();

window.app = { stage, game, LEVELS, CIRCLES, R };
