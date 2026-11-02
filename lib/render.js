// Draw native Excalidraw elements onto a canvas, with rough.js options, arrowheads
// and fonts modelled on Excalidraw's renderer and the element's own seed.
//
// Shapes are compiled once to Path2D in the element's local coordinates, so
// moving, rotating or fading an element reuses its strokes. Only a change of
// size, points or style generates new ones, and the seed keeps the hand-drawn
// line stable across those changes.

import rough from 'roughjs';
import { getStroke } from 'perfect-freehand';

const gen = rough.generator();

// Excalidraw's fontFamily numbers. Metrics place the baseline as Excalidraw does.
export const FONTS = {
  1: { css: 'Virgil', ascent: 0.886, descent: 0.374 },
  2: { css: 'Helvetica, Arial, sans-serif', ascent: 0.77, descent: 0.23 },
  3: { css: 'Cascadia, monospace', ascent: 0.928, descent: 0.234 },
  5: { css: 'Excalifont', ascent: 0.886, descent: 0.374 },
  6: { css: 'Nunito', ascent: 1.011, descent: 0.353 },
};

export const fontOf = (el) => FONTS[el.fontFamily] ?? FONTS[5];
export const fontString = (el) => `${el.fontSize ?? 20}px ${fontOf(el).css}`;

const TRANSPARENT = new Set(['transparent', '', null, undefined]);

function adjustRoughness(el) {
  const r = el.roughness ?? 1;
  const max = Math.max(el.width ?? 0, el.height ?? 0);
  const min = Math.min(el.width ?? 0, el.height ?? 0);
  const linear = el.type === 'arrow' || el.type === 'line';
  if ((min >= 20 && max >= 50) || (min >= 15 && el.roundness) || (linear && max >= 50)) return r;
  return Math.min(r / (max < 10 ? 3 : 2), 2.5);
}

function roughOptions(el) {
  const strokeWidth = el.strokeWidth ?? 2;
  const style = el.strokeStyle ?? 'solid';
  const options = {
    seed: el.seed ?? 1,
    strokeLineDash: style === 'dashed' ? [8, 8 + strokeWidth] : style === 'dotted' ? [1.5, 6 + strokeWidth] : undefined,
    disableMultiStroke: style !== 'solid',
    strokeWidth: style !== 'solid' ? strokeWidth + 0.5 : strokeWidth,
    fillWeight: strokeWidth / 2,
    hachureGap: strokeWidth * 4,
    roughness: adjustRoughness(el),
    stroke: el.strokeColor ?? '#1e1e1e',
    preserveVertices: (el.roughness ?? 1) < 2,
  };
  if (!TRANSPARENT.has(el.backgroundColor) && el.type !== 'arrow') {
    options.fill = el.backgroundColor;
    options.fillStyle = el.fillStyle ?? 'solid';
  }
  return options;
}

function cornerRadius(size, el) {
  if (!el.roundness) return 0;
  if (el.roundness.type === 3) return Math.min(el.roundness.value ?? 32, size * 0.25);
  return size * 0.25;
}

