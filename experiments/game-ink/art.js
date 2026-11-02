// What the game looks like. World bodies are drawn straight through the handwave
// renderer each frame, in their own coordinates, so a body's rough strokes are
// generated once and then only rotated. The renderer does not fill `line`
// elements, so polygon fills are rough hachure paths generated here.

import rough from 'roughjs';
import { drawElement } from '/lib/render.js';
import { color, line, rect, ellipse, seedOf } from '/lib/draw.js';

const gen = rough.generator();

/** A rough fill as Path2D strokes. Cached by the caller. */
export function hatch(points, { fill, style = 'hachure', gap = 12, weight = 1.4, angle = -41, seed = 1 }) {
  const drawable = gen.polygon(points, { stroke: 'none', fill, fillStyle: style, hachureGap: gap, fillWeight: weight, hachureAngle: angle, roughness: 1, seed });
  const sets = drawable.sets.filter((s) => s.type === 'fillSketch' || s.type === 'fillPath');
  return { color: fill, weight, solid: sets.some((s) => s.type === 'fillPath'), path: new Path2D(sets.map((s) => gen.opsToPath(s)).join(' ')) };
}

export function paintHatch(ctx, h) {
  ctx.lineCap = 'round';
  if (h.solid) {
    ctx.fillStyle = h.color;
    ctx.fill(h.path);
  } else {
    ctx.strokeStyle = h.color;
    ctx.lineWidth = h.weight;
    ctx.stroke(h.path);
  }
}

const closedLine = (id, points, o) => line(id, [...points, points[0]], o);

/** The still parts of a level, built once per level. */
export function levelArt(level) {
  const under = [];   // Fills.
  const lines = [];   // Outlines.
  const ground = { stroke: color.gray.stroke, fill: '#ced4da' };

  (level.ground ?? []).forEach((chain, i) => {
    const seed = seedOf(`${level.id}-g${i}`);
    const first = chain[0], last = chain[chain.length - 1];
    under.push(hatch([...chain, [last[0], 960], [first[0], 960]], { fill: ground.fill, gap: 16, weight: 1.2, seed }));
    lines.push(line(`g${i}`, [[first[0], 960], ...chain, [last[0], 960]], { strokeColor: ground.stroke, strokeWidth: 3 }));
  });
  (level.blocks ?? []).forEach((block, i) => {
    under.push(hatch(block, { fill: ground.fill, gap: 16, weight: 1.2, seed: seedOf(`${level.id}-b${i}`) }));
    lines.push(closedLine(`b${i}`, block, { strokeColor: ground.stroke, strokeWidth: 3 }));
  });
  (level.hazards ?? []).forEach((hazard, i) => {
    under.push(hatch(hazard, { fill: color.rose.stroke, style: 'cross-hatch', gap: 14, weight: 1.2, seed: seedOf(`${level.id}-h${i}`) }));
    lines.push(closedLine(`h${i}`, hazard, { strokeColor: color.rose.stroke, strokeWidth: 3 }));
  });

  const { x, y } = level.flag;
  const pennant = [[x, y - 118], [x + 62, y - 96], [x, y - 74]];
  under.push(hatch(pennant, { fill: color.green.stroke, gap: 6, weight: 2, angle: 20, seed: seedOf(`${level.id}-flag`) }));
  lines.push(line('pole', [[x, y], [x, y - 120]], { strokeColor: color.ink, strokeWidth: 3 }));
  lines.push(closedLine('pennant', pennant, { strokeColor: color.green.stroke, strokeWidth: 3 }));
  return { under, lines };
}

/** A stroke's line, in coordinates around `origin`. */
export function strokeElement(id, points, origin = [0, 0]) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return {
    ...line(id, [[minX, minY], [minX, minY]], { strokeColor: color.ink, strokeWidth: 4 }),
    x: minX - origin[0],
    y: minY - origin[1],
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
    points: points.map(([x, y]) => [x - minX, y - minY]),
  };
}

export function strokeArt(stroke) {
  if (stroke.art) return stroke.art;
  const art = { el: strokeElement(stroke.id, stroke.points, stroke.origin) };
  if (stroke.closed) {
    const seed = seedOf(`${stroke.id}-fill`);
    art.fill = hatch(stroke.points.map(([x, y]) => [x - stroke.origin[0], y - stroke.origin[1]]), { fill: color.ink, style: 'cross-hatch', gap: 9, weight: 1.1, seed });
  }
  stroke.art = art;
  return art;
}

// The ball, drawn around its own centre so spin only rotates it.
const BALL = (r) => [
  ellipse('ball', -r, -r, r * 2, r * 2, { tone: color.blue, strokeWidth: 3, roughness: 0.8 }),
  ellipse('ball-spot', r * 0.3, -r * 0.2, r * 0.36, r * 0.36, { strokeColor: color.blue.stroke, backgroundColor: color.blue.stroke, strokeWidth: 1.5, roughness: 0.4 }),
];

let ballArt = null;
export function drawBall(ctx, x, y, angle, radius) {
  ballArt ??= BALL(radius);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  for (const el of ballArt) drawElement(ctx, el);
  ctx.restore();
}

const pinArt = new Map();
export function drawPin(ctx, pin, used) {
  const key = `${pin.x},${pin.y},${used}`;
  let el = pinArt.get(key);
  if (!el) {
    el = ellipse(`pin-${pin.x}-${pin.y}`, pin.x - 10, pin.y - 10, 20, 20, used ? { strokeColor: color.ink, backgroundColor: color.ink, strokeWidth: 2, roughness: 0.6 } : { strokeColor: color.amber.stroke, backgroundColor: color.amber.fill, strokeWidth: 3, roughness: 0.6 });
    pinArt.set(key, el);
  }
  drawElement(ctx, el);
}

/** The gate and the plate, which move. */
export function machineArt(level) {
  const out = {};
  if (level.gate) {
    const g = level.gate;
    out.gate = rect('gate', 0, 0, g.w, g.h, { tone: color.amber, roundness: null, strokeWidth: 3 });
  }
  if (level.plate) {
    const p = level.plate;
    out.plate = rect('plate', 0, 0, p.w, 10, { tone: color.amber, roundness: null, strokeWidth: 3 });
  }
  return out;
}

export function drawAt(ctx, el, x, y) {
  ctx.save();
  ctx.translate(x, y);
  drawElement(ctx, el);
  ctx.restore();
}

/** Short ticks around a hit. Their size says how hard it was. */
export function impactMark(id, x, y, speed, tone) {
  const reach = Math.min(34, 10 + speed * 2.2);
  const ticks = [];
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i - 2) * 0.62 + ((seedOf(`${id}${i}`) % 100) / 100 - 0.5) * 0.3;
    const from = 12;
    ticks.push(line(`${id}-${i}`, [[x + Math.cos(a) * from, y + Math.sin(a) * from], [x + Math.cos(a) * (from + reach), y + Math.sin(a) * (from + reach)]], { strokeColor: tone, strokeWidth: 2.5, roughness: 0.6 }));
  }
  return ticks;
}

export function starPoints(cx, cy, r) {
  const out = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const radius = i % 2 ? r * 0.45 : r;
    out.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius]);
  }
  return out;
}

export const starLine = (id, cx, cy, r, o = {}) => closedLine(id, starPoints(cx, cy, r), o);
