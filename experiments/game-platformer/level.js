// Read an Excalidraw drawing as a level. Nothing here touches the page, so the
// same code runs in the browser, in tests and in the solver.
//
// What an element does comes from how it is drawn. See LEGEND.md.

const HUES = { red: [335, 20], amber: [20, 65], green: [65, 175], blue: [175, 250] };

/** The color family of one color: neutral, red, amber, green, blue, other, or null for none. */
export function familyOf(c) {
  if (!c || c === 'transparent') return null;
  const m = /^#([0-9a-f]{6}|[0-9a-f]{3})/i.exec(c);
  if (!m) return 'neutral';
  const hex = m[1].length === 3 ? [...m[1]].map((h) => h + h).join('') : m[1];
  const n = parseInt(hex, 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  // Near-black inks such as navy read as black on paper, and pale grays as gray.
  if (s < 0.2 || l < 0.25 || l > 0.985) return 'neutral';
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h >= HUES.red[0] || h < HUES.red[1]) return 'red';
  for (const name of ['amber', 'green', 'blue']) if (h >= HUES[name][0] && h < HUES[name][1]) return name;
  return 'other';
}

/** A fill says more than an outline: a black outline with a red fill is red. */
export function familyOfElement(el) {
  const fill = familyOf(el.backgroundColor);
  if (fill && fill !== 'neutral') return fill;
  const stroke = familyOf(el.strokeColor);
  return stroke ?? fill;
}

/** What a drawn element is in the game. */
export function roleOf(el) {
  if (el.type === 'text') return /^\s*start\s*$/i.test(el.text ?? '') ? 'start' : 'scenery';
  if (!['rectangle', 'ellipse', 'diamond', 'line', 'arrow', 'freedraw'].includes(el.type)) return 'scenery';
  if ((el.opacity ?? 100) < 50) return 'scenery';
  if (el.type === 'arrow') return 'arrow';
  switch (familyOfElement(el)) {
    case 'neutral': return (el.strokeStyle ?? 'solid') !== 'solid' ? 'oneway' : 'solid';
    case 'red': return 'hazard';
    case 'amber': return el.type === 'ellipse' ? 'coin' : el.type === 'diamond' ? 'checkpoint' : 'scenery';
    case 'green': return el.type === 'diamond' ? 'goal' : 'scenery';
    case 'blue': return el.type === 'rectangle' ? 'water' : 'bounce';
    default: return 'scenery';
  }
}

// ---------------------------------------------------------------------------
// Outlines in world coordinates, matching what the renderer draws.

// rough.js draws a rounded line as this Catmull-Rom curve, with the ends repeated.
export function curvePoints(points, steps = 8) {
  const p = [points[0], ...points, points[points.length - 1]];
  const out = [points[0]];
  for (let i = 1; i + 2 < p.length; i++) {
    const b0 = p[i];
    const b1 = [p[i][0] + (p[i + 1][0] - p[i - 1][0]) / 6, p[i][1] + (p[i + 1][1] - p[i - 1][1]) / 6];
    const b2 = [p[i + 1][0] + (p[i][0] - p[i + 2][0]) / 6, p[i + 1][1] + (p[i][1] - p[i + 2][1]) / 6];
    const b3 = p[i + 1];
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, u = 1 - t;
      out.push([
        u * u * u * b0[0] + 3 * u * u * t * b1[0] + 3 * u * t * t * b2[0] + t * t * t * b3[0],
        u * u * u * b0[1] + 3 * u * u * t * b1[1] + 3 * u * t * t * b2[1] + t * t * t * b3[1],
      ]);
    }
  }
  return out;
}

function roundedRect(w, h, r) {
  if (r <= 0) return [[0, 0], [w, 0], [w, h], [0, h]];
  const corner = (ax, ay, cx, cy, bx, by) => [1, 2, 3, 4].map((k) => {
    const t = k / 4, u = 1 - t;
    return [u * u * ax + 2 * u * t * cx + t * t * bx, u * u * ay + 2 * u * t * cy + t * t * by];
  });
  return [
    [r, 0], [w - r, 0], ...corner(w - r, 0, w, 0, w, r),
    [w, h - r], ...corner(w, h - r, w, h, w - r, h),
    [r, h], ...corner(r, h, 0, h, 0, h - r),
    [0, r], ...corner(0, r, 0, 0, r, 0),
  ];
}

const isLinear = (el) => el.type === 'line' || el.type === 'arrow' || el.type === 'freedraw';

