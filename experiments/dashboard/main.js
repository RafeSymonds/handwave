// A monitoring dashboard you draw. vocab.js says what labels can mean, read.js reads a
// dashboard out of Excalidraw elements, sources.mjs fetches data on the server, data.js
// holds it on the page, and panels.js draws it over the drawing. edit.js from the runnable
// diagrams changes the drawing. This file holds the state and takes input.

import { createStage } from '/lib/stage.js';
import { color, loadScene, parseScene, text as textElement, toExcalidraw } from '/lib/draw.js';
import { absPoints, distanceToPath, infer, inside, isArrow, isShape, isText, ownerOf, pathOf, pointAlong } from '../machine/graph.js';
import { addArrow, addNote, addPart, appendToLabel, duplicate, moveNote, moveShape, rebind, removeElement, resizeShape, restoreArrow, route, dragEnd, setLabel, setText, settle } from '../machine/edit.js';
import { headerPlan, tooSmall, levelColor, levelFill, innerRect, createPainter, THEMES } from './panels.js';
import { createData } from './data.js';
import { readDashboard, usesSource, allRules } from './read.js';
import { createUi } from './ui.js';
import { PARTS, readLabel } from './vocab.js';

const params = new URLSearchParams(location.search);
const stageCanvas = document.getElementById('stage');
const tapeCanvas = document.getElementById('tape');
const editor = document.getElementById('label');
const fileInput = document.getElementById('file');

const board = await createStage(stageCanvas, { width: 1600, height: 900 });

const m = {
  board,
  doc: [],
  dash: readDashboard([]),
  catalog: new Map(),
  configError: null,
  title: '',
  sceneId: null,
  selected: null,
  hoverShape: null,
  hoverChart: null,
  gesture: null,
  editing: null,
  past: [],
  future: [],
  hot: [],
  problemBoxes: [],
  flows: new Map(),
  flowScale: new Map(),
  transitions: [],
  firingNow: [],
  pendingNow: [],
  silentNow: [],
  ruleCount: 0,
  wall: false,
  loadCount: 0,
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  theme: THEMES.light,
  link: null,
  version: 0,
  time: { live: true, span: 900, end: null, at: null, cursor: null, stack: [], offset: 0 },
};

m.now = () => Date.now() / 1000 + m.time.offset;

/** The range on screen. It moves once a second while live, so charts step, they do not crawl. */
let liveEnd = Math.floor(m.now());
m.range = () => {
  const t1 = m.time.live ? liveEnd : m.time.end;
  return { t0: t1 - m.time.span, t1 };
};

/** What shapes show. Null is now. Paused with no moment picked is the end of the range. */
m.viewAt = () => m.time.at ?? (m.time.live ? null : m.range().t1);

m.byId = (id) => m.doc.find((el) => el.id === id);
m.unit = () => 1 / ((board.view.scale / board.view.css) * board.camera.zoom);
m.pointOnArrow = (el, t) => pointAlong(pathOf(el), t);
m.arrowPath = (el) => pathOf(el);
m.connectAt = (el) => [el.x + el.width + 14 * m.unit(), el.y + el.height / 2];
m.resizeAt = (el) => [el.x + el.width, el.y + el.height];
m.visibleRect = () => {
  const a = board.toStage(0, 0);
  const r = stageCanvas.getBoundingClientRect();
  const b = board.toStage(r.width, r.height);
  return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
};

// One dot stands for the same amount on every arrow with the same unit, a round number that
// keeps the busiest arrow near 1.5 dots a second. It only grows, so a dot's speed stays a
// fair comparison with what it was a moment ago.
m.flowPer = (unit, rate) => {
  let per = m.flowScale.get(unit) ?? 0;
  if (rate && rate / (per || Infinity) > 3 || (!per && rate)) {
    const want = rate / 1.5;
    const power = 10 ** Math.floor(Math.log10(want));
    per = [1, 2, 5, 10].map((k) => k * power).find((k) => k >= want);
    m.flowScale.set(unit, per);
  }
  return per;
};

m.data = createData(m);

// ---------------------------------------------------------------------------
// Sizes. The stage is as wide as its canvas, so a stage unit is a CSS pixel at zoom 1.

function sizeStage() {
  const b = stageCanvas.getBoundingClientRect();
  if (b.width && b.height) {
    board.width = Math.max(1000, b.width);
    board.height = (board.width * b.height) / b.width;
  }
  board.resize();
}

// Whatever changes the board's size, the canvas follows, or it would stretch what it drew.
let sizedTo = '';
new ResizeObserver(() => {
  const r = stageCanvas.getBoundingClientRect();
  const key = `${r.width}x${r.height}`;
  if (key === sizedTo || !m.ready) return;
  sizedTo = key;
  sizeStage();
  fitCamera();
  refreshBoard();
  ui.drawTape();
}).observe(stageCanvas);

