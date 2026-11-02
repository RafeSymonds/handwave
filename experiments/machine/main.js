// O8. The drawing is the program. graph.js reads a program out of Excalidraw
// elements, sim.js runs it, edit.js changes the drawing, and this file puts them on
// screen and takes input. The board shows the drawing as drawn, with the running
// program on top. The panel underneath says what the program is doing.

import { createStage } from '/lib/stage.js';
import { drawElement } from '/lib/render.js';
import { rect, ellipse, line, text, box, color, parseScene, loadScene, toExcalidraw } from '/lib/draw.js';
import { infer, isArrow, isShape, isText, inside, ownerOf, pathOf, pointAlong, distanceToPath, absPoints, readGraph } from './graph.js';
import { FlowSim, StateSim, STEP } from './sim.js';
import { addLabel, dragEnd, moveShape, rebind, restoreArrow, setText, settle } from './edit.js';

const BOARD = { width: 1600, height: 640 };
const board = await createStage(document.getElementById('stage'), BOARD);
const panel = await createStage(document.getElementById('panel'), { width: 1600, height: 250 });
const editor = document.getElementById('label');

const DEMOS = { queue: './scenes/queue.excalidraw', breaker: './scenes/breaker.excalidraw' };
const seed = Number(new URLSearchParams(location.search).get('seed') ?? 7);

let doc = [];
let graph = readGraph([]);
let sim = null;
let demo = null;
let title = '';
let message = null;       // {words, tone}
let gesture = null;       // what the pointer is doing
let hover = null;         // arrow under the pointer
let startAt = 0;          // the program starts once the drawing has drawn in
let clock = 0;
let panelClock = 0;

// ---------------------------------------------------------------------------
// Loading.

function buildSim() {
  sim = graph.mode === 'flow' ? new FlowSim(graph, seed) : graph.mode === 'states' ? new StateSim(graph) : null;
  clock = 0;
}

function fitCamera() {
  const seen = doc.filter((el) => !el.isDeleted && el.type !== 'selection');
  if (!seen.length) { board.camera = { x: 0, y: 0, zoom: 1 }; return; }
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const el of seen) {
    if (el.strokeColor === 'transparent' && el.type !== 'text') continue;
    // An arrow's x and y are its first point, which need not be its top left.
    const corners = el.points ? absPoints(el) : [[el.x, el.y], [el.x + (el.width ?? 0), el.y + (el.height ?? 0)]];
    for (const [x, y] of corners) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  // Counts appear under shapes, so leave room below.
  const pad = 40, below = 34;
  const w = right - left + pad * 2, h = bottom - top + pad + below;
  const zoom = Math.min(1.15, BOARD.width / w, BOARD.height / h);
  board.camera = { x: (left + right) / 2 - BOARD.width / (2 * zoom), y: (top + bottom + below - pad) / 2 - BOARD.height / (2 * zoom), zoom };
}

function loadElements(elements, files, name) {
  closeEditor(false);
  doc = settle(infer(elements));
  board.files = files ?? {};
  graph = readGraph(doc);
  buildSim();
  fitCamera();
  title = name;
  message = null;
  gesture = null;
  board.show(display(), { stagger: 0.02, morphSeconds: 0.3 });
  startAt = board.time + 0.9;
  refreshPanel();
}

async function loadDemo(name) {
  demo = name;
  const { elements, files } = await loadScene(DEMOS[name]);
  loadElements(elements, files, name);
  history.replaceState(null, '', `#${name}`);
}

function restart() {
  closeEditor(true);
  graph = readGraph(doc);
  buildSim();
  message = null;
  refreshBoard({ morphSeconds: 0.2 });
  refreshPanel();
}

// ---------------------------------------------------------------------------
// The drawing on the board.

function display() {
  const out = [];
  const arrows = new Set(doc.filter(isArrow).map((a) => a.id));
  for (const el of doc) {
    // Excalidraw cuts an arrow's line under its label. A white patch does the same.
    if (el.type === 'text' && el.containerId && arrows.has(el.containerId)) {
      out.push(rect(`${el.id}-patch`, el.x - 6, el.y - 1, el.width + 12, el.height + 2, { backgroundColor: '#ffffff', strokeColor: 'transparent', roughness: 0, roundness: null, customData: { handwave: { enter: 'fade', ghost: true } } }));
    }
    if (sim?.mode === 'states' && el.id === sim.current) {
      out.push({ ...el, backgroundColor: color.amber.fill, strokeColor: color.amber.stroke });
      continue;
    }
    out.push(el);
  }
  return out;
}

