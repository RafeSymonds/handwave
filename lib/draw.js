// Build Excalidraw elements in a line of code, in excalive's house style. The
// seed comes from the id, so an element keeps the same hand-drawn line every
// time a view function rebuilds it. Everything here returns a plain Excalidraw
// element, so a scene built in code can be saved and opened in excalidraw.com.

import { measure } from './stage.js';

export const color = {
  ink: '#1B2547',
  muted: '#7A776E',
  blue: { fill: '#d0ebff', stroke: '#1864ab' },
  amber: { fill: '#fff3bf', stroke: '#a35200' },
  green: { fill: '#d3f9d8', stroke: '#2b8a3e' },
  rose: { fill: '#ffe3e3', stroke: '#c92a2a' },
  gray: { fill: '#f1f3f5', stroke: '#343a40' },
};

export function seedOf(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 2000000000 + 1;
}

const base = (id, type, x, y, width, height, o = {}) => {
  const { tone, ...rest } = o;
  return {
    id, type, x, y, width, height,
    angle: 0,
    strokeColor: tone?.stroke ?? color.ink,
    backgroundColor: tone?.fill ?? 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    seed: seedOf(id),
    roundness: null,
    ...rest,
  };
};

export const rect = (id, x, y, w, h, o = {}) => base(id, 'rectangle', x, y, w, h, { roundness: { type: 3 }, ...o });
export const ellipse = (id, x, y, w, h, o = {}) => base(id, 'ellipse', x, y, w, h, o);
export const diamond = (id, x, y, w, h, o = {}) => base(id, 'diamond', x, y, w, h, o);

/** A polyline. Points are absolute stage coordinates. */
export function line(id, points, o = {}) {
  const [ox, oy] = points[0];
  const local = points.map(([x, y]) => [x - ox, y - oy]);
  const xs = local.map((p) => p[0]), ys = local.map((p) => p[1]);
  return base(id, 'line', ox, oy, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), { points: local, ...o });
}

export const arrow = (id, points, o = {}) => ({ ...line(id, points, o), type: 'arrow', endArrowhead: o.endArrowhead ?? 'arrow', startArrowhead: o.startArrowhead ?? null });

/** Text placed by its anchor: `align` is left, center or right of x. `valign` is top or middle of y. */
export function text(id, x, y, words, o = {}) {
  const { size = 28, font = 5, align = 'left', valign = 'top', tone, color: ink, ...rest } = o;
  const m = measure(words, size, font);
  const left = align === 'center' ? x - m.width / 2 : align === 'right' ? x - m.width : x;
  const top = valign === 'middle' ? y - m.height / 2 : y;
  return base(id, 'text', left, top, m.width, m.height, {
    text: String(words), fontSize: size, fontFamily: font, textAlign: align, verticalAlign: 'top', lineHeight: 1.25,
    strokeColor: ink ?? tone?.stroke ?? color.ink, ...rest,
  });
}

/** A rounded box with a centered label. Returns [box, label]. The label is `${id}-t` and lets input through to the box. */
export function box(id, x, y, w, h, words, o = {}) {
  const { size = 28, font = 5, tone, labelColor, ...rest } = o;
  const shape = rect(id, x, y, w, h, { tone, ...rest });
  const label = text(`${id}-t`, x + w / 2, y + h / 2, words, { size, font, align: 'center', valign: 'middle', color: labelColor ?? tone?.stroke, customData: { handwave: { ghost: true } }, opacity: rest.opacity ?? 100 });
  return [shape, label];
}

// excalive's hand-placed scenes store the middle of centered text in x, always a
// whole number, while Excalidraw stores the left edge. Same rule as excalive's.
function normalizeText(elements) {
  const centered = elements.filter((e) => e.type === 'text' && !e.containerId && e.textAlign === 'center');
  const xIsMiddle = centered.length > 0 && centered.every((e) => Number.isInteger(e.x));
  return elements.map((e) => {
    if (e.type !== 'text' || e.containerId) return e;
    const { width } = measure(e.text ?? '', e.fontSize ?? 20, e.fontFamily ?? 5, e.lineHeight ?? 1.25);
    const align = e.textAlign ?? 'left';
    if (align === 'center') return { ...e, x: (xIsMiddle ? e.x : e.x + (e.width ?? 0) / 2) - width / 2, width };
    if (align === 'right') return { ...e, x: e.x + (e.width ?? 0) - width, width };
    return { ...e, width };
  });
}

/** Load an .excalidraw file. Call after the stage exists, so fonts can be measured. Returns {elements, files}. */
export async function loadScene(url) {
  const data = await (await fetch(url)).json();
  return parseScene(data);
}

/** The same for a parsed document, such as a file dropped on the page. */
export const parseScene = (data) => ({ elements: normalizeText(data.elements.filter((e) => !e.isDeleted)), files: data.files ?? {} });

/** Serialise elements to an .excalidraw document. */
export const toExcalidraw = (elements, files = {}) => JSON.stringify({ type: 'excalidraw', version: 2, source: 'handwave', elements, appState: { viewBackgroundColor: '#ffffff' }, files }, null, 2);
