// Turns the validated board state into Excalidraw elements. The page holds the same
// items as the server's Board and rebuilds its whole scene after every op. Stage.show
// then draws in whatever is new and morphs whatever moved.

import { measure } from '/lib/stage.js';
import { rect, ellipse, diamond, arrow, line, text, color } from '/lib/draw.js';

export const STAGE = { width: 1600, height: 860 };

const COLS = 4, ROWS = 4;
const X0 = 40, Y0 = 104, CW = 380, CH = 185;
const GAP_X = 150, GAP_Y = 75;
const ARROW_GAP = 9;

const TONE = { ink: { fill: '#ffffff', stroke: color.ink }, blue: color.blue, amber: color.amber, green: color.green, rose: color.rose, gray: color.gray };

const ghost = (extra = {}) => ({ customData: { handwave: { ghost: true, ...extra } } });

function wrap(words, maxWidth, size, font = 5) {
  const lines = [];
  let current = '';
  for (const word of String(words).split(/\s+/)) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && measure(candidate, size, font).width > maxWidth) { lines.push(current); current = word; } else current = candidate;
  }
  if (current) lines.push(current);
  return lines;
}

/** The largest size at which words fit a box, wrapped. */
function fit(words, width, height, sizes = [34, 30, 28, 26, 24, 22, 20, 18, 16]) {
  for (const size of sizes) {
    const lines = wrap(words, width, size);
    const m = measure(lines.join('\n'), size);
    if (m.width <= width && m.height <= height) return { size, text: lines.join('\n') };
  }
  const size = sizes[sizes.length - 1];
  return { size, text: wrap(words, width, size).join('\n') };
}

function solidRect(item) {
  const x = X0 + item.col * CW, y = Y0 + item.row * CH;
  const w = item.cols * CW, h = item.rows * CH;
  if (item.kind === 'note') return { x: x + 16, y: y + 12, width: w - 32, height: h - 24 };
  if (item.kind === 'frame') return { x: x + 8, y: y + 2, width: w - 16, height: h - 4 };
  return { x: x + GAP_X / 2, y: y + GAP_Y / 2, width: w - GAP_X, height: h - GAP_Y };
}

function cellsGeometry(item) {
  const r = solidRect(item);
  // A strip reaches across its cells, since nothing connects to it from the sides.
  const x = X0 + item.col * CW + 30, width = item.cols * CW - 60;
  const height = Math.min(r.height, 88);
  const y = r.y + (r.height - height) / 2 + (item.label ? 12 : 0);
  const cell = width / item.values.length;
  return { x, y, width, height, cell };
}

