// O8. The drawing is the program. vocab.js says what labels can mean, graph.js reads a
// program out of Excalidraw elements, sim.js runs it, and edit.js changes the drawing.
// This file holds the state and takes input. overlay.js draws the running program on
// the board, panel.js says what it is doing, and ui.js holds the words around them.

import { createStage } from '/lib/stage.js';
import { box, color, parseScene, rect, loadScene, toExcalidraw } from '/lib/draw.js';
import { absPoints, distanceToPath, infer, inside, isArrow, isShape, isText, ownerOf, pathOf, pointAlong, readGraph } from './graph.js';
import { simFor, STEP } from './sim.js';
import { addArrow, addBlank, addLabel, addNote, addPart, addStartArrow, appendToLabel, dragEnd, duplicate, insertOnArrow, moveNote, moveShape, rebind, removeElement, replaceInLabel, resizeShape, restoreArrow, setLabel, setText, settle, TONES } from './edit.js';
import { KINDS, PARTS, readLabel } from './vocab.js';
import { connectAt, createOverlay, resizeAt, slotLayout } from './overlay.js';
import { createPanel } from './panel.js';
import { createUi } from './ui.js';

const stageCanvas = document.getElementById('stage');
const panelCanvas = document.getElementById('panel');
const trayCanvas = document.getElementById('tray');
const editor = document.getElementById('label');
const fileInput = document.getElementById('file');

const board = await createStage(stageCanvas, { width: 1600, height: 900 });
const panel = await createStage(panelCanvas, { width: 1600, height: 300 });
const tray = await createStage(trayCanvas, { width: 380, height: 800 });

const seed = Number(new URLSearchParams(location.search).get('seed') ?? 7);

const m = {
  board, panel, tray,
  doc: [],
  graph: readGraph([]),
  sim: null,
  demo: null,
  title: '',
  message: null,
  gesture: null,
  selected: null,
  hover: null,
  hoverArrow: null,
  running: true,
  clockHeld: false,
  speed: 1,
  version: 0,
  past: [],
  future: [],
  bubbles: [],
  tokensSeen: new Map(),
  whatif: null,
  demos: [],
  galleryOpen: false,
  editing: null,
};

let startAt = 0;          // the program starts once the drawing has drawn in
let clock = 0;
let panelClock = 0;
let overlayTime = 0;
let tabChoice = null;
let logicKey = '';

const byId = (id) => m.doc.find((el) => el.id === id);
const shapes = () => m.doc.filter(isShape);
const arrows = () => m.doc.filter(isArrow);
m.byId = byId;
m.isShape = isShape;
m.empty = () => m.doc.length === 0;

// ---------------------------------------------------------------------------
// Sizes. The board's stage has the same shape as its canvas, so nothing is letterboxed.

function sizeStages() {
  const b = stageCanvas.getBoundingClientRect();
  // On a small screen the stage narrows, so a part keeps a readable size on a blank board.
  if (b.width && b.height) { board.width = Math.max(900, Math.min(1600, b.width * 1.5)); board.height = (board.width * b.height) / b.width; }
  board.resize();
  const p = panelCanvas.getBoundingClientRect();
  if (p.width && p.height) { panel.width = 1600; panel.height = (1600 * p.height) / p.width; }
  panel.resize();
  layoutTray();
}

addEventListener('resize', () => {
  sizeStages();
  fitCamera();
  refreshBoard({ instant: true });
  panelView.refresh();
});

// ---------------------------------------------------------------------------
// Loading.

function buildSim() {
  m.sim = simFor(m.graph, seed);
  m.stats = null;
  m.tokensSeen = new Map();
  clock = 0;
}

function fitCamera() {
  const seen = m.doc.filter((el) => !el.isDeleted && el.type !== 'selection');
  if (!seen.length) { board.camera = { x: 0, y: 0, zoom: 1 }; return; }
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const el of seen) {
    if (el.strokeColor === 'transparent' && el.type !== 'text') continue;
    // An arrow's x and y are its first point, which need not be its top left.
    const corners = el.points ? absPoints(el) : [[el.x, el.y], [el.x + (el.width ?? 0), el.y + (el.height ?? 0)]];
    for (const [x, y] of corners) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  // Counts and messages appear under shapes, so leave room below.
  const pad = 40, below = 60;
  const w = right - left + pad * 2, h = bottom - top + pad + below;
  const zoom = Math.min(1.15, board.width / w, board.height / h);
  board.camera = { x: (left + right) / 2 - board.width / (2 * zoom), y: top - pad / 2, zoom };
}

function loadElements(elements, files, name) {
  closeEditor(false);
  ui?.closeWhatIf();
  m.doc = settle(infer(elements));
  board.files = files ?? {};
  m.graph = readGraph(m.doc);
  buildSim();
  fitCamera();
  m.title = name;
  m.message = null;
  m.gesture = null;
  m.selected = null;
  m.hover = null;
  m.hoverArrow = null;
  m.past = [];
  m.future = [];
  m.running = true;
  m.version++;
  tabChoice = null;
  logicKey = '';
  board.show(display(), { stagger: 0.02, morphSeconds: 0.3 });
  startAt = board.time + 0.9;
  showTab(defaultTab());
  panelView.refresh();
  ui?.refresh();
}

