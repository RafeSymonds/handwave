// Every source of data. A drawing names a source and a query, and that is all it can
// say: where a source lives and how to log in are in a local config file, read only here.
// `list()` is what the page sees of a source, and it never includes a URL or a credential.
//
// Built in, with no config: machine (this computer), demo (the simulated service) and push
// (numbers a script sends). A config file adds prometheus, json and more push sources:
//
//   experiments/dashboard/.sources.json, or the file named by DASHBOARD_SOURCES
//
// The name starts with a dot because the root server serves the repository as static
// files, and it refuses any path with a dot-file in it. See sources.example.json.

import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { INCIDENTS, SIM_METRICS, simValue } from './sim.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const NAME = /^[A-Za-z][\w-]{0,40}$/;
const METRIC = /^[\w.:-]{1,80}$/;
const BUILT_IN = new Set(['machine', 'demo', 'push']);
const MAX_QUERIES = 300;
const MAX_QUERY_TEXT = 4000;
const MAX_SPAN = 31 * 86400;
const MAX_POINTS = 11000;
const MAX_SERIES = 200;
const MAX_RESPONSE = 20 * 1024 * 1024;

export function parseEvery(text, fallback) {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(String(text ?? '').trim());
  if (!m) return fallback;
  const n = Number(m[1]);
  const seconds = m[2] === 'ms' ? n / 1000 : m[2] === 'm' ? n * 60 : m[2] === 'h' ? n * 3600 : n;
  return Math.max(0.2, seconds);
}

// ---------------------------------------------------------------------------
// A fixed-size history of one number.

class Ring {
  constructor(interval, cap = 7200) {
    this.interval = interval;
    this.cap = cap;
    this.t = new Float64Array(cap);
    this.v = new Float64Array(cap);
    this.head = 0;
    this.size = 0;
  }

  push(t, v) {
    this.t[this.head] = t;
    this.v[this.head] = v;
    this.head = (this.head + 1) % this.cap;
    this.size = Math.min(this.cap, this.size + 1);
  }

  index(i) { return (this.head - this.size + i + this.cap * 2) % this.cap; }

  range(start, end) {
    const t = [], v = [];
    for (let i = 0; i < this.size; i++) {
      const k = this.index(i);
      if (this.t[k] < start) continue;
      if (this.t[k] > end) break;
      t.push(this.t[k]);
      v.push(Number.isFinite(this.v[k]) ? this.v[k] : null);
    }
    return { t, v };
  }

  at(time) {
    for (let i = this.size - 1; i >= 0; i--) {
      const k = this.index(i);
      if (this.t[k] <= time) return { t: this.t[k], v: this.v[k] };
    }
    return null;
  }

  latest() { return this.size ? { t: this.t[this.index(this.size - 1)], v: this.v[this.index(this.size - 1)] } : null; }

  /** How often points really arrive: the middle of the last few gaps, for numbers sent to us. */
  pace(fallback) {
    if (this.size < 3) return fallback;
    const gaps = [];
    for (let i = Math.max(1, this.size - 8); i < this.size; i++) gaps.push(this.t[this.index(i)] - this.t[this.index(i - 1)]);
    gaps.sort((a, b) => a - b);
    return Math.max(0.2, gaps[gaps.length >> 1]);
  }
}

// ---------------------------------------------------------------------------
// This computer. Read from the operating system, on a schedule, from when the server
// started. There is no history from before that, and the chart says so.

const MACHINE_METRICS = {
  cpu: { name: 'CPU', unit: '%', axis: [0, 100], every: 1, help: 'Share of all cores busy, from the kernel\'s counters.' },
  memory: { name: 'memory used', unit: '%', axis: [0, 100], every: 2, help: 'Memory in use. On macOS: active, wired and compressed pages.' },
  'memory.used': { name: 'memory used', unit: 'GB', every: 2, help: 'The same, in gigabytes.' },
  load: { name: 'load', unit: 'tasks', every: 1, help: 'Tasks running or waiting over the last minute.' },
  disk: { name: 'disk used', unit: '%', axis: [0, 100], every: 10, help: 'How much of the main disk you can no longer write to, from the same counters df reads.' },
  'disk.free': { name: 'disk free', unit: 'GB', every: 10, help: 'Space you can still write to on the main disk.' },
  'net.in': { name: 'network in', unit: 'MB/s', every: 2, help: 'Bytes received per second, on every interface except loopback.' },
  'net.out': { name: 'network out', unit: 'MB/s', every: 2, help: 'Bytes sent per second, on every interface except loopback.' },
};

