// The tutor's op language and its validator. The model writes one JSON op per
// line. Each line passes through a Board here before the page sees it, so a bad
// line can only ever be dropped or corrected. Pure JavaScript with no DOM or Node
// imports, which lets tests run it directly.

export const COLS = 4;
export const ROWS = 4;

const TONES = new Set(['ink', 'blue', 'amber', 'green', 'rose', 'gray']);
const SOLID = new Set(['box', 'ellipse', 'diamond', 'note', 'cells']);
const KINDS = new Set([...SOLID, 'arrow', 'line', 'frame']);
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const CHILD = /^([A-Za-z0-9_-]{1,40})\.(\d{1,3})$/;

const LIMITS = { label: 48, arrowLabel: 36, note: 160, say: 280, title: 70, cell: 8, cells: 24, points: 60 };

const int = (v, fallback) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : fallback);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Cut text at a word boundary. */
function cap(value, limit) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= limit) return s;
  const cut = s.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return (space > limit * 0.5 ? cut.slice(0, space) : cut).trim();
}

const toneOf = (v, fallback) => (TONES.has(v) ? v : fallback);

export class Board {
  constructor() {
    this.items = new Map();
    this.pending = [];     // arrows that name an item not drawn yet
    this.title = null;
    this.log = [];         // accepted board ops, for rewinding to what the page applied
  }

  /** Validate one raw op. Returns {ops, notes}: normalized ops for the page and reasons for anything dropped. */
  apply(raw) {
    const out = { ops: [], notes: [] };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { out.notes.push('not an object'); return out; }
    const accept = (op) => {
      if (op.op === 'say') { out.ops.push(op); return; }
      const logged = { ...op, seq: this.log.length + 1 };
      this.log.push(logged);
      out.ops.push(logged);
    };
    switch (raw.op) {
      case 'say': {
        const text = cap(raw.text, LIMITS.say);
        if (text) accept({ op: 'say', text }); else out.notes.push('say without text');
        break;
      }
      case 'title': {
        const text = cap(raw.text, LIMITS.title);
        if (text) { this.title = text; accept({ op: 'title', text }); } else out.notes.push('title without text');
        break;
      }
      case 'draw': this._draw(raw, accept, out); break;
      case 'update': this._update(raw, accept, out); break;
      case 'remove': this._remove(raw, accept, out); break;
      case 'focus': {
        const ids = (Array.isArray(raw.ids) ? raw.ids : raw.id ? [raw.id] : []).filter((id) => this._exists(id));
        accept({ op: 'focus', ids });
        break;
      }
      case 'clear':
        this.items.clear();
        this.pending = [];
        this.title = null;
        accept({ op: 'clear' });
        break;
      default:
        out.notes.push(`unknown op ${JSON.stringify(raw.op)}`);
    }
    return out;
  }

  /** Drop arrows whose ends never appeared. Call at the end of a turn. */
  endTurn() {
    const notes = this.pending.map((p) => `arrow ${p.id} never had both ends`);
    this.pending = [];
    return notes;
  }

  /** Go back to the state after op number `seq`, when the page stopped before applying the rest. */
  rewind(seq) {
    if (!Number.isInteger(seq) || seq < 0 || seq >= this.log.length) return;
    const kept = this.log.slice(0, seq);
    this.items.clear();
    this.title = null;
    this.pending = [];
    this.log = kept;
    for (const op of kept) {
      if (op.op === 'title') this.title = op.text;
      else if (op.op === 'clear') { this.items.clear(); this.title = null; } else if (op.op === 'draw') this.items.set(op.item.id, structuredClone(op.item));
      else if (op.op === 'update') this._patch(op.id, op.patch);
      else if (op.op === 'remove') for (const id of op.ids) this.items.delete(id);
    }
  }

  /** The board as lines of text, for the model's next turn. */
  describe() {
    const lines = [];
    if (this.title) lines.push(`title: ${this.title}`);
    for (const it of this.items.values()) {
      if (it.kind === 'arrow') lines.push(`${it.id}: arrow ${it.from} -> ${it.to}${it.label ? ` "${it.label}"` : ''} tone ${it.tone}`);
      else if (it.kind === 'line') lines.push(`${it.id}: line`);
      else if (it.kind === 'cells') lines.push(`${it.id}: cells col ${it.col} row ${it.row} cols ${it.cols} values [${it.values.join(', ')}]`);
      else lines.push(`${it.id}: ${it.kind} "${it.label ?? it.text ?? ''}" col ${it.col} row ${it.row}${it.cols > 1 ? ` cols ${it.cols}` : ''}${it.rows > 1 ? ` rows ${it.rows}` : ''} tone ${it.tone}`);
    }
    const free = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (this._isFree(c, r, 1, 1)) free.push(`${c},${r}`);
    lines.push(`free cells (col,row): ${free.join(' ') || 'none'}`);
    return lines.join('\n');
  }