function arrowhead(el, curve, position) {
  const kind = position === 'end' ? el.endArrowhead : el.startArrowhead;
  if (!kind) return [];
  const ops = curve.sets[0]?.ops ?? [];
  if (ops.length < 2) return [];
  const index = position === 'start' ? 1 : ops.length - 1;
  const d = ops[index].data;
  const prev = ops[index - 1];
  const p0 = prev.op === 'move' ? prev.data.slice(0, 2) : prev.data.slice(4, 6);
  const p1 = d.slice(0, 2), p2 = d.slice(2, 4), p3 = d.slice(4, 6);
  const bez = (t, i) => (1 - t) ** 3 * p3[i] + 3 * t * (1 - t) ** 2 * p2[i] + 3 * t * t * (1 - t) * p1[i] + t ** 3 * p0[i];
  const [x2, y2] = position === 'start' ? p0 : p3;
  const x1 = bez(0.3, 0), y1 = bez(0.3, 1);
  const dist = Math.hypot(x2 - x1, y2 - y1) || 1;
  const nx = (x2 - x1) / dist, ny = (y2 - y1) / dist;
  const pts = el.points;
  const a = position === 'end' ? pts[pts.length - 1] : pts[0];
  const b = position === 'end' ? pts[pts.length - 2] : pts[1];
  const last = Math.hypot(a[0] - b[0], a[1] - b[1]);
  const sizes = { arrow: 25, bar: 15, dot: 15, circle: 15, circle_outline: 15, triangle: 15, triangle_outline: 15, diamond: 12, diamond_outline: 12 };
  const size = Math.min(sizes[kind] ?? 15, last * (kind.startsWith('diamond') ? 0.25 : 0.5));
  const xs = x2 - nx * size, ys = y2 - ny * size;
  const options = { ...roughOptions(el), strokeLineDash: undefined };
  delete options.fill;
  if (kind === 'dot' || kind === 'circle' || kind === 'circle_outline') {
    const r = Math.hypot(ys - y2, xs - x2) + (el.strokeWidth ?? 2) - 2;
    const fill = kind === 'circle_outline' ? '#ffffff' : el.strokeColor;
    return [gen.circle(x2 + nx * r * -1, y2 + ny * r * -1, r * 2, { ...options, fill, fillStyle: 'solid', stroke: el.strokeColor, roughness: Math.min(0.5, options.roughness) })];
  }
  const angle = ((kind === 'bar' ? 90 : kind === 'arrow' ? 20 : 25) * Math.PI) / 180;
  const rot = (x, y, t) => [x2 + (x - x2) * Math.cos(t) - (y - y2) * Math.sin(t), y2 + (x - x2) * Math.sin(t) + (y - y2) * Math.cos(t)];
  const [x3, y3] = rot(xs, ys, -angle);
  const [x4, y4] = rot(xs, ys, angle);
  if (kind === 'triangle' || kind === 'triangle_outline') {
    const fill = kind === 'triangle' ? el.strokeColor : '#ffffff';
    return [gen.polygon([[x2, y2], [x3, y3], [x4, y4]], { ...options, fill, fillStyle: 'solid', roughness: Math.min(1, options.roughness) })];
  }
  return [gen.line(x3, y3, x2, y2, options), gen.line(x4, y4, x2, y2, options)];
}

function drawablesFor(el) {
  const o = roughOptions(el);
  const w = el.width ?? 0, h = el.height ?? 0;
  switch (el.type) {
    case 'rectangle': {
      if (el.roundness) {
        const r = cornerRadius(Math.min(w, h), el);
        return [gen.path(`M ${r} 0 L ${w - r} 0 Q ${w} 0, ${w} ${r} L ${w} ${h - r} Q ${w} ${h}, ${w - r} ${h} L ${r} ${h} Q 0 ${h}, 0 ${h - r} L 0 ${r} Q 0 0, ${r} 0`, o)];
      }
      return [gen.rectangle(0, 0, w, h, o)];
    }
    case 'ellipse':
      return [gen.ellipse(w / 2, h / 2, w, h, { ...o, curveFitting: 1 })];
    case 'diamond': {
      const top = [w / 2, 0], right = [w, h / 2], bottom = [w / 2, h], left = [0, h / 2];
      if (el.roundness) {
        const v = cornerRadius(Math.abs(top[0] - left[0]), el);
        const u = cornerRadius(Math.abs(right[1] - top[1]), el);
        return [gen.path(
          `M ${top[0] + v} ${top[1] + u} L ${right[0] - v} ${right[1] - u} C ${right[0]} ${right[1]}, ${right[0]} ${right[1]}, ${right[0] - v} ${right[1] + u} ` +
          `L ${bottom[0] + v} ${bottom[1] - u} C ${bottom[0]} ${bottom[1]}, ${bottom[0]} ${bottom[1]}, ${bottom[0] - v} ${bottom[1] - u} ` +
          `L ${left[0] + v} ${left[1] + u} C ${left[0]} ${left[1]}, ${left[0]} ${left[1]}, ${left[0] + v} ${left[1] - u} ` +
          `L ${top[0] - v} ${top[1] + u} C ${top[0]} ${top[1]}, ${top[0]} ${top[1]}, ${top[0] + v} ${top[1] + u}`, o)];
      }
      return [gen.polygon([top, right, bottom, left], o)];
    }
    case 'line':
    case 'arrow': {
      const points = el.points?.length ? el.points : [[0, 0]];
      if (points.length === 1) return [];
      const stroke = { ...o };
      delete stroke.fill;
      const curve = el.roundness ? gen.curve(points, stroke) : gen.linearPath(points, stroke);
      if (el.type !== 'arrow') return [curve];
      return [curve, ...arrowhead(el, curve, 'start'), ...arrowhead(el, curve, 'end')];
    }
    default:
      return [];
  }
}