const DISK_PATH = process.platform === 'darwin' && fs.existsSync('/System/Volumes/Data') ? '/System/Volumes/Data' : '/';

const runTool = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 3000, maxBuffer: 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out)));
});

function readCpuTimes() {
  let busy = 0, total = 0;
  for (const cpu of os.cpus()) {
    const { user, nice, sys, idle, irq } = cpu.times;
    busy += user + nice + sys + irq;
    total += user + nice + sys + irq + idle;
  }
  return { busy, total };
}

async function readMemoryUsed() {
  if (process.platform === 'darwin') {
    const out = await runTool('/usr/bin/vm_stat', []);
    const page = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 4096);
    const pages = (label) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
    return (pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor')) * page;
  }
  if (process.platform === 'linux') {
    const info = await fs.promises.readFile('/proc/meminfo', 'utf8');
    const available = Number(/MemAvailable:\s+(\d+) kB/.exec(info)?.[1] ?? NaN) * 1024;
    if (Number.isFinite(available)) return os.totalmem() - available;
  }
  return os.totalmem() - os.freemem();
}

async function readNetworkBytes() {
  if (process.platform === 'linux') {
    const text = await fs.promises.readFile('/proc/net/dev', 'utf8');
    let rx = 0, tx = 0;
    for (const line of text.split('\n').slice(2)) {
      const [name, rest] = line.split(':');
      if (!rest || name.trim() === 'lo') continue;
      const cols = rest.trim().split(/\s+/).map(Number);
      rx += cols[0];
      tx += cols[8];
    }
    return { rx, tx };
  }
  if (process.platform === 'darwin') {
    const out = await runTool('/usr/sbin/netstat', ['-ibn']);
    const rows = out.split('\n');
    const head = rows[0].trim().split(/\s+/);
    const rxAt = head.indexOf('Ibytes'), txAt = head.indexOf('Obytes');
    const seen = new Set();
    let rx = 0, tx = 0;
    for (const row of rows.slice(1)) {
      const cols = row.trim().split(/\s+/);
      // A link row has the interface's total. The rows after it repeat it per address.
      if (cols.length < head.length || !cols[2]?.startsWith('<Link') || seen.has(cols[0]) || cols[0].startsWith('lo')) continue;
      seen.add(cols[0]);
      rx += Number(cols[rxAt]) || 0;
      tx += Number(cols[txAt]) || 0;
    }
    return { rx, tx };
  }
  throw new Error(`no network counters on ${process.platform}`);
}

function createMachine() {
  const rings = new Map(Object.entries(MACHINE_METRICS).map(([id, m]) => [id, new Ring(m.every)]));
  const problems = new Map();
  const record = (id, value) => rings.get(id).push(Date.now() / 1000, value);
  const failed = (ids, err) => { for (const id of ids) problems.set(id, String(err.message ?? err)); };
  const fine = (ids) => { for (const id of ids) problems.delete(id); };

  let cpu = readCpuTimes();
  const everySecond = () => {
    const next = readCpuTimes();
    const total = next.total - cpu.total;
    if (total > 0) record('cpu', Math.round(((next.busy - cpu.busy) / total) * 10000) / 100);
    cpu = next;
    record('load', os.loadavg()[0]);
  };

  let memoryBusy = false;
  const everyMemory = async () => {
    if (memoryBusy) return;
    memoryBusy = true;
    try {
      const used = await readMemoryUsed();
      record('memory', Math.round((used / os.totalmem()) * 10000) / 100);
      record('memory.used', Math.round((used / 1e9) * 1000) / 1000);
      fine(['memory', 'memory.used']);
    } catch (err) { failed(['memory', 'memory.used'], err); }
    memoryBusy = false;
  };

  const everyDisk = () => {
    try {
      const s = fs.statfsSync(DISK_PATH);
      const used = s.blocks - s.bfree;
      record('disk', Math.round((used / (used + s.bavail)) * 10000) / 100);
      record('disk.free', Math.round(((s.bavail * s.bsize) / 1e9) * 100) / 100);
      fine(['disk', 'disk.free']);
    } catch (err) { failed(['disk', 'disk.free'], err); }
  };

  let net = null, netBusy = false;
  const everyNet = async () => {
    if (netBusy) return;
    netBusy = true;
    try {
      const now = Date.now() / 1000;
      const next = await readNetworkBytes();
      if (net) {
        const dt = now - net.at;
        record('net.in', Math.round((Math.max(0, next.rx - net.rx) / dt / 1e6) * 10000) / 10000);
        record('net.out', Math.round((Math.max(0, next.tx - net.tx) / dt / 1e6) * 10000) / 10000);
      }
      net = { ...next, at: now };
      fine(['net.in', 'net.out']);
    } catch (err) { failed(['net.in', 'net.out'], err); }
    netBusy = false;
  };

  const startedAt = Date.now() / 1000;
  const timers = [setInterval(everySecond, 1000), setInterval(everyMemory, 2000), setInterval(everyDisk, 10000), setInterval(everyNet, 2000)];
  for (const timer of timers) timer.unref();
  // The first sample comes straight away, so a chart has something on first open.
  setTimeout(everySecond, 200).unref();
  everyMemory();
  everyDisk();
  // Network is a rate, so it takes two readings.
  everyNet().then(() => setTimeout(everyNet, 500).unref());

  return { rings, problems, startedAt };
}

