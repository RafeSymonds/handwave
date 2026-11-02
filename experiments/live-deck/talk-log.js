// What this talk has recorded, shown on the replay slide. Numbers come from the log
// the server is keeping right now, so the slide cannot overstate it.
//
// ReplayLog holds every change the room saw, each with its time. Activity frames are
// thinned and stop at a byte budget, so a long talk keeps its slides, votes and ink
// even if the frames run out. Nothing sent to the presenter alone is ever recorded.

const FRAME_BUDGET = 32 * 1024 * 1024;
const TOTAL_BUDGET = 64 * 1024 * 1024;

export class ReplayLog {
  constructor() {
    this.startedAt = Date.now();
    this.entries = [];
    this.bytes = 0;
    this.frameBytes = 0;
    this.framesCut = false;
    this.opsCut = false;
  }

  add(op, json = JSON.stringify(op)) {
    const isFrame = op.t === 'act-frame';
    if (isFrame && this.frameBytes + json.length > FRAME_BUDGET) { this.framesCut = true; return; }
    if (this.bytes + json.length > TOTAL_BUDGET) { this.opsCut = true; return; }
    this.bytes += json.length + 12;
    if (isFrame) this.frameBytes += json.length;
    this.entries.push([Date.now() - this.startedAt, op]);
  }

  // A drawing the presenter takes back must not survive in a file that gets shared.
  retract(slide, id) {
    for (const [, op] of this.entries) {
      if (op.t === 'gal-show' && op.slide === slide && op.item.id === id) op.item.strokes = [];
    }
  }

  retractQuestion(id) {
    for (const [, op] of this.entries) {
      if (op.t === 'q-show' && op.q.id === id) op.q.text = '';
    }
  }

  document(info) {
    return { kind: 'handwave-live-deck-replay', version: 1, startedAt: this.startedAt, framesCut: this.framesCut, opsCut: this.opsCut, info, entries: this.entries };
  }

  // Time spent on each slide and how many changes of each kind, for the slide.
  summary() {
    const tally = { changes: this.entries.length, slides: 0, votes: 0, strokes: 0, frames: 0, drawings: 0, seconds: this.entries.length ? this.entries.at(-1)[0] / 1000 : 0, spans: [] };
    let current = null;
    for (const [at, op] of this.entries) {
      if (op.t === 'tally') tally.votes++;
      else if (op.t === 'ink-start') tally.strokes++;
      else if (op.t === 'act-frame') tally.frames++;
      else if (op.t === 'gal-show') tally.drawings++;
      else if (op.t === 'goto') {
        tally.slides++;
        if (current?.index !== op.index) {
          if (current) current.to = at;
          current = { index: op.index, from: at, to: at };
          tally.spans.push(current);
        }
      }
    }
    if (current) current.to = Date.now() - this.startedAt;
    tally.spans = tally.spans.slice(-60).map((s) => [s.index, s.from, s.to]);
    return tally;
  }
}

/** The replay slide's activity: it reads the log and has no phone input. */
export class TalkLog {
  static tickHz = 1;
  static frameHz = 1;
  static logEverySeconds = null;   // A summary of the log must not add to the log.

  constructor(slide, host) {
    this.slide = slide;
    this.host = host;
    this.lastKey = '';
  }

  tick() {}
  you() { return {}; }

  frame() {
    const summary = this.host.log.summary();
    const key = JSON.stringify([summary.changes, summary.spans.length]);
    if (key === this.lastKey) return null;
    this.lastKey = key;
    return summary;
  }
}
