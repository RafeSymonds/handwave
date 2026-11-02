// The state of a room and the only way it changes. The server and every page run
// this same reducer, so a copy built from a full state plus later changes always
// matches the server's. Runs in the browser and in Node.

import { SLIDES, slideById } from './meta.js';

export const newState = () => ({
  index: 0,
  step: 0,
  offsets: {},    // slide id -> element id -> [dx, dy]
  ink: {},        // slide id -> [{id, pts: [[x, y], ...]}]
  tallies: {},    // slide id -> [count per option]
  shown: null,    // the question on the shared screen: {id, text}
  questions: [],  // the presenter's queue. Other roles receive it empty.
  counts: { phones: 0, screens: 0 },
});

export function apply(s, op) {
  switch (op.t) {
    case 'goto':
      s.index = op.index;
      s.step = op.step;
      break;
    case 'offset':
      (s.offsets[op.slide] ??= {})[op.id] = [op.dx, op.dy];
      break;
    case 'ink-start':
      (s.ink[op.slide] ??= []).push({ id: op.id, pts: op.pts.map((p) => [...p]) });
      break;
    case 'ink-add': {
      const stroke = s.ink[op.slide]?.find((k) => k.id === op.id);
      if (stroke) stroke.pts.push(...op.pts.map((p) => [...p]));
      break;
    }
    case 'home':
      delete s.offsets[op.slide];
      delete s.ink[op.slide];
      break;
    case 'tally':
      s.tallies[op.slide] = op.counts;
      break;
    case 'asked':
      s.questions.push(op.q);
      break;
    case 'q-show':
      s.shown = op.q;
      break;
    case 'q-hide':
      s.shown = null;
      break;
    case 'q-drop':
      s.questions = s.questions.filter((q) => q.id !== op.id);
      if (s.shown?.id === op.id) s.shown = null;
      break;
    case 'counts':
      s.counts = op.counts;
      break;
    default:
      break;
  }
  return s;
}

/** The step before or after this one, across slides. Stays put at either end. */
export function stepFrom(index, step, delta) {
  const slide = SLIDES[index];
  if (delta > 0) {
    if (step + 1 < slide.steps) return { index, step: step + 1 };
    if (index + 1 < SLIDES.length) return { index: index + 1, step: 0 };
  } else {
    if (step > 0) return { index, step: step - 1 };
    if (index > 0) return { index: index - 1, step: SLIDES[index - 1].steps - 1 };
  }
  return { index, step };
}

// ---------------------------------------------------------------------------
// Checks on what the presenter sends. Votes and questions are checked on the server.

const MAX_STROKES = 300, MAX_POINTS = 5000, MAX_BATCH = 400, FAR = 20000;
const okNumber = (v) => Number.isFinite(v) && Math.abs(v) <= FAR;
const okId = (v) => typeof v === 'string' && /^[a-z0-9][\w:-]{0,79}$/i.test(v);
const okPoints = (pts) => Array.isArray(pts) && pts.length > 0 && pts.length <= MAX_BATCH && pts.every((p) => Array.isArray(p) && okNumber(p[0]) && okNumber(p[1]));
const cleanPoints = (pts) => pts.map((p) => [p[0], p[1]]);

/** A safe copy of a presenter's change, or null if it is not one. */
export function cleanPresenterOp(op, state) {
  const slideOk = typeof op.slide === 'string' && Boolean(slideById(op.slide));
  switch (op.t) {
    case 'goto': {
      const slide = SLIDES[op.index];
      if (!slide || !Number.isInteger(op.step) || op.step < 0 || op.step >= slide.steps) return null;
      return { t: 'goto', index: op.index, step: op.step };
    }
    case 'offset':
      if (!slideOk || !okId(op.id) || !okNumber(op.dx) || !okNumber(op.dy)) return null;
      return { t: 'offset', slide: op.slide, id: op.id, dx: op.dx, dy: op.dy };
    case 'ink-start':
      if (!slideOk || !okId(op.id) || !okPoints(op.pts) || (state.ink[op.slide]?.length ?? 0) >= MAX_STROKES) return null;
      return { t: 'ink-start', slide: op.slide, id: op.id, pts: cleanPoints(op.pts) };
    case 'ink-add': {
      if (!slideOk || !okId(op.id) || !okPoints(op.pts)) return null;
      const stroke = state.ink[op.slide]?.find((k) => k.id === op.id);
      if (!stroke || stroke.pts.length + op.pts.length > MAX_POINTS) return null;
      return { t: 'ink-add', slide: op.slide, id: op.id, pts: cleanPoints(op.pts) };
    }
    case 'home':
      return slideOk ? { t: 'home', slide: op.slide } : null;
    case 'q-show': {
      const q = state.questions.find((k) => k.id === op.id);
      return q ? { t: 'q-show', q: { id: q.id, text: q.text } } : null;
    }
    case 'q-hide':
      return { t: 'q-hide' };
    case 'q-drop':
      return okId(op.id) ? { t: 'q-drop', id: op.id } : null;
    default:
      return null;
  }
}