function fitCamera() {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const el of m.doc) {
    if (el.isDeleted) continue;
    if (el.containerId) continue;
    const corners = el.points ? absPoints(el) : [[el.x, el.y], [el.x + (el.width ?? 0), el.y + (el.height ?? 0)]];
    for (const [x, y] of corners) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  if (left === Infinity) { board.camera = { x: 0, y: 0, zoom: 1 }; return; }
  // Room below for the line about dots on arrows, and for messages under shapes.
  const flows = [...m.dash.edges.values()].some((e) => e.flow);
  const pad = 24, below = m.dash.issues.some((i) => i.level === 'error') ? 60 : flows ? 44 : 24;
  const w = right - left + pad * 2, h = bottom - top + pad + below;
  const zoom = Math.min(m.wall ? 2 : 1.25, board.width / w, board.height / h);
  const spare = Math.max(0, board.height / zoom - h);
  board.camera = { x: (left + right) / 2 - board.width / (2 * zoom), y: top - pad - (m.wall ? spare / 2 : 0), zoom };
  painter?.forget();
}

// ---------------------------------------------------------------------------
// The drawing on the board. Frames and titles are Excalidraw elements. A shape's source
// lines stay in its label, and on the board it shows its title and its numbers instead.

const THEME_CACHE = new Map();

function darkColor(hex) {
  if (!hex || hex === 'transparent') return hex;
  if (THEME_CACHE.has(hex)) return THEME_CACHE.get(hex);
  const m6 = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m6) return hex;
  const n = parseInt(m6[1], 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  // Light for dark and dark for light, with the hue kept, as Excalidraw's dark mode does.
  const L = 0.93 - l * 0.8;
  const c = (1 - Math.abs(2 * L - 1)) * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const [a1, a2, a3] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h) % 6];
  const o = L - c / 2;
  const out = `#${[a1, a2, a3].map((v) => Math.round((v + o) * 255).toString(16).padStart(2, '0')).join('')}`;
  THEME_CACHE.set(hex, out);
  return out;
}

const themed = (c) => (m.theme.name === 'dark' ? darkColor(c) : c);

function frameOf(el, level) {
  const stroke = level && levelColor(m.theme, level);
  const fill = level && levelFill(m.theme, level);
  const out = { ...el, strokeColor: themed(el.strokeColor), backgroundColor: themed(el.backgroundColor), customData: { ...el.customData, handwave: { change: 'none', exit: 'none', enter: 'none', ghost: true } } };
  if (level === 'critical' || level === 'warn') return { ...out, strokeColor: stroke, backgroundColor: fill, strokeWidth: level === 'critical' ? 4 : 3 };
  // No number: dashed, so an empty frame can't be read as a healthy one.
  if (level === 'nodata' || level === 'failed') return { ...out, strokeColor: stroke, backgroundColor: fill, strokeStyle: 'dashed' };
  return out;
}

function display() {
  const out = [];
  const seenTitle = new Set();
  const u = m.unit();
  for (const el of m.doc) {
    if (el.isDeleted) continue;
    if (el.type === 'text') {
      const owner = ownerOf(el);
      const panel = owner && m.dash.panels.get(owner);
      const edge = owner && m.dash.edges.get(owner);
      if (panel && panel.kind !== 'plain') {
        if (seenTitle.has(owner)) continue;
        seenTitle.add(owner);
        const r = innerRect(panel.el, u);
        const { room, size: titlePx } = headerPlan(panel, u);
        const size = Math.round(titlePx * u * 10) / 10;
        // Too small for a title: it shows only its state and number, and the inspector has the rest.
        if (tooSmall(panel, u) || room <= 0) continue;
        const title = shorten(panel.title, room, size);
        out.push({ ...textElement(el.id, r.x, r.y + 2 * u, title, { size, font: el.fontFamily === 3 ? 5 : el.fontFamily ?? 5, color: themed(color.ink) }), customData: { handwave: { enter: 'none', change: 'none', exit: 'none', ghost: true } } });
        continue;
      }
      // An arrow's words are drawn with its number, in panels.js.
      if (edge && (edge.bindings.length || edge.watch)) continue;
      if (edge && edge.problems.length) continue;
      out.push({ ...el, strokeColor: themed(el.strokeColor), customData: { ...el.customData, handwave: { enter: 'none', change: 'none', exit: 'none', ghost: true } } });
      continue;
    }
    if (isShape(el)) {
      const panel = m.dash.panels.get(el.id);
      const level = panel && panel.kind !== 'alerts' && panel.kind !== 'plain' ? panel.status?.level : null;
      out.push(frameOf(el, level));
      // A shape with no title line still gets one, drawn here.
      if (panel && panel.kind !== 'plain' && !panel.texts.length) {
        const r = innerRect(el, u);
        out.push({ ...textElement(`${el.id}-title`, r.x, r.y + 2 * u, panel.title, { size: 18 * u, color: themed(color.ink) }), customData: { handwave: { enter: 'none', change: 'none', exit: 'none', ghost: true } } });
      }
      continue;
    }
    if (isArrow(el)) {
      const edge = m.dash.edges.get(el.id);
      const level = edge?.bindings.length ? edge.status?.level : null;
      const frame = frameOf(el, level);
      if (edge?.watch) out.push({ ...frame, strokeColor: themed(color.muted), strokeWidth: 1, opacity: 70, endArrowhead: null });
      else out.push(frame);
      continue;
    }
    out.push({ ...el, customData: { ...el.customData, handwave: { enter: 'none', ghost: true } } });
  }
  return out;
}