async function loadDemo(name) {
  m.demo = name;
  const { elements, files } = await loadScene(`./scenes/${name}.excalidraw`);
  loadElements(elements, files, name);
  history.replaceState(null, '', `#${name}`);
}

function loadBlank() {
  m.demo = null;
  loadElements([], {}, 'blank');
  history.replaceState(null, '', '#blank');
}

function restart() {
  closeEditor(true);
  m.graph = readGraph(m.doc);
  buildSim();
  m.message = null;
  m.running = true;
  logicKey = '';
  refreshBoard({ morphSeconds: 0.2 });
  panelView.refresh();
  ui.refresh();
}

// ---------------------------------------------------------------------------
// The drawing on the board.

function display() {
  const out = [];
  const arrowIds = new Set(m.doc.filter(isArrow).map((a) => a.id));
  const sim = m.sim;
  const states = sim?.mode === 'states';
  const logic = sim?.mode === 'logic';
  for (const el of m.doc) {
    // Excalidraw cuts an arrow's line under its label. A white patch does the same.
    if (el.type === 'text' && el.containerId && arrowIds.has(el.containerId)) {
      out.push(rect(`${el.id}-patch`, el.x - 6, el.y - 1, el.width + 12, el.height + 2, { backgroundColor: '#ffffff', strokeColor: 'transparent', roughness: 0, roundness: null, customData: { handwave: { enter: 'fade', ghost: true } } }));
    }
    if (states && el.id === sim.current) {
      out.push({ ...el, backgroundColor: color.amber.fill, strokeColor: color.amber.stroke });
      continue;
    }
    // Arrows out of the current state say whether they can fire right now.
    if (states && isArrow(el)) {
      const edge = m.graph.edges.get(el.id);
      if (edge?.from === sim.current && edge.to && !edge.watch) {
        const open = !edge.params.guard || sim._guardOk(edge);
        out.push({ ...el, strokeColor: open ? color.blue.stroke : '#adb5bd', strokeStyle: open ? 'solid' : 'dashed' });
        continue;
      }
    }
    if (logic && isShape(el) && m.graph.nodes.get(el.id)?.kind !== 'chart') {
      if (sim.value(el.id)) {
        const lamp = m.graph.nodes.get(el.id)?.kind === 'lamp';
        out.push({ ...el, backgroundColor: lamp ? '#ffd43b' : color.green.fill, strokeColor: lamp ? color.amber.stroke : color.green.stroke });
        continue;
      }
    }
    out.push(el);
  }
  return out;
}

const refreshBoard = (options = {}) => board.show(display(), { stagger: 0, ...options });

function changed(options = {}) {
  const before = m.graph.mode;
  m.graph = readGraph(m.doc);
  if (m.graph.mode !== before || !m.sim) buildSim();
  else m.sim.setGraph(m.graph);
  m.version++;
  m.message = null;
  refreshBoard(options);
  panelView.refresh();
  ui.refresh();
  if (m.selected && !byId(m.selected)) select(null);
  if (!tabChoice) showTab(defaultTab());
}

// One step of changing the document, which can be undone.
function commit(before) {
  if (before === m.doc) return;
  m.past.push(before);
  if (m.past.length > 200) m.past.shift();
  m.future = [];
  ui?.refresh();
}

function edit(fn, options = { morphSeconds: 0.18 }) {
  const before = m.doc;
  m.doc = fn(m.doc);
  commit(before);
  changed(options);
}

function undo() {
  closeEditor(true);
  if (!m.past.length) return;
  m.future.push(m.doc);
  m.doc = m.past.pop();
  changed({ morphSeconds: 0.18 });
}

function redo() {
  closeEditor(true);
  if (!m.future.length) return;
  m.past.push(m.doc);
  m.doc = m.future.pop();
  changed({ morphSeconds: 0.18 });
}

function select(id) {
  m.selected = id;
  ui.refresh();
  board.invalidate();
}

// ---------------------------------------------------------------------------
// Things a click can do to the running program.

m.pokeFor = (node) => {
  const poke = m.sim?.mode === 'flow' ? KINDS[node.kind]?.poke : null;
  return poke && (!poke.needs || node.params[poke.needs] !== undefined) ? poke : null;
};

m.poke = (id) => {
  const node = m.graph.nodes.get(id);
  const poke = node && m.pokeFor(node);
  if (poke) { m.sim.poke(id, poke.id); panelView.refresh(); }
};