function localOutline(el) {
  const w = el.width ?? 0, h = el.height ?? 0;
  switch (el.type) {
    case 'rectangle': {
      const size = Math.min(w, h);
      const r = !el.roundness ? 0 : el.roundness.type === 3 ? Math.min(el.roundness.value ?? 32, size * 0.25) : size * 0.25;
      return { points: roundedRect(w, h, r), closed: true };
    }
    case 'diamond':
      return { points: [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]], closed: true };
    case 'ellipse': {
      const points = [];
      for (let i = 0; i < 32; i++) {
        const a = (i / 32) * Math.PI * 2;
        points.push([w / 2 + (Math.cos(a) * w) / 2, h / 2 + (Math.sin(a) * h) / 2]);
      }
      return { points, closed: true };
    }
    case 'freedraw': {
      const points = [];
      for (const p of el.points ?? []) {
        const last = points[points.length - 1];
        if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= 10) points.push([p[0], p[1]]);
      }
      const end = el.points?.[el.points.length - 1];
      if (end && points.length > 1) points.push([end[0], end[1]]);
      return { points, closed: false };
    }
    default: {
      const raw = (el.points ?? []).map((p) => [p[0], p[1]]);
      return { points: el.roundness && raw.length > 2 ? curvePoints(raw) : raw, closed: false };
    }
  }
}

// Excalidraw turns a line about the middle of its points' bounds.
function pivotOf(el) {
  if (isLinear(el) && el.points?.length) {
    const xs = el.points.map((p) => p[0]), ys = el.points.map((p) => p[1]);
    return [el.x + (Math.min(...xs) + Math.max(...xs)) / 2, el.y + (Math.min(...ys) + Math.max(...ys)) / 2];
  }
  return [el.x + (el.width ?? 0) / 2, el.y + (el.height ?? 0) / 2];
}

/** An element's outline in world coordinates. */
export function worldOutline(el) {
  const { points, closed } = localOutline(el);
  const angle = el.angle ?? 0;
  const [cx, cy] = pivotOf(el);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return {
    closed,
    points: points.map(([px, py]) => {
      const x = el.x + px, y = el.y + py;
      if (!angle) return [x, y];
      return [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos];
    }),
  };
}

function boundsOf(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

// ---------------------------------------------------------------------------
// Movers: an arrow that starts on an element carries it along the arrow's path.

const SPEED_BY_WIDTH = (w) => (w <= 1 ? 100 : w <= 2 ? 170 : 280);
const DWELL = 0.35;

class Mover {
  constructor(id, path, speed) {
    this.id = id;
    this.path = path;
    this.lengths = [0];
    for (let i = 1; i < path.length; i++) this.lengths[i] = this.lengths[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    this.length = this.lengths[this.lengths.length - 1] || 1;
    this.travel = this.length / speed;
    this.period = 2 * (this.travel + DWELL);
    this.ox = 0; this.oy = 0; this.dx = 0; this.dy = 0; this.vx = 0; this.vy = 0;
  }

  /** Where it has moved to at a time: out along the arrow, a rest, and back. */
  offsetAt(time) {
    const u = time % this.period;
    let s;
    if (u < DWELL) s = 0;
    else if (u < DWELL + this.travel) s = (u - DWELL) / this.travel;
    else if (u < 2 * DWELL + this.travel) s = 1;
    else s = 1 - (u - 2 * DWELL - this.travel) / this.travel;
    const along = s * s * (3 - 2 * s) * this.length;
    let i = 1;
    while (i < this.path.length - 1 && this.lengths[i] < along) i++;
    const span = this.lengths[i] - this.lengths[i - 1] || 1;
    const t = (along - this.lengths[i - 1]) / span;
    const a = this.path[i - 1], b = this.path[i];
    return [a[0] + (b[0] - a[0]) * t - this.path[0][0], a[1] + (b[1] - a[1]) * t - this.path[0][1]];
  }
}

function findMoverTarget(arrow, byId, elements) {
  const bound = arrow.startBinding?.elementId && byId.get(arrow.startBinding.elementId);
  if (bound) return bound;
  const [sx, sy] = worldOutline(arrow).points[0] ?? [];
  if (sx === undefined) return null;
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (el === arrow || el.type === 'arrow' || el.type === 'text') continue;
    const b = boundsOf(worldOutline(el).points);
    if (roleOf(el) !== 'scenery' && sx >= b.minX - 16 && sx <= b.maxX + 16 && sy >= b.minY - 16 && sy <= b.maxY + 16) return el;
  }
  return null;
}

// ---------------------------------------------------------------------------

const CELL = 128;
const keyOf = (ix, iy) => (ix + 20000) * 40000 + (iy + 20000);

function makeSegments(body, points, closed) {
  const segs = [];
  // A positive area here means the outline runs clockwise on screen.
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i], [bx, by] = points[(i + 1) % points.length];
    area += ax * by - bx * ay;
  }
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i++) {
    const [ax, ay] = points[i], [bx, by] = points[(i + 1) % points.length];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 0.001) continue;
    // The normal on the upper side, used for one-way surfaces.
    let ux = (by - ay) / len, uy = -(bx - ax) / len;
    if (uy > 0) { ux = -ux; uy = -uy; }
    // A closed one-way shape is only its top: the edges facing outward and up.
    if (closed && body.role === 'oneway') {
      const outX = (by - ay) * (area > 0 ? 1 : -1), outY = -(bx - ax) * (area > 0 ? 1 : -1);
      if (outY >= 0 || Math.abs(outY) / Math.hypot(outX, outY) < 0.3) continue;
    }
    segs.push({ ax, ay, bx, by, x1: ax, y1: ay, x2: bx, y2: by, ux, uy, oneway: body.role === 'oneway', body, stamp: 0 });
  }
  return segs;
}

