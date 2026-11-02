// Read a program out of a drawing. Shapes are nodes, arrows are edges and labels are
// parameters. This file has no DOM and no state, so anything it decides can be checked
// by reading the .excalidraw file. The words themselves live in vocab.js.
//
// A drawing runs as one of four things:
//   a flow of work     a shape uses a work word such as rate or workers
//   a logic circuit    a shape is a switch, clock, lamp or gate
//   a chance walk      arrows carry % labels and nothing above applies
//   a state machine    any other drawing with arrows

import { KIND_ORDER, KINDS, MODES, readLabel, triggerOf, distance } from './vocab.js';

const SHAPES = new Set(['rectangle', 'ellipse', 'diamond']);

export const isShape = (el) => SHAPES.has(el.type) && !el.isDeleted && !(el.strokeColor === 'transparent' && (el.backgroundColor === 'transparent' || !el.backgroundColor));
export const isArrow = (el) => el.type === 'arrow' && !el.isDeleted && (el.points?.length ?? 0) > 1;
export const isText = (el) => el.type === 'text' && !el.isDeleted;

export const center = (el) => [el.x + (el.width ?? 0) / 2, el.y + (el.height ?? 0) / 2];
export const absPoints = (el) => el.points.map(([x, y]) => [el.x + x, el.y + y]);

/** Whether a point is on a shape, grown by `gap`. */
export function inside(el, x, y, gap = 0) {
  const [cx, cy] = center(el);
  const a = el.width / 2 + gap, b = el.height / 2 + gap;
  if (a <= 0 || b <= 0) return false;
  const dx = Math.abs(x - cx), dy = Math.abs(y - cy);
  if (el.type === 'ellipse') return (dx / a) ** 2 + (dy / b) ** 2 <= 1;
  if (el.type === 'diamond') return dx / (a + gap * 0.4) + dy / (b + gap * 0.4) <= 1;
  return dx <= a && dy <= b;
}

/** Where a line from outside a shape first meets it, stopping `gap` short. */
export function boundaryHit(el, from, to, gap = 8) {
  const at = (t) => [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
  if (inside(el, from[0], from[1], gap)) {
    // The two shapes overlap, so there is no outside to come from.
    return from;
  }
  let lo = 0, hi = 1;
  const steps = 48;
  for (let i = 1; i <= steps; i++) {
    const p = at(i / steps);
    if (inside(el, p[0], p[1], gap)) { lo = (i - 1) / steps; hi = i / steps; break; }
  }
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    const p = at(mid);
    if (inside(el, p[0], p[1], gap)) hi = mid; else lo = mid;
  }
  return at(lo);
}

// ---------------------------------------------------------------------------
// The path an arrow draws, so a token can follow it. A rounded arrow is rough.js's
// curve: Catmull-Rom through its points, with the end points doubled.

const paths = new WeakMap();