// ---------------------------------------------------------------------------
// Words for what went wrong. A message goes to the page, so it never carries the source's
// address, and anything secret in the config is removed from it first.

function plainError(err) {
  const code = err?.cause?.code ?? err?.code;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return 'no answer in time';
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'its host name did not resolve';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'the connection was dropped';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'the connection timed out';
  if (String(err?.cause?.message ?? err?.message).includes('redirect')) return 'it tried to redirect, which is not followed';
  return err?.cause?.message ?? err?.message ?? 'it failed for an unknown reason';
}

function scrubber(source) {
  // Long enough to be a secret: a one-letter value would turn a message into nonsense.
  const secrets = [source.url, source.bearer, source.token, source.password, ...Object.values(source.headers ?? {})].filter(Boolean).map(String).filter((x) => x.length >= 4);
  return (text) => {
    let out = String(text);
    for (const secret of secrets) out = out.split(secret).join('[hidden]');
    return out.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"')]+/gi, '[address hidden]').slice(0, 400);
  };
}

function authHeaders(source) {
  const headers = { ...(source.headers ?? {}) };
  if (source.bearer) headers.Authorization = `Bearer ${source.bearer}`;
  if (source.user) headers.Authorization = `Basic ${Buffer.from(`${source.user}:${source.password ?? ''}`).toString('base64')}`;
  return headers;
}

// A source gets a fixed number of requests at once, so a large drawing cannot flood it.
class Gate {
  constructor(size = 6) { this.size = size; this.busy = 0; this.waiting = []; }
  async run(fn) {
    if (this.busy >= this.size) await new Promise((resolve) => this.waiting.push(resolve));
    this.busy++;
    try { return await fn(); } finally {
      this.busy--;
      this.waiting.shift()?.();
    }
  }
}

async function request(source, url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { ...authHeaders(source), ...(init.headers ?? {}) },
    // Following a redirect would send this source's credentials to wherever it points.
    redirect: 'error',
    signal: AbortSignal.timeout(source.timeoutSeconds * 1000),
  });
  const text = await res.text();
  if (text.length > MAX_RESPONSE) throw new Error('its answer was too large');
  return { status: res.status, text };
}

// ---------------------------------------------------------------------------
// Prometheus, over its HTTP API. A drawing supplies the query text and nothing else: the
// host and path come from the config, so the most it can do is ask this Prometheus a
// question.

const numberOf = (text) => {
  const v = Number(text);
  return Number.isFinite(v) ? v : null;
};

