// Read a program out of a drawing. Shapes are nodes, arrows are edges and labels
// are parameters. This file has no DOM and no state, so anything it decides can
// be checked by reading the .excalidraw file.
//
//   A shape labelled `rate 3/s`        makes work
//   A shape labelled `workers 3`       does work, `takes 0.75s` each
//   A shape with nothing going out     is where work ends
//   A diamond                          splits work, by `90%` labels on its arrows
//   Any other shape                    holds work until the next shape has room
//   An arrow labelled `after 5s`       fires by itself after that time
//   An arrow labelled `fail x3`        fires on the third `fail` in a row
//
// A drawing with a rate or workers runs as a flow. Any other drawing with arrows
// runs as a state machine, and its arrow labels are the events.

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
// Labels.

const seconds = (n, unit) => (unit && unit.toLowerCase().startsWith('ms') ? Number(n) / 1000 : Number(n));

export function parseNodeLabel(words = '') {
  const params = {};
  let m;
  if ((m = /\brate\s*[:=]?\s*(\d+(?:\.\d+)?)/i.exec(words)) || (m = /(\d+(?:\.\d+)?)\s*(?:\/|per\s+)\s*s(?:ec\w*)?\b/i.exec(words))) params.rate = Number(m[1]);
  if ((m = /\bworkers?\s*[:=]?\s*(\d+)/i.exec(words))) params.workers = Number(m[1]);
  else if ((m = /(\d+)\s*workers?\b/i.exec(words))) params.workers = Number(m[1]);
  if ((m = /\btakes?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|s\w*)?/i.exec(words))) params.takes = seconds(m[1], m[2]);
  if ((m = /\blimit\s*[:=]?\s*(\d+)/i.exec(words))) params.limit = Number(m[1]);

  // A word we know with no number we can read is a mistake worth pointing out.
  const unread = [];
  if (/\brate\b/i.test(words) && params.rate === undefined) unread.push('rate');
  if (/\bworkers?\b/i.test(words) && params.workers === undefined) unread.push('workers');
  if (/\btakes?\b/i.test(words) && params.takes === undefined) unread.push('takes');
  if (/\blimit\b/i.test(words) && params.limit === undefined) unread.push('limit');

  const first = words.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const name = first.replace(/\b(rate|limit|takes?)\b.*$/i, '').replace(/\bworkers?\s*[:=]?\s*\d+/i, 'workers').replace(/(\d+)\s*workers?/i, 'workers').trim();
  return { name, params, unread };
}

export function parseEdgeLabel(words = '') {
  const first = words.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const out = { percent: undefined, after: undefined, event: 'next', times: 1 };
  let m;
  if ((m = /(\d+(?:\.\d+)?)\s*%/.exec(words))) out.percent = Number(m[1]);
  if ((m = /\bafter\s+(\d+(?:\.\d+)?)\s*(ms|s\w*)?/i.exec(words))) { out.after = seconds(m[1], m[2]); out.event = null; return out; }
  if ((m = /^(.*?)\s*[x×]\s*(\d+)$/i.exec(first))) { out.event = m[1].trim().toLowerCase() || 'next'; out.times = Number(m[2]); return out; }
  if (first) out.event = first.toLowerCase();
  return out;
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
    if (!isText(el) || el.containerId) continue;
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

export function readGraph(elements) {
  const nodes = new Map();
  const edges = new Map();
  const words = new Map();
  for (const el of elements) {
    if (!isText(el)) continue;
    const owner = ownerOf(el);
    if (owner) words.set(owner, [...(words.get(owner) ?? []), el.text]);
  }

  for (const el of elements) {
    if (!isShape(el)) continue;
    const label = (words.get(el.id) ?? []).join('\n');
    nodes.set(el.id, { id: el.id, el, label, ...parseNodeLabel(label), in: [], out: [], kind: null });
  }
  for (const el of elements) {
    if (!isArrow(el)) continue;
    // An arrowhead at the start only means the arrow runs backwards.
    const reversed = !el.endArrowhead && !!el.startArrowhead;
    const a = el.startBinding?.elementId ?? null, b = el.endBinding?.elementId ?? null;
    const from = reversed ? b : a, to = reversed ? a : b;
    const label = (words.get(el.id) ?? []).join('\n');
    const edge = { id: el.id, el, label, reversed, from: nodes.has(from) ? from : null, to: nodes.has(to) ? to : null, ...parseEdgeLabel(label) };
    edges.set(el.id, edge);
    if (edge.from) nodes.get(edge.from).out.push(edge);
    if (edge.to) nodes.get(edge.to).in.push(edge);
  }

  const flow = [...nodes.values()].some((n) => n.params.rate !== undefined || n.params.workers !== undefined || n.params.takes !== undefined);
  const linked = [...edges.values()].some((e) => e.from || e.to);
  const mode = flow ? 'flow' : linked ? 'states' : 'none';

  const issues = [];
  for (const n of nodes.values()) {
    if (n.unread.length) issues.push(`I can't read "${n.label.replace(/\n/g, ' ')}". Try something like ${n.unread[0] === 'rate' ? '"rate 2/s"' : n.unread[0] === 'workers' ? '"workers 3"' : n.unread[0] === 'takes' ? '"takes 0.5s"' : '"limit 20"'}.`);
    if (mode === 'flow') n.kind = kindOf(n);
    if (mode === 'states') n.kind = 'state';
  }
  if (mode === 'none') issues.push('Nothing to run: no arrow touches a shape.');
  if (mode === 'flow' && ![...nodes.values()].some((n) => n.kind === 'source')) issues.push('No work is arriving. Label a shape "rate 2/s" to start some.');
  return { mode, nodes, edges, issues };
}

function kindOf(n) {
  if (n.params.rate !== undefined) return 'source';
  if (n.params.workers !== undefined || n.params.takes !== undefined) return 'workers';
  if (!n.in.length && !n.out.length) return 'idle';
  if (!n.out.some((e) => e.to)) return 'sink';
  if (n.el.type === 'diamond') return 'router';
  return 'queue';
}
