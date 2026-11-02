// Edit a drawing as Excalidraw would: a moved shape takes its label and the ends of
// its arrows with it, and an arrow keeps its bindings up to date. Every function
// takes the element list and returns a new one, which remains a plain Excalidraw
// document.

import { measure } from '/lib/stage.js';
import { absPoints, aimOffset, boundaryHit, center, distanceToPath, isArrow, isShape, ownerOf, pathOf, pointAlong } from './graph.js';

const GAP = 9;

function fromAbsolute(arrow, abs) {
  const [ox, oy] = abs[0];
  const points = abs.map(([x, y]) => [x - ox, y - oy]);
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return { ...arrow, x: ox, y: oy, points, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

// Bent arrows keep their bend. Points between the ends turn and scale with the line
// from end to end, so a long curve rewired to something close becomes a small curve
// rather than swinging off the board.
function remap(abs, start, end) {
  const a = abs[0], b = abs[abs.length - 1];
  const ox = b[0] - a[0], oy = b[1] - a[1], nx = end[0] - start[0], ny = end[1] - start[1];
  const size = ox * ox + oy * oy || 1;
  const re = (nx * ox + ny * oy) / size, im = (ny * ox - nx * oy) / size;
  return abs.map(([x, y], i) => {
    if (i === 0) return start;
    if (i === abs.length - 1) return end;
    const dx = x - a[0], dy = y - a[1];
    return [start[0] + dx * re - dy * im, start[1] + dx * im + dy * re];
  });
}

// A point on a line through a shape's center, off to the side of the arrow's direction
// of travel. Clamped so the line still crosses the shape.
function aimFrom(shape, flow, offset = 0) {
  const [cx, cy] = center(shape);
  const length = Math.hypot(flow[0], flow[1]) || 1;
  const most = Math.min(shape.width, shape.height) * 0.45;
  const off = Math.max(-most, Math.min(most, offset));
  return [cx - (flow[1] / length) * off, cy + (flow[0] / length) * off];
}

/** Put an arrow's bound ends on the edges of their shapes. */
export function route(arrow, shapes) {
  const S = shapes.get(arrow.startBinding?.elementId), E = shapes.get(arrow.endBinding?.elementId);
  const aim = arrow.customData?.machine?.aim ?? {};
  const abs = absPoints(arrow);
  const n = abs.length;
  if (n === 2) {
    // A straight arrow runs between the two aim points, so it stays straight.
    const a = S ? center(S) : abs[0];
    const b = E ? center(E) : abs[1];
    const flow = [b[0] - a[0], b[1] - a[1]];
    const aimS = S ? aimFrom(S, flow, aim.start) : a;
    const aimE = E ? aimFrom(E, flow, aim.end) : b;
    if (S) abs[0] = boundaryHit(S, aimE, aimS, GAP);
    if (E) abs[1] = boundaryHit(E, aimS, aimE, GAP);
  } else {
    if (S) {
      const [cx, cy] = center(S);
      abs[0] = boundaryHit(S, abs[1], aimFrom(S, [abs[1][0] - cx, abs[1][1] - cy], aim.start), GAP);
    }
    if (E) {
      const [cx, cy] = center(E);
      abs[n - 1] = boundaryHit(E, abs[n - 2], aimFrom(E, [cx - abs[n - 2][0], cy - abs[n - 2][1]], aim.end), GAP);
    }
  }
  return fromAbsolute(arrow, abs);
}

// An arrow's label stays on the arrow: a bound label on its midpoint, and a label
// placed beside it by the same offset as before.
function carryLabels(list, before, after) {
  const was = pointAlong(pathOf(before), 0.5);
  const now = pointAlong(pathOf(after), 0.5);
  return list.map((el) => {
    if (el.type !== 'text' || ownerOf(el) !== after.id) return el;
    if (el.containerId) return { ...el, x: now[0] - el.width / 2, y: now[1] - el.height / 2 };
    return { ...el, x: el.x + now[0] - was[0], y: el.y + now[1] - was[1] };
  });
}

const shapeMap = (list) => new Map(list.filter(isShape).map((s) => [s.id, s]));

export function moveShape(list, id, dx, dy) {
  let out = list.map((el) => {
    if (el.id === id) return { ...el, x: el.x + dx, y: el.y + dy };
    if (el.type === 'text' && ownerOf(el) === id) return { ...el, x: el.x + dx, y: el.y + dy };
    return el;
  });
  const shapes = shapeMap(out);
  for (const before of out.filter(isArrow)) {
    const isStart = before.startBinding?.elementId === id, isEnd = before.endBinding?.elementId === id;
    if (!isStart && !isEnd) continue;
    const abs = absPoints(before);
    const first = abs[0], last = abs[abs.length - 1];
    const moved = remap(abs, isStart ? [first[0] + dx, first[1] + dy] : first, isEnd ? [last[0] + dx, last[1] + dy] : last);
    const after = route(fromAbsolute(before, moved), shapes);
    out = carryLabels(out.map((el) => (el.id === after.id ? after : el)), before, after);
  }
  return out;
}

/** Show an arrow's end following the pointer. `original` is the arrow when the drag began. */
export function dragEnd(list, original, end, point) {
  const abs = absPoints(original);
  const moved = end === 'start' ? remap(abs, point, abs[abs.length - 1]) : remap(abs, abs[0], point);
  const after = fromAbsolute(original, moved);
  return carryLabels(list.map((el) => (el.id === after.id ? after : el)), pathHolder(list, after.id), after);
}

const pathHolder = (list, id) => list.find((el) => el.id === id);

// Route a rewired straight arrow where it does not lie on top of another arrow. Two
// arrows between the same shapes otherwise run along one line and hide each other.
function clearRoute(arrow, list) {
  const shapes = shapeMap(list);
  const others = list.filter((el) => isArrow(el) && el.id !== arrow.id);
  const placed = (off) => route({ ...arrow, customData: { ...arrow.customData, machine: { ...arrow.customData?.machine, aim: { start: off, end: off } } } }, shapes);
  if (arrow.points.length !== 2) return route(arrow, shapes);
  for (const off of [0, 44, -44]) {
    const candidate = placed(off);
    const [x, y] = pointAlong(pathOf(candidate), 0.5);
    if (others.every((other) => distanceToPath(pathOf(other), x, y) >= 34)) return candidate;
  }
  return route(arrow, shapes);
}

/** Put an arrow back as it was when the drag began. */
export function restoreArrow(list, original) {
  const current = pathHolder(list, original.id);
  return carryLabels(list.map((el) => (el.id === original.id ? original : el)), current, original);
}

/** Bind an arrow's end to another shape. `original` is the arrow when the drag began. */
export function rebind(list, original, end, targetId) {
  const key = end === 'start' ? 'startBinding' : 'endBinding';
  const oldId = original[key]?.elementId ?? null;
  const target = shapeMap(list).get(targetId);
  const abs = absPoints(original);
  const middle = center(target);
  const moved = end === 'start' ? remap(abs, middle, abs[abs.length - 1]) : remap(abs, abs[0], middle);
  const machine = original.customData?.machine ?? {};
  let arrow = {
    ...fromAbsolute(original, moved),
    [key]: { elementId: targetId, focus: 0, gap: GAP },
    customData: { ...original.customData, machine: { ...machine, aim: { ...machine.aim, [end]: 0 } } },
    boundElements: original.boundElements,
  };
  let out = list.map((el) => {
    if (el.id === arrow.id) return arrow;
    if (el.id === targetId && !(el.boundElements ?? []).some((b) => b.id === arrow.id)) return { ...el, boundElements: [...(el.boundElements ?? []), { id: arrow.id, type: 'arrow' }] };
    // The old shape lets go, unless the arrow's other end is on it too.
    const otherEnd = end === 'start' ? original.endBinding?.elementId : original.startBinding?.elementId;
    if (el.id === oldId && oldId !== otherEnd) return { ...el, boundElements: (el.boundElements ?? []).filter((b) => b.id !== arrow.id) };
    return el;
  });
  arrow = clearRoute(arrow, out);
  const held = pathHolder(list, arrow.id);
  return carryLabels(out.map((el) => (el.id === arrow.id ? arrow : el)), held, arrow);
}

// ---------------------------------------------------------------------------
// Labels.

function placeLabel(text, owner) {
  if (!owner) return text;
  if (owner.type === 'arrow') {
    const [x, y] = pointAlong(pathOf(owner), 0.5);
    return { ...text, x: x - text.width / 2, y: y - text.height / 2 };
  }
  const x = owner.x + (owner.width - text.width) / 2;
  let y = owner.y + (owner.height - text.height) / 2;
  if (owner.type === 'rectangle' && text.verticalAlign === 'top') y = owner.y + 10;
  if (owner.type === 'rectangle' && text.verticalAlign === 'bottom') y = owner.y + owner.height - text.height - 10;
  if (owner.type === 'ellipse' && text.verticalAlign === 'top') y = owner.y + owner.height * 0.2;
  return { ...text, x, y };
}

const sized = (text) => {
  const m = measure(text.text, text.fontSize, text.fontFamily, text.lineHeight ?? 1.25);
  return { ...text, width: m.width, height: m.height };
};

/** Measure bound labels with the real font and center them. */
export function settle(list) {
  const owners = new Map(list.map((el) => [el.id, el]));
  return list.map((el) => (el.type === 'text' && el.containerId ? placeLabel(sized(el), owners.get(el.containerId)) : el));
}

/** Change a text element's words, or delete it if they are empty. */
export function setText(list, id, words) {
  const owners = new Map(list.map((el) => [el.id, el]));
  const text = owners.get(id);
  if (!words.trim()) {
    return list.filter((el) => el.id !== id).map((el) => (el.id === text.containerId ? { ...el, boundElements: (el.boundElements ?? []).filter((b) => b.id !== id) } : el));
  }
  return list.map((el) => {
    if (el.id !== id) return el;
    const next = sized({ ...el, text: words, originalText: words });
    if (next.containerId) return placeLabel(next, owners.get(next.containerId));
    // Free text keeps its middle, so a label beside an arrow stays over the arrow.
    if ((next.textAlign ?? 'left') === 'center') return { ...next, x: el.x + (el.width - next.width) / 2 };
    return next;
  });
}

let labelCount = 0;

/** Give a shape or arrow a bound label, as Excalidraw does. */
export function addLabel(list, ownerId, words) {
  const owner = list.find((el) => el.id === ownerId);
  const id = `${ownerId}-label-${Date.now().toString(36)}${labelCount++}`;
  const text = placeLabel(sized({
    id, type: 'text', x: 0, y: 0, width: 0, height: 0, angle: 0, strokeColor: owner.strokeColor, backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false,
    text: words, originalText: words, fontSize: owner.type === 'arrow' ? 24 : 28, fontFamily: 5, textAlign: 'center', verticalAlign: 'middle', containerId: ownerId, autoResize: true, lineHeight: 1.25,
  }), owner);
  const at = list.indexOf(owner);
  const out = list.map((el) => (el.id === ownerId ? { ...el, boundElements: [...(el.boundElements ?? []), { id, type: 'text' }] } : el));
  // Right above its owner, so a label always draws over the arrow it sits on.
  return [...out.slice(0, at + 1), text, ...out.slice(at + 1)];
}

// ---------------------------------------------------------------------------
// Adding, deleting and copying. New elements carry every field Excalidraw writes, so
// a saved file opens there as if it had been drawn there.

let idCount = 0;
const freshId = (prefix) => `${prefix}-${Date.now().toString(36)}${(idCount++).toString(36)}`;
const seedOf = () => 1 + Math.floor(Math.random() * 2000000000);

const COMMON = () => ({ angle: 0, fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, seed: seedOf(), version: 1, versionNonce: seedOf(), isDeleted: false, boundElements: [], updated: 1, link: null, locked: false });

export const TONES = {
  blue: ['#1864ab', '#d0ebff'], amber: ['#a35200', '#fff3bf'], green: ['#2b8a3e', '#d3f9d8'], rose: ['#c92a2a', '#ffe3e3'], gray: ['#343a40', '#f1f3f5'], none: ['#1B2547', 'transparent'],
};

/** A shape for a palette part. Returns the new list and the shape's id. */
export function addPart(list, part, x, y) {
  const id = freshId(part.id);
  const [stroke, fill] = TONES[part.tone] ?? TONES.gray;
  const shape = { ...COMMON(), id, type: part.type, x: x - part.w / 2, y: y - part.h / 2, width: part.w, height: part.h, strokeColor: stroke, backgroundColor: fill, roundness: part.type === 'rectangle' ? { type: 3 } : { type: 2 } };
  let out = [...list, shape];
  if (part.label) {
    out = addLabel(out, id, part.label);
    if (part.valign === 'top') out = out.map((el) => (el.containerId === id ? placeLabel({ ...el, verticalAlign: 'top' }, shape) : el));
  }
  return { list: out, id };
}

/** An empty shape with no label yet, for a double-click on nothing. */
export function addBlank(list, x, y) {
  return addPart(list, { id: 'shape', type: 'rectangle', tone: 'gray', w: 220, h: 110, label: '' }, x, y);
}

const arrowBase = (id, points, startId, endId) => {
  const local = points.map(([x, y]) => [x - points[0][0], y - points[0][1]]);
  const xs = local.map((p) => p[0]), ys = local.map((p) => p[1]);
  return {
    ...COMMON(), id, type: 'arrow', x: points[0][0], y: points[0][1], width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), points: local,
    strokeColor: '#1B2547', backgroundColor: 'transparent', roundness: points.length > 2 ? { type: 2 } : null, lastCommittedPoint: null, elbowed: false,
    startBinding: startId ? { elementId: startId, focus: 0, gap: GAP } : null, endBinding: endId ? { elementId: endId, focus: 0, gap: GAP } : null, startArrowhead: null, endArrowhead: 'arrow',
  };
};

const withBound = (list, ids, arrowId) => list.map((el) => (ids.includes(el.id) && !(el.boundElements ?? []).some((b) => b.id === arrowId) ? { ...el, boundElements: [...(el.boundElements ?? []), { id: arrowId, type: 'arrow' }] } : el));

/** Draw an arrow between two shapes. Returns the new list and the arrow's id. */
export function addArrow(list, fromId, toId) {
  const id = freshId('arrow');
  const shapes = shapeMap(list);
  const from = shapes.get(fromId), to = shapes.get(toId);
  if (fromId === toId) {
    // An arrow from a shape to itself loops over the top.
    const [cx] = center(from);
    const reach = Math.min(from.width * 0.3, 70);
    const top = from.y;
    const points = [[cx - reach, top - GAP], [cx, top - 90], [cx + reach, top - GAP]];
    const dir = [0, -1];
    const loop = { ...arrowBase(id, points, fromId, toId), customData: { machine: { aim: { start: aimOffset(from, points[0], dir), end: aimOffset(from, points[2], [0, 1]) } } } };
    return { list: [...withBound(list, [fromId], id), route(loop, shapes)], id };
  }
  const arrow = arrowBase(id, [center(from), center(to)], fromId, toId);
  const out = [...withBound(list, [fromId, toId], id), arrow];
  const placed = clearRoute(arrow, out);
  return { list: out.map((el) => (el.id === id ? placed : el)), id };
}

/** An arrow from nothing to a shape: where a state machine begins. */
export function addStartArrow(list, toId) {
  const id = freshId('start');
  const shapes = shapeMap(list);
  const to = shapes.get(toId);
  const [cx, cy] = center(to);
  const arrow = route(arrowBase(id, [[to.x - 120, cy], [cx, cy]], null, toId), shapes);
  return { list: [...withBound(list, [toId], id), arrow], id };
}

const isAttached = (arrow, id) => arrow.startBinding?.elementId === id || arrow.endBinding?.elementId === id;

/** Delete a shape or arrow, with its label. A shape's arrows go too. */
export function removeElement(list, id) {
  const target = list.find((el) => el.id === id);
  if (!target) return list;
  const gone = new Set([id]);
  if (isShape(target)) for (const el of list) if (isArrow(el) && isAttached(el, id)) gone.add(el.id);
  for (const el of list) if (el.type === 'text' && gone.has(ownerOf(el))) gone.add(el.id);
  return list.filter((el) => !gone.has(el.id)).map((el) => {
    if (!el.boundElements?.some((b) => gone.has(b.id))) return el;
    return { ...el, boundElements: el.boundElements.filter((b) => !gone.has(b.id)) };
  });
}

/** Put a new part in the middle of an arrow, which becomes two arrows. */
export function insertOnArrow(list, arrowId, part) {
  const arrow = list.find((el) => el.id === arrowId);
  const [x, y] = pointAlong(pathOf(arrow), 0.5);
  const { list: withPart, id } = addPart(list, part, x, y);
  const toId = arrow.endBinding?.elementId ?? null;
  let out = rebind(withPart, withPart.find((el) => el.id === arrowId), 'end', id);
  // The arrow's label stays on the part before the new shape.
  if (toId) out = addArrow(out, id, toId).list;
  return { list: out, id };
}

/** Copy a shape and its label, a little to the side. Arrows are left behind. */
export function duplicate(list, id) {
  const shape = list.find((el) => el.id === id);
  if (!shape || !isShape(shape)) return { list, id };
  const copyId = freshId(shape.id);
  const offset = 36;
  const labels = list.filter((el) => el.type === 'text' && ownerOf(el) === id);
  const textCopies = labels.map((t) => {
    const textId = freshId(`${copyId}-t`);
    return { ...t, id: textId, x: t.x + offset, y: t.y + offset, containerId: t.containerId ? copyId : t.containerId, seed: seedOf(), customData: t.customData?.machine?.owner ? { ...t.customData, machine: { ...t.customData.machine, owner: copyId } } : t.customData };
  });
  const copy = { ...shape, id: copyId, x: shape.x + offset, y: shape.y + offset, seed: seedOf(), boundElements: textCopies.filter((t) => t.containerId).map((t) => ({ id: t.id, type: 'text' })) };
  return { list: [...list, copy, ...textCopies], id: copyId };
}

/** Replace part of an owner's label, wherever it is. Used for fixes and for changing a number. */
export function replaceInLabel(list, ownerId, oldWords, newWords) {
  const text = list.find((el) => el.type === 'text' && ownerOf(el) === ownerId && el.text.includes(oldWords));
  if (!text) return list;
  return setText(list, text.id, text.text.replace(oldWords, newWords));
}

/** Add a line to an owner's label, making the label if it has none. */
export function appendToLabel(list, ownerId, words) {
  const text = list.find((el) => el.type === 'text' && ownerOf(el) === ownerId);
  if (!text) return addLabel(list, ownerId, words);
  return setText(list, text.id, `${text.text}\n${words}`);
}

/** Set an owner's whole label. */
export function setLabel(list, ownerId, words) {
  const text = list.find((el) => el.type === 'text' && ownerOf(el) === ownerId);
  if (text) return setText(list, text.id, words);
  return words.trim() ? addLabel(list, ownerId, words) : list;
}

const NOTE_DEFAULTS = { fontSize: 26, fontFamily: 5, textAlign: 'left', verticalAlign: 'top', autoResize: true, lineHeight: 1.25, containerId: null, strokeColor: '#7A776E', backgroundColor: 'transparent', roundness: null };

/** Free text that does nothing, marked so it never attaches to what it sits beside. */
export function addNote(list, x, y, words = 'a note') {
  const id = freshId('note');
  const text = sized({ ...COMMON(), ...NOTE_DEFAULTS, id, type: 'text', x, y, width: 0, height: 0, boundElements: null, text: words, originalText: words, customData: { machine: { note: true } } });
  return { list: [...list, text], id };
}

/** Move free text. */
export const moveNote = (list, id, dx, dy) => list.map((el) => (el.id === id ? { ...el, x: el.x + dx, y: el.y + dy } : el));

/** Change a shape's size from its bottom right corner. Its label and arrows follow. */
export function resizeShape(list, id, width, height) {
  const target = list.find((el) => el.id === id);
  if (!target) return list;
  const next = { ...target, width: Math.max(70, width), height: Math.max(44, height) };
  let out = list.map((el) => {
    if (el.id === id) return next;
    if (el.type === 'text' && el.containerId === id) return placeLabel(el, next);
    // Free text inside it keeps its place in the middle of the shape.
    if (el.type === 'text' && ownerOf(el) === id) return { ...el, x: el.x + (next.width - target.width) / 2, y: el.y + (next.height - target.height) / 2 };
    return el;
  });
  const shapes = shapeMap(out);
  for (const before of out.filter(isArrow)) {
    if (!isAttached(before, id)) continue;
    const after = route(before, shapes);
    out = carryLabels(out.map((el) => (el.id === after.id ? after : el)), before, after);
  }
  return out;
}