function seriesFromPrometheus(data) {
  const type = data?.resultType;
  const rows = data?.result ?? [];
  if (type === 'scalar' || type === 'string') return { series: [{ name: '', labels: {}, t: [rows[0]], v: [numberOf(rows[1])] }], dropped: 0 };
  const all = rows.map((row) => {
    const pairs = row.values ?? (row.value ? [row.value] : []);
    return { name: row.metric?.__name__ ?? '', labels: row.metric ?? {}, t: pairs.map((p) => p[0]), v: pairs.map((p) => numberOf(p[1])) };
  });
  if (all.length <= MAX_SERIES) return { series: all, dropped: 0 };
  // Prometheus sorts by label, so the first few are no more interesting than the rest.
  const peak = (row) => row.v.reduce((most, v) => Math.max(most, Math.abs(v ?? 0)), 0);
  const kept = all.map((row) => ({ row, peak: peak(row) })).sort((a, b) => b.peak - a.peak).slice(0, MAX_SERIES).map((x) => x.row);
  return { series: kept, dropped: all.length - MAX_SERIES };
}

async function askPrometheus(source, q) {
  const base = source.url.endsWith('/') ? source.url : `${source.url}/`;
  const body = new URLSearchParams({ query: q.query });
  let endpoint;
  if (q.instant) {
    endpoint = 'api/v1/query';
    if (Number.isFinite(q.time)) body.set('time', String(q.time));
  } else {
    endpoint = 'api/v1/query_range';
    const step = Math.max(q.step, (q.end - q.start) / MAX_POINTS, 1);
    body.set('start', String(Math.floor(q.start / step) * step));
    body.set('end', String(q.end));
    body.set('step', String(step));
  }
  const { status, text } = await request(source, new URL(endpoint, base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* Said below, by status. */ }
  if (status === 401 || status === 403) throw new Error(`it said ${status}: check the credentials in the config`);
  if (parsed?.status === 'error') {
    const why = new Error(`it rejected the query: ${parsed.error ?? parsed.errorType ?? 'no reason given'}`);
    why.queryProblem = true;
    throw why;
  }
  if (status >= 400) throw new Error(`it answered ${status}`);
  if (!parsed) throw new Error('its answer was not JSON, so it may not be Prometheus');
  return { ...seriesFromPrometheus(parsed.data), interval: q.instant ? source.every : Math.max(q.step, (q.end - q.start) / MAX_POINTS, 1), warnings: parsed.warnings };
}

// ---------------------------------------------------------------------------
// A JSON URL, polled on an interval while a page is using it. Every number in the answer
// is kept, so a drawing can name a declared field or any path, such as a.b[0].c.

function numericLeaves(value, prefix, out, depth = 0) {
  if (out.size >= 500 || depth > 12) return;
  if (typeof value === 'number' && Number.isFinite(value)) { out.set(prefix, value); return; }
  if (Array.isArray(value)) { value.slice(0, 50).forEach((item, i) => numericLeaves(item, `${prefix}[${i}]`, out, depth + 1)); return; }
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) numericLeaves(item, prefix ? `${prefix}.${key}` : key, out, depth + 1);
}

function createPoller(source, onState) {
  let timer = null, usedAt = 0;
  const poll = async () => {
    if (Date.now() - usedAt > 120000) { clearInterval(timer); timer = null; return; }
    const now = Date.now() / 1000;
    try {
      const { status, text } = await request(source, source.url);
      if (status >= 400) throw new Error(`it answered ${status}`);
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new Error('its answer was not JSON'); }
      const leaves = new Map();
      numericLeaves(parsed, '', leaves);
      for (const [leaf, value] of leaves) {
        if (!source.rings.has(leaf)) source.rings.set(leaf, new Ring(source.every, 3600));
        source.rings.get(leaf).push(now, value);
      }
      onState(source, true, null);
    } catch (err) {
      onState(source, false, plainError(err));
    }
  };
  return {
    use() {
      usedAt = Date.now();
      if (timer) return;
      timer = setInterval(poll, source.every * 1000);
      timer.unref();
      poll();
    },
  };
}

// ---------------------------------------------------------------------------