/** Compile a parsed .excalidraw document into what the simulation needs. */
export function compileLevel(doc) {
  const elements = (doc.elements ?? []).filter((e) => e && !e.isDeleted);
  const byId = new Map(elements.map((e) => [e.id, e]));

  // Arrows that start on something move it, and whatever is grouped or bound to it.
  const movers = [];
  const moverOf = new Map();
  for (const el of elements) {
    if (roleOf(el) !== 'arrow' || !el.points || el.points.length < 2) continue;
    const target = findMoverTarget(el, byId, elements);
    if (!target) continue;
    const mover = new Mover(el.id, worldOutline(el).points, SPEED_BY_WIDTH(el.strokeWidth ?? 2));
    const ids = new Set([target.id]);
    const group = target.groupIds?.[target.groupIds.length - 1];
    if (group) for (const other of elements) if (other.groupIds?.includes(group) && other.type !== 'arrow') ids.add(other.id);
    for (const other of elements) if (other.containerId && ids.has(other.containerId)) ids.add(other.id);
    mover.ids = [...ids];
    movers.push(mover);
    for (const id of ids) moverOf.set(id, mover);
  }
  const moverArrows = new Set(movers.map((m) => m.id));

  const bodies = [];
  let start = null;
  for (const el of elements) {
    const role = roleOf(el);
    if (role === 'start') { start = { x: el.x + 16, y: el.y + (el.height ?? 30) }; continue; }
    if (role === 'scenery' || role === 'arrow') continue;
    const { points, closed } = worldOutline(el);
    if (points.length < 2) continue;
    const body = { id: el.id, role, closed, points, mover: moverOf.get(el.id) ?? null, ...boundsOf(points) };
    body.cx = (body.minX + body.maxX) / 2;
    body.cy = (body.minY + body.maxY) / 2;
    body.radius = (body.maxX - body.minX + body.maxY - body.minY) / 4;
    body.segs = makeSegments(body, points, closed);
    bodies.push(body);
  }

  const solidRoles = new Set(['solid', 'oneway', 'bounce']);
  const solids = bodies.filter((b) => solidRoles.has(b.role));
  const grid = new Map();
  const moving = [];
  for (const body of solids) {
    if (body.mover) { moving.push(...body.segs); continue; }
    for (const seg of body.segs) {
      const x0 = Math.floor(Math.min(seg.ax, seg.bx) / CELL), x1 = Math.floor(Math.max(seg.ax, seg.bx) / CELL);
      const y0 = Math.floor(Math.min(seg.ay, seg.by) / CELL), y1 = Math.floor(Math.max(seg.ay, seg.by) / CELL);
      for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) {
        const key = keyOf(ix, iy);
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(seg);
      }
    }
  }

  // The moving reach of a mover counts toward the level's bounds.
  const extent = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = (x0, y0, x1, y1) => {
    extent.minX = Math.min(extent.minX, x0); extent.minY = Math.min(extent.minY, y0);
    extent.maxX = Math.max(extent.maxX, x1); extent.maxY = Math.max(extent.maxY, y1);
  };
  for (const body of bodies) {
    grow(body.minX, body.minY, body.maxX, body.maxY);
    if (body.mover) for (const [x, y] of body.mover.path) {
      const dx = x - body.mover.path[0][0], dy = y - body.mover.path[0][1];
      grow(body.minX + dx, body.minY + dy, body.maxX + dx, body.maxY + dy);
    }
  }
  if (extent.minX === Infinity) grow(0, 0, 1600, 900);

  // With no start marked, begin above the leftmost thing you can stand on.
  if (!start) {
    const left = solids.slice().sort((a, b) => a.minX - b.minX)[0];
    start = left ? { x: left.minX + 40, y: left.minY - 8 } : { x: 100, y: 100 };
  }

  return {
    elements, bodies, movers, moverArrows, moving, grid, start, extent, moverOf,
    hazards: bodies.filter((b) => b.role === 'hazard'),
    coins: bodies.filter((b) => b.role === 'coin'),
    goals: bodies.filter((b) => b.role === 'goal'),
    checkpoints: bodies.filter((b) => b.role === 'checkpoint'),
    waters: bodies.filter((b) => b.role === 'water'),
    closedSolids: solids.filter((b) => b.closed && b.role === 'solid'),
  };
}

export { CELL, keyOf };