export function pathOf(el) {
  let path = paths.get(el);
  if (path) return path;
  const abs = absPoints(el);
  let pts = abs;
  if (el.roundness && abs.length > 2) {
    const p = [abs[0], ...abs, abs[abs.length - 1]];
    pts = [abs[0]];
    for (let i = 1; i < p.length - 2; i++) {
      const c1 = [p[i][0] + (p[i + 1][0] - p[i - 1][0]) / 6, p[i][1] + (p[i + 1][1] - p[i - 1][1]) / 6];
      const c2 = [p[i + 1][0] - (p[i + 2][0] - p[i][0]) / 6, p[i + 1][1] - (p[i + 2][1] - p[i][1]) / 6];
      for (let k = 1; k <= 16; k++) {
        const t = k / 16, u = 1 - t;
        pts.push([
          u * u * u * p[i][0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p[i + 1][0],
          u * u * u * p[i][1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p[i + 1][1],
        ]);
      }
    }
  }
  const lens = [0];
  for (let i = 1; i < pts.length; i++) lens[i] = lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  path = { pts, lens, total: lens[lens.length - 1] || 1 };
  paths.set(el, path);
  return path;
}

export function pointAlong(path, t) {
  const at = Math.max(0, Math.min(1, t)) * path.total;
  let i = 1;
  while (i < path.pts.length - 1 && path.lens[i] < at) i++;
  const span = path.lens[i] - path.lens[i - 1] || 1;
  const k = (at - path.lens[i - 1]) / span;
  return [path.pts[i - 1][0] + (path.pts[i][0] - path.pts[i - 1][0]) * k, path.pts[i - 1][1] + (path.pts[i][1] - path.pts[i - 1][1]) * k];
}

export function distanceToPath(path, x, y) {
  let best = Infinity;
  for (let i = 1; i < path.pts.length; i++) {
    const [ax, ay] = path.pts[i - 1], [bx, by] = path.pts[i];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return best;
}

// ---------------------------------------------------------------------------
// Tidy a file on load. Excalidraw binds arrows and labels, but a hand-placed scene
// may only put them near each other, so those are bound by position. The result is
// still a plain Excalidraw document.

function nearestShape(shapes, [x, y], reach = 30) {
  let best = null, bestScore = Infinity;
  for (const s of shapes) {
    if (!inside(s, x, y, reach)) continue;
    const dx = Math.max(s.x - x, 0, x - (s.x + s.width));
    const dy = Math.max(s.y - y, 0, y - (s.y + s.height));
    // Nearest edge first. Among shapes the point is inside, the smallest.
    const score = Math.hypot(dx, dy) * 1e7 + s.width * s.height;
    if (score < bestScore) { bestScore = score; best = s; }
  }
  return best;
}

// How far an arrow's end sits off the line through its shape's center. Keeping this
// lets two arrows between the same shapes stay apart when a shape moves.
export function aimOffset(shape, point, direction) {
  const length = Math.hypot(direction[0], direction[1]) || 1;
  const perp = [-direction[1] / length, direction[0] / length];
  const [cx, cy] = center(shape);
  const off = (point[0] - cx) * perp[0] + (point[1] - cy) * perp[1];
  const most = Math.min(shape.width, shape.height) * 0.45;
  return Math.max(-most, Math.min(most, off));
}

export function infer(input) {
  const elements = input.filter((el) => !el.isDeleted).map((el) => ({ ...el }));
  const byId = new Map(elements.map((el) => [el.id, el]));
  const shapes = elements.filter(isShape);
  const shapeIds = new Set(shapes.map((s) => s.id));
  const bindTo = (shape, arrowId) => {
    const list = shape.boundElements ?? [];
    if (!list.some((b) => b.id === arrowId)) shape.boundElements = [...list, { id: arrowId, type: 'arrow' }];
  };

  for (const el of elements) {
    if (!isArrow(el)) continue;
    const abs = absPoints(el);
    for (const [key, point] of [['startBinding', abs[0]], ['endBinding', abs[abs.length - 1]]]) {
      const bound = el[key]?.elementId;
      if (bound && shapeIds.has(bound)) continue;
      const shape = nearestShape(shapes, point);
      el[key] = shape ? { elementId: shape.id, focus: 0, gap: 8 } : null;
      if (shape) bindTo(shape, el.id);
    }
    const aim = {};
    const S = byId.get(el.startBinding?.elementId), E = byId.get(el.endBinding?.elementId);
    if (S) aim.start = aimOffset(S, abs[0], [abs[1][0] - abs[0][0], abs[1][1] - abs[0][1]]);
    const n = abs.length;
    if (E) aim.end = aimOffset(E, abs[n - 1], [abs[n - 1][0] - abs[n - 2][0], abs[n - 1][1] - abs[n - 2][1]]);
    el.customData = { ...el.customData, machine: { ...el.customData?.machine, aim } };
  }

  // Free text inside a shape labels the shape, and free text beside an arrow labels
  // the arrow. Anything else, such as a title, is a note and does nothing.
  const arrows = elements.filter(isArrow);
  for (const el of elements) {
    if (!isText(el) || el.containerId || el.customData?.machine?.note) continue;
    const [cx, cy] = center(el);
    const holders = shapes.filter((s) => inside(s, cx, cy));
    let owner = holders.sort((a, b) => a.width * a.height - b.width * b.height)[0];
    if (!owner) {
      let best = 46;
      for (const a of arrows) {
        const d = distanceToPath(pathOf(a), cx, cy);
        if (d < best) { best = d; owner = a; }
      }
    }
    if (owner) el.customData = { ...el.customData, machine: { ...el.customData?.machine, owner: owner.id } };
  }
  return elements;
}

export const ownerOf = (text) => text.containerId ?? text.customData?.machine?.owner ?? null;

// ---------------------------------------------------------------------------
// The program.

// The numbers a chart can read from a shape in a flow. sim.metrics() fills these in.
const METRICS = ['waiting', 'busy', 'inside', 'done', 'rate', 'dropped', 'wasted', 'hitrate', 'time'];

const LOGIC_KINDS = new Set(['switch', 'button', 'clock', 'and', 'or', 'not', 'xor', 'nand', 'nor', 'flip', 'lamp']);

function chooseMode(labels, edgeLabels, linked) {
  if (labels.some((l) => triggerOf(l, 'flow'))) return 'flow';
  if (labels.some((l) => triggerOf(l, 'logic'))) return 'logic';
  if (!linked) return 'none';
  if (edgeLabels.some((l) => readLabel(l, 'arrow', 'chain').hits.some((h) => h.word.id === 'share'))) return 'chain';
  return 'states';
}

/** The sentence behind the mode, naming the shape that decided it. */
export function whyMode(graph) {
  const mode = MODES[graph.mode];
  if (graph.mode !== 'flow' && graph.mode !== 'logic') return `It runs as ${mode.name} because ${mode.why}.`;
  for (const node of graph.nodes.values()) {
    const hit = node.hits.find((h) => h.word.triggers);
    if (hit) return `It runs as ${mode.name} because ${node.name && node.name !== hit.word.head ? `${node.name} says` : 'a shape says'} "${hit.text.trim()}".`;
  }
  return `It runs as ${mode.name}.`;
}

export function readGraph(elements) {
  const nodes = new Map();
  const edges = new Map();
  const words = new Map();
  const texts = new Map();
  for (const el of elements) {
    if (!isText(el)) continue;
    const owner = ownerOf(el);
    if (!owner) continue;
    words.set(owner, [...(words.get(owner) ?? []), el.text]);
    texts.set(owner, [...(texts.get(owner) ?? []), el]);
  }
  const shapes = elements.filter(isShape);
  const arrows = elements.filter(isArrow);
  const shapeIds = new Set(shapes.map((s) => s.id));
  const labelOf = (id) => (words.get(id) ?? []).join('\n');

  // Which way an arrow runs. An arrowhead only at the start means it runs backwards.
  const ends = (el) => {
    const reversed = !el.endArrowhead && !!el.startArrowhead;
    const a = el.startBinding?.elementId ?? null, b = el.endBinding?.elementId ?? null;
    const from = reversed ? b : a, to = reversed ? a : b;
    return { reversed, from: shapeIds.has(from) ? from : null, to: shapeIds.has(to) ? to : null };
  };
  const linked = arrows.some((el) => { const e = ends(el); return e.from || e.to; });
  const mode = chooseMode(shapes.map((s) => labelOf(s.id)), arrows.map((a) => labelOf(a.id)), linked);
  const reading = mode === 'none' ? 'states' : mode;

  for (const el of shapes) {
    const label = labelOf(el.id);
    const read = readLabel(label, 'shape', reading);
    nodes.set(el.id, { id: el.id, el, label, texts: texts.get(el.id) ?? [], ...read, in: [], out: [], watching: [], kind: null });
  }

  for (const el of arrows) {
    const label = labelOf(el.id);
    const read = readLabel(label, 'arrow', reading);
    const edge = { id: el.id, el, label, texts: texts.get(el.id) ?? [], ...ends(el), ...read, ...read.params, event: null, times: read.params.times ?? 1 };
    edge.action = read.params.action;
    edges.set(el.id, edge);
    // The first line's other words are the event's name.
    const firstLine = read.rest.filter((r) => r.line === 0).map((r) => r.word).join(' ').toLowerCase();
    edge.eventName = firstLine;
    if (reading === 'states') {
      const automatic = read.params.guard && !firstLine;
      const timed = read.params.after !== undefined || read.params.afterExpr;
      if (firstLine) edge.event = firstLine;
      else if (!automatic && !timed) edge.event = 'next';
    }
  }

  // An arrow touching a chart watches. Nothing travels along it.
  const charts = new Set(shapes.filter((s) => nodes.get(s.id).hits.some((h) => h.word.makes === 'chart')).map((s) => s.id));
  for (const edge of edges.values()) {
    if (edge.from && charts.has(edge.from) || edge.to && charts.has(edge.to)) {
      edge.watch = true;
      const chart = charts.has(edge.from) ? edge.from : edge.to;
      const other = chart === edge.from ? edge.to : edge.from;
      if (other && !charts.has(other)) nodes.get(chart).watching.push(other);
      continue;
    }
    if (edge.from) nodes.get(edge.from).out.push(edge);
    if (edge.to) nodes.get(edge.to).in.push(edge);
  }

  for (const n of nodes.values()) n.kind = kindOf(n, mode);

  const issues = [];
  const add = (id, message, extra = {}) => issues.push({ id, message, level: 'error', ...extra });
  for (const item of [...nodes.values(), ...edges.values()]) {
    for (const p of item.problems) add(item.id, p.message, { ...p, textId: textAt(item, p.line).id, lineInText: textAt(item, p.line).line });
  }
  lintWords(nodes, add);
  if (mode === 'none' && !shapes.length && !arrows.length) issues.length = 0;
  else if (mode === 'none') add(null, 'Nothing to run: no arrow touches a shape.', { level: 'note' });
  if (mode === 'flow') lintFlow(nodes, edges, add);
  if (mode === 'states') lintStates(nodes, edges, add);
  if (mode === 'logic') lintLogic(nodes, add);
  return { mode, nodes, edges, issues };
}

// Which of an owner's text elements a line of its joined label is in.
function textAt(item, line) {
  let left = line;
  for (const t of item.texts) {
    const count = t.text.split('\n').length;
    if (left < count) return { id: t.id, line: left };
    left -= count;
  }
  return { id: item.texts[0]?.id ?? null, line: 0 };
}

function kindOf(n, mode) {
  const has = new Set(n.hits.map((h) => h.word.makes).filter(Boolean));
  if (has.has('chart')) return 'chart';
  if (mode === 'none') return 'idle';
  if (mode === 'states') return 'state';
  if (mode === 'chain') return 'place';
  if (mode === 'logic') {
    for (const h of n.hits) if (LOGIC_KINDS.has(h.word.makes)) return h.word.makes;
    return 'wire';
  }
  for (const kind of KIND_ORDER) if (has.has(kind)) return kind;
  if (n.el.type === 'diamond' && (n.in.length || n.out.length)) return 'router';
  if (!n.in.length && !n.out.length) return 'idle';
  if (!n.out.some((e) => e.to)) return 'sink';
  return 'queue';
}

// A word that reads fine but can't do anything on this kind of shape.
function lintWords(nodes, add) {
  for (const n of nodes.values()) {
    const kindName = KINDS[n.kind]?.phrase ?? n.kind;
    for (const hit of n.hits) {
      const w = hit.word;
      const text = hit.text.trim();
      const place = textAt(n, hit.line);
      const where = { textId: place.id, lineInText: place.line, line: hit.line, start: hit.start, end: hit.end, text, level: 'error' };
      if (w.makes && w.makes !== n.kind && !(w.for ?? []).includes(n.kind)) add(n.id, `"${text}" does nothing here, because this shape is ${kindName}. Give it its own shape.`, where);
      else if (w.for && !w.for.includes(n.kind)) add(n.id, `"${text}" does nothing on ${kindName}. It works on: ${w.for.map((k) => KINDS[k]?.name ?? k).join(', ')}.`, where);
    }
  }
}

function lintFlow(nodes, edges, add) {
  const list = [...nodes.values()];
  if (!list.some((n) => n.kind === 'source')) add(null, 'No work is arriving. Label a shape "rate 2/s" to start some.');
  const kindNames = new Set(list.flatMap((n) => (n.params.mix ?? []).map((m) => m.kind)));
  for (const n of list) {
    const out = n.out.filter((e) => e.to);
    if (n.kind === 'source' && !out.length) add(n.id, `${n.name || 'This source'} has no arrow out, so its work goes nowhere.`);
    const guarded = out.filter((e) => e.when);
    if (guarded.length && !out.some((e) => !e.when && !e.exit && e.after === undefined)) add(n.id, 'Work that matches no "if" arrow stops here. Add an arrow labelled else.', { level: 'note' });
    const named = out.filter((e) => e.percent !== undefined);
    const sum = named.reduce((s, e) => s + e.percent, 0);
    if (named.length && (sum > 100.01 || (named.length === out.length && sum < 99.99))) add(n.id, `The arrows out of ${n.name || 'this shape'} add up to ${Math.round(sum)}%, so shares are scaled to fit.`, { level: 'note' });
    if (n.kind === 'merge' && !list.some((m) => m.kind === 'split')) add(n.id, 'A merge waits for the parts of a split, and this drawing has no split.', { level: 'note' });
    if (n.kind === 'chart' && !n.watching.length) add(n.id, 'Draw an arrow from this chart to the shape you want to watch.', { level: 'note' });
    if (n.kind === 'chart' && n.params.chartOf) for (const name of namesIn(n.params.chartOf)) if (!METRICS.includes(name)) add(n.id, `A chart can't read "${name}". It can read: ${METRICS.join(', ')}.`, { level: 'note' });
    if (n.kind === 'workers' && n.params.workers === 0) add(n.id, 'Zero workers never finish anything.', { level: 'note' });
  }
  for (const e of edges.values()) {
    if (e.watch) continue;
    if (e.from && !e.to || !e.from && e.to) add(e.id, 'This arrow is not attached at both ends, so nothing travels along it.', { level: 'note' });
    const from = nodes.get(e.from);
    // The table says which shapes each arrow word can leave from.
    for (const hit of e.hits) {
      if (hit.word.from && from && !hit.word.from.includes(from.kind)) add(e.id, `"${hit.text.trim()}" does nothing on an arrow out of ${KINDS[from.kind]?.phrase ?? from.kind}. It works on arrows out of: ${hit.word.from.map((k) => KINDS[k]?.name ?? k).join(', ')}.`);
    }
    // `gold` on its own reads as a name, which is almost never what was meant.
    if (e.eventName && kindNames.has(e.eventName) && !e.when) add(e.id, `"${e.eventName}" is just a name here. To send only ${e.eventName} work this way, write "if ${e.eventName}".`, { suggestLine: `if ${e.eventName}` });
    if (e.when) for (const name of namesIn(e.when)) if (!['retries', 'age'].includes(name) && !kindNames.has(name)) add(e.id, `Nothing here is called "${name}". Work knows retries, age and any name from a mix word.`, { level: 'note' });
  }
}

function lintStates(nodes, edges, add) {
  const set = new Set();
  const used = [];
  const note = (tree, id) => { for (const name of namesIn(tree)) used.push({ name, id }); };
  for (const e of edges.values()) {
    for (const a of e.action ?? []) { set.add(a.name); note(a.value, e.id); }
    if (e.guard) note(e.guard, e.id);
    if (e.afterExpr) note(e.afterExpr, e.id);
  }
  for (const n of nodes.values()) {
    for (const a of n.params.enter ?? []) { set.add(a.name); note(a.value, n.id); }
    if (n.params.chartOf) note(n.params.chartOf, n.id);
  }
  const seen = new Set();
  for (const { name, id } of used) {
    if (set.has(name) || seen.has(`${id}:${name}`)) continue;
    seen.add(`${id}:${name}`);
    const near = [...set].find((s) => distance(s, name) <= 2);
    add(id, near ? `Nothing sets "${name}". Did you mean "${near}"?` : `Nothing sets "${name}", so it stays 0. Set it with an action like "/ ${name} = 1".`, { level: 'note' });
  }
  if (![...edges.values()].some((e) => e.from && e.to)) add(null, 'No arrow joins two states yet, so nothing can happen.', { level: 'note' });
}

function lintLogic(nodes, add) {
  for (const n of nodes.values()) {
    if (['and', 'or', 'not', 'xor', 'nand', 'nor', 'flip', 'lamp'].includes(n.kind) && !n.in.length) add(n.id, `This ${KINDS[n.kind].name} has no arrow in, so it never changes.`, { level: 'note' });
    if (['switch', 'clock', 'button'].includes(n.kind) && !n.out.length) add(n.id, `This ${KINDS[n.kind].name} has no arrow out, so nothing listens to it.`, { level: 'note' });
  }
}

export function namesIn(tree) {
  const out = [];
  const walk = (t) => {
    if (!t) return;
    if (t.type === 'name') out.push(t.name);
    if (t.of) walk(t.of);
    if (t.left) walk(t.left);
    if (t.right) walk(t.right);
    if (t.args) t.args.forEach(walk);
  };
  walk(tree);
  return [...new Set(out)];
}