// A click on a worker's box kills or revives it.
function slotAt(x, y) {
  if (m.sim?.mode !== 'flow') return null;
  for (const node of m.graph.nodes.values()) {
    if (node.kind !== 'workers') continue;
    const st = m.sim.state(node.id);
    if (!st) continue;
    for (const slot of slotLayout(node, st)) {
      if (x >= slot.x && x <= slot.x + slot.size && y >= slot.y && y <= slot.y + slot.size) return { node, slot };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The clock.

function fire(event) {
  if (m.sim?.mode !== 'states') return;
  m.sim.fire(event);
  refreshBoard({ morphSeconds: 0.2 });
  panelView.refresh();
}

function tick(dt) {
  if (!m.sim || board.time < startAt || m.galleryOpen) return;
  const sim = m.sim;
  const before = sim.mode === 'states' ? sim.current : null;
  if (m.running && !m.clockHeld) {
    clock += dt * m.speed;
    let guard = 0;
    while (clock >= STEP && guard++ < 40) {
      sim.step(STEP);
      clock -= STEP;
    }
    if (clock >= STEP) clock = 0;
  }
  if (sim.mode === 'states' && sim.current !== before) refreshBoard({ morphSeconds: 0.25 });
  if (sim.mode === 'logic') refreshLogic();
  panelClock += dt;
  if (panelClock >= 0.2) {
    panelClock = 0;
    panelView.refresh();
    ui.live();
  }
}

// Shapes in a circuit change color with their output, so they redraw only when one flips.
function refreshLogic() {
  let key = '';
  for (const id of m.sim.output.keys()) key += m.sim.value(id);
  if (key !== logicKey) {
    logicKey = key;
    refreshBoard({ morphSeconds: 0.08 });
  }
}

board.onFrame(tick);

/** Run the program ahead at the fixed step, without drawing. For tests. */
function fastForward(seconds) {
  const before = m.sim?.mode === 'states' ? m.sim.current : null;
  startAt = 0;
  for (let i = 0, n = Math.round(seconds / STEP); i < n; i++) m.sim.step(STEP);
  if (m.sim?.mode === 'states' && m.sim.current !== before) refreshBoard({ morphSeconds: 0.25 });
  if (m.sim?.mode === 'logic') refreshLogic();
  panelView.refresh();
  ui.live();
}

/**
 * Stop the page's own clock, so only fastForward moves the program. For tests: otherwise
 * how far it runs between two fastForward calls depends on how busy the machine is.
 */
function holdClock(on) { m.clockHeld = on; clock = 0; }

function setRunning(on) {
  m.running = on;
  board.invalidate();
  ui.refresh();
}

function stepOnce() {
  setRunning(false);
  startAt = 0;
  for (let i = 0; i < 6; i++) m.sim?.step(STEP);
  if (m.sim?.mode === 'states') refreshBoard({ morphSeconds: 0.1 });
  if (m.sim?.mode === 'logic') refreshLogic();
  panelView.refresh();
  ui.live();
}

function setSpeed(value) {
  m.speed = value;
  ui.refresh();
}

// ---------------------------------------------------------------------------
// Pointer input on the board.

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

const pickText = (x, y) => m.doc.filter(isText).reverse().find((t) => x >= t.x - 6 && x <= t.x + t.width + 6 && y >= t.y - 4 && y <= t.y + t.height + 4) ?? null;

function pickArrow(x, y, reach = 12) {
  let best = null, bestDistance = reach;
  for (const arrow of arrows()) {
    const d = distanceToPath(pathOf(arrow), x, y);
    if (d < bestDistance) { bestDistance = d; best = arrow; }
  }
  return best;
}

// The shape that shows its "draw an arrow" circle: what the pointer is on, or what is selected.
m.connectShape = () => {
  const g = m.gesture;
  if (g?.type === 'connect') return byId(g.from);
  const id = m.hoverShape ?? m.selected;
  const el = id && byId(id);
  return el && isShape(el) ? el : null;
};

function onConnect(x, y) {
  const shape = m.connectShape();
  if (!shape) return null;
  const [cx, cy] = connectAt(shape);
  return Math.hypot(cx - x, cy - y) <= 18 ? shape : null;
}

// Text that labels nothing is a note, which can be moved and deleted like anything else.
const pickNote = (x, y) => m.doc.filter((el) => isText(el) && !ownerOf(el)).reverse().find((t) => x >= t.x - 6 && x <= t.x + t.width + 6 && y >= t.y - 4 && y <= t.y + t.height + 4) ?? null;

function onResize(x, y) {
  const el = m.selected && byId(m.selected);
  if (!el || !isShape(el)) return null;
  const [cx, cy] = resizeAt(el);
  return Math.hypot(cx - x, cy - y) <= 14 ? el : null;
}

board.on('down', '*', ({ x, y }) => {
  closeEditor(true);
  const corner = onResize(x, y);
  if (corner) {
    m.gesture = { type: 'resize', id: corner.id, before: m.doc };
    return;
  }
  const start = onConnect(x, y);
  if (start) {
    m.gesture = { type: 'connect', from: start.id, point: null, target: null };
    return;
  }
  const end = pickEnd(x, y);
  if (end) {
    m.gesture = { type: 'rewire', arrow: end.arrow, end: end.end, original: byId(end.arrow), target: null, before: m.doc };
    return;
  }
  const shape = pickShape(x, y);
  if (shape && m.graph.nodes.get(shape.id)?.kind === 'button') m.sim?.poke?.(shape.id, 'press');
  const note = shape ? null : pickNote(x, y);
  m.gesture = shape ? { type: 'move', id: shape.id, last: { x, y }, before: m.doc } : note ? { type: 'moveNote', id: note.id, last: { x, y }, before: m.doc } : null;
});

board.on('drag', '*', ({ x, y }) => {
  const g = m.gesture;
  if (!g) return;
  if (g.type === 'move') {
    m.doc = moveShape(m.doc, g.id, x - g.last.x, y - g.last.y);
    g.last = { x, y };
    changed({ instant: true });
  } else if (g.type === 'moveNote') {
    m.doc = moveNote(m.doc, g.id, x - g.last.x, y - g.last.y);
    g.last = { x, y };
    changed({ instant: true });
  } else if (g.type === 'resize') {
    const el = byId(g.id);
    m.doc = resizeShape(m.doc, g.id, x - el.x, y - el.y);
    changed({ instant: true });
  } else if (g.type === 'rewire') {
    m.doc = dragEnd(m.doc, g.original, g.end, [x, y]);
    // An arrow joins two different shapes.
    const otherKey = g.end === 'start' ? 'endBinding' : 'startBinding';
    g.target = pickShape(x, y, g.original[otherKey]?.elementId)?.id ?? null;
    changed({ instant: true });
  } else if (g.type === 'connect') {
    g.point = [x, y];
    g.target = pickShape(x, y)?.id ?? null;
    board.invalidate();
  }
});

board.on('up', '*', ({ moved, x, y }) => {
  const g = m.gesture;
  m.gesture = null;
  if (g?.type === 'move' && m.graph.nodes.get(g.id)?.kind === 'button') m.sim?.poke?.(g.id, 'release');
  if ((g?.type === 'move' || g?.type === 'moveNote' || g?.type === 'resize') && moved) commit(g.before);
  if (g?.type === 'rewire' && moved) {
    // Letting go over nothing, or over the shape it came from, puts the arrow back.
    const key = g.end === 'start' ? 'startBinding' : 'endBinding';
    const real = g.target && g.target !== g.original[key]?.elementId;
    m.doc = real ? rebind(m.doc, g.original, g.end, g.target) : restoreArrow(m.doc, g.original);
    if (real) commit(g.before);
    changed({ morphSeconds: 0.18 });
  }
  if (g?.type === 'connect') {
    if (moved && g.target) {
      const { list, id } = addArrow(m.doc, g.from, g.target);
      const before = m.doc;
      m.doc = list;
      commit(before);
      m.selected = id;
      changed({ morphSeconds: 0.18 });
    } else if (moved) {
      m.message = { words: 'An arrow joins two shapes. Let go over a shape.', tone: color.rose };
      panelView.refresh();
    }
    board.invalidate();
  }
  void x; void y;
});

board.on('click', '*', ({ x, y }) => {
  // A message on the drawing with a fix in it is a button.
  const bubble = m.bubbles.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
  if (bubble) {
    if (bubble.issue.suggest || bubble.issue.suggestLine) { m.applyFix(bubble.issue); return; }
    select(bubble.issue.id);
    return;
  }
  const hit = slotAt(x, y);
  if (hit) {
    const said = m.sim.poke(hit.node.id, 'kill', hit.slot.i);
    m.message = { words: `${said === 'worker killed' ? 'Killed a worker' : 'Brought a worker back'} in ${hit.node.name || 'this shape'}. Restart heals everything.`, tone: color.blue };
    panelView.refresh();
    select(hit.node.id);
    return;
  }
  const end = pickEnd(x, y);
  const shape = pickShape(x, y);
  if (shape && !end) {
    if (m.graph.nodes.get(shape.id)?.kind === 'switch') { m.sim.poke(shape.id, 'click'); refreshLogic(); panelView.refresh(); }
    select(shape.id);
    return;
  }
  const note = pickNote(x, y);
  if (note) { select(note.id); return; }
  const arrow = end ? byId(end.arrow) : pickArrow(x, y);
  if (arrow) {
    // Clicking an arrow the machine can take now fires it.
    const edge = m.graph.edges.get(arrow.id);
    if (m.sim?.mode === 'states' && edge && m.sim.canFire(edge) && !end) fire(edge.event);
    select(arrow.id);
    return;
  }
  select(null);
});

board.on('move', '*', ({ x, y }) => {
  if (m.gesture) return;
  const end = pickEnd(x, y);
  const onCircle = onConnect(x, y);
  const shape = pickShape(x, y);
  const arrow = end ? byId(end.arrow) : shape ? null : pickArrow(x, y);
  m.hoverArrow = arrow?.id ?? null;
  // Keep the circle's shape in focus while the pointer goes to the circle.
  if (shape) m.hoverShape = shape.id;
  else if (!onCircle) m.hoverShape = null;
  const note = shape || arrow ? null : pickNote(x, y);
  const next = shape?.id ?? arrow?.id ?? (onCircle ? onCircle.id : note?.id ?? null);
  if (next !== m.hover) { m.hover = next; ui.refresh(); }
  const canvas = board.canvas;
  const slot = slotAt(x, y);
  if (onResize(x, y)) canvas.style.cursor = 'nwse-resize';
  else if (onCircle || end) canvas.style.cursor = 'crosshair';
  else if (slot) canvas.style.cursor = 'pointer';
  else if (shape) canvas.style.cursor = m.graph.nodes.get(shape.id)?.kind === 'switch' ? 'pointer' : 'grab';
  else if (arrow) canvas.style.cursor = 'pointer';
  else if (note) canvas.style.cursor = 'grab';
  else canvas.style.cursor = '';
  board.invalidate();
});

stageCanvas.addEventListener('pointerleave', () => {
  if (m.gesture) return;
  m.hover = null; m.hoverShape = null; m.hoverArrow = null;
  ui.refresh();
  board.invalidate();
});

stageCanvas.addEventListener('dblclick', (e) => {
  const r = stageCanvas.getBoundingClientRect();
  const { x, y } = board.toStage(e.clientX - r.left, e.clientY - r.top);
  const hit = pickText(x, y);
  if (hit && !hit.customData?.machine?.note) return openEditor({ textId: hit.id });
  const owner = pickArrow(x, y) ?? pickShape(x, y);
  if (owner) return m.editLabelOf(owner.id);
  if (hit) return openEditor({ textId: hit.id });
  // Double-clicking nothing makes a shape to type into.
  const before = m.doc;
  const { list, id } = addBlank(m.doc, x, y);
  m.doc = list;
  commit(before);
  changed({ morphSeconds: 0.18 });
  select(id);
  openEditor({ ownerId: id });
});

// ---------------------------------------------------------------------------
// The palette. Parts are real shapes in a tray of their own, dragged onto the board.

const tabs = document.getElementById('tabs');
const trayNote = document.getElementById('tray-note');
let currentTab = 'work';

const defaultTab = () => (m.graph.mode === 'logic' ? 'logic' : m.graph.mode === 'states' || m.graph.mode === 'chain' ? 'states' : 'work');

function layoutTray() {
  const r = trayCanvas.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const parts = PARTS[currentTab];
  const wide = r.width > r.height;
  const cols = wide ? Math.ceil(parts.length / 2) : 2;
  const rows = Math.ceil(parts.length / cols);
  // A wide strip on a phone gets more stage units, so its words stay inside their parts.
  tray.width = wide ? cols * 170 : 380;
  tray.height = (tray.width * r.height) / r.width;
  tray.resize();
  const cellW = tray.width / cols, cellH = Math.min(wide ? tray.height / rows : 112, tray.height / rows);
  const out = [];
  parts.forEach((part, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const w = cellW - 16, h = cellH - 18;
    const x = col * cellW + 8, y = row * cellH + 9;
    const [stroke, fill] = TONES[part.tone] ?? TONES.gray;
    const tone = { stroke, fill };
    const id = `part-${currentTab}-${part.id}`;
    const hand = { customData: { handwave: { enter: 'none', cursor: 'grab' } } };
    if (part.type === 'arrow') {
      out.push({ ...rect(id, x, y, w, h, { strokeColor: 'transparent', backgroundColor: '#ffffff', ...hand }) });
      out.push({ ...rect(`${id}-line`, x + 16, y + h / 2 + 18, w - 34, 2, { tone: { stroke: color.ink, fill: color.ink }, roundness: null, customData: { handwave: { enter: 'none', ghost: true } } }) });
      out.push({ id: `${id}-t`, type: 'text', x: x + 8, y: y + h / 2 - 20, width: w - 16, height: 34, text: part.short, fontSize: 26, fontFamily: 5, textAlign: 'center', verticalAlign: 'top', lineHeight: 1.25, strokeColor: color.ink, angle: 0, opacity: 100, seed: 1, customData: { handwave: { enter: 'none', ghost: true } } });
      return;
    }
    if (part.type === 'text') {
      out.push(rect(id, x, y, w, h, { strokeColor: 'transparent', backgroundColor: '#ffffff', ...hand }));
      out.push({ id: `${id}-t`, type: 'text', x: x + 8, y: y + h / 2 - 17, width: w - 16, height: 34, text: part.short, fontSize: 26, fontFamily: 5, textAlign: 'center', verticalAlign: 'top', lineHeight: 1.25, strokeColor: color.muted, angle: 0, opacity: 100, seed: 1, customData: { handwave: { enter: 'none', ghost: true } } });
      return;
    }
    if (part.type === 'rectangle') out.push(...box(id, x, y, w, h, part.short, { size: 26, tone, labelColor: stroke, ...hand }));
    else {
      const shape = { ...rect(id, x, y, w, h, { tone, ...hand }), type: part.type, roundness: { type: 2 } };
      const [, label] = box(id, x, y, w, h, part.short, { size: 26, tone, labelColor: stroke });
      out.push(shape, { ...label, customData: { handwave: { enter: 'none', ghost: true } } });
    }
    for (const el of out) if (el.id === `${id}-t`) el.customData = { handwave: { enter: 'none', ghost: true } };
  });
  tray.show(out, { instant: true });
  trayNote.textContent = currentTab === 'states' ? 'Arrows carry the logic of a state machine. Click one to see what its label can say.' : 'Drag a part onto the board. Drop it on an arrow to put it in line.';
}

function showTab(name) {
  currentTab = name;
  for (const b of tabs.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === name);
  layoutTray();
}

tabs.addEventListener('click', (e) => {
  const name = e.target.dataset?.tab;
  if (name) { tabChoice = name; showTab(name); }
});

const partOf = (el) => (el ? PARTS[currentTab].find((p) => `part-${currentTab}-${p.id}` === el.id) : null);

m.ghostShape = (part, x, y) => {
  const [stroke, fill] = TONES[part.tone] ?? TONES.gray;
  return { ...rect(`ghost-${part.id}`, x - part.w / 2, y - part.h / 2, part.w, part.h, { strokeColor: stroke, backgroundColor: fill }), type: part.type, roundness: part.type === 'rectangle' ? { type: 3 } : { type: 2 } };
};

function boardPoint(e) {
  const r = stageCanvas.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return null;
  return board.toStage(e.clientX - r.left, e.clientY - r.top);
}

tray.on('down', '*', ({ el }) => {
  const part = partOf(el);
  if (part) m.gesture = { type: 'part', part, point: null, onArrow: null, onShape: null };
});

tray.on('drag', '*', ({ event }) => {
  const g = m.gesture;
  if (g?.type !== 'part') return;
  const p = boardPoint(event);
  g.point = p ? [p.x, p.y] : null;
  g.onShape = p && g.part.type === 'arrow' ? pickShape(p.x, p.y)?.id ?? null : null;
  g.onArrow = p && g.part.type !== 'arrow' && g.part.type !== 'text' ? pickArrow(p.x, p.y, 26)?.id ?? null : null;
  board.invalidate();
});

tray.on('up', '*', () => {
  const g = m.gesture;
  m.gesture = null;
  if (g?.type !== 'part' || !g.point) { board.invalidate(); return; }
  const before = m.doc;
  const [x, y] = g.point;
  if (g.part.type === 'arrow') {
    if (!g.onShape) {
      m.message = { words: 'A start arrow goes on a shape. Drop it on the state to begin in.', tone: color.rose };
      panelView.refresh();
      return;
    }
    const { list, id } = addStartArrow(m.doc, g.onShape);
    m.doc = list;
    commit(before);
    m.selected = id;
  } else if (g.part.type === 'text') {
    const { list, id } = addNote(m.doc, x, y, g.part.label);
    m.doc = list;
    commit(before);
    m.selected = id;
    changed({ morphSeconds: 0.18 });
    openEditor({ textId: id });
    return;
  } else if (g.onArrow) {
    const { list, id } = insertOnArrow(m.doc, g.onArrow, g.part);
    m.doc = settle(list);
    commit(before);
    m.selected = id;
  } else {
    const { list, id } = addPart(m.doc, g.part, x, y);
    m.doc = settle(list);
    commit(before);
    m.selected = id;
  }
  changed({ morphSeconds: 0.18 });
});

tray.on('enter', '*', ({ el }) => {
  const part = partOf(el);
  if (part) ui.showPart(part);
});
tray.on('leave', '*', () => ui.showPart(null));
trayCanvas.addEventListener('pointerleave', () => { if (m.gesture?.type !== 'part') ui.showPart(null); });

// ---------------------------------------------------------------------------
// Label editing, in a real text box over the drawing.

function toScreen(x, y) {
  const { view, camera: c } = board;
  const r = stageCanvas.getBoundingClientRect();
  return { x: r.left + (((x - c.x) * c.zoom) * view.scale + view.ox) / view.css, y: r.top + (((y - c.y) * c.zoom) * view.scale + view.oy) / view.css };
}

function editorContext(owner) {
  const place = owner?.type === 'arrow' ? 'arrow' : 'shape';
  return { place, kind: place === 'shape' ? m.graph.nodes.get(owner?.id)?.kind ?? null : null };
}

function openEditor({ textId, ownerId }) {
  closeEditor(true);
  const el = textId ? byId(textId) : null;
  const owner = ownerId ? byId(ownerId) : el ? byId(ownerOf(el)) : null;
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
  m.editing = { textId, ownerId, context: editorContext(owner) };
  const scale = (board.camera.zoom * board.view.scale) / board.view.css;
  const px = Math.max(14, size * scale);
  const lines = words.split('\n');
  const widest = Math.max(...lines.map((l) => l.length), 8);
  const width = widest * px * 0.62 + 30;
  const height = Math.max(lines.length, 1) * px * 1.25 + 10;
  const at = toScreen(middle[0], middle[1]);
  Object.assign(editor.style, { display: 'block', left: `${at.x - width / 2}px`, top: `${at.y - height / 2}px`, width: `${width}px`, height: `${height}px`, fontSize: `${px}px`, lineHeight: 1.25 });
  editor.value = words;
  editor.dataset.lineHeight = String(px * 1.25);
  editor.dataset.width = String(width);
  editor.focus();
  editor.select();
  ui.hints.render(editor, m.editing.context);
}

function closeEditor(commitEdit) {
  if (!m.editing) return;
  const { textId, ownerId } = m.editing;
  m.editing = null;
  const words = editor.value;
  editor.style.display = 'none';
  editor.blur();
  ui.hints.hide();
  if (!commitEdit) return;
  const before = m.doc;
  if (textId) {
    if (byId(textId)?.text !== words) m.doc = setText(m.doc, textId, words);
  } else if (words.trim()) m.doc = addLabel(m.doc, ownerId, words);
  commit(before);
  changed({ instant: true });
}

editor.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); closeEditor(true); }
  if (e.key === 'Escape') { e.preventDefault(); closeEditor(false); }
  if (e.key === 'Tab') {
    e.preventDefault();
    ui.hints.take(editor, 0);
  }
});
editor.addEventListener('input', () => {
  const lines = editor.value.split('\n');
  editor.style.height = `${lines.length * Number(editor.dataset.lineHeight) + 10}px`;
  const px = parseFloat(editor.style.fontSize);
  const wanted = Math.max(...lines.map((l) => l.length), 8) * px * 0.62 + 30;
  if (wanted > Number(editor.dataset.width)) {
    const left = parseFloat(editor.style.left) - (wanted - Number(editor.dataset.width)) / 2;
    Object.assign(editor.style, { width: `${wanted}px`, left: `${left}px` });
    editor.dataset.width = String(wanted);
  }
  ui.hints.render(editor, m.editing.context);
});
editor.addEventListener('keyup', (e) => { if (e.key.startsWith('Arrow') && m.editing) ui.hints.render(editor, m.editing.context); });
editor.addEventListener('blur', () => closeEditor(true));