function shorten(words, room, size) {
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = `${size}px Excalifont`;
  if (ctx.measureText(words).width <= room || room <= 0) return words;
  let lo = 0, hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${words.slice(0, mid)}...`).width <= room) lo = mid; else hi = mid - 1;
  }
  return `${words.slice(0, lo)}...`;
}

function statusKeys() {
  let key = '';
  for (const panel of m.dash.panels.values()) {
    if (panel.kind === 'plain') continue;
    panel.status = panel.kind === 'alerts' ? { level: 'none', why: '' } : m.data.status(panel, m.viewAt());
    // How many series a chart has decides what shares its title's row.
    if (panel.kind === 'chart') panel.lineCount = panel.bindings.reduce((sum, b) => sum + m.data.seriesOf(b, panel.kind).length, 0);
    key += `${panel.id}:${panel.status.level}:${panel.kind === 'chart' && panel.lineCount > 1},`;
  }
  for (const edge of m.dash.edges.values()) {
    if (!edge.bindings.length) continue;
    edge.status = m.data.status(edge, m.viewAt());
    key += `${edge.id}:${edge.status.level},`;
  }
  return key;
}

let statusKey = '';
function refreshBoard() {
  statusKey = statusKeys();
  board.show(display(), { instant: true });
}

function refreshIfStateChanged() {
  const next = statusKeys();
  if (next !== statusKey) {
    statusKey = next;
    board.show(display(), { instant: true });
    ui.refresh();
  }
}

// ---------------------------------------------------------------------------
// Loading, editing and undo.

function reread() {
  m.dash = readDashboard(m.doc, m.catalog.size ? m.catalog : null);
  m.ruleEpoch = (m.ruleEpoch ?? 0) + 1;
  syncFlowLoop();
}

function loadElements(elements, files, name, sceneId = null) {
  closeEditor(false);
  // A drawing can only carry images inside itself. An address would be a way to send data out.
  const safeFiles = {};
  for (const [id, file] of Object.entries(files ?? {})) if (String(file?.dataURL ?? '').startsWith('data:image/')) safeFiles[id] = file;
  // Excalidraw wraps long labels by inserting line breaks in `text`, and keeps what you typed
  // in `originalText`. A query must be read as typed, and this page draws its own words.
  const inferred = infer(elements.map((el) => (el.type === 'text' && el.containerId && el.originalText ? { ...el, text: el.originalText } : el)));
  const shapes = new Map(inferred.filter(isShape).map((el) => [el.id, el]));
  // Arrows in a file can end anywhere inside a shape. Here they stop at its edge.
  m.doc = settle(inferred.map((el) => (isArrow(el) ? route(el, shapes) : el)));
  board.files = safeFiles;
  m.loadCount++;
  m.data.reset();
  painter?.forgetRanks();
  m.flows.clear();
  m.title = name;
  m.sceneId = sceneId;
  m.selected = null;
  m.past = [];
  m.future = [];
  m.time = { ...m.time, live: true, end: null, at: null, cursor: null, span: m.time.span, stack: [] };
  reread();
  fitCamera();
  m.version++;
  refreshBoard();
  ui.refresh();
  ui.drawTape();
  m.data.poll();
}

function changed() {
  reread();
  m.version++;
  if (m.selected && !m.byId(m.selected)) m.selected = null;
  m.data.recompute();
  refreshBoard();
  ui.refresh();
  m.data.poll();
}

function edit(fn) {
  const before = m.doc;
  m.doc = fn(m.doc);
  if (m.doc !== before) {
    m.past.push(before);
    if (m.past.length > 200) m.past.shift();
    m.future = [];
  }
  changed();
}

function undo() {
  closeEditor(true);
  if (!m.past.length) return;
  m.future.push(m.doc);
  m.doc = m.past.pop();
  changed();
}

function redo() {
  closeEditor(true);
  if (!m.future.length) return;
  m.past.push(m.doc);
  m.doc = m.future.pop();
  changed();
}

function select(id) {
  m.selected = id;
  ui.refresh();
  board.invalidate();
}

m.select = select;
m.remove = (id) => { edit((list) => removeElement(list, id)); select(null); };
m.copy = (id) => {
  let made = null;
  edit((list) => { const out = duplicate(list, id); made = out.id; return out.list; });
  select(made);
};
m.applyFix = (ownerId, problem) => {
  edit((list) => {
    const label = list.find((el) => el.type === 'text' && ownerOf(el) === ownerId && el.text.includes(problem.text));
    if (!label) return list;
    return setText(list, label.id, label.text.replace(problem.text, problem.text.replace(problem.fix.from, problem.fix.to)));
  });
};
m.addWord = (id, words) => edit((list) => appendToLabel(list, id, words));
m.editLabelOf = (id) => openEditor(id);

// ---------------------------------------------------------------------------
// The clock.

function setLive(on) {
  m.time.live = on;
  if (on) {
    m.time.at = null;
    m.time.end = null;
    m.time.stack = [];
    liveEnd = Math.floor(m.now());
  } else if (m.time.end === null) m.time.end = liveEnd;
  afterTimeChange();
}

function setSpan(seconds) {
  // A preset keeps what you were doing: it follows now if you were, and stays put if not.
  m.time.span = seconds;
  if (!m.time.live && m.time.at !== null) m.time.end = Math.min(m.now(), m.time.at + seconds / 2);
  m.time.stack = [];
  afterTimeChange();
}

function zoomTo(t0, t1) {
  m.time.stack.push({ span: m.time.span, end: m.time.end, live: m.time.live });
  if (m.time.live) m.time.end = liveEnd;
  m.time.live = false;
  m.time.span = Math.max(5, t1 - t0);
  m.time.end = t1;
  if (m.time.at !== null && (m.time.at < t0 || m.time.at > t1)) m.time.at = null;
  afterTimeChange();
}

function zoomOut() {
  const was = m.time.stack.pop();
  if (!was) { m.time.span = Math.min(86400 * 7, m.time.span * 2); afterTimeChange(); return; }
  m.time.span = was.span;
  m.time.end = was.end;
  m.time.live = was.live;
  if (was.live) { m.time.at = null; liveEnd = Math.floor(m.now()); }
  afterTimeChange();
}

function setMoment(t) {
  const { t0, t1 } = m.range();
  if (m.time.live) { m.time.end = t1; m.time.live = false; }
  m.time.at = Math.max(t0, Math.min(t1, t));
  afterTimeChange();
}

m.setMoment = setMoment;
m.setLive = setLive;
m.setSpan = setSpan;
m.zoomOut = zoomOut;

function afterTimeChange() {
  painter?.forget();
  m.data.recompute();
  refreshIfStateChanged();
  board.invalidate();
  ui.refresh();
  ui.drawTape();
  m.data.poll();
}

m.onData = () => {
  refreshIfStateChanged();
  board.invalidate();
  ui.tick();
  ui.drawTape();
};

let lastSecond = 0;
function everyQuarterSecond() {
  const now = m.now();
  const second = Math.floor(now);
  m.data.poll();
  if (second === lastSecond) return;
  lastSecond = second;
  if (m.time.live) liveEnd = second;
  // Staleness and "for" durations move with the clock, even with no new data.
  m.data.recompute();
  refreshIfStateChanged();
  board.invalidate();
  ui.tick();
  ui.drawTape();
}
setInterval(everyQuarterSecond, 250);

// Dots need a frame every frame, so the frame loop only runs while there are dots to move.
let flowStop = null;
let lastPaint = null;
function syncFlowLoop() {
  const wanted = [...m.dash.edges.values()].some((e) => e.flow) && !m.reducedMotion;
  if (wanted && !flowStop) flowStop = board.onFrame(() => {});
  if (!wanted && flowStop) { flowStop(); flowStop = null; }
}

const painter = createPainter(m);
board.layer('over', (ctx, stage) => {
  const dt = lastPaint === null ? 0 : Math.max(0, stage.time - lastPaint);
  lastPaint = stage.time;
  painter.paint(ctx, stage, dt);
});
m.painter = painter;

// ---------------------------------------------------------------------------
// Pointer input on the board.

const pointIn = (rect, x, y) => x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;

function plotAt(x, y) {
  for (const panel of m.dash.panels.values()) {
    const c = panel.kind === 'chart' ? panel.chart : null;
    if (!c) continue;
    const top = c.strips[0]?.y ?? 0;
    if (x >= c.plotX && x <= c.plotX + c.plotW && y >= top && y <= c.plotBottom) return panel;
  }
  return null;
}

const timeAtX = (c, x) => c.t0 + ((x - c.plotX) / c.plotW) * (c.t1 - c.t0);

function shapeAt(x, y, except) {
  return m.doc.filter((el) => isShape(el) && el.id !== except && inside(el, x, y)).sort((a, b) => a.width * a.height - b.width * b.height)[0] ?? null;
}

function arrowAt(x, y) {
  let best = null, bestD = 12 * m.unit();
  for (const el of m.doc) {
    if (!isArrow(el)) continue;
    const d = distanceToPath(pathOf(el), x, y);
    if (d < bestD) { bestD = d; best = el; }
  }
  return best;
}

const noteAt = (x, y) => m.doc.filter((el) => isText(el) && !ownerOf(el)).reverse().find((t) => x >= t.x - 4 && x <= t.x + t.width + 4 && y >= t.y - 3 && y <= t.y + t.height + 3) ?? null;

const snap = (v) => Math.round(v / 20) * 20;

function endOfSelectedArrow(x, y) {
  const el = m.selected && m.byId(m.selected);
  if (!el || !isArrow(el)) return null;
  const pts = absPoints(el);
  for (const [end, p] of [['start', pts[0]], ['end', pts[pts.length - 1]]]) if (Math.hypot(p[0] - x, p[1] - y) < 14 * m.unit()) return { arrow: el.id, end };
  return null;
}

board.on('down', '*', ({ x, y, event }) => {
  if (event.button !== 0 || m.wall) return;
  closeMenus();
  if (m.editing) closeEditor(true);
  const u = m.unit();
  for (const hot of m.hot) {
    if (hot.fix && pointIn(hot, x, y)) { m.applyFix(hot.owner, hot.fix); m.gesture = null; return; }
  }
  const sel = m.selected && m.byId(m.selected);
  if (sel && isShape(sel)) {
    const c = m.connectAt(sel);
    if (Math.hypot(c[0] - x, c[1] - y) < 12 * u) { m.gesture = { type: 'connect', from: sel.id, at: { x, y } }; return; }
    const s = m.resizeAt(sel);
    if (Math.hypot(s[0] - x, s[1] - y) < 12 * u) { m.gesture = { type: 'resize', id: sel.id, before: m.doc }; return; }
  }
  const end = endOfSelectedArrow(x, y);
  if (end) { m.gesture = { type: 'rewire', ...end, before: m.doc, original: m.byId(end.arrow), at: { x, y } }; return; }

  for (const hot of m.hot) {
    if (hot.select && pointIn(hot, x, y)) {
      select(hot.select);
      if (hot.at !== null && hot.at !== undefined) setMoment(hot.at);
      m.gesture = null;
      return;
    }
  }

  const plot = plotAt(x, y);
  if (plot) { m.gesture = { type: 'zoom', panel: plot.id, x0: x, x1: x, moved: false }; return; }

  const shape = shapeAt(x, y);
  const note = noteAt(x, y);
  if (note && !shape) { select(note.id); m.gesture = { type: 'moveNote', id: note.id, before: m.doc, last: { x, y }, moved: false }; return; }
  if (shape) {
    select(shape.id);
    m.gesture = { type: 'move', id: shape.id, before: m.doc, start: { x: shape.x, y: shape.y }, grab: { x, y }, moved: false };
    return;
  }
  const arrow = arrowAt(x, y);
  if (arrow) { select(arrow.id); m.gesture = null; return; }
  select(null);
  m.gesture = null;
});

board.on('drag', '*', ({ x, y }) => {
  const g = m.gesture;
  if (!g) return;
  if (g.type === 'zoom') {
    g.x1 = x;
    g.moved = Math.abs(g.x1 - g.x0) > 6 * m.unit();
    board.invalidate();
  } else if (g.type === 'move') {
    const el = m.byId(g.id);
    const nx = g.start.x + x - g.grab.x, ny = g.start.y + y - g.grab.y;
    const tx = snap(nx), ty = snap(ny);
    if (tx !== el.x || ty !== el.y) {
      m.doc = moveShape(m.doc, g.id, tx - el.x, ty - el.y);
      g.moved = true;
      reread();
      painter.forget();
      refreshBoard();
    }
  } else if (g.type === 'moveNote') {
    m.doc = moveNote(m.doc, g.id, x - g.last.x, y - g.last.y);
    g.last = { x, y };
    g.moved = true;
    reread();
    refreshBoard();
  } else if (g.type === 'resize') {
    const el = m.byId(g.id);
    m.doc = resizeShape(m.doc, g.id, snap(x - el.x), snap(y - el.y));
    reread();
    painter.forget();
    refreshBoard();
  } else if (g.type === 'connect') {
    g.at = { x, y };
    board.invalidate();
  } else if (g.type === 'rewire') {
    g.at = { x, y };
    m.doc = dragEnd(m.doc, g.original, g.end, [x, y]);
    reread();
    refreshBoard();
  }
});

board.on('up', '*', ({ x, y }) => {
  const g = m.gesture;
  // A part being dragged in is finished by the window's handler, which runs after this one.
  if (g?.type === 'part') return;
  m.gesture = null;
  if (!g) return;
  if (g.type === 'zoom') {
    const panel = m.dash.panels.get(g.panel);
    const c = panel?.chart;
    if (!c) return;
    select(panel.id);
    if (g.moved) {
      const a = timeAtX(c, Math.max(c.plotX, Math.min(g.x0, g.x1))), b = timeAtX(c, Math.min(c.plotX + c.plotW, Math.max(g.x0, g.x1)));
      zoomTo(a, b);
    } else setMoment(timeAtX(c, g.x0));
    return;
  }
  if (g.type === 'move' || g.type === 'moveNote' || g.type === 'resize') {
    if ((g.moved ?? true) && g.before !== m.doc) {
      m.past.push(g.before);
      m.future = [];
      changed();
    }
    return;
  }
  if (g.type === 'connect') {
    const to = shapeAt(x, y);
    if (to && to.id !== g.from) {
      let made = null;
      edit((list) => { const out = addArrow(list, g.from, to.id); made = out.id; return out.list; });
      select(made);
    }
    board.invalidate();
    return;
  }
  if (g.type === 'rewire') {
    const to = shapeAt(x, y);
    m.doc = to ? rebind(m.doc, g.original, g.end, to.id) : restoreArrow(m.doc, g.original);
    if (to) { m.past.push(g.before); m.future = []; }
    changed();
  }
});

board.on('move', '*', ({ x, y }) => {
  if (m.gesture && m.gesture.type !== 'zoom') return;
  const plot = m.wall ? null : plotAt(x, y);
  const was = m.time.cursor;
  m.hoverChart = plot?.id ?? null;
  m.time.cursor = plot ? timeAtX(plot.chart, x) : null;
  m.hoverShape = shapeAt(x, y)?.id ?? null;
  if (was !== m.time.cursor) board.invalidate();
  const u = m.unit();
  const sel = m.selected && m.byId(m.selected);
  let cursor = '';
  if (plot) cursor = 'crosshair';
  else if (m.hot.some((h) => pointIn(h, x, y))) cursor = 'pointer';
  else if (sel && isShape(sel) && Math.hypot(m.connectAt(sel)[0] - x, m.connectAt(sel)[1] - y) < 12 * u) cursor = 'crosshair';
  else if (sel && isShape(sel) && Math.hypot(m.resizeAt(sel)[0] - x, m.resizeAt(sel)[1] - y) < 12 * u) cursor = 'nwse-resize';
  else if (m.hoverShape) cursor = 'move';
  stageCanvas.style.cursor = cursor;
});

stageCanvas.addEventListener('pointerleave', () => {
  m.time.cursor = null;
  m.hoverChart = null;
  m.hoverShape = null;
  board.invalidate();
});

stageCanvas.addEventListener('dblclick', (e) => {
  if (m.wall) return;
  const r = stageCanvas.getBoundingClientRect();
  const { x, y } = board.toStage(e.clientX - r.left, e.clientY - r.top);
  const note = noteAt(x, y);
  const target = shapeAt(x, y) ?? (note ? null : arrowAt(x, y));
  if (target) { select(target.id); openEditor(target.id); return; }
  if (note) { select(note.id); openEditor(note.id); return; }
  const part = { ...PARTS[0], label: '' };
  let made = null;
  edit((list) => { const out = addPart(list, part, snap(x), snap(y)); made = out.id; return out.list; });
  select(made);
  openEditor(made);
});

// ---------------------------------------------------------------------------
// The label editor.

const toScreen = (x, y) => {
  const c = board.camera, v = board.view;
  const r = stageCanvas.getBoundingClientRect();
  return { x: r.left + (((x - c.x) * c.zoom) * v.scale + v.ox) / v.css, y: r.top + (((y - c.y) * c.zoom) * v.scale + v.oy) / v.css };
};
m.toScreen = toScreen;

function openEditor(id) {
  closeEditor(true);
  const el = m.byId(id);
  if (!el) return;
  const isNote = el.type === 'text';
  const place = isArrow(el) ? 'arrow' : 'shape';
  const text = isNote ? el : m.doc.find((t) => t.type === 'text' && ownerOf(t) === id);
  m.editing = { id, place, isNote };
  const anchor = isArrow(el) ? m.pointOnArrow(el, 0.5) : [el.x, el.y];
  const a = toScreen(anchor[0], anchor[1]);
  const rect = stageCanvas.getBoundingClientRect();
  const width = Math.max(340, isArrow(el) || isNote ? 340 : toScreen(el.x + el.width, el.y).x - a.x);
  const value = isNote ? el.text : text ? (m.dash.panels.get(id) ?? m.dash.edges.get(id))?.label ?? text.text : '';
  const lines = Math.max(3, value.split('\n').length + 1);
  editor.value = value;
  editor.style.display = 'block';
  editor.style.width = `${width}px`;
  editor.style.height = `${Math.round(lines * 18 + 14)}px`;
  editor.style.left = `${Math.max(rect.left + 4, Math.min(rect.right - width - 4, a.x))}px`;
  editor.style.top = `${Math.max(rect.top + 4, Math.min(rect.bottom - 80, a.y))}px`;
  editor.focus();
  editor.setSelectionRange(value.length, value.length);
  ui.hints.render(editor, m.editing);
}
m.openEditor = openEditor;

function closeEditor(commit) {
  const editing = m.editing;
  if (!editing) return;
  m.editing = null;
  // Or the keyboard keeps going to a text box nobody can see, and Delete does nothing.
  editor.blur();
  editor.style.display = 'none';
  ui.hints.hide();
  if (!commit) return;
  const words = editor.value.replace(/\s+$/, '');
  const el = m.byId(editing.id);
  if (!el) return;
  if (editing.isNote) {
    if (words !== el.text) edit((list) => setText(list, el.id, words));
    return;
  }
  const was = (m.dash.panels.get(editing.id) ?? m.dash.edges.get(editing.id))?.label ?? '';
  if (words !== was) edit((list) => setLabel(list, editing.id, words));
}

editor.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape') { closeEditor(false); return; }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); closeEditor(true); return; }
  if (e.key === 'Tab') { e.preventDefault(); ui.hints.take(editor); }
});
editor.addEventListener('input', () => {
  if (m.editing) {
    editor.style.height = `${Math.round(Math.max(3, editor.value.split('\n').length + 1) * 18 + 14)}px`;
    ui.hints.render(editor, m.editing);
  }
});
editor.addEventListener('keyup', (e) => { if (e.key.startsWith('Arrow') && m.editing) ui.hints.render(editor, m.editing); });
editor.addEventListener('blur', () => { if (!m.hintClick) closeEditor(true); });

// ---------------------------------------------------------------------------
// The palette. A part or a metric is dragged with real pointer events, or added with Enter.

function addPartAt(part, x, y) {
  let made = null;
  edit((list) => {
    if (part.type === 'text') { const out = addNote(list, snap(x), snap(y)); made = out.id; return out.list; }
    if (part.type === 'grid') {
      const labels = ['chart\nmachine: cpu', 'chart\nmachine: memory', 'chart\nmachine: load', 'chart\nmachine: net.in\nmachine: net.out'];
      let out = list;
      labels.forEach((label, i) => {
        const placed = addPart(out, { id: 'chart', type: 'rectangle', label, tone: 'none', w: 460, h: 240 }, snap(x) + (i % 2 ? 240 : -240), snap(y) + (i < 2 ? -130 : 130));
        out = placed.list;
        made ??= placed.id;
      });
      return out;
    }
    const out = addPart(list, part, snap(x), snap(y));
    made = out.id;
    return out.list;
  });
  fitIfOutside();
  if (made) select(made);
}

function fitIfOutside() {
  const view = m.visibleRect();
  const outside = m.doc.some((el) => isShape(el) && (el.x < view.x || el.y < view.y || el.x + el.width > view.x + view.w || el.y + el.height > view.y + view.h));
  if (outside) { fitCamera(); refreshBoard(); }
}

function addMetricAt(source, metric, x, y, target) {
  const line = `${source}: ${metric}`;
  if (target) {
    edit((list) => appendToLabel(list, target.id, line));
    select(target.id);
    return;
  }
  addPartAt({ id: 'chart', type: 'rectangle', label: `chart\n${line}`, tone: 'none', w: 460, h: 240 }, x, y);
}

m.startPartDrag = (e, payload) => {
  e.preventDefault();
  m.gesture = { type: 'part', ...payload, part: payload.part ?? { w: 460, h: 240 }, at: null, over: false, target: null };
  const move = (ev) => {
    const r = stageCanvas.getBoundingClientRect();
    const over = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
    const g = m.gesture;
    if (!g) return;
    g.over = over;
    g.at = board.toStage(ev.clientX - r.left, ev.clientY - r.top);
    g.target = over && g.metric ? shapeAt(g.at.x, g.at.y) ?? arrowAt(g.at.x, g.at.y) : null;
    if (g.target && isArrow(g.target)) { const mid = m.pointOnArrow(g.target, 0.5); g.target = { x: mid[0] - 30, y: mid[1] - 20, width: 60, height: 40, id: g.target.id }; }
    board.invalidate();
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    const g = m.gesture;
    m.gesture = null;
    if (!g?.over || !g.at) { board.invalidate(); return; }
    if (g.metric) addMetricAt(g.source, g.metric, g.at.x, g.at.y, g.target);
    else addPartAt(g.part, g.at.x, g.at.y);
    board.invalidate();
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
};

m.addAtCenter = (payload) => {
  const view = m.visibleRect();
  const x = view.x + view.w / 2, y = view.y + view.h / 2;
  if (payload.metric) addMetricAt(payload.source, payload.metric, x, y, m.selected && isShape(m.byId(m.selected) ?? {}) ? m.byId(m.selected) : null);
  else addPartAt(payload.part, x, y);
};

// ---------------------------------------------------------------------------
// Files.

const fileName = () => `${(m.sceneId ?? m.title ?? 'dashboard').replace(/\.excalidraw$/, '').replace(/[^\w-]+/g, '-') || 'dashboard'}.excalidraw`;

function saveFile() {
  closeEditor(true);
  const url = URL.createObjectURL(new Blob([toExcalidraw(m.doc, board.files)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName();
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  ui.say(`Saved ${fileName()}. It opens in Excalidraw, and you can drop it back here.`);
}

async function openFile(name, words) {
  let data;
  try {
    data = JSON.parse(words);
    if (!Array.isArray(data.elements)) throw new Error('no elements');
  } catch {
    ui.say(`${name} is not an Excalidraw drawing, so the board stays as it was.`, 'bad');
    return;
  }
  const { elements, files } = parseScene(data);
  history.replaceState(null, '', location.pathname + location.search);
  loadElements(elements, files, name);
  ui.say(`Opened ${name}.`);
}
m.openFile = openFile;

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (file) await openFile(file.name, await file.text());
  fileInput.value = '';
});

addEventListener('dragover', (e) => { e.preventDefault(); });
addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  ui.closeGallery();
  await openFile(file.name, await file.text());
});

let scenes = [];

async function loadScenePage(id) {
  const info = scenes.find((s) => s.id === id);
  if (!info) return;
  const { elements, files } = await loadScene(`./scenes/${id}.excalidraw`);
  m.time.span = info.span ?? m.time.span;
  loadElements(elements, files, info.title, id);
  history.replaceState(null, '', `${location.pathname}${location.search}#${id}`);
}
m.loadScene = loadScenePage;
m.loadBlank = () => {
  loadElements([], {}, 'a new dashboard');
  history.replaceState(null, '', `${location.pathname}${location.search}#blank`);
};