export function createSources({ configPath } = {}) {
  const machine = createMachine();
  const pushRings = new Map();       // source name -> Map(metric -> Ring)
  const sim = { seed: 7, incidents: [] };
  // So the first look has something to find: a database slowdown 18 minutes before now.
  const started = Math.floor(Date.now() / 1000);
  sim.incidents.push({ kind: 'db-slow', start: started - 18 * 60, end: started - 14 * 60, seeded: true });

  const state = new Map();           // source name -> {ok, why, at, okAt}
  const setState = (source, ok, why) => {
    const name = typeof source === 'string' ? source : source.name;
    const prev = state.get(name) ?? {};
    const now = Date.now() / 1000;
    state.set(name, { ok, why: why ?? null, at: now, okAt: ok ? now : prev.okAt ?? null });
  };

  // -------------------------------------------------------------- the config file

  let declared = new Map();
  let configError = null;
  let configStamp = null;
  const pollers = new Map();
  const gates = new Map();

  function loadConfig() {
    const file = configPath ?? process.env.DASHBOARD_SOURCES ?? path.join(here, '.sources.json');
    let stat = null;
    try { stat = fs.statSync(file); } catch { /* No config is fine. */ }
    const stamp = stat ? `${file}|${stat.mtimeMs}|${stat.size}` : `${file}|none`;
    if (stamp === configStamp) return;
    configStamp = stamp;
    declared = new Map();
    configError = null;
    pollers.clear();
    if (!stat) return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      configError = `${path.basename(file)} is not valid JSON: ${err.message}`;
      return;
    }
    for (const [name, raw] of Object.entries(parsed?.sources ?? {})) {
      if (!NAME.test(name) || BUILT_IN.has(name)) {
        configError = `"${name}" can't be a source name. Use a letter, then letters, digits, - or _, and not machine, demo or push.`;
        continue;
      }
      const source = { ...raw, name, every: parseEvery(raw?.every, raw?.type === 'prometheus' ? 15 : 5), timeoutSeconds: Number(raw?.timeoutSeconds ?? 5) };
      if (raw?.type === 'prometheus' || raw?.type === 'json') {
        let url;
        try { url = new URL(raw.url); } catch { /* Said below. */ }
        if (url?.protocol !== 'http:' && url?.protocol !== 'https:') {
          source.bad = `it needs a "url" starting with http or https`;
        }
      } else if (raw?.type !== 'push') {
        source.bad = `it has type "${raw?.type}", and only prometheus, json and push exist`;
      }
      if (source.type === 'json') {
        source.rings = new Map();
        source.fields = new Map(Object.entries(raw.fields ?? {}));
      }
      declared.set(name, source);
    }
  }

  const gateFor = (name) => {
    if (!gates.has(name)) gates.set(name, new Gate());
    return gates.get(name);
  };

  // -------------------------------------------------------------- what the page may know

  function list() {
    loadConfig();
    const out = [
      {
        name: 'machine', type: 'this computer', every: 1, closed: true, ok: true, why: null, says: 'This computer, read from the operating system since the server started.',
        metrics: Object.entries(MACHINE_METRICS).map(([id, m]) => ({ id, ...m })),
      },
      {
        name: 'demo', type: 'simulated service', every: 1, closed: true, ok: !sim.failing, why: sim.failing ? 'it is set to fail, for this demo' : null, says: 'A made-up checkout service. Its numbers are not real.',
        metrics: Object.entries(SIM_METRICS).map(([id, m]) => ({ id, ...m })),
        incidents: Object.entries(INCIDENTS).map(([id, i]) => ({ id, ...i })),
        active: sim.incidents.filter((i) => !i.seeded && (i.end === null || i.end > Date.now() / 1000)).map((i) => i.kind),
      },
      { name: 'push', type: 'numbers you send', every: 30, closed: false, ok: true, why: null, says: 'Numbers a script sends to /dashboard/push.', metrics: pushMetrics('push') },
    ];
    for (const source of declared.values()) {
      const s = state.get(source.name);
      const row = { name: source.name, type: source.type, every: source.every, closed: false, ok: source.bad ? false : s?.ok ?? null, why: source.bad ?? s?.why ?? null, at: s?.at ?? null, okAt: s?.okAt ?? null };
      if (source.type === 'json') {
        const fields = [...source.fields].map(([id, f]) => ({ id, name: f.name ?? id, unit: f.unit ?? '' }));
        const known = new Set(fields.map((f) => f.id));
        const paths = new Set([...source.fields.values()].map((f) => f.path));
        row.metrics = [...fields, ...[...source.rings.keys()].filter((leaf) => !known.has(leaf) && !paths.has(leaf)).map((id) => ({ id, name: id, unit: '' }))];
      } else if (source.type === 'push') {
        row.metrics = pushMetrics(source.name);
      } else {
        row.metrics = source.metricList ?? [];
      }
      out.push(row);
    }
    return { sources: out, configError };
  }

  function pushMetrics(name) {
    return [...(pushRings.get(name)?.keys() ?? [])].map((id) => ({ id, name: id, unit: '' }));
  }

  // -------------------------------------------------------------- answering a query

  function fromRing(ring, q, name, why) {
    if (q.instant) {
      const point = ring.at(Number.isFinite(q.time) ? q.time : Date.now() / 1000);
      return { ok: !why, why, interval: ring.interval, series: point ? [{ name, labels: {}, t: [point.t], v: [Number.isFinite(point.v) ? point.v : null] }] : [] };
    }
    const { t, v } = ring.range(q.start, q.end);
    return { ok: !why, why, interval: ring.interval, series: [{ name, labels: {}, t, v }] };
  }

  function answerMachine(q) {
    const ring = machine.rings.get(q.query);
    if (!ring) throw Object.assign(new Error(`it has no metric "${q.query}"`), { queryProblem: true });
    const trouble = machine.problems.get(q.query);
    return fromRing(ring, q, q.query, trouble ?? null);
  }

  function answerDemo(q) {
    if (simValue(q.query, 0) === undefined) throw Object.assign(new Error(`it has no metric "${q.query}"`), { queryProblem: true });
    if (sim.failing) throw new Error('it is set to fail, for this demo');
    if (q.instant) {
      const when = Number.isFinite(q.time) ? q.time : Date.now() / 1000;
      const value = simValue(q.query, when, sim);
      return { ok: true, why: null, interval: 1, series: [{ name: q.query, labels: {}, t: [Math.floor(when)], v: [value] }] };
    }
    const step = Math.max(1, q.step, (q.end - q.start) / MAX_POINTS);
    const t = [], v = [];
    const first = Math.ceil(q.start / step) * step;
    for (let at = first; at <= q.end; at += step) {
      t.push(at);
      v.push(simValue(q.query, at, sim));
    }
    return { ok: true, why: null, interval: step, series: [{ name: q.query, labels: {}, t, v }] };
  }

  function answerPush(name, q, every) {
    const ring = pushRings.get(name)?.get(q.query);
    if (!ring) return { ok: true, why: null, interval: every, series: [], empty: `nothing has been pushed to "${q.query}" yet` };
    return { ...fromRing(ring, q, q.query, null), interval: ring.pace(every) };
  }

  function answerJson(source, q) {
    const poller = pollers.get(source.name) ?? createPoller(source, setState);
    pollers.set(source.name, poller);
    poller.use();
    const state_ = state.get(source.name);
    const field = source.fields.get(q.query);
    const leaf = field?.path ?? q.query;
    const ring = source.rings.get(leaf);
    if (!ring) {
      if (state_?.ok === false) return { ok: false, why: state_.why, interval: source.every, series: [] };
      if (state_?.ok === true) {
        const known = [...source.rings.keys()].slice(0, 8).join(', ');
        throw Object.assign(new Error(`its answer has no number at "${leaf}". It has: ${known || 'nothing'}`), { queryProblem: true });
      }
      return { ok: true, why: null, interval: source.every, series: [] };
    }
    const out = fromRing(ring, q, q.query, null);
    if (state_?.ok === false) { out.ok = false; out.why = state_.why; }
    out.unit = field?.unit;
    out.title = field?.name;
    return out;
  }

  async function answer(q) {
    if (q.source === 'machine') return answerMachine(q);
    if (q.source === 'demo') return answerDemo(q);
    if (q.source === 'push') return answerPush('push', q, 30);
    const source = declared.get(q.source);
    if (!source) throw Object.assign(new Error(`there is no source named "${q.source}". Declare it in .sources.json on this machine`), { unknownSource: true });
    if (source.bad) throw Object.assign(new Error(`its config is wrong: ${source.bad}`), { unknownSource: true });
    if (source.type === 'push') return answerPush(source.name, q, source.every);
    if (source.type === 'json') return answerJson(source, q);
    const scrub = scrubber(source);
    try {
      const result = await gateFor(source.name).run(() => askPrometheus(source, q));
      setState(source, true, null);
      return { ok: true, why: null, interval: result.interval, series: result.series, dropped: result.dropped, warning: result.warnings?.[0] && scrub(result.warnings[0]) };
    } catch (err) {
      const why = scrub(err.queryProblem ? err.message : plainError(err));
      if (err.queryProblem) { setState(source, true, null); throw Object.assign(new Error(why), { queryProblem: true }); }
      setState(source, false, why);
      return { ok: false, why, interval: source.every, series: [] };
    }
  }

  // Check every field from the page. Anything other than these fields is ignored, so a
  // request cannot carry an address, whatever else it says.
  function clean(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('that query is not an object');
    const source = String(raw.source ?? '');
    const query = String(raw.query ?? '');
    if (!NAME.test(source)) throw Object.assign(new Error(`"${source.slice(0, 60)}" can't be a source name`), { unknownSource: true });
    if (!query || query.length > MAX_QUERY_TEXT) throw new Error('that query is empty or too long');
    const end = Number(raw.end ?? Date.now() / 1000);
    const start = Number(raw.start ?? end - 900);
    const step = Number(raw.step ?? 1);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(step)) throw new Error('that time range is not made of numbers');
    if (end < start || end - start > MAX_SPAN) throw new Error('that time range is too long');
    return { source, query, start, end, step: Math.max(0.2, step), instant: !!raw.instant, time: raw.time === undefined || raw.time === null ? undefined : Number(raw.time) };
  }

  async function fetchAll(queries) {
    loadConfig();
    if (!Array.isArray(queries)) throw new Error('send a list of queries');
    if (queries.length > MAX_QUERIES) throw new Error(`that is more than ${MAX_QUERIES} queries at once`);
    return Promise.all(queries.map(async (raw) => {
      try {
        return await answer(clean(raw));
      } catch (err) {
        return { ok: false, why: String(err.message ?? err).slice(0, 400), queryProblem: !!err.queryProblem, unknownSource: !!err.unknownSource, series: [] };
      }
    }));
  }

  // -------------------------------------------------------------- numbers pushed in

  function push(body, authorization) {
    loadConfig();
    const name = String(body.source ?? 'push');
    const source = declared.get(name);
    if (name !== 'push' && source?.type !== 'push') throw Object.assign(new Error(`there is no push source named "${name.slice(0, 60)}"`), { status: 404 });
    if (source?.token && authorization !== `Bearer ${source.token}`) throw Object.assign(new Error('that source needs its token, as Authorization: Bearer ...'), { status: 401 });
    const now = Date.now() / 1000;
    const when = body.t === undefined ? now : Number(body.t);
    if (!Number.isFinite(when)) throw new Error('t is not a number');
    const values = body.metrics ?? (body.metric === undefined ? null : { [body.metric]: body.value });
    if (!values || typeof values !== 'object') throw new Error('send metric and value, or metrics: {name: value}');
    if (!pushRings.has(name)) pushRings.set(name, new Map());
    const rings = pushRings.get(name);
    let stored = 0;
    for (const [metric, raw] of Object.entries(values)) {
      if (!METRIC.test(metric)) throw new Error(`"${metric.slice(0, 60)}" can't be a metric name`);
      const value = raw === null ? null : Number(raw);
      if (value !== null && !Number.isFinite(value)) throw new Error(`the value of "${metric}" is not a number`);
      if (!rings.has(metric)) {
        if (rings.size >= 200) throw new Error('that source already has 200 metrics');
        rings.set(metric, new Ring(source?.every ?? 30, 3600));
      }
      rings.get(metric).push(when, value === null ? NaN : value);
      stored++;
    }
    return { stored };
  }

  // -------------------------------------------------------------- the simulated service

  function incident(body) {
    const now = Math.floor(Date.now() / 1000);
    if (body.recover) {
      for (const inc of sim.incidents) if (!inc.seeded && (inc.end === null || inc.end > now)) inc.end = now;
      sim.failing = false;
    } else if (body.fail !== undefined) {
      sim.failing = !!body.fail;
    } else {
      if (!INCIDENTS[body.kind]) throw new Error(`there is no incident called "${String(body.kind).slice(0, 40)}"`);
      const seconds = Number(body.seconds);
      sim.incidents.push({ kind: body.kind, start: now, end: Number.isFinite(seconds) && seconds > 0 ? now + seconds : null });
    }
    return { seed: sim.seed, incidents: sim.incidents, failing: !!sim.failing };
  }

  return { list, fetchAll, push, incident };
}
