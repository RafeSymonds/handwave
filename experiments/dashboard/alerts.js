// Whether a rule is true, and when that changed. This file has no DOM and keeps no
// state: the states come from replaying the data, so looking back shows what the rule
// said then, and a reload shows the same history. Anything that wants to act on a change
// (a notifier, say) takes the transitions from `replay` and can run on the server too.
//
// A rule is {level: 'warn'|'critical', op: 'above'|'below', value, for}. For one rule:
//   ok        the value is on the right side of the line
//   pending   it has crossed the line, for less than `for`
//   firing    it has stayed across the line for `for`
//   nodata    no number to judge. This is never reported as ok

export const breached = (rule, v) => (rule.op === 'below' ? v < rule.value : v > rule.value);

/** Replay a rule over a series. `until` is now, so a series that went quiet goes to nodata. */
export function replay(rule, series, { gapAfter, staleAfter = gapAfter, until = Infinity }) {
  const transitions = [];
  let state = 'nodata', since = null, crossed = null, last = null;
  const go = (next, t, value) => {
    if (next === state) return;
    transitions.push({ t, from: state, to: next, value, rule });
    state = next;
    since = t;
  };
  const { t, v, n } = series;
  for (let i = 0; i < n; i++) {
    const value = v[i], at = t[i];
    if (last !== null && at - last > gapAfter) { go('nodata', last + gapAfter, null); crossed = null; }
    if (!Number.isFinite(value)) { go('nodata', at, null); crossed = null; last = null; continue; }
    last = at;
    if (!breached(rule, value)) { crossed = null; go('ok', at, value); continue; }
    crossed ??= at;
    go(at - crossed >= rule.for ? 'firing' : 'pending', at, value);
  }
  // Going quiet is noticed at the source's pace. But if it stopped long ago, it is only known to
  // the spacing of these points, and saying sooner would invent a gap before whatever came next.
  if (last !== null && until - last > staleAfter) go('nodata', last + (until - last > gapAfter ? Math.max(staleAfter, gapAfter) : staleAfter), null);
  return { transitions, state, since, crossed };
}

/** What a replayed rule said at time `t`. */
export function stateAt(result, t) {
  const list = result.transitions;
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t <= t) lo = mid + 1; else hi = mid;
  }
  if (!lo) return { state: 'nodata', since: null, entry: null };
  return { state: list[lo - 1].to, since: list[lo - 1].t, entry: list[lo - 1] };
}

// How much a shape's state matters, worst last. Each has a word and an icon, so state
// never rests on color: `icon` names a drawing in panels.js.
export const LEVELS = {
  none: { rank: 0, word: '', icon: null },
  ok: { rank: 1, word: 'OK', icon: 'check' },
  pending: { rank: 2, word: 'PENDING', icon: 'clock' },
  nodata: { rank: 3, word: 'NO DATA', icon: 'question' },
  failed: { rank: 4, word: 'FAILED', icon: 'cross' },
  warn: { rank: 5, word: 'WARN', icon: 'triangle' },
  critical: { rank: 6, word: 'CRITICAL', icon: 'octagon' },
};

export const worse = (a, b) => (LEVELS[a].rank >= LEVELS[b].rank ? a : b);

/** A rule's state as a level on the shape. */
export function levelOf(rule, state) {
  if (state === 'firing') return rule.level;
  if (state === 'pending') return 'pending';
  if (state === 'nodata') return 'nodata';
  return 'ok';
}