// ---------------------------------------------------------------------------
// Things the inspector asks for.

m.select = (id) => select(id);
m.editNote = (id) => openEditor({ textId: id });
m.editLabelOf = (id) => {
  const label = m.doc.find((el) => isText(el) && ownerOf(el) === id);
  openEditor(label ? { textId: label.id } : { ownerId: id });
};
m.remove = (id) => {
  edit((list) => removeElement(list, id));
  if (m.selected === id) select(null);
  if (m.hover === id) m.hover = null;
};
m.copy = (id) => {
  const before = m.doc;
  const { list, id: copyId } = duplicate(m.doc, id);
  m.doc = list;
  commit(before);
  changed({ morphSeconds: 0.18 });
  select(copyId);
};
m.addWord = (id, words) => edit((list) => appendToLabel(list, id, words), { instant: true });
m.applyFix = (issue) => {
  if (issue.suggestLine) return edit((list) => setLabel(list, issue.id, issue.suggestLine), { instant: true });
  const old = issue.text;
  const first = old.split(' ')[0];
  edit((list) => replaceInLabel(list, issue.id, old, `${issue.suggest}${old.slice(first.length)}`), { instant: true });
};

// A slider changes a number many times, and all of it is one step to undo.
let scrubBefore = null;
m.beginEdit = () => { scrubBefore = m.doc; };
m.endEdit = () => { if (scrubBefore) commit(scrubBefore); scrubBefore = null; };
m.scrub = (id, from, to, single = false) => {
  const before = m.doc;
  m.doc = replaceInLabel(m.doc, id, from, to);
  if (single) commit(before);
  changed({ instant: true });
};
m.docWith = (id, from, to) => replaceInLabel(m.doc, id, from, to);