// One drawn pass of a shape. `kind` says how to paint it.
function compile(drawable, head) {
  const o = drawable.options;
  return drawable.sets.map((set) => {
    const path = new Path2D(gen.opsToPath(set));
    if (set.type === 'path') return { kind: 'stroke', head, ops: set.ops, path, width: o.strokeWidth, dash: o.strokeLineDash };
    if (set.type === 'fillPath') return { kind: 'fill', head, path, headFill: head ? o.fill : undefined, rule: drawable.shape === 'curve' || drawable.shape === 'polygon' || drawable.shape === 'path' ? 'evenodd' : 'nonzero' };
    return { kind: 'stroke', head, hatch: true, ops: set.ops, path, width: o.fillWeight, dash: undefined };
  });
}

// ---------------------------------------------------------------------------
// The shape cache. Keys leave out position, angle, opacity and color, which are
// applied when drawing. An LRU bounds what continuous resizing leaves behind.

const cache = new Map();
const CACHE_MAX = 4000;

function shapeKey(el) {
  const pts = el.points ? el.points.map((p) => `${+p[0].toFixed(1)},${+p[1].toFixed(1)}`).join(';') : '';
  const filled = !TRANSPARENT.has(el.backgroundColor);
  return [el.type, +(el.width ?? 0).toFixed(1), +(el.height ?? 0).toFixed(1), pts, el.seed, filled,
    el.fillStyle, el.strokeWidth, el.strokeStyle, el.roughness, el.roundness?.type, el.roundness?.value, el.startArrowhead, el.endArrowhead].join('|');
}

export function passesFor(el) {
  const key = shapeKey(el);
  let passes = cache.get(key);
  if (passes) {
    cache.delete(key);
    cache.set(key, passes);
    return passes;
  }
  passes = drawablesFor(el).flatMap((drawable, i) => compile(drawable, el.type === 'arrow' && i > 0));
  cache.set(key, passes);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return passes;
}

export const shapeCacheSize = () => cache.size;

// ---------------------------------------------------------------------------
// Draw-on: reveal the real rough strokes in order, the way a pen would. A rough
// stroke holds two passes of each edge, so passes that start together draw
// together. Lengths are measured once per pass list.

function opLength(ops) {
  let length = 0, x = 0, y = 0;
  for (const op of ops) {
    if (op.op === 'move') [x, y] = op.data;
    else if (op.op === 'lineTo') { length += Math.hypot(op.data[0] - x, op.data[1] - y); [x, y] = op.data; }
    else if (op.op === 'bcurveTo') {
      const [a, b, c, d, e, f] = op.data;
      let px = x, py = y;
      for (let k = 1; k <= 12; k++) {
        const t = k / 12, u = 1 - t;
        const qx = u * u * u * x + 3 * u * u * t * a + 3 * u * t * t * c + t * t * t * e;
        const qy = u * u * u * y + 3 * u * u * t * b + 3 * u * t * t * d + t * t * t * f;
        length += Math.hypot(qx - px, qy - py);
        px = qx; py = qy;
      }
      x = e; y = f;
    }
  }
  return length;
}