  _exists(id) {
    if (this.items.has(id)) return true;
    const child = CHILD.exec(String(id));
    return !!child && this.items.get(child[1])?.kind === 'cells' && +child[2] < this.items.get(child[1]).values.length;
  }

  _isFree(col, row, cols, rows, ignore) {
    if (col < 0 || row < 0 || col + cols > COLS || row + rows > ROWS) return false;
    for (const it of this.items.values()) {
      if (!SOLID.has(it.kind) || it.id === ignore) continue;
      if (col < it.col + it.cols && it.col < col + cols && row < it.row + it.rows && it.row < row + rows) return false;
    }
    return true;
  }

  /** The free region nearest the one asked for, or null when the board is full. */
  _place(col, row, cols, rows, ignore) {
    if (this._isFree(col, row, cols, rows, ignore)) return { col, row };
    let best = null;
    for (let r = 0; r <= ROWS - rows; r++) {
      for (let c = 0; c <= COLS - cols; c++) {
        if (!this._isFree(c, r, cols, rows, ignore)) continue;
        const d = Math.abs(c - col) + Math.abs(r - row);
        if (!best || d < best.d) best = { col: c, row: r, d };
      }
    }
    return best;
  }

  _draw(raw, accept, out) {
    const kind = raw.kind;
    if (!KINDS.has(kind)) { out.notes.push(`unknown kind ${JSON.stringify(kind)}`); return; }
    const id = String(raw.id ?? '');
    if (!ID.test(id)) { out.notes.push(`bad id ${JSON.stringify(raw.id)}`); return; }
    // Drawing an id again replaces it, the way the model usually means it.
    const replacing = this.items.get(id);

    let item;
    if (kind === 'arrow') {
      const from = String(raw.from ?? ''), to = String(raw.to ?? '');
      if (from === to) { out.notes.push(`arrow ${id} joins ${from} to itself`); return; }
      item = { id, kind, from, to, tone: toneOf(raw.tone, 'ink'), label: raw.label ? cap(raw.label, LIMITS.arrowLabel) : '', dashed: !!raw.dashed, both: !!raw.both };
      const at = Number(raw.row);
      if (Number.isFinite(at)) item.at = clamp(at, 0, ROWS - 1);
      if (!this._exists(from) || !this._exists(to)) {
        if (this.pending.length < 40) this.pending.push(item);
        else out.notes.push(`too many waiting arrows, dropped ${id}`);
        return;
      }
    } else if (kind === 'line') {
      const points = (Array.isArray(raw.points) ? raw.points : [])
        .filter((p) => Array.isArray(p) && Number.isFinite(+p[0]) && Number.isFinite(+p[1]))
        .slice(0, LIMITS.points)
        .map((p) => [clamp(+p[0], 0, COLS), clamp(+p[1], 0, ROWS)]);
      if (points.length < 2) { out.notes.push(`line ${id} needs two points`); return; }
      item = { id, kind, points, tone: toneOf(raw.tone, 'ink'), head: !!raw.head, curved: !!raw.curved, dashed: !!raw.dashed, label: raw.label ? cap(raw.label, LIMITS.arrowLabel) : '' };
    } else {
      const cols = clamp(int(raw.cols, kind === 'cells' ? COLS : 1), 1, COLS);
      const rows = clamp(int(raw.rows, 1), 1, ROWS);
      const wantCol = clamp(int(raw.col, 0), 0, COLS - cols);
      const wantRow = clamp(int(raw.row, 0), 0, ROWS - rows);
      item = { id, kind, cols, rows, col: wantCol, row: wantRow, tone: toneOf(raw.tone, kind === 'note' ? 'ink' : 'gray') };
      if (kind === 'note') {
        item.text = cap(raw.text ?? raw.label, LIMITS.note);
        if (!item.text) { out.notes.push(`note ${id} has no text`); return; }
      } else if (kind === 'cells') {
        const values = Array.isArray(raw.values) ? raw.values.slice(0, LIMITS.cells).map((v) => cap(v, LIMITS.cell)) : [];
        if (!values.length) { out.notes.push(`cells ${id} has no values`); return; }
        item.values = values;
        item.tones = {};
        if (raw.label) item.label = cap(raw.label, LIMITS.label);
      } else {
        item.label = cap(raw.label ?? raw.text ?? '', LIMITS.label);
        if (raw.dashed) item.dashed = true;
      }
      if (SOLID.has(kind)) {
        const spot = this._place(wantCol, wantRow, cols, rows, id);
        if (!spot) { out.notes.push(`no free cell for ${id}`); return; }
        if (spot.col !== wantCol || spot.row !== wantRow) out.notes.push(`moved ${id} from ${wantCol},${wantRow} to ${spot.col},${spot.row}`);
        item.col = spot.col;
        item.row = spot.row;
      }
    }
    if (replacing && replacing.kind !== item.kind) out.notes.push(`${id} changed from ${replacing.kind} to ${item.kind}`);
    this.items.set(id, item);
    accept({ op: 'draw', item: structuredClone(item) });

    // Any arrow that was waiting for this item can now be drawn.
    for (const waiting of [...this.pending]) {
      if (this._exists(waiting.from) && this._exists(waiting.to)) {
        this.pending = this.pending.filter((p) => p !== waiting);
        this.items.set(waiting.id, waiting);
        accept({ op: 'draw', item: structuredClone(waiting) });
      }
    }
  }

