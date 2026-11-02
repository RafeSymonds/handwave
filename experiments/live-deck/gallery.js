// The room draws. A phone's drawing goes to the presenter alone. Only a drawing the
// presenter approves is emitted to the room, so an unapproved one never reaches a
// shared screen, another phone or the replay log.
//
// A drawing is numbers and nothing else: strokes of [x, y] in a 600 by 400 box.

export const BOX = { width: 600, height: 400 };
export const LIMITS = { strokes: 40, points: 1200, onWall: 24, waiting: 300, gapSeconds: 2 };

/** A safe copy of a phone's strokes, or null if they are not a drawing. */
export function cleanStrokes(strokes) {
  if (!Array.isArray(strokes) || !strokes.length || strokes.length > LIMITS.strokes) return null;
  let total = 0;
  const out = [];
  for (const stroke of strokes) {
    if (!Array.isArray(stroke) || !stroke.length) return null;
    total += stroke.length;
    if (total > LIMITS.points) return null;
    const clean = [];
    for (const p of stroke) {
      if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
      clean.push([Math.max(0, Math.min(BOX.width, Math.round(p[0]))), Math.max(0, Math.min(BOX.height, Math.round(p[1])))]);
    }
    out.push(clean);
  }
  return out;
}

export class Gallery {
  constructor(slide, host) {
    this.slide = slide;
    this.host = host;
    this.next = 1;
    this.byPhone = new Map();   // phone id -> {waiting: drawing id or null, shown: [ids], last: seconds}
    this.owners = new Map();    // drawing id -> phone id
  }

  _phone(id) {
    let phone = this.byPhone.get(id);
    if (!phone) { phone = { waiting: null, shown: new Set(), said: null, last: -Infinity }; this.byPhone.set(id, phone); }
    return phone;
  }

  _waitingCount() {
    return this.host.state.review[this.slide.id]?.length ?? 0;
  }

  _publishCount() {
    this.host.emit({ t: 'gal-count', slide: this.slide.id, waiting: this._waitingCount() });
  }

  /** A phone sends a drawing. A newer one replaces the one still waiting. */
  submit(id, op) {
    const strokes = cleanStrokes(op.strokes);
    if (!strokes) return 'rejected';
    const phone = this._phone(id);
    const now = Date.now() / 1000;
    if (now - phone.last < LIMITS.gapSeconds) return 'too soon';
    if (!phone.waiting && this._waitingCount() >= LIMITS.waiting) return 'full';
    phone.last = now;
    if (phone.waiting) this.host.toPresenter({ t: 'gal-out', slide: this.slide.id, id: phone.waiting });
    const drawingId = `d${this.next++}`;
    this.owners.set(drawingId, id);
    phone.waiting = drawingId;
    phone.said = null;
    this.host.toPresenter({ t: 'gal-in', slide: this.slide.id, item: { id: drawingId, strokes } });
    this._publishCount();
    return 'ok';
  }

  review(op) {
    const slide = this.slide.id;
    const owner = this.host.state;
    if (op.t === 'gal-ok' || op.t === 'gal-no') {
      const item = owner.review[slide]?.find((k) => k.id === op.id);
      if (!item) return false;
      this.host.toPresenter({ t: 'gal-out', slide, id: op.id });
      const phone = this._phone(this.owners.get(op.id));
      phone.waiting = null;
      if (op.t === 'gal-ok') {
        phone.said = 'shown';
        phone.shown.add(op.id);
        const wall = owner.live[slide]?.shown ?? [];
        // The wall holds a fixed number. The oldest makes way, and its phone can tell.
        if (wall.length >= LIMITS.onWall) this.host.emit({ t: 'gal-pull', slide, id: wall[0].id });
        this.host.emit({ t: 'gal-show', slide, item });
      } else phone.said = 'declined';
      this._publishCount();
      return true;
    }
    if (op.t === 'gal-pull') {
      if (!owner.live[slide]?.shown?.some((k) => k.id === op.id)) return false;
      const phone = this._phone(this.owners.get(op.id));
      phone.shown.delete(op.id);
      phone.said = 'removed';
      this.host.emit({ t: 'gal-pull', slide, id: op.id, retract: true });
      return true;
    }
    return false;
  }

  you(id) {
    const phone = this._phone(id);
    const onWall = (this.host.state.live[this.slide.id]?.shown ?? []).filter((k) => this.owners.get(k.id) === id).length;
    return { waiting: Boolean(phone.waiting), said: phone.said, onWall };
  }
}