const refreshBoard = (options = {}) => board.show(display(), { stagger: 0, ...options });

function changed(options) {
  const before = graph.mode;
  graph = readGraph(doc);
  if (graph.mode !== before || !sim) buildSim();
  else sim.setGraph(graph);
  refreshBoard(options);
  refreshPanel();
}

// ---------------------------------------------------------------------------
// What the program is doing, drawn over the drawing.

const tokenBase = {
  blue: Array.from({ length: 6 }, (_, i) => ellipse(`token-b${i}`, 0, 0, 22, 22, { tone: { fill: '#74c0fc', stroke: color.blue.stroke }, roughness: 0.8 })),
  amber: Array.from({ length: 6 }, (_, i) => ellipse(`token-a${i}`, 0, 0, 22, 22, { tone: { fill: '#ffd43b', stroke: color.amber.stroke }, roughness: 0.8 })),
};

function drawToken(ctx, token, x, y) {
  const shapes = token.retries > 0 ? tokenBase.amber : tokenBase.blue;
  drawElement(ctx, { ...shapes[token.id % 6], x: x - 11, y: y - 11 });
}

const say = (ctx, words, x, y, { size = 24, ink = color.ink, align = 'left' } = {}) => {
  ctx.font = `${size}px Excalifont`;
  ctx.fillStyle = ink;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(words, x, y);
};

// A waiting token eases towards its place, so a line shuffles forward and a new
// token drops into it rather than jumping.
function ease(token, tx, ty, dt) {
  if (token.px === undefined) { token.px = tx; token.py = ty; }
  const k = Math.min(1, dt * 12);
  token.px += (tx - token.px) * k;
  token.py += (ty - token.py) * k;
  return [token.px, token.py];
}

const PILE_GAP = 26;

const labelOf = (id) => doc.find((el) => isText(el) && ownerOf(el) === id);

// A waiting line winds through the shape from its bottom, with the next token out at
// the bottom right. Winding back and forth means each token moves one place when the
// line moves, instead of the end of each row crossing the whole shape. It skips the
// label and keeps going past the top, so a line that outgrows its box looks like it.
function drawPile(ctx, node, st, dt, { above = false } = {}) {
  const el = node.el;
  const cols = Math.max(1, Math.floor((el.width - 24) / PILE_GAP));
  const left = el.x + (el.width - cols * PILE_GAP) / 2 + PILE_GAP / 2;
  const floor = above ? el.y - 18 : el.y + el.height - 22;
  // Stop under the title. The count below the shape keeps saying how long the line is.
  const ceiling = board.camera.y + 112;
  const label = above ? null : labelOf(node.id);
  const rows = [];
  for (let y = floor; y >= ceiling; y -= PILE_GAP) {
    if (label && y + 11 > label.y - 2 && y - 11 < label.y + label.height + 2) continue;
    rows.push(y);
  }
  const shown = Math.min(st.queue.length, Math.max(1, rows.length) * cols);
  for (let i = 0; i < shown; i++) {
    const row = Math.floor(i / cols), col = i % cols;
    const across = row % 2 === 0 ? cols - 1 - col : col;
    const [x, y] = ease(st.queue[i], left + across * PILE_GAP, rows[row] ?? floor, dt);
    drawToken(ctx, st.queue[i], x, y);
  }
  if (st.queue.length) say(ctx, `${st.queue.length} waiting`, el.x + 6, el.y + el.height + 28, { size: 26, ink: color.rose.stroke });
}