  _patch(id, patch) {
    const child = CHILD.exec(id);
    if (child && this.items.get(child[1])?.kind === 'cells') {
      const parent = this.items.get(child[1]);
      if (patch.tone) parent.tones[child[2]] = patch.tone;
      if (patch.label !== undefined) parent.values[+child[2]] = patch.label;
      return;
    }
    const it = this.items.get(id);
    if (it) Object.assign(it, patch);
  }

  _update(raw, accept, out) {
    const id = String(raw.id ?? '');
    if (!this._exists(id)) { out.notes.push(`update of missing ${id}`); return; }
    const patch = {};
    if (raw.tone !== undefined) {
      if (TONES.has(raw.tone)) patch.tone = raw.tone; else out.notes.push(`bad tone ${raw.tone}`);
    }
    const child = CHILD.exec(id);
    if (child && this.items.get(child[1])?.kind === 'cells') {
      const value = raw.label ?? raw.value ?? raw.text;
      if (value !== undefined) patch.label = cap(value, LIMITS.cell);
    } else {
      const it = this.items.get(id);
      if (raw.label !== undefined || (raw.text !== undefined && it.kind !== 'note')) patch.label = cap(raw.label ?? raw.text, it.kind === 'arrow' ? LIMITS.arrowLabel : LIMITS.label);
      if (raw.text !== undefined && it.kind === 'note') patch.text = cap(raw.text, LIMITS.note);
      if (raw.dashed !== undefined) patch.dashed = !!raw.dashed;
      if (SOLID.has(it.kind) && (raw.col !== undefined || raw.row !== undefined)) {
        const col = clamp(int(raw.col, it.col), 0, COLS - it.cols);
        const row = clamp(int(raw.row, it.row), 0, ROWS - it.rows);
        const spot = this._place(col, row, it.cols, it.rows, id);
        if (spot) { patch.col = spot.col; patch.row = spot.row; } else out.notes.push(`no free cell to move ${id}`);
      }
    }
    if (!Object.keys(patch).length) { out.notes.push(`update of ${id} changed nothing`); return; }
    this._patch(id, patch);
    accept({ op: 'update', id, patch });
  }

  _remove(raw, accept, out) {
    const asked = Array.isArray(raw.ids) ? raw.ids : [raw.id];
    const ids = new Set();
    for (const id of asked) {
      if (this.items.has(id)) ids.add(id); else out.notes.push(`remove of missing ${id}`);
    }
    if (!ids.size) return;
    // An arrow cannot outlive what it joins.
    for (const it of this.items.values()) {
      if (it.kind === 'arrow' && [it.from, it.to].some((end) => ids.has(end) || ids.has(end.split('.')[0]))) ids.add(it.id);
    }
    for (const id of ids) this.items.delete(id);
    accept({ op: 'remove', ids: [...ids] });
  }
}

/** Split a stream of text deltas into complete lines. */
export class Lines {
  constructor() { this.buffer = ''; }
  push(text) {
    this.buffer += text;
    const parts = this.buffer.split('\n');
    this.buffer = parts.pop();
    return parts;
  }
  flush() {
    const rest = this.buffer;
    this.buffer = '';
    return rest.trim() ? [rest] : [];
  }
}

/**
 * Turn one line of model output into raw ops. A code fence is ignored, two objects
 * on one line are separated, and a plain sentence counts as speech, since the model
 * meant to say it. Returns {ops, note}.
 */
export function parseLine(line) {
  const s = line.trim().replace(/,$/, '');
  if (!s || /^```/.test(s)) return { ops: [] };
  if (s.startsWith('{')) {
    try { return { ops: [JSON.parse(s)] }; } catch { /* maybe several objects */ }
    const pieces = s.split(/(?<=\})\s*(?=\{)/);
    if (pieces.length > 1) {
      const ops = [];
      for (const piece of pieces) { try { ops.push(JSON.parse(piece)); } catch { return { ops, note: `unparsable part: ${piece.slice(0, 80)}` }; } }
      return { ops };
    }
    return { ops: [], note: `unparsable line: ${s.slice(0, 80)}` };
  }
  if (/[A-Za-z]{2}/.test(s) && !/^[[\]{}"]/.test(s)) return { ops: [{ op: 'say', text: s }], note: 'plain text treated as speech' };
  return { ops: [], note: `ignored line: ${s.slice(0, 80)}` };
}