// A chart is a native shape joined by an arrow to what it watches, so saving keeps it.
m.addChartOf = (id) => {
  const target = byId(id);
  if (!target) return;
  const before = m.doc;
  const chart = PARTS.work.find((p) => p.id === 'chart');
  const c = board.camera;
  const right = c.x + board.width / c.zoom - chart.w / 2 - 12;
  const x = Math.min(right, target.x + target.width + chart.w / 2 + 40);
  const y = Math.max(c.y + chart.h / 2 + 100, target.y - chart.h / 2 - 30);
  const { list, id: chartId } = addPart(m.doc, chart, x, y);
  m.doc = addArrow(settle(list), chartId, id).list;
  commit(before);
  changed({ morphSeconds: 0.18 });
  select(chartId);
};

m.demoInfo = () => m.demos.find((d) => d.id === m.demo) ?? null;
m.setGalleryOpen = (open) => { m.galleryOpen = open; };
m.loadDemo = loadDemo;
m.loadBlank = loadBlank;

m.nextStep = () => {
  if (m.empty()) return 'Drag a part from the left onto the board, or double-click anywhere to add a shape.';
  if (!arrows().length) return 'Hover a shape and drag from its small blue circle to another shape to draw an arrow.';
  return 'Click anything to see what it understood. Double-click a label to change it.';
};