function subpathsOf(pass) {
  if (pass.subpaths) return pass.subpaths;
  const pieces = [];
  let current = null;
  for (const op of pass.ops ?? []) {
    if (op.op === 'move') { current = { ops: [op], start: op.data }; pieces.push(current); } else current?.ops.push(op);
  }
  const groups = [];
  for (const piece of pieces) {
    piece.length = opLength(piece.ops) * 1.02 + 1;
    piece.path = new Path2D(gen.opsToPath({ type: 'path', ops: piece.ops }));
    const last = groups[groups.length - 1];
    if (last && Math.hypot(piece.start[0] - last.start[0], piece.start[1] - last.start[1]) < 16) {
      last.members.push(piece);
      last.length = Math.max(last.length, piece.length);
    } else groups.push({ start: piece.start, members: [piece], length: piece.length });
  }
  pass.subpaths = { groups, total: groups.reduce((s, g) => s + g.length, 0) };
  return pass.subpaths;
}

function strokeReveal(ctx, pass, progress) {
  const { groups, total } = subpathsOf(pass);
  let offset = 0;
  for (const group of groups) {
    const local = Math.min(1, (progress * total - offset) / group.length);
    offset += group.length;
    if (local <= 0) break;
    for (const piece of group.members) {
      if (local >= 1) ctx.setLineDash(pass.dash ?? []);
      else ctx.setLineDash([piece.length * local, piece.length]);
      ctx.stroke(piece.path);
    }
  }
  ctx.setLineDash([]);
}

// ---------------------------------------------------------------------------
// Text, freehand ink and images.

const freehandPaths = new Map();

function freehandPath(el) {
  const key = `${el.id}|${el.points.length}|${el.strokeWidth}`;
  let entry = freehandPaths.get(key);
  if (entry) return entry;
  const outline = getStroke(el.points.map((p) => [p[0], p[1], p[2] ?? 0.5]), { size: (el.strokeWidth ?? 2) * 4.25, thinning: 0.6, smoothing: 0.5, streamline: 0.5, simulatePressure: el.simulatePressure ?? true, last: true });
  if (!outline.length) { entry = new Path2D(); } else {
    let d = `M ${outline[0][0]} ${outline[0][1]} Q`;
    for (let i = 0; i < outline.length; i++) {
      const [x0, y0] = outline[i];
      const [x1, y1] = outline[(i + 1) % outline.length];
      d += ` ${x0} ${y0} ${(x0 + x1) / 2} ${(y0 + y1) / 2}`;
    }
    entry = new Path2D(d + ' Z');
  }
  freehandPaths.set(key, entry);
  if (freehandPaths.size > 2000) freehandPaths.delete(freehandPaths.keys().next().value);
  return entry;
}

const images = new Map();
const imageWatchers = new Set();

/** Run `fn` when an image finishes loading, since a resting scene draws no more frames. */
export function onImageLoad(fn) {
  imageWatchers.add(fn);
  return () => imageWatchers.delete(fn);
}