function drawSlots(ctx, node, st, dt) {
  const el = node.el;
  const count = node.params.workers ?? 1;
  const slots = Math.max(count, ...st.busy.map((b) => b.slot + 1), 0);
  const gap = 12;
  const perRow = Math.max(1, Math.floor((el.width - 20) / (46 + gap)));
  const rows = Math.ceil(slots / perRow) || 1;
  // Slots share the room under the label.
  const label = labelOf(node.id);
  const room = el.y + el.height - 10 - (label ? label.y + label.height : el.y + 10);
  const drawnSize = Math.max(18, Math.min(46, room / rows - gap));
  const step = drawnSize + gap;
  const top = el.y + el.height - rows * step - 8;
  const busyAt = new Map(st.busy.map((b) => [b.slot, b]));
  for (let i = 0; i < slots; i++) {
    const row = Math.floor(i / perRow), col = i % perRow;
    const inRow = Math.min(perRow, slots - row * perRow);
    const x = el.x + (el.width - inRow * step + gap) / 2 + col * step;
    const y = top + row * step + gap / 2;
    // A slot past the count is a removed worker finishing its last job.
    const gone = i >= count;
    drawElement(ctx, { ...slotShape(node.id, i, drawnSize), x, y, strokeStyle: gone ? 'dashed' : 'solid' });
    const job = busyAt.get(i);
    if (job) {
      const [tx, ty] = ease(job.token, x + drawnSize / 2, y + drawnSize / 2, dt);
      drawToken(ctx, job.token, tx, ty);
      // The bar under a job is the time it has left.
      ctx.strokeStyle = color.ink;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x + 4, y + drawnSize + 3);
      ctx.lineTo(x + 4 + (drawnSize - 8) * Math.max(0, job.left / job.total), y + drawnSize + 3);
      ctx.stroke();
    }
  }
  if (st.queue.length) drawPile(ctx, node, st, dt, { above: true });
}

const slotShapes = new Map();
function slotShape(node, i, size) {
  const key = `${node}-${i}-${size}`;
  if (!slotShapes.has(key)) slotShapes.set(key, rect(`slot-${key}`, 0, 0, size, size, { backgroundColor: '#ffffff', strokeColor: color.gray.stroke, roughness: 0.8 }));
  return slotShapes.get(key);
}