// ---------------------------------------------------------------------------
// Saving and opening.

const filename = () => `${(m.demo ?? 'my-diagram').replace(/[^\w-]/g, '')}.excalidraw`;

function saveFile() {
  closeEditor(true);
  const url = URL.createObjectURL(new Blob([toExcalidraw(m.doc, board.files)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename();
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  m.message = { words: `Saved ${filename()}. It opens in Excalidraw, and you can drop it back here.`, tone: color.blue };
  panelView.refresh();
}

async function runFile(name, words) {
  let data;
  try {
    data = JSON.parse(words);
    if (!Array.isArray(data.elements)) throw new Error('no elements');
  } catch {
    m.message = { words: `${name} is not an Excalidraw drawing, so the board stays as it was.`, tone: color.rose };
    panelView.refresh();
    return;
  }
  const { elements, files } = parseScene(data);
  m.demo = null;
  history.replaceState(null, '', location.pathname + location.search);
  loadElements(elements, files, name);
  m.message = { words: `Running ${name}.`, tone: color.blue };
  panelView.refresh();
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (file) await runFile(file.name, await file.text());
  fileInput.value = '';
});

addEventListener('dragover', (e) => { e.preventDefault(); });
addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  ui.closeGallery();
  await runFile(file.name, await file.text());
});

