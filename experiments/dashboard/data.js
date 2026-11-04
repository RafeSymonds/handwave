// The page's side of the data: what to ask the server for, what came back, and what each
// shape should say at a given moment. The server is asked in one request per second at
// most, and each query only for what it has not got.
//
// Two lanes hold points. `series` covers the range on screen. While the view is paused,
// `tail` keeps following now, so looking at last night cannot hide what is firing today. It
// starts as a copy of `series`, so going back changes nothing about what is known of now, and
// its points join `series` on the way back to live, for the same reason.

import { LEVELS, levelOf, replay, stateAt, worse } from './alerts.js';
import { fmtAgo, showLevel, showValue, stepFor } from './format.js';
import { allRules } from './read.js';
import { Series } from './series.js';

const TAIL_SECONDS = 180;
const DEFAULT_EVERY = 5;

// A name for one series of a query, from the labels that differ between its series.
function seriesId(row) {
  const keys = Object.keys(row.labels ?? {}).filter((k) => k !== '__name__').sort();
  return keys.length ? keys.map((k) => `${k}=${row.labels[k]}`).join(',') : row.name || '';
}

// One series' own labels, for a row that has no other series to differ from. Only their values,
// as the keys take the room and a name only has to say which one this is.
function labelWords(series) {
  return Object.keys(series.labels ?? {}).filter((k) => k !== '__name__').map((k) => series.labels[k]).join(' ');
}

// Only the values that differ, as `upgrader no-energy`, in the order the query groups them by.
function shortNames(list, fallback, query = '') {
  if (list.length === 1) return [fallback];
  const keys = [...new Set(list.flatMap((s) => Object.keys(s.labels)))].filter((k) => k !== '__name__');
  const said = /\bby\s*\(([^)]*)\)/.exec(query)?.[1].split(',').map((k) => k.trim()) ?? [];
  const place = (k) => (said.includes(k) ? said.indexOf(k) : said.length);
  const differ = keys.filter((k) => new Set(list.map((s) => s.labels[k])).size > 1).sort((a, b) => place(a) - place(b));
  return list.map((s) => differ.map((k) => s.labels[k]).filter(Boolean).join(' ') || s.name || fallback);
}

// A rule covers the series that exist. One that stops while others carry on has ended, as a room's
// does after a world reset, so it drops out. This says when the rule as a whole had nothing at all
// to judge: the moments the count of series with data reached zero, and left it.
function coverage(list) {
  const events = [];
  for (const { result } of list) {
    for (const tr of result.transitions) {
      const had = tr.from !== 'nodata', has = tr.to !== 'nodata';
      if (had !== has) events.push({ t: tr.t, up: has });
    }
  }
  // One series ending as another starts is not a gap.
  events.sort((a, b) => a.t - b.t || b.up - a.up);
  const changes = [];
  let count = 0;
  for (const { t, up } of events) {
    count += up ? 1 : -1;
    if (up && count === 1) changes.push({ t, to: 'ok' });
    if (!up && count === 0) changes.push({ t, to: 'nodata' });
  }
  return changes;
}

// "api errors", not "api errors: errors".
export function nameOf(owner, binding) {
  const title = owner.title || '';
  if (!title) return binding.name;
  return title.toLowerCase().includes(binding.name.toLowerCase()) ? title : `${title} ${binding.name}`;
}

// Words for the changes worth a line in a list. A level crossed and uncrossed in less than
// its "for" is on the chart's strip, and is not news.
function changeWords(tr, name) {
  if (tr.to === 'firing') return { words: `${name}: ${tr.rule.level}`, level: tr.rule.level };
  if (tr.from === 'firing' && tr.to === 'ok') return { words: `${name}: ${tr.rule.level} ended`, level: 'ok' };
  if (tr.from === 'firing' && tr.to === 'nodata') return { words: `${name}: no data, so ${tr.rule.level} can't say`, level: 'nodata' };
  if (tr.from === 'ok' && tr.to === 'nodata') return { words: `${name}: no data`, level: 'nodata' };
  if (tr.from === 'nodata' && tr.to === 'ok') return { words: `${name}: data is back`, level: 'ok' };
  return null;
}

