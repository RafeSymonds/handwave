// Every word a dashboard drawing can use, in one table. The label parser, the inspector,
// the hints while typing, the palette and the reference all read this table, so none of
// them can disagree about what is allowed. This file has no DOM.
//
// A label is read one line at a time. A line is a word from this table, or a name.
// Anything that reaches data is a line like `source: query`, where the source is a name
// declared on the server. A drawing can't name a URL, and a line that tries gets a message.

import { distance } from '../machine/vocab.js';

const TIME_RE = '\\d+(?:\\.\\d+)?\\s*(?:ms|secs?|seconds?|s|mins?|minutes?|m|hrs?|hours?|h|days?|d)';
const NUM_RE = '[-+]?\\d+(?:\\.\\d+)?[kKMG]?';

export function parseTime(text) {
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(String(text).trim());
  if (!m) return NaN;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  if (u === 'ms') return n / 1000;
  if (u.startsWith('s')) return n;
  if (u.startsWith('m')) return n * 60;
  if (u.startsWith('h')) return n * 3600;
  if (u.startsWith('d')) return n * 86400;
  return NaN;
}

export function parseNumber(text) {
  const m = /^([-+]?\d+(?:\.\d+)?)([kKMG]?)$/.exec(String(text).trim());
  if (!m) return NaN;
  const scale = { k: 1e3, K: 1e3, M: 1e6, G: 1e9 }[m[2]] ?? 1;
  return Number(m[1]) * scale;
}