function imageFor(el, files) {
  const url = files?.[el.fileId]?.dataURL;
  if (!url) return null;
  let img = images.get(url);
  if (!img) {
    img = new Image();
    img.onload = () => imageWatchers.forEach((fn) => fn());
    img.src = url;
    images.set(url, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

function drawText(ctx, el, draw) {
  const font = fontOf(el);
  const size = el.fontSize ?? 20;
  const lineHeight = (el.lineHeight ?? 1.25) * size;
  const baseline = (lineHeight - (font.ascent + font.descent) * size) / 2 + font.ascent * size;
  const lines = String(el.text ?? '').split('\n');
  ctx.font = fontString(el);
  ctx.fillStyle = el.strokeColor ?? '#1e1e1e';
  ctx.textBaseline = 'alphabetic';
  const align = el.textAlign ?? 'left';
  ctx.textAlign = align;
  const w = el.width ?? 0;
  const ax = align === 'center' ? w / 2 : align === 'right' ? w : 0;
  const widths = lines.map((l) => ctx.measureText(l).width);

  const write = draw?.write;
  const type = draw?.type;
  if (type !== undefined) {
    let left = Math.floor(String(el.text ?? '').length * type);
    lines.forEach((line, i) => {
      if (left <= 0) return;
      ctx.fillText(line.slice(0, left), ax, baseline + i * lineHeight);
      left -= line.length + 1;
    });
    return;
  }
  if (write !== undefined) {
    // Lines write on in turn, each left to right, at a speed set by its width.
    const total = widths.reduce((a, b) => a + b, 0) || 1;
    let drawn = write * total;
    lines.forEach((line, i) => {
      if (drawn <= 0) return;
      const shown = Math.min(1, drawn / (widths[i] || 1));
      drawn -= widths[i];
      const left = align === 'center' ? w / 2 - widths[i] / 2 : align === 'right' ? w - widths[i] : 0;
      ctx.save();
      ctx.beginPath();
      ctx.rect(left - 4, i * lineHeight - size * 0.2, (widths[i] + 8) * shown, lineHeight + size * 0.4);
      ctx.clip();
      ctx.fillText(line, ax, baseline + i * lineHeight);
      ctx.restore();
    });
    return;
  }
  lines.forEach((line, i) => ctx.fillText(line, ax, baseline + i * lineHeight));
}

// ---------------------------------------------------------------------------

/**
 * Draw one element. `draw` optionally holds entrance progress:
 *   {outline: 0..1, fill: 0..1}   trace the strokes, then bring in the fill
 *   {write: 0..1} or {type: 0..1} reveal text
 */
export function drawElement(ctx, el, draw, files) {
  if (el.isDeleted || el.visible === false || el.type === 'frame' || el.type === 'selection') return;
  const opacity = (el.opacity ?? 100) / 100;
  if (opacity <= 0) return;
  ctx.save();
  ctx.globalAlpha *= opacity;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const w = el.width ?? 0, h = el.height ?? 0;
  ctx.translate(el.x + w / 2, el.y + h / 2);
  if (el.angle) ctx.rotate(el.angle);
  ctx.translate(-w / 2, -h / 2);

  if (el.type === 'text') {
    drawText(ctx, el, draw);
  } else if (el.type === 'freedraw') {
    ctx.fillStyle = el.strokeColor ?? '#1e1e1e';
    if (el.points?.length) ctx.fill(freehandPath(el));
  } else if (el.type === 'image') {
    const img = imageFor(el, files);
    if (img) ctx.drawImage(img, 0, 0, w, h);
  } else {
    const outline = draw?.outline ?? 1;
    const fill = draw?.fill ?? 1;
    const stroke = el.strokeColor ?? '#1e1e1e';
    const background = el.backgroundColor;
    for (const pass of passesFor(el)) {
      if (pass.kind === 'fill' || pass.hatch) {
        const color = pass.headFill ?? background;
        if (fill <= 0 || TRANSPARENT.has(color)) continue;
        const base = ctx.globalAlpha;
        ctx.globalAlpha = base * fill;
        if (pass.hatch) {
          ctx.strokeStyle = color;
          ctx.lineWidth = pass.width;
          ctx.stroke(pass.path);
        } else {
          ctx.fillStyle = color;
          ctx.fill(pass.path, pass.rule);
        }
        ctx.globalAlpha = base;
        continue;
      }
      if (stroke === 'transparent') continue;
      // An arrow's shaft grows first and its head lands at the end.
      const progress = el.type !== 'arrow' ? outline : pass.head ? (outline - 0.82) / 0.18 : outline / 0.82;
      if (progress <= 0) continue;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = pass.width;
      if (progress >= 1) {
        ctx.setLineDash(pass.dash ?? []);
        ctx.stroke(pass.path);
        ctx.setLineDash([]);
      } else strokeReveal(ctx, pass, progress);
    }
  }
  ctx.restore();
}

// Load the hand-drawn fonts. Call before measuring or drawing text.
export async function loadFonts(base = new URL('./fonts/', import.meta.url).href) {
  const faces = [['Excalifont', 'Excalifont-Regular.ttf'], ['Virgil', 'Virgil-Regular.ttf'], ['Nunito', 'Nunito-Regular.ttf'], ['Cascadia', 'CascadiaCode-Regular.ttf']];
  await Promise.all(faces.map(async ([name, file]) => {
    try {
      const face = new FontFace(name, `url(${base}${file})`);
      await face.load();
      document.fonts.add(face);
    } catch (err) {
      console.warn(`handwave: font ${name} did not load`, err);
    }
  }));
}