// ---------------------------------------------------------------------------
// Keys and buttons.

const typing = () => m.editing || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);

addEventListener('keydown', (e) => {
  const cmd = e.metaKey || e.ctrlKey;
  if (e.key === 'Escape') {
    if (ui.referenceOpen()) ui.closeReference();
    else if (m.whatif) ui.closeWhatIf();
    else if (ui.galleryOpen() && m.doc.length) ui.closeGallery();
    else select(null);
    return;
  }
  if (typing() && document.activeElement?.type !== 'range') return;
  if (cmd && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (cmd && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (cmd && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); return; }
  if (cmd && e.key.toLowerCase() === 'd') { e.preventDefault(); if (m.selected) m.copy(m.selected); return; }
  if (cmd) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && m.selected) { e.preventDefault(); m.remove(m.selected); return; }
  if (e.key === ' ') { e.preventDefault(); setRunning(!m.running); return; }
  if (e.key === '.') { stepOnce(); return; }
  if (e.key === '?') { e.preventDefault(); if (ui.referenceOpen()) ui.closeReference(); else ui.openReference(); return; }
  if (m.sim?.mode === 'states') {
    const event = m.sim.events()[Number(e.key) - 1];
    if (event) fire(event);
  }
});

panel.on('click', '*', ({ id }) => {
  if (id?.startsWith('event-')) fire(id.slice(6));
});