function drawFlow(ctx, dt) {
  for (const token of sim.moving) {
    const edge = graph.edges.get(token.edge);
    if (!edge) continue;
    const [x, y] = pointAlong(pathOf(edge.el), edge.reversed ? 1 - token.t : token.t);
    token.px = x; token.py = y;
    drawToken(ctx, token, x, y);
  }
  for (const node of graph.nodes.values()) {
    const st = sim.state(node.id);
    if (!st) continue;
    if (node.kind === 'queue') drawPile(ctx, node, st, dt);
    if (node.kind === 'workers') drawSlots(ctx, node, st, dt);
    if (node.kind === 'sink' && st.done) say(ctx, String(st.done), node.el.x + node.el.width / 2, node.el.y + node.el.height + 30, { size: 30, ink: node.el.strokeColor, align: 'center' });
  }
  // A cross where work was just turned away, since a dropped token is otherwise invisible.
  for (const drop of sim.drops) {
    const node = graph.nodes.get(drop.node);
    if (!node) continue;
    const age = (sim.time - drop.time) / 0.6;
    if (age >= 1) continue;
    ctx.globalAlpha = 1 - age;
    ctx.strokeStyle = color.rose.stroke;
    ctx.lineWidth = 3;
    const x = node.el.x - 18, y = node.el.y + 20;
    ctx.beginPath(); ctx.moveTo(x - 9, y - 9); ctx.lineTo(x + 9, y + 9); ctx.moveTo(x + 9, y - 9); ctx.lineTo(x - 9, y + 9); ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawStates(ctx) {
  if (sim.moving) {
    const edge = graph.edges.get(sim.moving.edge);
    if (edge) {
      const [x, y] = pointAlong(pathOf(edge.el), edge.reversed ? 1 - sim.moving.t : sim.moving.t);
      drawElement(ctx, { ...tokenBase.amber[0], x: x - 11, y: y - 11 });
    }
    return;
  }
  for (const edge of sim.outgoing()) {
    // A timed arrow fills in as its time runs out.
    if (edge.after !== undefined && edge.to) {
      const path = pathOf(edge.el);
      const reach = sim.progress(edge) * path.total;
      ctx.strokeStyle = color.amber.stroke;
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(path.pts[0][0], path.pts[0][1]);
      for (let i = 1; i < path.pts.length && path.lens[i - 1] < reach; i++) {
        const [x, y] = pointAlong(path, Math.min(reach, path.lens[i]) / path.total);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
      // The label stays readable over the line.
      for (const el of doc) {
        if (!isText(el) || ownerOf(el) !== edge.id) continue;
        const patch = board.get(`${el.id}-patch`);
        if (patch) drawElement(ctx, patch);
        drawElement(ctx, el);
      }
    }
    // `fail x3` shows how many it has seen.
    const seen = sim.counts.get(edge.id);
    if (seen) {
      const [x, y] = pointAlong(pathOf(edge.el), 0.5);
      say(ctx, `${seen} of ${edge.times}`, x, y - 26, { size: 28, ink: color.rose.stroke, align: 'center' });
    }
  }
}

function drawEditing(ctx) {
  const outline = (el, ink) => drawElement(ctx, { ...el, backgroundColor: 'transparent', strokeColor: ink, strokeWidth: 4, opacity: 100 });
  if (gesture?.type === 'rewire' && gesture.target) outline(byId(gesture.target), color.amber.stroke);
  // The ends you can grab, on the arrow under the pointer.
  const held = gesture?.type === 'rewire' ? gesture.arrow : hover;
  const arrow = held && byId(held);
  if (!arrow) return;
  const abs = absPoints(arrow);
  if (arrow.startBinding) drawElement(ctx, { ...handleShape, x: abs[0][0] - 10, y: abs[0][1] - 10 });
  if (arrow.endBinding) drawElement(ctx, { ...handleShape, x: abs[abs.length - 1][0] - 10, y: abs[abs.length - 1][1] - 10 });
}

const handleShape = ellipse('handle', 0, 0, 20, 20, { tone: color.amber, roughness: 0.5 });

let overlayTime = 0;
board.layer('over', (ctx, stage) => {
  const dt = Math.max(0, stage.time - overlayTime);
  overlayTime = stage.time;
  if (sim?.mode === 'flow') drawFlow(ctx, dt);
  if (sim?.mode === 'states') drawStates(ctx);
  drawEditing(ctx);
});

// ---------------------------------------------------------------------------
// The panel: what the program is doing, in words and numbers.

const quiet = { customData: { handwave: { enter: 'fade', ghost: true } } };
const round = (n) => (n >= 10 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, ''));

function buttons(out) {
  const entries = [['demo-queue', 'queue', demo === 'queue', 130], ['demo-breaker', 'circuit breaker', demo === 'breaker', 210], ['restart', 'restart', false, 120]];
  let x = 1560;
  for (const [id, words, on, width] of [...entries].reverse()) {
    x -= width;
    out.push(...box(id, x, 10, width, 46, words, { size: 24, tone: on ? color.amber : color.gray, customData: { handwave: { enter: 'fade' } } }));
    x -= 10;
  }
}

function flowPanel(out) {
  const s = sim.stats();
  const b = s.bottleneck;
  const workerWords = b ? `${b.count} ${b.count === 1 ? 'worker finishes' : 'workers finish'} ${round(b.capacity)}/s` : '';
  const arriving = b ? `${round(b.demand)}/s arrive` : '';
  const started = s.time > 8;
  const sentence = !started ? 'Watching how fast work arrives...' : s.verdict === 'turning away' ? `Turning work away: ${arriving}, but ${workerWords}.` : s.verdict === 'backing up' ? `Backing up: ${arriving}, but ${workerWords}.` : s.verdict === 'draining' ? `Draining the line: ${arriving}, and ${workerWords}.` : `Keeping up: ${arriving}, and ${workerWords}.`;
  const tone = !started ? color.gray : s.verdict === 'backing up' || s.verdict === 'turning away' ? color.rose : s.verdict === 'draining' ? color.amber : color.green;
  out.push(text('verdict', 40, 12, sentence, { size: 34, color: tone.stroke, ...quiet }));

  // Two bars on one scale, so the comparison is the picture.
  if (b) {
    const scale = 340 / Math.max(0.1, b.demand, b.capacity);
    const bar = (id, y, value, words, barTone) => {
      const width = Math.max(4, value * scale);
      out.push(rect(`${id}-bar`, 40, y, width, 36, { tone: barTone, roundness: null, ...quiet }));
      out.push(text(`${id}-t`, 40 + width + 14, y + 18, words, { size: 26, valign: 'middle', color: barTone.stroke, ...quiet }));
    };
    bar('arriving', 70, b.demand, `arriving ${round(b.demand)}/s`, color.blue);
    bar('capacity', 116, b.capacity, `can finish ${round(b.capacity)}/s`, b.capacity < b.demand ? color.rose : color.green);
  }

  // The waiting line over the last minute. The line itself is drawn on the layer below.
  out.push(line('chart-y', [[CHART.x, CHART.y], [CHART.x, CHART.y + CHART.h]], { strokeColor: color.muted, ...quiet }));
  out.push(line('chart-x', [[CHART.x, CHART.y + CHART.h], [CHART.x + CHART.w, CHART.y + CHART.h]], { strokeColor: color.muted, ...quiet }));
  out.push(text('chart-t', CHART.x, CHART.y - 36, `waiting, last minute: ${s.waiting} now`, { size: 24, color: color.muted, ...quiet }));
  chartMax = Math.max(10, ...sim.history.filter((p) => p.t > sim.time - 60).map((p) => p.waiting));
  out.push(text('chart-max', CHART.x - 8, CHART.y + 12, String(chartMax), { size: 20, align: 'right', valign: 'middle', color: color.muted, ...quiet }));

  const x = 1290;
  out.push(text('finished', x, 74, `${s.finished} finished`, { size: 30, ...quiet }));
  out.push(text('average', x, 114, `${s.average ? round(s.average) : '0'}s each, start to finish`, { size: 24, color: color.muted, ...quiet }));
  if (s.dropped) out.push(text('dropped', x, 148, `${s.dropped} turned away`, { size: 26, color: color.rose.stroke, ...quiet }));
}

const CHART = { x: 640, y: 100, w: 600, h: 80 };
let chartMax = 10;

panel.layer('under', (ctx) => {
  if (sim?.mode !== 'flow') return;
  const points = sim.history.filter((p) => p.t > sim.time - 60);
  if (points.length < 2) return;
  ctx.strokeStyle = color.rose.stroke;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = CHART.x + ((p.t - (sim.time - 60)) / 60) * CHART.w;
    const y = CHART.y + CHART.h - (p.waiting / chartMax) * CHART.h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
});

function statePanel(out) {
  const name = sim.nameOf(sim.current);
  out.push(text('verdict', 40, 12, sim.moving ? 'Moving...' : `Now: ${name}`, { size: 34, color: color.amber.stroke, ...quiet }));
  let x = 40;
  sim.events().forEach((event, i) => {
    const on = sim.enabled(event);
    const width = Math.max(110, event.length * 16 + 54);
    out.push(...box(`event-${event}`, x, 70, width, 56, `${i + 1}  ${event}`, { size: 26, tone: on ? color.blue : color.gray, opacity: on ? 100 : 55, customData: { handwave: { enter: 'fade' } } }));
    x += width + 12;
  });
  const timed = sim.outgoing().find((e) => e.after !== undefined && e.to);
  if (timed && !sim.moving) out.push(text('timer', x + 16, 98, `${sim.nameOf(timed.to)} in ${Math.max(0, timed.after - (sim.time - sim.entered)).toFixed(1)}s`, { size: 28, valign: 'middle', color: color.amber.stroke, ...quiet }));
  else if (sim.note) out.push(text('ignored', x + 16, 98, sim.note, { size: 28, valign: 'middle', color: color.muted, ...quiet }));
  out.push(text('trail', 40, 142, sim.trail.join('  >  '), { size: 26, color: color.muted, ...quiet }));
}

function refreshPanel() {
  const out = [];
  buttons(out);
  if (sim?.mode === 'flow') flowPanel(out);
  if (sim?.mode === 'states') statePanel(out);
  const problem = message ?? (graph.issues.length ? { words: graph.issues[0], tone: color.rose } : null);
  if (problem) out.push(text('message', 40, 184, problem.words, { size: 26, color: problem.tone.stroke, ...quiet }));
  out.push(text('hint', 40, 218, 'Drag a shape. Drag an arrow\'s end onto another shape. Double-click a label to change it. Drop an .excalidraw file anywhere to run it.', { size: 23, color: color.muted, ...quiet }));
  panel.show(out, { stagger: 0, morphSeconds: 0.25 });
}

// ---------------------------------------------------------------------------
// The clock.

function fire(event) {
  if (sim?.mode !== 'states') return;
  sim.fire(event);
  refreshPanel();
}

function tick(dt) {
  if (!sim || board.time < startAt) return;
  const before = sim.mode === 'states' ? sim.current : null;
  clock += dt;
  while (clock >= STEP) {
    sim.step(STEP);
    clock -= STEP;
  }
  if (sim.mode === 'states' && sim.current !== before) refreshBoard({ morphSeconds: 0.25 });
  panelClock += dt;
  if (panelClock >= 0.2) {
    panelClock = 0;
    refreshPanel();
  }
}

board.onFrame(tick);

/** Run the program ahead at the fixed step, without drawing. For tests. */
function fastForward(seconds) {
  const before = sim?.mode === 'states' ? sim.current : null;
  startAt = 0;
  for (let i = 0, n = Math.round(seconds / STEP); i < n; i++) sim.step(STEP);
  if (sim?.mode === 'states' && sim.current !== before) refreshBoard({ morphSeconds: 0.25 });
  refreshPanel();
}

// ---------------------------------------------------------------------------
// Pointer input.

const byId = (id) => doc.find((el) => el.id === id);
const shapes = () => doc.filter(isShape);
const arrows = () => doc.filter(isArrow);

function pickEnd(x, y, reach = 18) {
  let best = null, bestDistance = reach;
  for (const arrow of arrows()) {
    const abs = absPoints(arrow);
    for (const [end, point] of [['start', abs[0]], ['end', abs[abs.length - 1]]]) {
      // A start marker's free end is not attached to anything, so it has nothing to rewire.
      if (!arrow[`${end}Binding`]) continue;
      const d = Math.hypot(point[0] - x, point[1] - y);
      if (d < bestDistance) { bestDistance = d; best = { arrow: arrow.id, end }; }
    }
  }
  return best;
}

function pickShape(x, y, except) {
  return shapes().filter((s) => s.id !== except && inside(s, x, y)).sort((a, b) => a.width * a.height - b.width * b.height)[0] ?? null;
}

const pickText = (x, y) => doc.filter(isText).reverse().find((t) => x >= t.x - 6 && x <= t.x + t.width + 6 && y >= t.y - 4 && y <= t.y + t.height + 4) ?? null;

function pickArrow(x, y, reach = 12) {
  let best = null, bestDistance = reach;
  for (const arrow of arrows()) {
    const d = distanceToPath(pathOf(arrow), x, y);
    if (d < bestDistance) { bestDistance = d; best = arrow; }
  }
  return best;
}

board.on('down', '*', ({ x, y }) => {
  closeEditor(true);
  const end = pickEnd(x, y);
  if (end) {
    gesture = { type: 'rewire', arrow: end.arrow, end: end.end, original: byId(end.arrow), target: null };
    return;
  }
  const shape = pickShape(x, y);
  gesture = shape ? { type: 'move', id: shape.id, last: { x, y } } : null;
});

board.on('drag', '*', ({ x, y }) => {
  if (!gesture) return;
  if (gesture.type === 'move') {
    doc = moveShape(doc, gesture.id, x - gesture.last.x, y - gesture.last.y);
    gesture.last = { x, y };
  } else {
    doc = dragEnd(doc, gesture.original, gesture.end, [x, y]);
    // An arrow joins two different shapes.
    const otherKey = gesture.end === 'start' ? 'endBinding' : 'startBinding';
    gesture.target = pickShape(x, y, gesture.original[otherKey]?.elementId)?.id ?? null;
  }
  changed({ instant: true });
});

board.on('up', '*', ({ moved }) => {
  const g = gesture;
  gesture = null;
  if (g?.type !== 'rewire' || !moved) return;
  // Letting go over nothing, or over the shape it came from, puts the arrow back.
  const key = g.end === 'start' ? 'startBinding' : 'endBinding';
  doc = g.target && g.target !== g.original[key]?.elementId ? rebind(doc, g.original, g.end, g.target) : restoreArrow(doc, g.original);
  changed({ morphSeconds: 0.18 });
});

board.on('move', '*', ({ x, y }) => {
  if (gesture) return;
  const end = pickEnd(x, y);
  hover = end?.arrow ?? pickArrow(x, y)?.id ?? null;
  const canvas = board.canvas;
  if (end) canvas.style.cursor = 'crosshair';
  else if (pickShape(x, y)) canvas.style.cursor = 'grab';
  else canvas.style.cursor = '';
});

board.canvas.addEventListener('dblclick', (e) => {
  const r = board.canvas.getBoundingClientRect();
  const { x, y } = board.toStage(e.clientX - r.left, e.clientY - r.top);
  const hit = pickText(x, y);
  if (hit) return openEditor({ textId: hit.id });
  const owner = pickArrow(x, y) ?? pickShape(x, y);
  if (!owner) return;
  const label = doc.find((el) => isText(el) && ownerOf(el) === owner.id);
  openEditor(label ? { textId: label.id } : { ownerId: owner.id });
});

// ---------------------------------------------------------------------------
// Label editing, in a real text box over the drawing.

let editing = null;

function toScreen(x, y) {
  const { view, camera: c } = board;
  const r = board.canvas.getBoundingClientRect();
  return { x: r.left + (((x - c.x) * c.zoom) * view.scale + view.ox) / view.css, y: r.top + (((y - c.y) * c.zoom) * view.scale + view.oy) / view.css };
}

function openEditor({ textId, ownerId }) {
  closeEditor(true);
  const el = textId ? byId(textId) : null;
  const owner = ownerId ? byId(ownerId) : null;
  let middle, size, words;
  if (el) {
    middle = [el.x + el.width / 2, el.y + el.height / 2];
    size = el.fontSize;
    words = el.text;
  } else {
    middle = owner.type === 'arrow' ? pointAlong(pathOf(owner), 0.5) : [owner.x + owner.width / 2, owner.y + owner.height / 2];
    size = owner.type === 'arrow' ? 24 : 28;
    words = '';
  }
  editing = { textId, ownerId };
  const scale = (board.camera.zoom * board.view.scale) / board.view.css;
  const px = size * scale;
  const lines = words.split('\n');
  const widest = Math.max(...lines.map((l) => l.length), 8);
  const width = widest * px * 0.62 + 30;
  const height = Math.max(lines.length, 1) * px * 1.25 + 10;
  const at = toScreen(middle[0], middle[1]);
  Object.assign(editor.style, { display: 'block', left: `${at.x - width / 2}px`, top: `${at.y - height / 2}px`, width: `${width}px`, height: `${height}px`, fontSize: `${px}px`, lineHeight: 1.25 });
  editor.value = words;
  editor.dataset.lineHeight = String(px * 1.25);
  editor.focus();
  editor.select();
}

function closeEditor(commit) {
  if (!editing) return;
  const { textId, ownerId } = editing;
  editing = null;
  const words = editor.value;
  editor.style.display = 'none';
  editor.blur();
  if (!commit) return;
  if (textId) doc = setText(doc, textId, words);
  else if (words.trim()) doc = addLabel(doc, ownerId, words);
  message = null;
  changed({ instant: true });
}

editor.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); closeEditor(true); }
  if (e.key === 'Escape') { e.preventDefault(); closeEditor(false); }
});
editor.addEventListener('input', () => {
  const lines = editor.value.split('\n').length;
  editor.style.height = `${lines * Number(editor.dataset.lineHeight) + 10}px`;
});
editor.addEventListener('blur', () => closeEditor(true));