export const showTime = (seconds) => {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${+seconds.toFixed(1)}s`;
  if (seconds < 3600) return `${+(seconds / 60).toFixed(1)}m`;
  return `${+(seconds / 3600).toFixed(1)}h`;
};

// The rest of an alert line, after its first word.
const ALERT_TAIL = new RegExp(`^(?:(.+?)\\s+)?(above|over|below|under|>=|<=|>|<)\\s*(${NUM_RE})(%?)(?:\\s+for\\s+(${TIME_RE}))?\\s*$`, 'i');

function readAlert(level, rest) {
  const m = ALERT_TAIL.exec(rest);
  if (!m) return null;
  const op = /below|under|</i.test(m[2]) ? 'below' : 'above';
  return { level, op, value: parseNumber(m[3]), percent: !!m[4], for: m[5] ? parseTime(m[5]) : 0, metric: m[1]?.trim() ?? null };
}

// `re` must match a whole line. `read` turns its match into values.
export const WORDS = [
  // ------------------------------------------------------------ what a shape shows
  { id: 'box', group: 'panel', on: ['shape'], head: 'box', re: /^box$/i, read: () => ({ panel: 'box' }), example: 'box', means: 'Numbers and a status, for a service or a part of a system. This is what a shape with a source line and no other panel word becomes.', also: ['service', 'node', 'tile'] },
  { id: 'chart', group: 'panel', on: ['shape'], head: 'chart', re: /^chart(?:\s+(.+))?$/i, read: (m) => ({ panel: 'chart', pick: m[1]?.trim() ?? null }), example: 'chart', means: 'A line chart. It draws its own source lines, or what it is joined to by an arrow. chart errors picks one number from that shape. Different units get separate strips, never a second axis.', also: ['graph', 'plot', 'timeseries', 'lines', 'sparkline'] },
  { id: 'stat', group: 'panel', on: ['shape'], head: 'stat', re: /^stat$/i, read: () => ({ panel: 'stat' }), example: 'stat', means: 'One big number and its recent trend.', also: ['number', 'singlestat', 'kpi', 'big'] },
  { id: 'meter', group: 'panel', on: ['shape'], head: 'meter', re: /^meter(?:\s+(NUM)\s+to\s+(NUM))?$/i, reSource: true, read: (m) => ({ panel: 'meter', range: m[1] === undefined ? null : [parseNumber(m[1]), parseNumber(m[2])] }), example: 'meter 0 to 100', means: 'A value against its limits. Its warn and critical levels are marked on the bar. With no numbers it uses the metric\'s own limits, if it has any.', also: ['gauge', 'bar', 'progress'] },
  { id: 'table', group: 'panel', on: ['shape'], head: 'table', re: /^table$/i, read: () => ({ panel: 'table' }), example: 'table', means: 'One row per number. A Prometheus query that returns many series gets a row for each, from an instant query.', also: ['list', 'rows'] },
  { id: 'alerts', group: 'panel', on: ['shape'], head: 'alerts', re: /^alerts$/i, read: () => ({ panel: 'alerts' }), example: 'alerts', means: 'What is firing on this drawing, then what changed most recently. It needs no source line.', also: ['alert', 'firing', 'status', 'overview', 'incidents'] },

  // ------------------------------------------------------------ alerts
  { id: 'warn', group: 'alert', on: ['shape', 'arrow'], head: 'warn', re: /^(?:warn|warning)\s+(.+)$/i, read: (m) => readAlert('warn', m[1]), example: 'warn above 80 for 2m', means: 'Warn when the number above this line stays past this level for this long. Use above or below, and leave out "for" to warn at once. warn errors above 1 names which number.', also: ['warning', 'threshold', 'alarm', 'alert'] },
  { id: 'critical', group: 'alert', on: ['shape', 'arrow'], head: 'critical', re: /^(?:critical|crit)\s+(.+)$/i, read: (m) => readAlert('critical', m[1]), example: 'critical above 95 for 30s', means: 'The same, for when someone should act now.', also: ['crit', 'error', 'page', 'severe', 'danger'] },

  // ------------------------------------------------------------ settings
  { id: 'axis', group: 'setting', on: ['shape'], head: 'axis', re: /^axis\s+(NUM)\s+to\s+(NUM)$/i, reSource: true, read: (m) => ({ axis: [parseNumber(m[1]), parseNumber(m[2])] }), example: 'axis 0 to 100', means: 'Fixes a chart\'s vertical axis. Without it the axis fits the data and starts at zero unless the data is far from zero.', also: ['range', 'scale', 'ymax', 'ylim'] },
  { id: 'stale', group: 'setting', on: ['shape', 'arrow'], head: 'stale', re: /^stale\s+after\s+(TIME)$/i, reSource: true, read: (m) => ({ stale: parseTime(m[1]) }), example: 'stale after 30s', means: 'How long a number can go without an update before this shape says "no data". The default is three times how often the source updates.', also: ['timeout', 'ttl'] },
  { id: 'every', group: 'setting', on: ['shape', 'arrow'], head: 'every', re: /^every\s+(TIME)$/i, reSource: true, read: (m) => ({ every: parseTime(m[1]) }), example: 'every 5s', means: 'How often to ask for new data. The default comes from the source.', also: ['interval', 'refresh', 'poll'] },
  { id: 'flow', group: 'setting', on: ['arrow'], head: 'flow', re: /^flow$/i, read: () => ({ flow: true }), example: 'flow', means: 'Dots travel along this arrow, and their speed is its number: twice the rate moves twice as fast. One dot stands for the same amount on every arrow, and the board says how much. No data stops them.', also: ['animate', 'dots', 'traffic', 'moving'] },
  { id: 'name', group: 'setting', on: ['shape', 'arrow'], free: true, head: '', example: 'checkout api', means: 'Any other line is a name. The first one is the title, and the rest do nothing.' },

  // ------------------------------------------------------------ data. Tried last, because a query can hold almost anything.
  { id: 'binding', group: 'data', on: ['shape', 'arrow'], head: 'source:', example: 'machine: cpu', means: 'Shows a number from a source. The source is a name, not an address. Sources are built in or declared in .sources.json on this machine.' },
  { id: 'named', group: 'data', on: ['shape', 'arrow'], head: 'name =', example: 'busy = machine: cpu', means: 'The same, with your own name for the number.' },
  { id: 'unit', group: 'data', on: ['shape', 'arrow'], head: 'in', example: 'demo: api.rate in req/s', means: 'Says what the number is measured in, for sources that don\'t say. bytes, bytes/s, ms and s change scale by themselves.' },
];

const fill = (re) => new RegExp(re.source.replaceAll('NUM', NUM_RE).replaceAll('TIME', TIME_RE), re.flags);
for (const word of WORDS) if (word.reSource) word.re = fill(word.re);

const BINDING = /^(?:([^=:{}"\n]+?)\s*=\s*)?([A-Za-z][\w-]*)\s*:\s*(.+?)(?:\s+in\s+(\S+))?\s*$/;

export const BY_ID = new Map(WORDS.map((w) => [w.id, w]));

export const URL_MESSAGE = 'A drawing can\'t name an address, because a shared file could then read your internal services. Declare it as a source in .sources.json on this machine, then write the source\'s name here.';

// An address, outside any quoted text. Quoted text in a query is only compared, by the
// source, with its own data: up{instance="http://a:9100"} fetches nothing.
function namesAddress(line) {
  const bare = line.replace(/"[^"]*"|'[^']*'/g, '""');
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(bare)) return true;
  if (/^(www\.|localhost\b|\d+\.\d+\.\d+\.\d+)/i.test(bare)) return true;
  return /^[\w.-]+:\d+(\/|$)/.test(bare);
}

// Letters swapped count as one slip, so chrat is close to chart.
function slipsFrom(a, b) {
  for (let i = 0; i + 1 < a.length; i++) {
    if (a.length === b.length && a[i] !== b[i] && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(0, i) === b.slice(0, i) && a.slice(i + 2) === b.slice(i + 2)) return 1;
  }
  return distance(a, b);
}

// Close to a word, but not a word itself: cart is a name and so are charts, while chrat is a slip.
const near = (a, b) => a !== b && a !== `${b}s` && a[0] === b[0] && a.length >= 5 && slipsFrom(a, b) <= (Math.max(a.length, b.length) >= 6 ? 2 : 1);

function closest(word, names) {
  let best = null, bestDistance = 3;
  for (const name of names) {
    const d = slipsFrom(word.toLowerCase(), name.toLowerCase());
    if (d < bestDistance && d <= Math.max(1, Math.floor(Math.max(word.length, name.length) / 3))) { bestDistance = d; best = name; }
  }
  return best;
}

/**
 * Read one label. `catalog` maps source names to {metrics: Map(id -> {name, unit, axis}),
 * closed}. With no catalog yet, nothing can be said about names. Returns what it understood
 * line by line, and what looks wrong: {line, text, message, level, fix: {from, to}}.
 */
export function readLabel(label = '', place = 'shape', catalog = null) {
  const out = { title: null, names: [], panel: null, pick: null, range: null, axis: null, stale: null, every: null, flow: false, bindings: [], alerts: [], understood: [], problems: [] };
  const lines = String(label).split('\n');
  const onHere = (word) => word.on.includes(place);
  const problem = (line, text, message, level = 'error', fix = null) => out.problems.push({ line, text, message, level, fix });

  lines.forEach((raw, lineNo) => {
    const text = raw.trim();
    if (!text) return;

    if (namesAddress(text)) {
      problem(lineNo, text, URL_MESSAGE, 'error');
      return;
    }

    for (const word of WORDS) {
      if (!word.re) continue;
      const m = word.re.exec(text);
      if (!m) continue;
      if (!onHere(word)) {
        problem(lineNo, text, `"${word.head}" goes on ${word.on[0] === 'arrow' ? 'an arrow' : 'a shape'}, not ${place === 'arrow' ? 'an arrow' : 'a shape'}.`);
        return;
      }
      const values = word.read(m);
      if (!values) {
        problem(lineNo, text, `I can't read "${text}". Try something like "${word.example}".`);
        return;
      }
      if (word.group === 'alert') {
        out.alerts.push({ ...values, line: lineNo, text, binding: null });
        out.understood.push({ word, text, line: lineNo });
      } else {
        Object.assign(out, values);
        out.understood.push({ word, text, line: lineNo });
      }
      return;
    }

    const bound = BINDING.exec(text);
    if (bound && !/^\d/.test(bound[3])) {
      const source = bound[2];
      const known = catalog?.get(source);
      if (catalog && !known) {
        const guess = closest(source, [...catalog.keys()]);
        // Still a binding: a file shared with you names sources you may not have declared yet.
        const message = guess ? `There is no source named "${source}". Did you mean "${guess}"?` : `There is no source named "${source}". The sources here are ${[...catalog.keys()].join(', ')}. To add one, declare it in .sources.json. If this line is only a note, put it outside the shape.`;
        problem(lineNo, text, message, guess ? 'error' : 'note', guess ? { from: source, to: guess } : null);
      }
      const query = bound[3].trim();
      const metric = known?.metrics?.get(query);
      if (known?.closed && !metric) {
        const guess = closest(query, [...known.metrics.keys()]);
        problem(lineNo, text, guess ? `${source} has no metric "${query}". Did you mean "${guess}"?` : `${source} has no metric "${query}". It has ${[...known.metrics.keys()].join(', ')}.`, 'error', guess ? { from: query, to: guess } : null);
      }
      out.bindings.push({
        source, query, line: lineNo, text,
        givenName: bound[1]?.trim() ?? null,
        name: bound[1]?.trim() ?? metric?.name ?? shortName(query),
        unit: bound[4] ?? metric?.unit ?? '',
        hasUnit: !!(bound[4] ?? metric?.unit),
        axis: metric?.axis ?? null,
        help: metric?.help ?? null,
      });
      const id = bound[1] ? 'named' : bound[4] ? 'unit' : 'binding';
      out.understood.push({ word: BY_ID.get(id), text, line: lineNo });
      return;
    }

    // The right word, written in a way the table can't read.
    const first = text.split(/\s+/)[0].toLowerCase();
    const rest = text.slice(first.length).trim();
    const exact = WORDS.find((w) => w.re && w.head === first);
    if (exact && onHere(exact)) {
      problem(lineNo, text, `I can't read "${text}". Try something like "${exact.example}".`);
      return;
    }

    // A slip of the fingers, or another tool's word for the same thing.
    const pool = WORDS.filter((w) => w.re && onHere(w));
    const slip = pool.find((w) => near(first, w.head));
    if (slip && (rest ? slip.re.test(`${slip.head} ${rest}`) : slip.re.test(slip.head))) {
      problem(lineNo, text, `"${first}"? Did you mean "${slip.head}"?`, 'error', { from: text.split(/\s+/)[0], to: slip.head });
      return;
    }
    const synonym = pool.find((w) => (w.also ?? []).includes(first));
    if (synonym && (rest ? synonym.re.test(`${synonym.head} ${rest}`) : synonym.group === 'panel' && !out.title && lines.some((l, i) => i !== lineNo && BINDING.test(l.trim())))) {
      problem(lineNo, text, `Here that is "${synonym.head}". Did you mean "${synonym.head}${rest ? ` ${rest}` : ''}"?`, 'note', { from: text.split(/\s+/)[0], to: synonym.head });
    }

    if (!out.title) out.title = text; else out.names.push(text);
    out.understood.push({ word: BY_ID.get('name'), text, line: lineNo });
  });

  // An alert watches the number above it, or the one it names.
  for (const alert of out.alerts) {
    let index = -1;
    if (alert.metric) {
      index = out.bindings.findIndex((b) => b.name.toLowerCase() === alert.metric.toLowerCase() || b.query.toLowerCase() === alert.metric.toLowerCase());
      if (index < 0) problem(alert.line, alert.text, `No number here is called "${alert.metric}". Numbers here: ${out.bindings.map((b) => b.name).join(', ') || 'none yet'}.`);
    } else {
      for (let i = 0; i < out.bindings.length; i++) if (out.bindings[i].line < alert.line) index = i;
      if (index < 0) index = out.bindings.length ? 0 : -1;
      if (index < 0 && place !== 'chart') problem(alert.line, alert.text, `"${alert.text}" has nothing to watch. Add a line such as "machine: cpu" above it.`);
    }
    alert.binding = index >= 0 ? index : null;
    const bound = out.bindings[index];
    if (alert.percent && bound?.hasUnit && bound.unit !== '%') problem(alert.line, alert.text, `${bound.name} is measured in ${bound.unit}, so this % is read as ${alert.value} ${bound.unit}.`, 'note');
  }

  return out;
}