document.getElementById('btn-run').addEventListener('click', () => setRunning(!m.running));
document.getElementById('btn-step').addEventListener('click', stepOnce);
document.getElementById('btn-restart').addEventListener('click', restart);
document.getElementById('btn-undo').addEventListener('click', undo);
document.getElementById('btn-redo').addEventListener('click', redo);
document.getElementById('btn-save').addEventListener('click', saveFile);
document.getElementById('btn-open').addEventListener('click', () => fileInput.click());
document.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => setSpeed(Number(b.dataset.speed))));

// ---------------------------------------------------------------------------

const panelView = createPanel(m);
const ui = createUi(m);
const drawOverlay = createOverlay(m);
board.layer('over', (ctx, stage) => {
  const dt = Math.max(0, stage.time - overlayTime);
  overlayTime = stage.time;
  drawOverlay(ctx, dt);
});

m.demos = await (await fetch('./scenes/demos.json')).json();
sizeStages();

const wanted = location.hash.slice(1);
if (wanted === 'blank') loadBlank();
else if (m.demos.some((d) => d.id === wanted)) await loadDemo(wanted);
else {
  // A first visit opens on the range of what a drawing can be.
  await loadDemo('queue');
  history.replaceState(null, '', location.pathname + location.search);
  ui.openGallery();
}

window.app = {
  board, panel, tray, toScreen, loadDemo, loadBlank, restart, fastForward, holdClock, fire, ui, m,
  undo, redo, stepOnce, setRunning, setSpeed, saveFile, runFile, select, readLabel, frameMs: () => board.frameMs,
  get doc() { return m.doc; },
  get graph() { return m.graph; },
  get sim() { return m.sim; },
  get title() { return m.title; },
  get message() { return m.message; },
  get editing() { return m.editing; },
  get running() { return m.running; },
  byId,
  save: () => toExcalidraw(m.doc, board.files),
  graphOf: (json) => { const { elements } = parseScene(JSON.parse(json)); return readGraph(settle(infer(elements))); },
};