// ---------------------------------------------------------------------------
// Sources: what exists, and how each is doing.

async function refreshSources() {
  try {
    const res = await fetch('/dashboard/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (res.status === 403) {
      m.link = { ok: false, refused: true, why: await res.text(), since: m.now() };
      ui.tick();
      return;
    }
    const body = await res.json();
    const before = JSON.stringify([...m.catalog.values()].map((s) => [s.name, s.closed, [...s.metrics.keys()]]));
    m.catalog = new Map(body.sources.map((s) => [s.name, { ...s, metrics: new Map(s.metrics.map((row) => [row.id, row])) }]));
    m.configError = body.configError;
    const after = JSON.stringify([...m.catalog.values()].map((s) => [s.name, s.closed, [...s.metrics.keys()]]));
    if (before !== after) changed();
    ui.renderSources();
    document.getElementById('btn-incident').hidden = !usesSource(m.dash, 'demo');
  } catch { /* The next poll will say so, in the bar. */ }
}
m.refreshSources = refreshSources;
setInterval(refreshSources, 5000);

m.incident = async (body) => {
  const res = await fetch('/dashboard/incident', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = await res.json();
  await refreshSources();
  m.data.poll();
  return out;
};

// ---------------------------------------------------------------------------
// Theme and wall.

function setTheme(name) {
  m.theme = THEMES[name];
  document.documentElement.dataset.theme = name;
  board.background = m.theme.surface;
  try { localStorage.setItem('dashboard-theme', name); } catch { /* A private window. */ }
  painter.forget();
  refreshBoard();
  ui.refresh();
  ui.drawTape();
}
m.setTheme = setTheme;

function setWall(on) {
  m.wall = on;
  document.body.classList.toggle('wall', on);
  document.getElementById('wallbar').hidden = !on;
  select(null);
  if (on) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  // The layout has changed by the next frame.
  requestAnimationFrame(() => ui.tick());
}
m.setWall = setWall;

// ---------------------------------------------------------------------------
// Keys and buttons.

const typing = () => m.editing || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);