const shortName = (query) => {
  if (query.length <= 22) return query;
  const named = /[A-Za-z_:][\w:]*(?=\s*[{[])/.exec(query)?.[0] ?? /[A-Za-z_:][\w:]*_[\w:]*/.exec(query)?.[0];
  return named ?? `${query.slice(0, 20)}...`;
};

/** Hints while typing: what can come next on this line, given what is before the caret. */
export function suggest(before, place, catalog) {
  const line = before.slice(before.lastIndexOf('\n') + 1).trimStart();
  const named = /^(?:[^=:{}"]+?\s*=\s*)?([A-Za-z][\w-]*)\s*:\s*(\S*)$/.exec(line);
  if (named && catalog?.has(named[1])) {
    const source = catalog.get(named[1]);
    const prefix = named[2].toLowerCase();
    return [...source.metrics.values()]
      .filter((m) => m.id.toLowerCase().startsWith(prefix))
      .map((m) => ({ kind: 'metric', insert: m.id, replace: prefix.length, shown: m.id, means: `${m.name}${m.unit ? `, in ${m.unit}` : ''}` }));
  }
  if (line.includes(' ') || line.includes(':')) return [];
  const prefix = line.toLowerCase();
  const sources = catalog ? [...catalog.values()].filter((s) => s.name.toLowerCase().startsWith(prefix)).map((s) => ({ kind: 'source', insert: `${s.name}: `, replace: prefix.length, shown: `${s.name}:`, means: s.says ?? `A source of type ${s.type}.` })) : [];
  const words = WORDS.filter((w) => w.re && w.on.includes(place) && (w.head.startsWith(prefix) || (w.also ?? []).some((a) => a.startsWith(prefix) && prefix))).map((w) => ({ kind: 'word', insert: w.example, replace: prefix.length, shown: w.example, means: w.means }));
  return [...sources, ...words];
}

// Parts to drag on. `label` is what the shape starts with, which the tests read back as
// the kind it claims to be. `w` and `h` are stage units.
export const PARTS = [
  { id: 'box', short: 'box', type: 'rectangle', label: 'a service\nmachine: cpu', tone: 'gray', w: 300, h: 120, kind: 'box', says: 'Numbers and a status. Add a line per number.' },
  { id: 'chart', short: 'chart', type: 'rectangle', label: 'chart\nmachine: cpu', tone: 'none', w: 460, h: 240, kind: 'chart', says: 'A line chart with real axes.' },
  { id: 'stat', short: 'stat', type: 'rectangle', label: 'stat\nmachine: memory', tone: 'none', w: 240, h: 150, kind: 'stat', says: 'One big number and its trend.' },
  { id: 'meter', short: 'meter', type: 'rectangle', label: 'meter\nmachine: disk\nwarn above 90', tone: 'none', w: 320, h: 110, kind: 'meter', says: 'One value against its limits.' },
  { id: 'table', short: 'table', type: 'rectangle', label: 'table\nmachine: cpu\nmachine: memory\nmachine: load', tone: 'none', w: 320, h: 170, kind: 'table', says: 'One row per number.' },
  { id: 'alerts', short: 'alerts', type: 'rectangle', label: 'alerts', tone: 'none', w: 380, h: 220, kind: 'alerts', says: 'What is firing on this drawing, and what changed.' },
  { id: 'grid', short: 'grid of charts', type: 'grid', tone: 'none', w: 940, h: 500, kind: 'grid', says: 'Four charts in two rows, lined up. Drag any of them to rearrange, and they snap to a grid.' },
  { id: 'note', short: 'note', type: 'text', label: 'a note', tone: 'none', w: 120, h: 40, kind: 'note', says: 'Text outside a shape does nothing. Use it to explain the drawing.' },
];

export const PANEL_NAMES = {
  box: { name: 'box', phrase: 'a box', says: 'Shows its numbers and its status.', why: 'it has a source line and no other panel word' },
  chart: { name: 'chart', phrase: 'a chart', says: 'Draws a line for each number. Lines are exact: no smoothing, and a gap stays a gap.', why: 'it has the word chart' },
  stat: { name: 'stat', phrase: 'a stat', says: 'Shows one big number and its recent trend.', why: 'it has the word stat' },
  meter: { name: 'meter', phrase: 'a meter', says: 'Shows one value against its limits.', why: 'it has the word meter' },
  table: { name: 'table', phrase: 'a table', says: 'Shows one row per number.', why: 'it has the word table' },
  alerts: { name: 'alerts', phrase: 'an alerts panel', says: 'Shows what is firing on this drawing and what changed.', why: 'it has the word alerts' },
  plain: { name: 'just a shape', phrase: 'just a shape', says: 'It has no source line, so it is only part of the drawing.', why: 'nothing in its label reaches data' },
};