function boundsOf(item, id, items) {
  if (item.kind === 'cells') {
    const g = cellsGeometry(item);
    const child = id.includes('.') ? +id.split('.')[1] : null;
    if (child !== null) return { x: g.x + child * g.cell, y: g.y, width: g.cell, height: g.height };
    return { x: g.x, y: g.y, width: g.width, height: g.height };
  }
  if (item.kind === 'arrow') {
    const p = arrowPath(item, items);
    if (!p) return null;
    const xs = p.points.map((q) => q[0]), ys = p.points.map((q) => q[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }
  if (item.kind === 'line') {
    const pts = item.points.map(gridPoint);
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }
  return solidRect(item);
}

const gridPoint = ([c, r]) => [X0 + c * CW, Y0 + r * CH];

function shapeOf(id, items) {
  const parent = id.split('.')[0];
  const item = items.get(parent);
  if (!item) return null;
  const kind = id.includes('.') ? 'cell' : item.kind === 'ellipse' || item.kind === 'diamond' ? item.kind : 'box';
  return { kind, bounds: boundsOf(item, id, items) };
}

const centerOf = (shape) => [shape.bounds.x + shape.bounds.width / 2, shape.bounds.y + shape.bounds.height / 2];

/** The side of a line its words go on: above, or to the right when it is mostly upright. */
function normalOf(s, e) {
  const len = Math.hypot(e[0] - s[0], e[1] - s[1]) || 1;
  const n = [-(e[1] - s[1]) / len, (e[0] - s[0]) / len];
  if (Math.abs(n[1]) >= Math.abs(n[0])) return n[1] <= 0 ? n : [-n[0], -n[1]];
  return n[0] >= 0 ? n : [-n[0], -n[1]];
}

// A cell has neighbors on both sides, so an arrow reaches it from above or below.
// When both ends are level with each other, it goes up and over the strip.
function cellRoute(a, b) {
  const ac = centerOf(a), bc = centerOf(b);
  const reach = (a.bounds.height + b.bounds.height) / 2;
  if (Math.abs(ac[1] - bc[1]) < reach) {
    // Over the strip, or under it when the title leaves no room above.
    const top = Math.min(a.bounds.y, b.bounds.y) - 46;
    const under = top - 36 < Y0 - 8;
    const y = under ? Math.max(a.bounds.y + a.bounds.height, b.bounds.y + b.bounds.height) + 46 : top;
    const edgeY = (shape) => (under ? shape.bounds.y + shape.bounds.height + ARROW_GAP : shape.bounds.y - ARROW_GAP);
    const over = [[ac[0], y], [bc[0], y]];
    return { points: [[ac[0], edgeY(a)], ...over, [bc[0], edgeY(b)]], labelOn: over, side: -1, normal: [0, -1] };
  }
  const down = bc[1] > ac[1];
  const face = (shape, top) => [centerOf(shape)[0], top ? shape.bounds.y - ARROW_GAP : shape.bounds.y + shape.bounds.height + ARROW_GAP];
  const away = (p, q) => {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    return [p[0] + ((q[0] - p[0]) / d) * ARROW_GAP, p[1] + ((q[1] - p[1]) / d) * ARROW_GAP];
  };
  const start = a.kind === 'cell' ? face(a, !down) : away(edge(a, bc[0], bc[1]), bc);
  const end = b.kind === 'cell' ? face(b, down) : away(edge(b, ac[0], ac[1]), ac);
  return { points: [start, end], side: -1, normal: normalOf(start, end) };
}

// Where a ray from a shape's center toward (tx, ty) leaves the shape.
function edge(shape, tx, ty) {
  const b = shape.bounds;
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  const dx = tx - cx, dy = ty - cy;
  const hw = b.width / 2, hh = b.height / 2;
  if (!dx && !dy) return [cx, cy];
  let t;
  if (shape.kind === 'ellipse') t = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
  else if (shape.kind === 'diamond') t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else t = Math.min(hw / Math.abs(dx || 1e-6), hh / Math.abs(dy || 1e-6));
  return [cx + dx * t, cy + dy * t];
}

/** Arrows that join the same pair of items run side by side instead of on top of each other. */
function siblings(item, items) {
  const key = (a) => [a.from, a.to].sort().join('|');
  return [...items.values()].filter((a) => a.kind === 'arrow' && a.at === undefined && key(a) === key(item));
}

function arrowPath(item, items) {
  const a = shapeOf(item.from, items), b = shapeOf(item.to, items);
  if (!a || !b) return null;
  if (a.kind === 'cell' || b.kind === 'cell') return cellRoute(a, b);
  const ac = centerOf(a), bc = centerOf(b);
  let start, end, side = -1, normal;
  if (item.at !== undefined && Math.abs(ac[0] - bc[0]) > 1) {
    // A level arrow at a row's height, for sequences between tall boxes.
    const y = Y0 + (item.at + 0.5) * CH;
    const right = bc[0] > ac[0];
    const sx = right ? a.bounds.x + a.bounds.width + ARROW_GAP : a.bounds.x - ARROW_GAP;
    const ex = right ? b.bounds.x - ARROW_GAP : b.bounds.x + b.bounds.width + ARROW_GAP;
    start = [sx, y];
    end = [ex, y];
    normal = [0, -1];
  } else {
    const group = item.at === undefined ? siblings(item, items) : [item];
    const index = group.indexOf(item);
    // The normal comes from the sorted pair, so opposing arrows sit on opposite sides.
    const [p, q] = item.from < item.to ? [ac, bc] : [bc, ac];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const n = [-(q[1] - p[1]) / len, (q[0] - p[0]) / len];
    normal = Math.abs(n[1]) >= Math.abs(n[0]) ? (n[1] <= 0 ? n : [-n[0], -n[1]]) : (n[0] >= 0 ? n : [-n[0], -n[1]]);
    const offset = group.length > 1 ? (index - (group.length - 1) / 2) * 36 : 0;
    side = group.length > 1 && offset > 0 ? 1 : -1;
    const shift = [normal[0] * -side * Math.abs(offset), normal[1] * -side * Math.abs(offset)];
    if (group.length > 1 && offset === 0) { shift[0] = 0; shift[1] = 0; }
    const from = [ac[0] + shift[0], ac[1] + shift[1]], to = [bc[0] + shift[0], bc[1] + shift[1]];
    const ea = edge(a, to[0], to[1]), eb = edge(b, from[0], from[1]);
    // Move the edge points sideways by the same shift, so parallel arrows stay parallel.
    const startRaw = [ea[0] + shift[0], ea[1] + shift[1]], endRaw = [eb[0] + shift[0], eb[1] + shift[1]];
    const d = Math.hypot(endRaw[0] - startRaw[0], endRaw[1] - startRaw[1]) || 1;
    const u = [(endRaw[0] - startRaw[0]) / d, (endRaw[1] - startRaw[1]) / d];
    start = [startRaw[0] + u[0] * ARROW_GAP, startRaw[1] + u[1] * ARROW_GAP];
    end = [endRaw[0] - u[0] * ARROW_GAP, endRaw[1] - u[1] * ARROW_GAP];
  }
  return { points: [start, end], side, normal };
}

function arrowLabel(item, path) {
  const [s, e] = path.labelOn ?? [path.points[0], path.points[path.points.length - 1]];
  const dx = e[0] - s[0], dy = e[1] - s[1];
  const mid = [(s[0] + e[0]) / 2, (s[1] + e[1]) / 2];
  const horizontal = Math.abs(dy) < Math.abs(dx) * 0.2;
  const vertical = Math.abs(dx) < Math.abs(dy) * 0.2;
  const size = 22;
  const out = [];
  const tone = TONE[item.tone];
  const maxWidth = horizontal ? Math.max(100, Math.abs(dx) - 6) : 170;
  const words = wrap(item.label, maxWidth, size).join('\n');
  const m = measure(words, size);
  const gap = 8;
  let x, y, align = 'center';
  if (horizontal) {
    x = mid[0];
    y = path.side < 0 ? mid[1] - m.height - gap : mid[1] + gap;
  } else if (vertical) {
    align = path.side < 0 ? 'left' : 'right';
    x = path.side < 0 ? mid[0] + gap + 4 : mid[0] - gap - 4;
    y = mid[1] - m.height / 2;
  } else {
    // A slanted arrow: the words sit just clear of the line, on its upper side.
    const n = path.normal;
    const clear = (Math.abs(n[0]) * m.width + Math.abs(n[1]) * m.height) / 2 + gap;
    x = mid[0] + n[0] * clear;
    y = mid[1] + n[1] * clear - m.height / 2;
  }
  out.push(text(`${item.id}-t`, x, y, words, { size, align, color: tone.stroke, customData: { handwave: { delay: 0.25 } } }));
  return out;
}

export class BoardView {
  constructor() {
    this.items = new Map();
    this.title = null;
    this.focus = new Set();
    this.selected = [];
  }

  apply(op) {
    switch (op.op) {
      case 'title': this.title = op.text; break;
      case 'draw': this.items.set(op.item.id, op.item); break;
      case 'update': {
        const [parent, child] = op.id.split('.');
        const item = this.items.get(parent);
        if (!item) break;
        if (child !== undefined && item.kind === 'cells') {
          if (op.patch.tone) item.tones[child] = op.patch.tone;
          if (op.patch.label !== undefined) item.values[+child] = op.patch.label;
        } else Object.assign(item, op.patch);
        break;
      }
      case 'remove':
        for (const id of op.ids) this.items.delete(id);
        this.selected = this.selected.filter((id) => this.items.has(id.split('.')[0]));
        break;
      case 'focus': this.focus = new Set(op.ids); break;
      case 'clear':
        this.items.clear();
        this.title = null;
        this.focus = new Set();
        this.selected = [];
        break;
      default:
    }
  }

  /** The board item an element belongs to, for pointing. */
  ownerOf(elementId) {
    const base = elementId.replace(/-(t|k|l)$/, '');
    return this._has(base) ? base : null;
  }

  _has(id) {
    const [parent, child] = id.split('.');
    const item = this.items.get(parent);
    if (!item) return false;
    return child === undefined || (item.kind === 'cells' && +child < item.values.length);
  }

  toggle(id) {
    if (this.selected.includes(id)) this.selected = this.selected.filter((s) => s !== id);
    else this.selected = [...this.selected, id];
  }

  describe(id) {
    const [parent, child] = id.split('.');
    const item = this.items.get(parent);
    if (!item) return { id, kind: 'gone', label: '' };
    if (child !== undefined) return { id, kind: 'cell', label: `value ${item.values[+child]}` };
    if (item.kind === 'arrow') return { id, kind: 'arrow', label: item.label || `${item.from} to ${item.to}` };
    return { id, kind: item.kind, label: item.label ?? item.text ?? '' };
  }

  _dim(id) {
    if (!this.focus.size) return 100;
    const [parent] = id.split('.');
    if (this.focus.has(id) || this.focus.has(parent)) return 100;
    const item = this.items.get(parent);
    if (item?.kind === 'cells' && [...this.focus].some((f) => f.startsWith(`${parent}.`))) return 100;
    if (item?.kind === 'arrow' && (this.focus.has(item.from) && this.focus.has(item.to))) return 100;
    return 25;
  }

  elements() {
    const out = [];
    if (this.title) out.push(text('board-title', 44, 22, this.title, { size: 46, font: 6, ...ghost() }));
    const order = { frame: 0, line: 1, box: 2, ellipse: 2, diamond: 2, cells: 2, arrow: 3, note: 4 };
    const items = [...this.items.values()].sort((a, b) => order[a.kind] - order[b.kind]);
    for (const item of items) {
      const opacity = this._dim(item.id);
      const tone = TONE[item.tone] ?? TONE.gray;
      const dashed = item.dashed ? { strokeStyle: 'dashed' } : {};
      if (item.kind === 'box' || item.kind === 'ellipse' || item.kind === 'diamond') {
        const r = solidRect(item);
        const make = item.kind === 'box' ? rect : item.kind === 'ellipse' ? ellipse : diamond;
        out.push(make(item.id, r.x, r.y, r.width, r.height, { tone, opacity, ...dashed }));
        const inset = item.kind === 'box' ? 20 : item.kind === 'ellipse' ? r.width * 0.16 : r.width * 0.24;
        const insetY = item.kind === 'box' ? 12 : item.kind === 'ellipse' ? r.height * 0.14 : r.height * 0.22;
        if (item.label) {
          const f = fit(item.label, r.width - inset * 2, r.height - insetY * 2);
          out.push(text(`${item.id}-t`, r.x + r.width / 2, r.y + r.height / 2, f.text, { size: f.size, align: 'center', valign: 'middle', opacity, color: tone.stroke, ...ghost({ delay: 0.2 }) }));
        }
      } else if (item.kind === 'note') {
        const r = solidRect(item);
        const f = fit(item.text, r.width, r.height, [30, 28, 26, 24, 22, 20]);
        const m = measure(f.text, f.size);
        out.push(text(item.id, r.x, r.y + (r.height - m.height) / 2, f.text, { size: f.size, opacity, color: tone.stroke }));
      } else if (item.kind === 'frame') {
        const r = solidRect(item);
        out.push(rect(item.id, r.x, r.y, r.width, r.height, { strokeColor: tone.stroke, backgroundColor: 'transparent', strokeStyle: 'dashed', strokeWidth: 1.5, opacity }));
        if (item.label) out.push(text(`${item.id}-t`, r.x + 14, r.y + 6, item.label, { size: 22, color: tone.stroke, opacity, ...ghost({ delay: 0.2 }) }));
      } else if (item.kind === 'cells') {
        const g = cellsGeometry(item);
        if (item.label) out.push(text(`${item.id}-l`, g.x, g.y - 32, item.label, { size: 22, color: color.muted, opacity, ...ghost() }));
        item.values.forEach((value, i) => {
          const id = `${item.id}.${i}`;
          const cellTone = TONE[item.tones?.[i] ?? item.tone] ?? TONE.gray;
          const cellOpacity = this._dim(id);
          out.push(rect(id, g.x + i * g.cell, g.y, g.cell, g.height, { tone: cellTone, opacity: cellOpacity, roundness: null }));
          const f = fit(String(value), g.cell - 8, g.height - 8, [30, 26, 22, 18, 14]);
          out.push(text(`${id}-t`, g.x + i * g.cell + g.cell / 2, g.y + g.height / 2, f.text, { size: f.size, align: 'center', valign: 'middle', color: cellTone.stroke, opacity: cellOpacity, ...ghost({ delay: 0.1 }) }));
        });
      } else if (item.kind === 'arrow') {
        const path = arrowPath(item, this.items);
        if (!path) continue;
        out.push(arrow(item.id, path.points, { strokeColor: tone.stroke, opacity, startArrowhead: item.both ? 'arrow' : null, ...dashed }));
        if (item.label) out.push(...arrowLabel(item, path).map((el) => ({ ...el, opacity })));
      } else if (item.kind === 'line') {
        const pts = item.points.map(gridPoint);
        const make = item.head ? arrow : line;
        out.push(make(item.id, pts, { strokeColor: tone.stroke, opacity, roundness: item.curved ? { type: 2 } : null, ...dashed }));
        if (item.label) {
          const end = pts[pts.length - 1];
          out.push(text(`${item.id}-t`, Math.min(end[0] + 8, 1400), end[1] + 6, item.label, { size: 22, color: tone.stroke, opacity }));
        }
      }
    }
    // A ring marks what the student is pointing at.
    for (const id of this.selected) {
      const item = this.items.get(id.split('.')[0]);
      if (!item) continue;
      const b = boundsOf(item, id, this.items);
      if (!b) continue;
      const pad = 12;
      out.push(rect(`ring-${id}`, b.x - pad, b.y - pad, Math.max(b.width, 8) + pad * 2, Math.max(b.height, 8) + pad * 2, { strokeColor: color.amber.stroke, backgroundColor: 'transparent', strokeWidth: 3, ...ghost({ exit: 'none' }) }));
    }
    return out;
  }
}

export const GRID = { COLS, ROWS, X0, Y0, CW, CH };

/** Layout problems in a scene, for tests: shapes on shapes, text outside its box, arrows crossing shapes. */
export function audit(view) {
  const problems = [];
  const items = [...view.items.values()];
  const solids = items.filter((i) => ['box', 'ellipse', 'diamond', 'note', 'cells'].includes(i.kind));
  const rectOf = (i) => (i.kind === 'cells' ? cellsGeometry(i) : solidRect(i));
  const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  for (let i = 0; i < solids.length; i++) for (let j = i + 1; j < solids.length; j++) {
    if (overlap(rectOf(solids[i]), rectOf(solids[j]))) problems.push(`${solids[i].id} overlaps ${solids[j].id}`);
  }
  const elements = view.elements();
  const byId = new Map(elements.map((e) => [e.id, e]));
  for (const i of solids) {
    if (i.kind === 'cells' || i.kind === 'note') continue;
    const label = byId.get(`${i.id}-t`), shape = byId.get(i.id);
    if (label && shape && (label.width > shape.width + 1 || label.height > shape.height + 1)) problems.push(`label of ${i.id} is larger than its shape`);
  }
  for (const el of elements) {
    if (el.x < 0 || el.y < 0 || el.x + el.width > STAGE.width || el.y + el.height > STAGE.height) {
      if (el.type !== 'arrow' && el.type !== 'line') problems.push(`${el.id} runs off the board`);
    }
  }
  // An arrow may touch only what it joins, and a strip's other cells count.
  const targets = solids.flatMap((i) => {
    if (i.kind !== 'cells') return [{ id: i.id, r: rectOf(i) }];
    const g = cellsGeometry(i);
    return i.values.map((_, n) => ({ id: `${i.id}.${n}`, r: { x: g.x + n * g.cell, y: g.y, width: g.cell, height: g.height } }));
  });
  for (const a of items.filter((i) => i.kind === 'arrow')) {
    const path = arrowPath(a, view.items);
    if (!path) continue;
    for (const other of targets) {
      if (other.id === a.from || other.id === a.to) continue;
      let crossed = false;
      for (let k = 1; k < path.points.length && !crossed; k++) {
        const s = path.points[k - 1], e = path.points[k];
        for (let t = 0.02; t < 1; t += 0.02) {
          const x = s[0] + (e[0] - s[0]) * t, y = s[1] + (e[1] - s[1]) * t;
          if (x > other.r.x && x < other.r.x + other.r.width && y > other.r.y && y < other.r.y + other.r.height) { crossed = true; break; }
        }
      }
      if (crossed) problems.push(`arrow ${a.id} crosses ${other.id}`);
    }
  }
  // Arrow labels over shapes they do not belong to.
  for (const a of items.filter((i) => i.kind === 'arrow' && i.label)) {
    const label = byId.get(`${a.id}-t`);
    if (!label) continue;
    for (const other of solids) {
      const r = rectOf(other);
      if (overlap({ x: label.x, y: label.y, width: label.width, height: label.height }, r)) problems.push(`label of ${a.id} sits on ${other.id}`);
    }
  }
  return problems;
}