function closeMenus() {
  document.getElementById('incident-menu').hidden = true;
  document.getElementById('firing-menu').hidden = true;
}

addEventListener('keydown', (e) => {
  const cmd = e.metaKey || e.ctrlKey;
  if (e.key === 'Escape') {
    if (ui.closeTop()) return;
    if (m.wall) { setWall(false); return; }
    if (!m.time.live) { setLive(true); return; }
    select(null);
    return;
  }
  if (typing()) return;
  if (cmd && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (cmd && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (cmd && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); return; }
  if (cmd && e.key.toLowerCase() === 'd') { e.preventDefault(); if (m.selected) m.copy(m.selected); return; }
  if (cmd) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && m.selected) { e.preventDefault(); m.remove(m.selected); return; }
  if (e.key === ' ') { e.preventDefault(); setLive(!m.time.live); return; }
  if (e.key === 'f') { setWall(!m.wall); return; }
  if (e.key === 'd') { setTheme(m.theme.name === 'dark' ? 'light' : 'dark'); return; }
  if (e.key === 'z') { zoomOut(); return; }
  if (e.key === 't') { ui.toggleTable(); return; }
  if (e.key === '?') { e.preventDefault(); ui.toggleReference(); return; }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const { t0, t1 } = m.range();
    const from = m.time.at ?? t1;
    setMoment(from + (e.key === 'ArrowLeft' ? -1 : 1) * (t1 - t0) / (e.shiftKey ? 20 : 100));
  }
});