/**
 * What is firing, one line per number. A critical includes its warn. Worst first, then
 * oldest first, because the first thing to fire is usually nearest the cause.
 */
export function worstOfEach(list) {
  const best = new Map();
  for (const entry of list) {
    const key = `${entry.binding.key}|${entry.series ?? ''}`;
    const held = best.get(key);
    if (!held || (entry.rule.level === 'critical' && held.rule.level !== 'critical')) best.set(key, entry);
  }
  return [...best.values()].sort((a, b) => (a.rule.level === b.rule.level ? (a.since ?? 0) - (b.since ?? 0) : a.rule.level === 'critical' ? -1 : 1));
}

export function createData(m) {
  const states = new Map();
  const results = new Map();     // rule id -> [{series, id, result}]
  const tailResults = new Map();
  let requestInFlight = false;
  let lastRecompute = 0;

  const rangeKey = (binding) => `range\u0000${binding.key}`;
  const instantKey = (binding) => `instant\u0000${binding.key}`;

  function stateFor(binding, panelKind) {
    return states.get(panelKind === 'table' ? instantKey(binding) : rangeKey(binding)) ?? states.get(rangeKey(binding)) ?? states.get(instantKey(binding));
  }

  const everyOf = (q) => q.every ?? m.catalog.get(q.source)?.every ?? DEFAULT_EVERY;

  function ensure(q) {
    let st = states.get(q.key);
    if (!st) {
      st = { ...q, series: new Map(), tail: new Map(), order: [], interval: everyOf(q), ok: null, why: null, nextAt: 0, inflight: false, loaded: null, okAt: null, lastPointAt: null };
      states.set(q.key, st);
    }
    Object.assign(st, { every: q.every, rules: q.rules });
    return st;
  }

  /** Forget everything, for a new drawing. */
  function reset() {
    states.clear();
    results.clear();
    tailResults.clear();
    m.transitions = [];
    m.firingNow = [];
    m.flowScale = new Map();
  }

  const stepOf = (st, span) => stepFor(span, Math.max(1, everyOf(st)));

  // ---------------------------------------------------------------- asking

  function requests() {
    const now = m.now();
    const { t0, t1 } = m.range();
    const span = t1 - t0;
    const out = [];
    for (const q of m.dash.queries.values()) {
      const st = ensure(q);
      if (st.inflight) continue;
      if (st.instant) {
        const time = m.time.at ?? (m.time.live ? null : t1);
        if (now < st.nextAt && st.loadedTime === time) continue;
        out.push({ st, kind: 'instant', time, query: { source: st.source, query: st.query, instant: true, ...(time === null ? {} : { time }) } });
        continue;
      }
      const step = stepOf(st, span);
      const margin = st.rules + step * 3;
      const start = t0 - margin;
      const loaded = st.loaded;
      const fine = Math.max(1, everyOf(st));
      // On a long range the points are far apart, so the newest could be many minutes old while
      // the shape reads as current. The last few points then come at the source's own pace. A step
      // under twice the pace is only the pace rounded up to a step that stays aligned.
      const askEdge = () => { if (m.time.live && step >= fine * 2) out.push({ st, kind: 'edge', query: { source: st.source, query: st.query, start: now - fine * 4, end: now, step: fine } }); };
      const askTail = () => {
        const from = now - Math.max(TAIL_SECONDS, st.rules + fine * 4);
        out.push({ st, kind: 'tail', start: from, query: { source: st.source, query: st.query, start: from, end: now, step: fine } });
      };
      const stale = !loaded || loaded.step !== step || start < loaded.start - step || (!m.time.live && t1 > loaded.end + step) || (m.time.live && loaded.end < start);
      if (stale) {
        // A range that failed to load is asked for again, at the pace of the source.
        if (st.viewFailed && now < st.nextAt) continue;
        out.push({ st, kind: 'view', step, start, query: { source: st.source, query: st.query, start, end: t1, step } });
        askEdge();
        // Arriving here paused, as switching tabs can: nothing is known about now, so ask straight away.
        if (!m.time.live && !st.following) askTail();
      } else if (m.time.live && now >= st.nextAt) {
        const from = Math.max(start, loaded.end - step * 2);
        out.push({ st, kind: 'tailOfView', step, start: from, query: { source: st.source, query: st.query, start: from, end: now, step } });
        askEdge();
      } else if (!m.time.live && now >= st.nextAt) {
        askTail();
      }
    }
    return out;
  }

  async function poll() {
    if (requestInFlight || !m.dash) return;
    const asks = requests();
    if (!asks.length) return;
    requestInFlight = true;
    for (const ask of asks) ask.st.inflight = true;
    const sentFor = m.loadCount;
    try {
      const res = await fetch('/dashboard/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queries: asks.map((a) => a.query) }) });
      if (res.status === 403) throw Object.assign(new Error(await res.text()), { refused: true });
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      const body = await res.json();
      m.time.offset = body.now - Date.now() / 1000;
      if (m.link && !m.link.ok) m.link = { ok: true, at: body.now };
      m.link = { ok: true, at: body.now };
      if (sentFor === m.loadCount) {
        body.results.forEach((result, i) => ingest(asks[i], result));
        recompute();
        m.onData?.();
      }
    } catch (err) {
      const was = m.link;
      m.link = { ok: false, why: err.refused ? err.message : 'the handwave server is not answering', refused: !!err.refused, since: was?.ok === false ? was.since : m.now(), at: was?.at ?? null };
      recompute();
      m.onData?.();
    } finally {
      requestInFlight = false;
      for (const ask of asks) ask.st.inflight = false;
    }
  }

  function ingest(ask, result) {
    const { st } = ask;
    const now = m.now();
    st.ok = result.ok;
    st.why = result.why ?? null;
    st.queryProblem = !!result.queryProblem;
    st.unknownSource = !!result.unknownSource;
    st.warning = result.warning ?? null;
    st.empty = result.empty ?? null;
    st.dropped = result.dropped ?? 0;
    if (result.ok) st.okAt = now;
    // A chart judges gaps by the spacing of its own points, whatever the tail is asking for.
    if (result.interval) { if (ask.kind === 'tail') st.tailInterval = result.interval; else if (ask.kind === 'edge') st.edgeInterval = result.interval; else st.interval = result.interval; }
    st.nextAt = now + Math.max(0.2, result.ok ? everyOf(st) : Math.max(everyOf(st), 2));

    // A failed answer replaces nothing: what was there stays, and staleness says how old it is.
    if (ask.kind === 'instant') {
      if (result.ok || st.loadedTime !== ask.time) {
        st.series = new Map();
        st.order = [];
      }
      st.loadedTime = ask.time;
    }
    if (ask.kind === 'view') {
      st.viewFailed = !result.ok;
      if (result.ok) {
        st.series = new Map();
        st.order = [];
        st.edgeInterval = null;
      }
    }
    const lane = ask.kind === 'tail' ? st.tail : st.series;
    for (const row of result.series ?? []) {
      const id = seriesId(row);
      let s = lane.get(id);
      if (!s) {
        s = new Series(row.name, row.labels ?? {});
        lane.set(id, s);
        if (lane === st.series) st.order.push(id);
      }
      s.merge(row.t, row.v, ask.kind === 'instant' ? undefined : ask.start);
      const newest = s.latest();
      if (newest && (st.lastPointAt === null || newest.t > st.lastPointAt)) st.lastPointAt = newest.t;
    }
    if (ask.kind === 'view' && result.ok) st.loaded = { start: ask.start, end: Math.max(ask.query.end, ask.start), step: ask.step };
    // Only a good answer moves this on. After a failure the next ask covers what was missed,
    // so a dropped connection to a source that kept its data leaves no hole.
    if (ask.kind === 'tailOfView' && result.ok) {
      st.loaded.end = ask.query.end;
      const keep = m.range().t0 - st.rules - (st.loaded.step ?? 1) * 3;
      if (keep > st.loaded.start) {
        for (const s of st.series.values()) s.trim(keep);
        st.loaded.start = keep;
      }
    }
    m.dataVersion = (m.dataVersion ?? 0) + 1;
  }

  // ---------------------------------------------------------------- how old is too old

  const gapFor = (interval) => Math.max(3 * (interval ?? DEFAULT_EVERY), 1.5);
  const gapAfterOf = (st) => gapFor(st.interval);
  const freshGapOf = (st) => gapFor(m.time.live && st.edgeInterval ? st.edgeInterval : st.interval);
  const staleFor = (interval, binding) => binding?.stale ?? Math.max(3 * (interval ?? DEFAULT_EVERY), 5);
  // A long range is drawn from points far apart, but what is true now comes from `edge` when it can.
  const staleAfterOf = (st, binding) => staleFor(m.time.live && st.edgeInterval ? st.edgeInterval : st.interval, binding);

  // ---------------------------------------------------------------- the two lanes

  const copySeries = (from) => {
    const copy = new Series(from.name, from.labels);
    if (from.n) copy.merge(Array.from(from.t.subarray(0, from.n)), Array.from(from.v.subarray(0, from.n)));
    return copy;
  };

  // Leaving live. What is known about now is exactly what the page knew a moment ago, and the
  // whole history stays, because it says how long something has been firing.
  function startTail(st) {
    const asked = st.tail;
    st.tail = new Map([...st.series].map(([id, series]) => [id, copySeries(series)]));
    for (const [id, newer] of asked) {
      const held = st.tail.get(id);
      if (!held) st.tail.set(id, newer);
      else if (newer.n) held.merge(Array.from(newer.t.subarray(0, newer.n)), Array.from(newer.v.subarray(0, newer.n)));
    }
    st.seedInterval = st.interval;
    if (!asked.size) st.tailInterval = st.interval;
    st.following = true;
    st.nextAt = 0;
  }

  // Back to live. The range on screen may have stopped long ago, and the tail has what is newer.
  // The next answer replaces these with points at the range's own spacing.
  function endTail(st) {
    for (const [id, tail] of st.tail) {
      let view = st.series.get(id);
      if (!view) {
        view = new Series(tail.name, tail.labels);
        st.series.set(id, view);
        st.order.push(id);
      }
      const newest = view.n ? view.t[view.n - 1] : -Infinity;
      const times = [], values = [];
      for (let i = 0; i < tail.n; i++) if (tail.t[i] > newest) { times.push(tail.t[i]); values.push(tail.v[i]); }
      if (times.length) view.merge(times, values);
    }
    st.tail = new Map();
    st.following = false;
    st.nextAt = 0;
  }

  function followLanes() {
    for (const st of states.values()) {
      if (st.instant) continue;
      if (!m.time.live && !st.following) startTail(st);
      else if (m.time.live && st.following) endTail(st);
    }
  }

  // ---------------------------------------------------------------- alert states

  function recompute() {
    if (!m.dash) return;
    followLanes();
    lastRecompute = m.now();
    const now = m.now();
    const before = new Map(m.firingNow?.map((f) => [f.key, f]) ?? []);
    const transitions = [];
    const firing = [];
    const pending = [];
    const silent = [];
    const seen = new Set();
    let total = 0;
    const walk = (rule, binding, owner, lane, store) => {
      const st = states.get(rangeKey(binding)) ?? states.get(instantKey(binding));
      const out = [];
      if (st && lane === 'tail') {
        // Its history can be more widely spaced than what it is asked for now. Going quiet is
        // judged by how often it updates now.
        const gapAfter = Math.max(gapFor(st.seedInterval), gapFor(st.tailInterval));
        const staleAfter = staleFor(st.tailInterval, binding);
        for (const [id, series] of st.tail) out.push({ id, series, result: replay(rule, series, { gapAfter, staleAfter, until: now }) });
      } else if (st) {
        // The range on screen ends where it ends. Nothing past it was asked for, so paused, its
        // end is not the data stopping.
        const until = m.time.live ? now : Math.min(now, m.range().t1);
        for (const [id, series] of st.series) out.push({ id, series, result: replay(rule, series, { gapAfter: gapAfterOf(st), staleAfter: staleAfterOf(st, binding), until }) });
      }
      store.set(rule.id, out);
      return out;
    };
    for (const { rule, binding, owner } of allRules(m.dash)) {
      const view = walk(rule, binding, owner, 'series', results);
      const nowLane = m.time.live ? view : walk(rule, binding, owner, 'tail', tailResults);
      // The same rule on a box and on its chart is one rule to the lists.
      const sig = `${binding.key}|${rule.level}|${rule.op}|${rule.value}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      total++;
      const name = nameOf(owner, binding);
      const several = view.length > 1;
      for (const { id, result } of view) {
        for (const tr of result.transitions) {
          if (tr.from === 'nodata' && tr === result.transitions[0]) continue;
          // Among several, one series coming and going is not news. Below is when all of them did.
          if (several && ((tr.from === 'ok' && tr.to === 'nodata') || (tr.from === 'nodata' && tr.to === 'ok'))) continue;
          const words = changeWords(tr, name);
          if (words) transitions.push({ ...tr, ...words, name, owner: owner.id, binding, series: id, key: `${rule.id}|${id}` });
        }
      }
      if (several) {
        coverage(view).forEach(({ t, to }, i) => {
          if (i === 0 && to === 'ok') return;
          const tr = { t, from: to === 'ok' ? 'nodata' : 'ok', to, rule };
          transitions.push({ ...tr, ...changeWords(tr, name), name, owner: owner.id, binding, series: '', key: `${rule.id}|` });
        });
      }
      for (const { id, result } of nowLane) {
        const entry = { rule, binding, owner: owner.id, name, series: id, key: `${rule.id}|${id}`, since: result.since, state: result.state };
        if (result.state === 'firing') firing.push(entry);
        else if (result.state === 'pending') pending.push(entry);
      }
      // No series with a number: a failed source, nothing yet, or all of them gone. It can't say, and
      // it must not read as fine. That is one rule with no data, however many series it had.
      if (!nowLane.some(({ result }) => result.state !== 'nodata')) {
        const only = nowLane.length === 1 ? nowLane[0] : null;
        silent.push({ rule, binding, owner: owner.id, name, series: only?.id ?? '', key: `${rule.id}|${only?.id ?? ''}`, since: only?.result.since ?? null, state: 'nodata' });
      }
    }
    // Which sources this drawing uses are failing, whether or not an alert depends on them.
    const failing = new Map();
    for (const q of m.dash.queries.values()) {
      const st = states.get(q.key);
      if (st?.ok === false && !st.queryProblem) failing.set(q.source, st.why);
    }
    m.failingNow = failing;
    transitions.sort((a, b) => a.t - b.t);
    m.transitions = transitions;
    m.firingNow = worstOfEach(firing);
    m.pendingNow = pending;
    m.silentNow = silent;
    m.ruleCount = total;
    // One place a notifier could hang from later: everything that began firing since the last look.
    for (const f of firing) if (!before.has(f.key)) m.onFiring?.(f);
  }

  // ---------------------------------------------------------------- what a shape says

  function seriesOf(binding, panelKind) {
    const st = stateFor(binding, panelKind);
    if (!st) return [];
    const list = st.order.map((id) => ({ id, series: st.series.get(id) })).filter((row) => row.series);
    const names = shortNames(list.map((row) => row.series), binding.name, st.query);
    return list.map((row, i) => ({ ...row, name: names[i], labelled: labelWords(row.series), st }));
  }

  /** The numbers of one binding at a moment. `at` is null for now. */
  function readBinding(binding, at, panelKind) {
    const st = stateFor(binding, panelKind);
    const now = m.now();
    if (!st) return { rows: [], waiting: true, binding };
    const gap = gapAfterOf(st), staleAfter = staleAfterOf(st, binding);
    const rows = [];
    for (const { id, series, name, labelled } of seriesOf(binding, panelKind)) {
      if (at !== null) {
        const point = series.at(at, gap);
        rows.push({ id, name, labelled, value: point?.v ?? null, t: point?.t ?? null, stale: !point, age: 0 });
      } else {
        const point = series.latest();
        const age = point ? now - point.t : Infinity;
        rows.push({ id, name, labelled, value: point?.v ?? null, t: point?.t ?? null, stale: !point || (!st.instant && age > staleAfter) || (st.instant && age > Math.max(staleAfter, 60)), age });
      }
    }
    // A source that is down now says nothing about a moment whose numbers arrived. But a rejected
    // query was never going to have numbers, and a range that failed to load was never seen.
    const failed = st.ok === false && (at === null || st.queryProblem || st.unknownSource || st.viewFailed);
    // A series with nothing to say here has ended, or has not begun, if another is reporting.
    const fresh = rows.filter((r) => !r.stale);
    return { rows: fresh.length ? fresh : rows, binding, st, failed, why: st.why, queryProblem: st.queryProblem, unknownSource: st.unknownSource, empty: st.empty, noData: !fresh.length, gap, staleAfter, at, waiting: st.ok === null };
  }

  const resultsFor = (at) => (at === null && !m.time.live ? tailResults : results);

  /** What one rule says at a moment, across its series: the worst of them. */
  function ruleState(rule, at) {
    const list = (resultsFor(at).get(rule.id) ?? []);
    let best = null, silent = null;
    for (const { id, result } of list) {
      const state = at === null ? { state: result.state, since: result.since } : stateAt(result, at);
      const level = levelOf(rule, state.state);
      if (state.state === 'nodata') silent ??= { ...state, level, series: id };
      else if (!best || LEVELS[level].rank > LEVELS[best.level].rank) best = { ...state, level, series: id };
    }
    return best ?? silent;
  }

  /**
   * The state of a shape or arrow: a level from LEVELS, and the sentence behind it. At now,
   * paused or not, this reads the newest data. At a moment, it reads that moment.
   */
  function status(owner, at = null) {
    const own = owner.bindings ?? [];
    if (!own.length) return { level: 'none', why: '' };
    let level = 'none', why = '', rule = null, since = null, binding = null, value = null;
    const take = (next, words, r = null, s = null, b = null, v = null) => {
      if (LEVELS[next].rank > LEVELS[level].rank) { level = next; why = words; rule = r; since = s; binding = b; value = v; }
    };
    const panelKind = owner.kind;
    let anyRule = false;
    for (const b of own) {
      const read = readBinding(b, at, panelKind);
      if (read.waiting && !read.rows.length) { take('pending', 'waiting for the first numbers'); continue; }
      if (read.failed && !read.rows.some((r) => !r.stale)) { take('failed', failure(b, read), null, null, b); continue; }
      if (read.failed) take('failed', failure(b, read), null, null, b);
      if (read.noData) {
        const newest = Math.max(...read.rows.map((r) => r.t ?? -Infinity));
        const words = at !== null ? `no data at that moment` : read.empty ? read.empty : Number.isFinite(newest) ? `no data for ${fmtAgo(m.now() - newest)}` : 'no data in this range';
        take('nodata', `${b.name}: ${words}`, null, null, b);
        continue;
      }
      for (const r of b.rules) {
        anyRule = true;
        const state = ruleState(r, at);
        if (!state) continue;
        const row = read.rows.find((x) => x.id === state.series) ?? read.rows[0];
        const level_ = state.level;
        if (level_ === 'warn' || level_ === 'critical') {
          const dur = state.since !== null && state.since !== undefined ? ` for ${fmtAgo((at ?? m.now()) - state.since + r.for)}` : '';
          take(level_, `${b.name} ${row?.value === null || row?.value === undefined ? '' : showValue(row.value, b.unit)} ${r.op} ${showLevel(r.value, b.unit)}${dur}`.replace(/\s+/g, ' '), r, state.since, b, row?.value ?? null);
        } else if (level_ === 'pending') {
          const heldFor = (at ?? m.now()) - (state.since ?? 0);
          take('pending', `${b.name} ${r.op} ${showLevel(r.value, b.unit)}, ${fmtAgo(Math.max(0, r.for - heldFor))} until ${r.level}`, r, state.since, b, row?.value ?? null);
        } else if (level_ === 'nodata') {
          take('nodata', `${b.name}: no data`, r, state.since, b);
        } else take('ok', `${b.name} is within its limits`, r, state.since, b, row?.value ?? null);
      }
    }
    if (level === 'none' && !anyRule) return { level: 'none', why: '' };
    return { level, why, rule, since, binding, value };
  }

  function failure(binding, read) {
    if (read.unknownSource) return read.why[0].toUpperCase() + read.why.slice(1);
    if (!read.queryProblem) return `${binding.source} failed: ${read.why}`;
    return read.why.startsWith('it ') ? `${binding.source} ${read.why.slice(3)}` : `${binding.source}: ${read.why}`;
  }

  /** What a row is called: its labels if it has any, as the query says nothing about which one it is. */
  const rowName = (read, row) => (read.rows.length > 1 ? row.name : row.labelled || read.binding.name);

  // ---------------------------------------------------------------- what the charts draw

  /** Spans of a binding's rules at each level, for the strip along the bottom of a chart. */
  function ruleSpans(binding, t0, t1) {
    const spans = [];
    for (const rule of binding.rules) {
      const list = results.get(rule.id) ?? [];
      const several = list.length > 1;
      const add = (span) => { if (!several || span.level !== 'nodata') spans.push(span); };
      for (const { result } of list) {
        let current = result.transitions.length ? null : { state: result.state, t: t0 };
        for (const tr of result.transitions) {
          if (current && tr.t > t0) add({ level: levelOf(rule, current.state), a: Math.max(t0, current.t), b: Math.min(t1, tr.t) });
          current = { state: tr.to, t: tr.t };
        }
        if (current) add({ level: levelOf(rule, current.state), a: Math.max(t0, current.t), b: t1 });
      }
      if (several) {
        const changes = coverage(list);
        let quietFrom = changes.length ? null : t0;
        for (const { t, to } of changes) {
          if (to === 'nodata') quietFrom = t;
          else if (quietFrom !== null) { spans.push({ level: 'nodata', a: Math.max(t0, quietFrom), b: Math.min(t1, t) }); quietFrom = null; }
        }
        if (quietFrom !== null) spans.push({ level: 'nodata', a: Math.max(t0, quietFrom), b: t1 });
      }
    }
    return spans.filter((s) => s.b > s.a && s.a < t1);
  }

  return { poll, reset, recompute, failure, rowName, seriesOf, readBinding, status, ruleState, ruleSpans, gapAfterOf, freshGapOf, stateFor, everyOf, get lastRecompute() { return lastRecompute; }, get states() { return states; } };
}