// ---------------------------------------------------------------------------
// Keys, buttons and dropped files.

addEventListener('keydown', (e) => {
  if (editing || sim?.mode !== 'states') return;
  const event = sim.events()[Number(e.key) - 1];
  if (event) fire(event);
});

panel.on('click', '*', ({ id }) => {
  if (id === 'demo-queue') loadDemo('queue');
  else if (id === 'demo-breaker') loadDemo('breaker');
  else if (id === 'restart') restart();
  else if (id?.startsWith('event-')) fire(id.slice(6));
});

addEventListener('dragover', (e) => { e.preventDefault(); });
addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  await runFile(file.name, await file.text());
});

async function runFile(name, words) {
  let data;
  try {
    data = JSON.parse(words);
    if (!Array.isArray(data.elements)) throw new Error('no elements');
  } catch {
    message = { words: `${name} is not an Excalidraw drawing, so the board stays as it was.`, tone: color.rose };
    refreshPanel();
    return;
  }
  const { elements, files } = parseScene(data);
  demo = null;
  history.replaceState(null, '', location.pathname + location.search);
  loadElements(elements, files, name);
  message = { words: `Running ${name}.`, tone: color.blue };
  refreshPanel();
}

// ---------------------------------------------------------------------------

await loadDemo(location.hash === '#breaker' ? 'breaker' : 'queue');

window.app = {
  board, panel, toScreen, loadDemo, restart, fastForward, fire,
  get doc() { return doc; },
  get graph() { return graph; },
  get sim() { return sim; },
  get title() { return title; },
  get message() { return message; },
  get editing() { return editing; },
  byId,
  save: () => toExcalidraw(doc, board.files),
  graphOf: (json) => { const { elements } = parseScene(JSON.parse(json)); return readGraph(settle(infer(elements))); },
};