document.getElementById('btn-live').addEventListener('click', () => setLive(!m.time.live));
document.getElementById('btn-zoomout').addEventListener('click', zoomOut);
document.querySelectorAll('[data-span]').forEach((b) => b.addEventListener('click', () => setSpan(Number(b.dataset.span))));
document.getElementById('btn-undo').addEventListener('click', undo);
document.getElementById('btn-redo').addEventListener('click', redo);
document.getElementById('btn-save').addEventListener('click', saveFile);
document.getElementById('btn-open').addEventListener('click', () => fileInput.click());
document.getElementById('btn-theme').addEventListener('click', () => setTheme(m.theme.name === 'dark' ? 'light' : 'dark'));
document.getElementById('btn-wall').addEventListener('click', () => setWall(!m.wall));
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && m.wall) setWall(false); });

// ---------------------------------------------------------------------------

const ui = createUi(m);
m.ui = ui;

sizeStage();
m.ready = true;
let savedTheme = null;
try { savedTheme = localStorage.getItem('dashboard-theme'); } catch { /* A private window. */ }
setTheme(params.get('theme') ?? savedTheme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

await refreshSources();
scenes = await (await fetch('./scenes/scenes.json')).json();
m.scenes = scenes;

const wanted = location.hash.slice(1);
if (wanted === 'blank') m.loadBlank();
else if (scenes.some((s) => s.id === wanted)) await loadScenePage(wanted);
else await loadScenePage(scenes[0].id);
if (params.get('wall')) setWall(true);

window.app = {
  m, board, toScreen, undo, redo, setLive, setSpan, setMoment, zoomOut, zoomTo, select, setTheme, setWall, saveFile, openFile, readLabel, loadScene: loadScenePage,
  get doc() { return m.doc; },
  get dash() { return m.dash; },
  get editing() { return m.editing; },
  byId: m.byId,
  save: () => toExcalidraw(m.doc, board.files),
  rules: () => allRules(m.dash),
  // The words drawn for a panel on the last frame, and where a chart's plot is on screen.
  readouts: (id) => m.readouts?.get(id) ?? [],
  plotOf: (id) => {
    const c = m.dash.panels.get(id)?.chart;
    if (!c) return null;
    return { plotX: c.plotX, plotW: c.plotW, t0: c.t0, t1: c.t1, plotBottom: c.plotBottom, legendEnd: c.legendEnd ?? null, moreStart: c.moreStart ?? null, strips: c.strips.map((s) => ({ unit: s.unit, unitShown: s.unitShown, y: s.y, h: s.h, min: s.scale.min, max: s.scale.max, ticks: s.scale.ticks, labels: s.labels, hasData: s.hasData, gaps: s.gaps, colors: s.lines.map((l) => l.color), names: s.lines.map((l) => l.name) })) };
  },
  statusOf: (id) => {
    const owner = m.dash.panels.get(id) ?? m.dash.edges.get(id);
    const s = owner && m.data.status(owner, m.viewAt());
    return s && { level: s.level, why: s.why };
  },
  frameMs: () => board.frameMs,
  // What a panel's top row is doing, and the title the board really shows.
  headerOf: (id) => {
    const panel = m.dash.panels.get(id);
    const text = panel?.texts[0];
    return panel && { ...headerPlan(panel, m.unit()), full: panel.title, shown: text ? board.get(text.id)?.text ?? null : null, level: panel.status?.level };
  },
};
