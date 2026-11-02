// A finished talk is a log of changes, so any moment in it is the reducer run up to
// that time. Moving forward applies what is new. Moving back starts again from a
// saved copy of the state, so scrubbing stays quick on a long talk. No page needed.

import { SLIDES } from './meta.js';
import { apply, newState } from './room.js';

const KEEP_EVERY = 2000;
const LONGEST_PAUSE = 30000;   // A long silence, such as the hour before a talk, is cut to this.

export class ReplayPlayer {
  constructor(doc) {
    if (doc?.kind !== 'handwave-live-deck-replay' || !Array.isArray(doc.entries)) throw new Error('This file is not a saved talk.');
    for (const [, op] of doc.entries) if (op.t === 'goto' && !SLIDES[op.index]) throw new Error('This file is from a different deck.');
    this.doc = doc;
    let cut = 0, last = 0;
    this.entries = doc.entries.map(([at, op]) => {
      if (at - last > LONGEST_PAUSE) cut += at - last - LONGEST_PAUSE;
      last = at;
      return [at - cut, op];
    });
    this.cut = cut;
    this.duration = this.entries.length ? this.entries.at(-1)[0] : 0;
    this.kept = [{ index: 0, state: newState() }];
    const state = newState();
    this.entries.forEach(([, op], i) => {
      apply(state, op);
      if ((i + 1) % KEEP_EVERY === 0) this.kept.push({ index: i + 1, state: structuredClone(state) });
    });
    this.state = newState();
    this.cursor = 0;   // How many entries the state includes.
  }

  // How many entries happened at or before a time.
  countAt(ms) {
    let lo = 0, hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.entries[mid][0] <= ms) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** The room at a time. Returns true if the state changed. */
  seek(ms) {
    const target = this.countAt(ms);
    if (target === this.cursor) return false;
    if (target < this.cursor) {
      let k = this.kept.length - 1;
      while (this.kept[k].index > target) k--;
      this.state = structuredClone(this.kept[k].state);
      this.cursor = this.kept[k].index;
    }
    while (this.cursor < target) apply(this.state, this.entries[this.cursor++][1]);
    return true;
  }

  /** The activity frames either side of a time, for smooth motion between them. */
  framesAround(ms, slide) {
    let i = Math.min(this.countAt(ms), this.entries.length) - 1;
    for (let scan = 0; i >= 0 && scan < 200; i--, scan++) {
      const [, op] = this.entries[i];
      if (op.t === 'act-frame' && op.slide === slide) break;
    }
    if (i < 0 || this.entries[i]?.[1].t !== 'act-frame') return null;
    const a = this.entries[i];
    let b = null;
    for (let k = i + 1; k < this.entries.length && k < i + 200; k++) {
      if (this.entries[k][1].t === 'act-frame' && this.entries[k][1].slide === slide) { b = this.entries[k]; break; }
      if (this.entries[k][1].t === 'goto' && SLIDES[this.entries[k][1].index].id !== slide) break;
    }
    return { a, b };
  }

  /** Where each slide began, for the marks on the timeline. */
  marks() {
    const out = [];
    let last = null;
    for (const [at, op] of this.entries) {
      if (op.t === 'goto' && op.index !== last) { out.push({ at, index: op.index }); last = op.index; }
    }
    return out;
  }
}
