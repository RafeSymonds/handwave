// Monitoring dashboards you draw. Drives the real page with real mouse and keyboard input,
// against a small fake Prometheus and a fake internal service inside this test.
// node tests/dashboard.mjs [screenshot dir]
//
// Everything here runs from a clean checkout. The page's CSP blocks eval, which is what
// Playwright's waitForFunction uses, so this file polls with evaluate instead.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, page, shots } from './browser.mjs';
import { startServer } from '../server.mjs';
import { refusal } from '../experiments/dashboard/server.mjs';
import { breached, replay, stateAt } from '../experiments/dashboard/alerts.js';
import { axisLabels, fmtAgo, niceScale, showLevel, showValue, stepFor } from '../experiments/dashboard/format.js';
import { parseNumber, parseTime, PARTS, readLabel, WORDS, URL_MESSAGE } from '../experiments/dashboard/vocab.js';
import { readDashboard } from '../experiments/dashboard/read.js';
import { gaps, Series, trace } from '../experiments/dashboard/series.js';
import { SIM_METRICS, simValue } from '../experiments/dashboard/sim.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? shots('dashboard');
fs.mkdirSync(out, { recursive: true });

let passed = 0;
const check = (name, ok, detail = '') => {
  assert.ok(ok, `${name} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  passed++;
  console.log(`ok  ${name}${detail !== '' ? ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const section = (name) => console.log(`\n---- ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Date.now() / 1000;

// ===========================================================================
// A fake Prometheus, and a fake internal service nothing in a drawing should reach.

const prom = { calls: [], mode: 'ok', series: new Map(), hangMs: 0 };

// As real Prometheus does: a query it can't parse is a 400 with this body, and a metric that
// does not exist is a success with an empty result, not an error.
function parses(query) {
  let depth = 0;
  for (const c of query) { if (c === '(') depth++; if (c === ')' && --depth < 0) return false; }
  return depth === 0;
}

/** A number that changes at set times, so history stays true after it changes. */
function steps(first) {
  const list = [[0, first]];
  const fn = (t) => { let v = list[0][1]; for (const [at, value] of list) if (t >= at) v = value; return v; };
  fn.set = (value, at = nowS()) => list.push([at, value]);
  return fn;
}

const promServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', async () => {
    const url = new URL(req.url, 'http://x');
    const params = new URLSearchParams(body);
    for (const [k, v] of url.searchParams) params.set(k, v);
    const call = { path: url.pathname, query: params.get('query'), start: Number(params.get('start')), end: Number(params.get('end')), step: Number(params.get('step')), time: params.has('time') ? Number(params.get('time')) : null, auth: req.headers.authorization ?? null, method: req.method };
    prom.calls.push(call);
    if (prom.mode === 'hang') { await sleep(prom.hangMs); }
    if (prom.mode === '500') { res.writeHead(500); res.end('boom'); return; }
    if (prom.mode === 'drop') { req.socket.destroy(); return; }
    res.setHeader('Content-Type', 'application/json');
    if (!parses(call.query ?? '')) {
      res.writeHead(400);
      res.end(JSON.stringify({ status: 'error', errorType: 'bad_data', error: `invalid parameter "query": 1:${(call.query ?? '').length + 1}: parse error: unexpected end of input inside parentheses` }));
      return;
    }
    const fn = prom.series.get(call.query);
    const list = !fn ? [] : typeof fn === 'function' ? [{ metric: { __name__: call.query }, fn }] : fn;
    if (url.pathname === '/api/v1/query_range') {
      const result = list.map(({ metric, fn: f }) => {
        const values = [];
        for (let t = call.start; t <= call.end; t += call.step) {
          const v = f(t);
          if (v === null) continue;
          values.push([t, String(v)]);
        }
        return { metric, values };
      });
      res.end(JSON.stringify({ status: 'success', data: { resultType: 'matrix', result } }));
    } else if (url.pathname === '/api/v1/query') {
      const t = call.time ?? nowS();
      const result = list.flatMap(({ metric, fn: f }) => { const v = f(t); return v === null ? [] : [{ metric, value: [t, String(v)] }]; });
      res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result } }));
    } else { res.writeHead(404); res.end('{}'); }
  });
});

const internal = { hits: [], stats: { requests: { perSecond: 12.5, errorPercent: 0.25 }, up: 1 }, mode: 'ok' };
const internalServer = http.createServer((req, res) => {
  internal.hits.push({ url: req.url, key: req.headers['x-api-key'] ?? null });
  if (req.url === '/redirect/api/v1/query_range') { res.writeHead(302, { Location: `http://127.0.0.1:${internalPort}/leak` }); res.end(); return; }
  if (req.url === '/stats') {
    if (internal.mode === 'fail') { res.writeHead(503); res.end('nope'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(internal.stats));
    return;
  }
  res.end('internal secret');
});

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const promPort = await listen(promServer);
const internalPort = await listen(internalServer);
const leaks = () => internal.hits.filter((h) => h.url !== '/stats');
// A port nothing is listening on.
const closedPort = await new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const SECRETS = ['SECRET-PROM-TOKEN', 'SECRET-JSON-KEY', 'SECRET-PUSH-TOKEN'];
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handwave-dash-'));
const configFile = path.join(configDir, 'sources.json');
fs.writeFileSync(configFile, JSON.stringify({
  sources: {
    prod: { type: 'prometheus', url: `http://127.0.0.1:${promPort}`, every: '1s', bearer: 'SECRET-PROM-TOKEN', timeoutSeconds: 2 },
    orders: { type: 'json', url: `http://127.0.0.1:${internalPort}/stats`, every: '1s', headers: { 'X-Api-Key': 'SECRET-JSON-KEY' }, fields: { qps: { path: 'requests.perSecond', name: 'requests', unit: 'req/s' } } },
    deploys: { type: 'push', every: '1s', token: 'SECRET-PUSH-TOKEN' },
    slow: { type: 'prometheus', url: `http://127.0.0.1:${promPort}`, every: '5s', timeoutSeconds: 2 },
    sneaky: { type: 'prometheus', url: `http://127.0.0.1:${internalPort}/redirect`, every: '1s', timeoutSeconds: 2 },
    dead: { type: 'prometheus', url: `http://127.0.0.1:${closedPort}`, every: '1s', timeoutSeconds: 1 },
  },
}, null, 1));
process.env.DASHBOARD_SOURCES = configFile;

// ===========================================================================
section('the rules, with no browser');

{
  // A spike of one sample in 100,000 survives thinning.
  const s = new Series('x', {}, 200000);
  const t = [], v = [];
  for (let i = 0; i < 100000; i++) { t.push(i); v.push(i === 54321 ? 1000 : Math.sin(i / 50)); }
  s.merge(t, v);
  let top = Infinity, lines = 0;
  trace(s, 0, 99999, { X: (x) => (x / 99999) * 800, Y: (y) => 500 - y / 2, density: 1, gapAfter: 3 }, { move: () => {}, line: (_, y) => { lines++; top = Math.min(top, y); }, dot: () => {} });
  check('thinning keeps a one-sample spike', top === 0, { top, lines });
  check('thinning draws far fewer points than it reads', lines < 4000, { lines });

  // Sparse data is drawn through the exact values, in order.
  const sparse = new Series();
  sparse.merge([0, 10, 20, 30], [1, 3, 2, 8]);
  const drawn = [];
  trace(sparse, 0, 30, { X: (x) => x * 10, Y: (y) => y, density: 1, gapAfter: 15 }, { move: (a, b) => drawn.push([a, b]), line: (a, b) => drawn.push([a, b]), dot: () => assert.fail('no dots') });
  assert.deepEqual(drawn, [[0, 1], [100, 3], [200, 2], [300, 8]]);
  check('a sparse line goes through its exact values and nothing else', true);

  // A gap is never crossed, and a lone point between gaps is a dot.
  const holey = new Series();
  holey.merge([0, 1, 2, 10, 20, 21, 22], [1, 2, 3, 9, 5, null, 6]);
  const runs = [];
  const dots = [];
  trace(holey, 0, 22, { X: (x) => x, Y: (y) => y, density: 1, gapAfter: 3 }, { move: (a) => runs.push([a]), line: (a) => runs[runs.length - 1].push(a), dot: (a) => dots.push(a) });
  assert.deepEqual(runs, [[0, 1, 2]]);
  assert.deepEqual(dots, [10, 20, 22]);
  check('a gap breaks the line, and lone points are dots', true, { runs, dots });
  check('gaps() names the stretches with no data', JSON.stringify(gaps(holey, 0, 22, 3)) === '[[2,10],[10,20]]', gaps(holey, 0, 22, 3));
  check('at() finds nothing inside a gap', holey.at(6, 3) === null && holey.at(3, 3).v === 3);

  // Ticks are real.
  const axis = axisLabels(niceScale(0, 8, 4).ticks, '%');
  check('axis labels write a step of 2.5 exactly, or it rounds to the wrong number', !axis.labels.includes('3') && (axis.labels.includes('2.5') || !niceScale(0, 8, 4).ticks.includes(2.5)), axis);
  const t25 = axisLabels([0, 2.5, 5, 7.5, 10]);
  assert.deepEqual(t25.labels, ['0.0', '2.5', '5.0', '7.5', '10.0']);
  check('every tick lands on a round number', niceScale(13, 97, 4).ticks.every((x) => Number.isInteger(x)), niceScale(13, 97, 4).ticks);
  check('a level is written as it was typed', showLevel(85, '%') === '85%' && showLevel(0.5, 'ms') === '0.5 ms', showLevel(85, '%'));
  check('units scale themselves', showValue(1500, 'ms') === '1.50 s' && showValue(2.5e9, 'bytes') === '2.50 GB', showValue(2.5e9, 'bytes'));
  check('time words are short', fmtAgo(45) === '45s' && fmtAgo(133) === '2m 13s' && fmtAgo(120) === '2m' && fmtAgo(3840) === '1h 4m');
  check('fetches stay aligned on round steps', stepFor(900) === 1 && stepFor(86400) === 30 && stepFor(3600, 15) === 15);

  // Alert states.
  const rule = { level: 'warn', op: 'above', value: 10, for: 5 };
  const ser = new Series();
  ser.merge([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [1, 20, 20, 20, 20, 20, 20, 1, 20, 1, 1]);
  const r = replay(rule, ser, { gapAfter: 3, staleAfter: 3, until: 10 });
  const path_ = r.transitions.map((x) => `${x.to}@${x.t}`).join(' ');
  check('a level must hold for its "for" before it fires, then resolves', path_ === 'ok@0 pending@1 firing@6 ok@7 pending@8 ok@9', path_);
  check('stateAt reads the past', stateAt(r, 6.5).state === 'firing' && stateAt(r, 3).state === 'pending' && stateAt(r, -1).state === 'nodata');
  const quiet = replay(rule, ser, { gapAfter: 3, staleAfter: 4, until: 100 });
  check('data that stops becomes no data, never ok', quiet.state === 'nodata' && quiet.since === 14);
  const hole = new Series();
  hole.merge([0, 1, 2, 3, 20, 21, 22, 23, 24, 25, 26], [20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20]);
  const across = replay(rule, hole, { gapAfter: 3, until: 26 }).transitions.map((x) => `${x.to}@${x.t}`).join(' ');
  check('a gap resets "for": the time before it does not count', across === 'pending@0 nodata@6 pending@20 firing@25', across);
  check('below works', breached({ op: 'below', value: 5 }, 4) && !breached({ op: 'below', value: 5 }, 6));

  // The table the page reads.
  const catalog = new Map([['machine', { name: 'machine', closed: true, metrics: new Map([['cpu', { id: 'cpu', name: 'CPU', unit: '%', axis: [0, 100] }], ['memory', { id: 'memory', name: 'memory', unit: '%' }]]) }], ['prod', { name: 'prod', closed: false, metrics: new Map() }]]);
  for (const word of WORDS) {
    const place = word.on[0];
    const read = readLabel(word.id === 'unit' ? 'prod: up in req/s' : word.id === 'binding' ? 'machine: cpu' : word.id === 'named' ? 'busy = machine: cpu' : word.group === 'alert' ? `machine: cpu\n${word.example}` : word.example, place, catalog);
    const hit = read.understood.find((u) => u.word.id === word.id);
    assert.ok(hit, `${word.id}'s own example "${word.example}" reads as ${word.id}: ${JSON.stringify(read.understood.map((u) => u.word.id))}`);
    assert.deepEqual(read.problems.filter((p) => p.level === 'error'), [], `${word.id}'s example has no errors`);
  }
  check('every word in the table parses from its own example', true, `${WORDS.length} words`);
  for (const part of PARTS) {
    if (!part.label || part.type === 'text') continue;
    const read = readLabel(part.label, 'shape', catalog);
    const kind = read.panel ?? (read.bindings.length ? 'box' : 'plain');
    assert.equal(kind, part.kind, `the ${part.id} part's label reads as what it claims`);
  }
  check('every part in the palette reads as the panel it claims to be', true);

  const alert = readLabel('machine: cpu\nwarn above 1.5k for 2m\ncritical below 5 for 30s', 'shape', catalog);
  assert.equal(alert.alerts[0].value, 1500);
  assert.equal(alert.alerts[0].for, 120);
  assert.equal(alert.alerts[1].op, 'below');
  assert.equal(alert.alerts[1].for, 30);
  check('alert lines read their level, direction and duration', true);
  check('numbers and times parse', parseNumber('2M') === 2e6 && parseTime('500ms') === 0.5 && parseTime('1h') === 3600 && Number.isNaN(parseTime('5')));

  for (const line of [`http://169.254.169.254/latest/meta-data`, 'prod: http://10.0.0.1/metrics', 'orders = https://internal.corp/stats', 'localhost:9090/metrics', '10.0.0.1:9100', 'ftp://x/y']) {
    const read = readLabel(line, 'shape', catalog);
    assert.ok(read.problems.some((p) => p.message === URL_MESSAGE), `"${line}" is refused: ${JSON.stringify(read.problems)}`);
    assert.equal(read.bindings.length, 0, `"${line}" binds to nothing`);
  }
  check('a label that names an address gets a message and binds to nothing', true);
  check('an address inside a quoted Prometheus label is only text', readLabel('prod: up{instance="http://a:9100"}', 'shape', catalog).bindings.length === 1);

  const typo = (line) => readLabel(line, 'shape', catalog).problems[0];
  check('a misspelled word is caught with a fix', typo('machine: cpu\nchrat')?.fix?.to === 'chart' && typo('machine: cpu\nwarnn above 80')?.fix?.to === 'warn', typo('machine: cpu\nwarnn above 80'));
  check('a misspelled source is caught with a fix', typo('machin: cpu')?.fix?.to === 'machine', typo('machin: cpu'));
  check('a misspelled metric is caught with a fix', typo('machine: cpuu')?.fix?.to === 'cpu', typo('machine: cpuu'));
  check('the right word written wrongly says how to write it', /warn above 80 for 2m/.test(typo('machine: cpu\nwarn 80')?.message ?? ''), typo('machine: cpu\nwarn 80'));
  check('a level with nothing to watch says so', /nothing to watch/.test(typo('warn above 80')?.message ?? ''));
  check('a level naming an unknown number says so', /No number here/.test(typo('machine: cpu\nwarn bananas above 80')?.message ?? ''));
  check('a word from another tool is pointed at ours', /meter/.test(typo('gauge\nmachine: cpu')?.message ?? ''), typo('gauge\nmachine: cpu'));
  check('an ordinary title is left alone', readLabel('cart\nmachine: cpu', 'shape', catalog).problems.length === 0 && readLabel('cart\nmachine: cpu', 'shape', catalog).title === 'cart');

  // The simulated service is a pure function.
  const a = simValue('api.errors', 1000, { seed: 7, incidents: [] }), b = simValue('api.errors', 1000, { seed: 7, incidents: [] });
  check('the simulation repeats exactly', a === b);
  const during = simValue('db.latency', 1100, { seed: 7, incidents: [{ kind: 'db-slow', start: 1000, end: 1400 }] }), before = simValue('db.latency', 900, { seed: 7, incidents: [{ kind: 'db-slow', start: 1000, end: 1400 }] });
  check('an incident moves its numbers, and only from when it starts', during > 100 && before < 15, { during, before });
  check('a metric that stops reporting is null', simValue('db.latency', 1100, { seed: 7, incidents: [{ kind: 'exporter-down', start: 1000, end: 1400 }] }) === null);
  check('every simulated metric has a value', Object.keys(SIM_METRICS).every((id) => typeof simValue(id, 1000) === 'number'));
}

// ===========================================================================
section('security: routes, config and credentials');

const { base, browser, context, close } = await open();
const baseUrl = new URL(base);

function raw(pathname, { method = 'POST', headers = {}, body = '{}', port = baseUrl.port, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path: pathname, method, headers }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    if (method !== 'GET') req.write(body);
    req.end();
  });
}

const good = (extra = {}) => ({ 'Content-Type': 'application/json', Host: baseUrl.host, Origin: base, ...extra });
const api = async (pathname, body = {}, headers = {}) => {
  const r = await raw(pathname, { headers: good(headers), body: JSON.stringify(body) });
  return { status: r.status, text: r.text, json: r.status === 200 ? JSON.parse(r.text) : null };
};

for (const route of ['/dashboard/sources', '/dashboard/fetch', '/dashboard/push', '/dashboard/incident']) {
  const noOrigin = await raw(route, { headers: { 'Content-Type': 'application/json', Host: baseUrl.host } });
  const foreign = await raw(route, { headers: good({ Origin: 'https://evil.example' }) });
  const rebind = await raw(route, { headers: good({ Host: 'evil.example', Origin: 'http://evil.example' }) });
  const notJson = await raw(route, { headers: good({ 'Content-Type': 'text/plain' }) });
  const get = await raw(route, { method: 'GET', headers: { Host: baseUrl.host, Origin: base } });
  check(`${route} refuses no Origin, a foreign Origin and a foreign Host`, noOrigin.status === 403 && foreign.status === 403 && rebind.status === 403, [noOrigin.status, foreign.status, rebind.status]);
  check(`${route} takes only JSON, and only POST`, notJson.status === 415 && get.status === 404, [notJson.status, get.status]);
}
check('the check also refuses another machine', refusal({ socket: { remoteAddress: '192.168.1.20' }, headers: { host: 'localhost:4173', origin: 'http://localhost:4173' } }) !== null);
check('the check takes this machine', refusal({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { host: 'localhost:4173', origin: 'http://localhost:4173' } }) === null);

// The root server serves the repository as static files, even on HOST=0.0.0.0.
for (const p_ of ['/experiments/dashboard/.sources.json', '/experiments/dashboard/%2esources.json', '/experiments/dashboard/./.sources.json']) {
  const r = await raw(p_, { method: 'GET', headers: { Host: baseUrl.host } });
  check(`the config file is not served: ${p_}`, r.status === 403 || r.status === 404, r.status);
}
check('the config file is ignored by git', fs.readFileSync(path.join(here, '../experiments/dashboard/.gitignore'), 'utf8').split('\n').includes('.sources.json'));
const example = fs.readFileSync(path.join(here, '../experiments/dashboard/sources.example.json'), 'utf8');
check('the example config has only placeholders', !SECRETS.some((s) => example.includes(s)) && JSON.parse(example).sources.prod.type === 'prometheus');

const listed = await api('/dashboard/sources');
check('sources are listed by name', ['machine', 'demo', 'push', 'prod', 'orders', 'deploys'].every((n) => listed.json.sources.some((s) => s.name === n)), listed.json.sources.map((s) => s.name));
check('the list carries no credential and no address', !SECRETS.some((s) => listed.text.includes(s)) && !/http:\/\//.test(listed.text) && !listed.text.includes(String(promPort)));

const hits0 = leaks().length;
const asUrl = await api('/dashboard/fetch', { queries: [{ source: `http://127.0.0.1:${internalPort}/leak`, query: 'up' }, { source: '__proto__', query: 'up' }, { source: 'constructor', query: 'up' }, { source: 'prod', query: 'up', url: `http://127.0.0.1:${internalPort}/leak`, base: `http://127.0.0.1:${internalPort}/leak` }, { source: 'nope', query: 'x' }] });
check('a URL for a source is refused', asUrl.json.results[0].ok === false && /can't be a source name/.test(asUrl.json.results[0].why), asUrl.json.results[0]);
check('prototype names are not sources', asUrl.json.results[1].ok === false && asUrl.json.results[2].ok === false, asUrl.json.results[1]);
check('a request can\'t carry an address past the check', leaks().length === hits0, leaks());
check('an unknown source says where to declare it', /no source named "nope"/.test(asUrl.json.results[4].why) && /\.sources\.json/.test(asUrl.json.results[4].why), asUrl.json.results[4]);
const noRedirect = await api('/dashboard/fetch', { queries: [{ source: 'sneaky', query: 'up', start: nowS() - 60, end: nowS(), step: 1 }] });
check('a source that redirects is not followed', noRedirect.json.results[0].ok === false && /redirect/.test(noRedirect.json.results[0].why) && !internal.hits.some((h) => h.url === '/leak'), noRedirect.json.results[0]);

// Numbers pushed in.
check('a push source needs its token', (await api('/dashboard/push', { source: 'deploys', metric: 'count', value: 3 })).status === 401);
check('a wrong token is refused', (await api('/dashboard/push', { source: 'deploys', metric: 'count', value: 3 }, { Authorization: 'Bearer wrong' })).status === 401);
const pushed = await api('/dashboard/push', { source: 'deploys', metrics: { count: 3, duration: 0.5 } }, { Authorization: 'Bearer SECRET-PUSH-TOKEN' });
check('the right token works', pushed.status === 200 && pushed.json.stored === 2, pushed.text);
check('a source that is not a push source takes no pushes', (await api('/dashboard/push', { source: 'prod', metric: 'x', value: 1 })).status === 404);
check('a bad metric name is refused', (await api('/dashboard/push', { metric: '../../x', value: 1 })).status === 400);
check('a value that is not a number is refused', (await api('/dashboard/push', { metric: 'x', value: 'lots' })).status === 400);

// Bound to every interface, as the live deck does. A real connection from a real address.
const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
const wide = await startServer(0, { host: '0.0.0.0', quiet: true });
if (lan) {
  const remote = await raw('/dashboard/sources', { host: lan, port: wide.port, headers: { 'Content-Type': 'application/json', Host: `localhost:${wide.port}`, Origin: `http://localhost:${wide.port}` } }).catch((err) => ({ status: `could not connect: ${err.code}` }));
  check(`with HOST=0.0.0.0 a request from ${lan} is refused`, remote.status === 403, remote.status);
  const secret = await raw('/experiments/dashboard/.sources.json', { method: 'GET', host: lan, port: wide.port, headers: { Host: `${lan}:${wide.port}` } }).catch((err) => ({ status: `could not connect: ${err.code}` }));
  check('and the config file is not served there either', secret.status === 403, secret.status);
} else console.log('    this machine has no network address, so only the rule above covers HOST=0.0.0.0');
await wide.close();

// ===========================================================================
section('first open: real data, no setup');

const p = await page(context);
const app = (fn, ...args) => p.evaluate(fn, ...args);
const DASH = `${base}/experiments/dashboard/?theme=light`;

async function until(fn, what, seconds = 20, arg) {
  const deadline = Date.now() + seconds * 1000;
  let last;
  while (Date.now() < deadline) {
    last = await p.evaluate(fn, arg);
    if (last) return last;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${what}. Last: ${JSON.stringify(last)}. Page problems: ${JSON.stringify(p.problems.slice(-5))}`);
}

const shot = async (name) => {
  await sleep(250);
  await p.screenshot({ path: `${out}/${name}.png` }).catch(async () => { await sleep(2000); await p.screenshot({ path: `${out}/${name}.png`, timeout: 30000 }); });
};
const clearProblems = () => { p.problems.length = 0; };

await p.goto(DASH);
await until(() => !!window.app, 'the page to start', 60);
check('a first visit opens a real dashboard', await app(() => window.app.m.sceneId) === 'this-machine');
await until(() => window.app.readouts('computer').length > 2, 'this computer to show numbers', 30);

const machineLatest = async (metric) => {
  const end = nowS();
  const r = await api('/dashboard/fetch', { queries: [{ source: 'machine', query: metric, start: end - 60, end, step: 1 }] });
  const s = r.json.results[0].series[0];
  return { v: s.v.at(-1), t: s.t.at(-1), n: s.t.length };
};

const cpu = await machineLatest('cpu');
check('CPU is a real percentage', cpu.v >= 0 && cpu.v <= 100 && cpu.n > 0, cpu);
const disk = await machineLatest('disk');
if (process.platform !== 'win32') {
  const mount = process.platform === 'darwin' && fs.existsSync('/System/Volumes/Data') ? '/System/Volumes/Data' : '/';
  const row = execFileSync('df', ['-k', mount], { encoding: 'utf8' }).trim().split('\n').pop().trim().split(/\s+/);
  // Total and available, because on APFS df's Used is one volume and the space is shared.
  const total = Number(row[1]), avail = Number(row[3]);
  const fromDf = ((total - avail) / total) * 100;
  check('disk matches df on this machine', Math.abs(disk.v - fromDf) < 1, { shown: disk.v, df: +fromDf.toFixed(2) });
}
const memory = await machineLatest('memory');
check('memory is a real percentage', memory.v > 1 && memory.v <= 100, memory);
const load = await machineLatest('load');
const netIn = await machineLatest('net.in');
check('load and network report', load.v === os.loadavg()[0] || load.v >= 0, { load: load.v, netIn: netIn.v });
await until(() => window.app.statusOf('cpu') !== null && window.app.dash.panels.get('cpu').bindings.length === 1, 'the chart to read the box through its arrow', 15);
check('a chart with no source line reads the shape its arrow joins', await app(() => window.app.dash.panels.get('cpu').bindings[0].query) === 'cpu');
const words = await until(() => { const w = window.app.readouts('computer'); return w.some((x) => x === 'CPU') && w.includes('%') && w; }, 'CPU and % on the box');
check('the box shows names and units', words.includes('CPU') && words.includes('memory used') && words.includes('%'), words);
check('the time range and last update are on screen', /\d\d:\d\d:\d\d to \d\d:\d\d:\d\d/.test(await app(() => document.getElementById('range').textContent)) && /updated \d\d:\d\d:\d\d/.test(await app(() => document.getElementById('updated').textContent)));
await shot('01-first-open');
check('no page errors on first open', p.problems.length === 0, p.problems);

// ===========================================================================
// Drawings for the rest of the test, through the same file input a person uses.

let idCount = 0;
function draw(list) {
  const elements = [];
  const shapes = new Map();
  const common = { angle: 0, fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, version: 1, versionNonce: 1, isDeleted: false, updated: 1, link: null, locked: false };
  const label = (id, words, ownerId) => ({ ...common, id: `${id}-t`, type: 'text', x: 0, y: 0, width: 100, height: 20, strokeColor: '#1B2547', backgroundColor: 'transparent', roundness: null, seed: ++idCount, boundElements: null, text: words, originalText: words, fontSize: 20, fontFamily: 5, textAlign: 'center', verticalAlign: 'middle', containerId: ownerId, autoResize: true, lineHeight: 1.25 });
  for (const item of list) {
    if (item.arrow) continue;
    const el = { ...common, id: item.id, type: item.type ?? 'rectangle', x: item.x, y: item.y, width: item.w, height: item.h, strokeColor: '#1B2547', backgroundColor: 'transparent', roundness: { type: 3 }, seed: ++idCount, boundElements: [{ type: 'text', id: `${item.id}-t` }] };
    shapes.set(item.id, el);
    elements.push(el, label(item.id, item.label, item.id));
  }
  for (const item of list) {
    if (!item.arrow) continue;
    const a = shapes.get(item.from), b = shapes.get(item.to);
    const from = [a.x + a.width / 2, a.y + a.height / 2], to = [b.x + b.width / 2, b.y + b.height / 2];
    a.boundElements.push({ type: 'arrow', id: item.id });
    b.boundElements.push({ type: 'arrow', id: item.id });
    const el = { ...common, id: item.id, type: 'arrow', x: from[0], y: from[1], width: Math.abs(to[0] - from[0]), height: Math.abs(to[1] - from[1]), points: [[0, 0], [to[0] - from[0], to[1] - from[1]]], strokeColor: '#1B2547', backgroundColor: 'transparent', roundness: null, seed: ++idCount, boundElements: item.label ? [{ type: 'text', id: `${item.id}-t` }] : [], startBinding: { elementId: item.from, focus: 0, gap: 8 }, endBinding: { elementId: item.to, focus: 0, gap: 8 }, startArrowhead: null, endArrowhead: 'arrow', lastCommittedPoint: null, elbowed: false };
    elements.push(el);
    if (item.label) elements.push(label(item.id, item.label, item.id));
  }
  return { type: 'excalidraw', version: 2, source: 'test', elements, appState: {}, files: {} };
}

async function openDrawing(list, { name = 'test.excalidraw', files, span = 900 } = {}) {
  const doc = draw(list);
  if (files) doc.files = files;
  const file = path.join(configDir, name);
  fs.writeFileSync(file, JSON.stringify(doc));
  await p.setInputFiles('#file', file);
  await until((n) => window.app.m.title === n, `${name} to open`, 15, name);
  await app((s) => { window.app.setSpan(s); }, span);
  return doc;
}

const readouts = (id) => app((i) => window.app.readouts(i), id);
const statusOf = (id) => app((i) => window.app.statusOf(i), id);
// Words on a panel, checked here rather than in the page, because the page forbids eval.
async function wordsUntil(id, predicate, what, seconds = 15) {
  const deadline = Date.now() + seconds * 1000;
  let last;
  while (Date.now() < deadline) {
    last = await readouts(id);
    if (predicate(last)) return last;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${what} on ${id}. It says ${JSON.stringify(last)}. ${JSON.stringify(p.problems.slice(-3))}`);
}

async function statusUntil(id, level, seconds = 20) {
  const deadline = Date.now() + seconds * 1000;
  let last;
  while (Date.now() < deadline) {
    last = await statusOf(id);
    if (last?.level === level) return last;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${id} to be ${level}. It is ${JSON.stringify(last)}`);
}

// Where colored pixels of the series are in one column of a chart, as values on its axis.
const columnValues = (id, t, strip = 0, colorIndex = 0) => app(([id, t, strip, colorIndex]) => {
  const plot = window.app.plotOf(id);
  const s = plot.strips[strip];
  const canvas = window.app.board.canvas;
  const rect = canvas.getBoundingClientRect();
  const dpr = canvas.width / rect.width;
  const u = window.app.m.unit();
  const xStage = plot.plotX + ((t - plot.t0) / (plot.t1 - plot.t0)) * plot.plotW;
  const col = Math.round((window.app.toScreen(xStage, s.y).x - rect.left) * dpr);
  const top = Math.round((window.app.toScreen(xStage, s.y).y - rect.top) * dpr);
  const bottom = Math.round((window.app.toScreen(xStage, s.y + s.h).y - rect.top) * dpr);
  const hex = s.colors[colorIndex];
  const want = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  const data = canvas.getContext('2d').getImageData(col, top, 1, bottom - top + 1).data;
  const ys = [];
  for (let i = 0; i < bottom - top + 1; i++) {
    const d = Math.abs(data[i * 4] - want[0]) + Math.abs(data[i * 4 + 1] - want[1]) + Math.abs(data[i * 4 + 2] - want[2]);
    if (d < 60) ys.push(i);
  }
  if (!ys.length) return { found: false, min: s.min, max: s.max, height: bottom - top };
  const value = (i) => s.max - (i / (bottom - top)) * (s.max - s.min);
  return { found: true, low: value(Math.max(...ys)), high: value(Math.min(...ys)), perPixel: (s.max - s.min) / (bottom - top), min: s.min, max: s.max };
}, [id, t, strip, colorIndex]);

// ===========================================================================
section('files from Excalidraw itself');

// A file made by Excalidraw's own converter, kept with the runnable diagrams. Change one
// label in its JSON, as you would by typing in Excalidraw, and it is a dashboard.
const native = JSON.parse(fs.readFileSync(path.join(here, '../experiments/machine/scenes/from-excalidraw.excalidraw'), 'utf8'));
const boundText = native.elements.find((e) => e.type === 'text' && e.containerId);
const holder = native.elements.find((e) => e.id === boundText.containerId);
boundText.text = 'from excalidraw\nmachine: cpu\nwarn above 101 for 5s';
boundText.originalText = boundText.text;
const nativeFile = path.join(configDir, 'native.excalidraw');
fs.writeFileSync(nativeFile, JSON.stringify(native));
await p.setInputFiles('#file', nativeFile);
await until(() => window.app.m.title === 'native.excalidraw', 'the native file');
const nativePanel = await wordsUntil(holder.id, (w) => w.includes('%') && w.includes('CPU'), 'the native shape to show data');
const nativeStatus = await statusUntil(holder.id, 'ok');
check('a file from Excalidraw\'s own converter runs', nativePanel.includes('CPU') && nativeStatus.level === 'ok', { nativePanel, nativeStatus });

// Excalidraw wraps long labels by adding line breaks to `text`. What was typed is in `originalText`.
const wrapped = draw([{ id: 'wrap', x: 40, y: 40, w: 220, h: 170, label: 'x' }]);
const wrapText = wrapped.elements.find((e) => e.id === 'wrap-t');
wrapText.originalText = 'wrapped\nmachine: cpu\nwarn above 200 for 30s';
wrapText.text = 'wrapped\nmachine:\ncpu\nwarn above\n200 for 30s';
// Text placed inside a shape with no binding at all, as a quick drawing might be.
wrapped.elements.push(
  { id: 'loose', type: 'rectangle', x: 300, y: 40, width: 300, height: 170, angle: 0, strokeColor: '#1B2547', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, roundness: null, seed: 5, version: 1, versionNonce: 1, isDeleted: false, boundElements: [], groupIds: [], updated: 1, link: null, locked: false },
  { id: 'loose-text', type: 'text', x: 330, y: 70, width: 150, height: 50, angle: 0, strokeColor: '#1B2547', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, roundness: null, seed: 6, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, groupIds: [], updated: 1, link: null, locked: false, text: 'loose\nmachine: memory', originalText: 'loose\nmachine: memory', fontSize: 20, fontFamily: 5, textAlign: 'left', verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: 1.25 },
);
const wrappedFile = path.join(configDir, 'wrapped.excalidraw');
fs.writeFileSync(wrappedFile, JSON.stringify(wrapped));
await p.setInputFiles('#file', wrappedFile);
await until(() => window.app.m.title === 'wrapped.excalidraw', 'the wrapped file');
check('a label Excalidraw wrapped is read as it was typed', await app(() => { const b = window.app.dash.panels.get('wrap').bindings[0]; return b?.query === 'cpu' && b.rules[0]?.value === 200 && window.app.dash.issues.filter((i) => i.level === 'error').length === 0; }));
check('text placed inside a shape labels it', await app(() => window.app.dash.panels.get('loose').bindings[0]?.query === 'memory'));
check('and the shape reads as a box', (await wordsUntil('loose', (w) => w.includes('%'), 'the loose box')).includes('memory used'));

// ===========================================================================
section('Prometheus: drawn values match the source');

const wave = (t) => 50 + 30 * Math.sin(t / 40);
prom.series.set('rate_total', wave);
prom.series.set('errors_pct', () => 2);
prom.calls.length = 0;
await openDrawing([
  { id: 'c', x: 40, y: 40, w: 900, h: 420, label: 'requests\nchart\nprod: rate_total in req/s' },
  { id: 'b', x: 980, y: 40, w: 360, h: 200, label: 'api\nprod: rate_total in req/s\nprod: errors_pct in %' },
]);
const rows = await wordsUntil('c', (w) => w.includes('req/s'), 'the chart to show its number');
const firstCall = prom.calls.find((c) => c.path === '/api/v1/query_range' && c.query === 'rate_total');
check('a chart makes a range query', !!firstCall && firstCall.step >= 1 && firstCall.end > firstCall.start, firstCall);
check('the source\'s credential is sent to it', firstCall.auth === 'Bearer SECRET-PROM-TOKEN', firstCall.auth);
await sleep(1500);

// Pause, so what is drawn holds still while it is read back from the canvas.
await app(() => window.app.setLive(false));
await until(() => window.app.plotOf('c')?.strips[0].hasData, 'the plot to have data');
await sleep(300);
const plotted = await app(() => window.app.plotOf('c'));
const unitRow = plotted.strips[0];
check('the axis has its unit', unitRow.unitShown === 'req/s', unitRow.unitShown);
check('the axis has real ticks', unitRow.ticks.length >= 3 && unitRow.labels.length === unitRow.ticks.length && unitRow.ticks.every((tick) => Number.isFinite(tick) && Math.abs(tick / (unitRow.ticks[1] - unitRow.ticks[0]) - Math.round(tick / (unitRow.ticks[1] - unitRow.ticks[0]))) < 1e-6), unitRow.labels);
let matched = 0;
const span = plotted.t1 - plotted.t0;
for (const frac of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
  const t = Math.round(plotted.t0 + span * frac);
  const col = await columnValues('c', t);
  const expected = wave(t);
  assert.ok(col.found, `the line is drawn at ${t}`);
  // One column of pixels, for a 2px line: the value is within the stroke, plus a pixel's worth of time.
  const slack = col.perPixel * 3 + 30 * (1 / 40) * (span / plotted.plotW);
  assert.ok(expected >= col.low - slack && expected <= col.high + slack, `drawn ${col.low}..${col.high}, source ${expected}, slack ${slack}`);
  matched++;
}
check('the line\'s pixels match the source at every sample checked', matched === 7, { matched });

// Paused, every shape shows the last moment of the range.
const latest = await app(() => { const st = window.app.m.data.seriesOf(window.app.dash.panels.get('c').bindings[0], 'chart')[0]; return st.series.at(window.app.m.range().t1, st.st.interval * 3); });
const shownNow = await readouts('c');
check('the number drawn is the source\'s value at the newest sample', shownNow.includes(showValue(wave(latest.t), 'req/s').split(' ')[0]), { shown: shownNow, source: wave(latest.t) });
const inBox = await readouts('b');
check('the box draws the same number', inBox.includes(showValue(wave(latest.t), 'req/s').split(' ')[0]) && inBox.includes('req/s') && inBox.includes('2'), inBox);
await app(() => window.app.setLive(true));
await shot('02-prometheus');

// Instant queries, and many series from one query.
prom.series.set('up_by_job', [{ metric: { job: 'api' }, fn: () => 3 }, { metric: { job: 'db' }, fn: () => 2 }, { metric: { job: 'web' }, fn: () => 7 }]);
prom.calls.length = 0;
await openDrawing([
  { id: 't', x: 40, y: 40, w: 420, h: 260, label: 'targets\ntable\nprod: up_by_job in targets' },
  { id: 'c2', x: 500, y: 40, w: 700, h: 260, label: 'by job\nchart\nprod: up_by_job in targets' },
]);
const tableRows = await wordsUntil('t', (w) => w.includes('7 targets'), 'one row per series');
check('a table makes an instant query', prom.calls.some((c) => c.path === '/api/v1/query' && c.query === 'up_by_job'));
check('a table has a row for each series, biggest first', tableRows.indexOf('web') < tableRows.indexOf('api') && tableRows.indexOf('api') < tableRows.indexOf('db'), tableRows);
const legend = await wordsUntil('c2', (w) => w.includes('web'), 'a legend for many series');
check('a chart of many series has a legend naming each', legend.includes('api') && legend.includes('db') && legend.includes('web'), legend);
const colors = await app(() => window.app.plotOf('c2').strips[0].colors);
check('each series has its own color', new Set(colors).size === 3, colors);

// More series than colors: the rest are gray and named as such, never a ninth hue.
prom.series.set('many', Array.from({ length: 12 }, (_, i) => ({ metric: { pod: `pod-${i}` }, fn: () => 10 + i })));
await openDrawing([{ id: 'many', x: 40, y: 40, w: 900, h: 340, label: 'many\nchart\nprod: many in req/s' }]);
await until(() => window.app.plotOf('many')?.strips[0].colors.length === 12, 'twelve series');
const manyColors = await app(() => window.app.plotOf('many').strips[0].colors);
check('past 8 series, the rest are one gray', new Set(manyColors.slice(0, 8)).size === 8 && new Set(manyColors.slice(8)).size === 1, manyColors);
const manyWords = await readouts('many');
check('and the legend says how many it left out', manyWords.some((x) => /^\+\d+ more$/.test(x)), manyWords);

// A real shape: sum by (handler) gives 64 series sorted by label, and the first 8 are all
// zero. Colors and legend places must go to the busy ones, wherever the source listed them.
const HANDLERS = 'sum by (handler) (rate(prometheus_http_requests_total[1m]))';
const idleNames = ['/', '/-/healthy', '/-/quit', '/-/ready', '/-/reload', '/alerts', '/api/v1/admin/tsdb/clean_tombstones', '/api/v1/admin/tsdb/delete_series'];
const busyNames = ['/api/v1/query', '/api/v1/query_range', '/api/v1/series', '/api/v1/labels', '/metrics', '/query', '/rules'];
// Two series at the edge of the last color, taking turns to set a new high every second. If a
// place followed every change, these two would swap colors every second.
const leapNames = ['/leap/a', '/leap/b'];
const leap = (odd) => (t) => (Math.floor(t) % 2 === odd ? 60 + (Math.floor(t) % 1000) * 0.001 : 50);
const fillerNames = Array.from({ length: 46 }, (_, i) => `/idle/${String(i).padStart(2, '0')}`);
const busyLevel = new Map(busyNames.map((name, i) => [name, 100 - i * 5]));
// They wander by 3% a second, enough to swap places if places followed every change.
const jitter = (name, t) => { let h = 0; for (const c of `${name}${Math.floor(t)}`) h = (h * 31 + c.charCodeAt(0)) >>> 0; return 1 + ((h % 61) - 30) / 1000; };
const climb = steps(0);
const boosts = new Map(leapNames.map((name) => [name, steps(1)]));
const handlerRows = [...idleNames, ...fillerNames, '/new', ...busyNames, ...leapNames].sort().map((handler) => ({
  metric: { handler },
  fn: handler === '/new' ? climb : handler === '/leap/a' ? (t) => leap(0)(t) * boosts.get('/leap/a')(t) : handler === '/leap/b' ? (t) => leap(1)(t) * boosts.get('/leap/b')(t) : busyLevel.has(handler) ? (t) => busyLevel.get(handler) * jitter(handler, t) : () => 0,
}));
prom.series.set(HANDLERS, handlerRows);
await openDrawing([{ id: 'handlers', x: 40, y: 40, w: 1300, h: 460, label: `requests by handler\nchart\nprod: ${HANDLERS} in req/s` }], { span: 300 });
await until(() => window.app.plotOf('handlers')?.strips[0].names.length === 64, '64 series');
const colorsOf = () => app(() => { const s = window.app.plotOf('handlers').strips[0]; return Object.fromEntries(s.names.map((n, i) => [n, s.colors[i]])); });
const handlerPlot = await app(() => window.app.plotOf('handlers').strips[0]);
const topEight = handlerPlot.names.slice(0, 8);
check('the 8 largest series get the colors, wherever the source listed them', new Set(handlerPlot.colors.slice(0, 8)).size === 8 && busyNames.every((n) => topEight.includes(n)) && topEight.filter((n) => leapNames.includes(n)).length === 1, topEight);
check('in order of size', handlerPlot.names[0] === '/api/v1/query', handlerPlot.names.slice(0, 3));
const gray = await app(() => window.app.m.theme.other);
check('everything else is gray', handlerPlot.colors.slice(8).every((c) => c === gray), new Set(handlerPlot.colors.slice(8)).size);
const handlerWords = await wordsUntil('handlers', (w) => w.some((x) => /^\+\d+ more$/.test(x)), 'the legend');
check('the legend names the busy ones and says how many it left out', handlerWords.includes('/api/v1/query') && !idleNames.some((n) => handlerWords.includes(n)), handlerWords.slice(0, 12));
const leapHolder = topEight.find((n) => leapNames.includes(n));
await shot('02c-many-series-ranked');
const colorsBefore = await colorsOf();
let colorChanges = 0;
for (let i = 0; i < 7; i++) {
  await sleep(1100);
  const next = await colorsOf();
  for (const name of Object.keys(next)) if (next[name] !== colorsBefore[name]) colorChanges++;
}
check('no series changes color from one second to the next, even two trading the lead', colorChanges === 0, { colorChanges, leapHolder });
// Nor does looking at another range reshuffle series that are nearly equal.
await p.click('[data-span="900"]');
await until(() => { const p_ = window.app.plotOf('handlers'); return Math.abs(p_.t1 - p_.t0 - 900) < 0.5; }, 'the wider range');
const colorsWider = await colorsOf();
check('another range does not swap the colors of series that are nearly equal', Object.keys(colorsBefore).every((n) => colorsWider[n] === colorsBefore[n]), Object.keys(colorsBefore).filter((n) => colorsWider[n] !== colorsBefore[n]));
await p.click('[data-span="300"]');
await until(() => { const p_ = window.app.plotOf('handlers'); return Math.abs(p_.t1 - p_.t0 - 300) < 0.5; }, 'the narrower range');
// A series that becomes clearly the largest earns a place. It takes the place of the smallest, and nobody else changes.
const smallest = handlerPlot.names[7];
climb.set(500);
await until(() => window.app.plotOf('handlers').strips[0].names[0] === '/new', 'the new largest series to lead', 15);
const colorsAfter = await colorsOf();
check('a series that grows past the rest takes the color of the one it displaces', colorsAfter['/new'] === colorsBefore[smallest] && colorsAfter[smallest] === gray, { new: colorsAfter['/new'], was: colorsBefore[smallest] });
check('and every other series keeps its color', [...busyNames, ...leapNames].filter((n) => n !== smallest).every((n) => colorsAfter[n] === colorsBefore[n]));
check('and leads the legend', (await wordsUntil('handlers', (w) => w.includes('/new'), 'the legend to name it')).includes('/new'));
// The one it displaced comes back bigger still. It can't have its old color back, because a
// series that holds a color keeps it. It takes the color of whoever it displaces this time.
const nextOut = await app(() => window.app.plotOf('handlers').strips[0].names[7]);
boosts.get(smallest).set(30);
await until((n) => window.app.plotOf('handlers').strips[0].names[0] === n, 'the displaced series to come back', 15, smallest);
const colorsThird = await colorsOf();
check('a series that comes back does not take a color from one that holds it', colorsThird['/new'] === colorsAfter['/new'], { new: colorsThird['/new'], back: colorsThird[smallest] });
check('it takes the color of the one it displaces this time', colorsThird[smallest] === colorsAfter[nextOut] && colorsThird[nextOut] === gray, { back: colorsThird[smallest], nextOut, was: colorsAfter[nextOut] });

// As on a real Prometheus with little traffic: many series and only 3 of them moving. The zeros
// must not hold colors, or each one loses its color as soon as a real one wakes up.
const wakes = steps(0);
const fewRows = [...fillerNames.map((handler) => ({ metric: { handler }, fn: () => 0 })), { metric: { handler: '/x/a' }, fn: () => 50 }, { metric: { handler: '/x/b' }, fn: () => 30 }, { metric: { handler: '/x/c' }, fn: () => 20 }, { metric: { handler: '/x/d' }, fn: wakes }];
prom.series.set('few_busy', fewRows);
await openDrawing([{ id: 'few', x: 40, y: 40, w: 1300, h: 400, label: 'few busy\nchart\nprod: few_busy in req/s' }], { span: 300 });
await until(() => window.app.plotOf('few')?.strips[0].names.length === 50, '50 series');
const fewColors = () => app(() => { const s = window.app.plotOf('few').strips[0]; return Object.fromEntries(s.names.map((n, i) => [n, s.colors[i]])); });
const fewBefore = await fewColors();
check('with more series than colors, a series at zero gets no color', Object.entries(fewBefore).filter(([, c]) => c !== gray).map(([n]) => n).sort().join() === '/x/a,/x/b,/x/c', Object.entries(fewBefore).filter(([, c]) => c !== gray).map(([n]) => n));
const fewWords = await wordsUntil('few', (w) => w.includes('/x/a'), 'the legend');
check('and no legend place', !fillerNames.some((n) => fewWords.includes(n)), fewWords.slice(0, 8));
wakes.set(10);
await until(() => { const s = window.app.plotOf('few').strips[0]; return s.colors[s.names.indexOf('/x/d')] !== window.app.m.theme.other; }, 'a series waking up to get a color', 15);
const fewAfter = await fewColors();
check('a series that wakes up takes a free color, and nobody else changes', ['/x/a', '/x/b', '/x/c'].every((n) => fewAfter[n] === fewBefore[n]) && !['/x/a', '/x/b', '/x/c'].some((n) => fewAfter[n] === fewAfter['/x/d']), { d: fewAfter['/x/d'] });
// With few series there is nothing to compete for, so even one at zero keeps its color and name.
prom.series.set('two_lines', [{ metric: { job: 'a' }, fn: () => 100 }, { metric: { job: 'b' }, fn: () => 0 }]);
await openDrawing([{ id: 'twoz', x: 40, y: 40, w: 900, h: 300, label: 'two\nchart\nprod: two_lines in req/s' }], { span: 300 });
const twoWords = await wordsUntil('twoz', (w) => w.includes('a') && w.includes('b'), 'both names in the legend');
const twoColors = await app(() => window.app.plotOf('twoz').strips[0].colors);
check('with 8 or fewer series, a series at zero keeps its color and its name', new Set(twoColors).size === 2 && !twoColors.includes(gray), { twoColors, twoWords });

// More series than the server keeps: the largest stay, not the first alphabetically.
prom.series.set('too_many', Array.from({ length: 230 }, (_, i) => ({ metric: { pod: `pod-${String(i).padStart(3, '0')}` }, fn: () => i })));
await openDrawing([{ id: 'capped', x: 40, y: 40, w: 1000, h: 340, label: 'too many\nchart\nprod: too_many in req/s' }], { span: 300 });
await until(() => window.app.plotOf('capped')?.strips[0].names.length === 200, 'the kept series');
const capped = await app(() => window.app.plotOf('capped').strips[0].names);
check('past 200 series, the largest are kept', capped[0] === 'pod-229' && !capped.includes('pod-000'), capped.slice(0, 3));
const cappedWords = await readouts('capped');
check('and the legend counts the ones left out', cappedWords.some((x) => /^\+2\d\d more$/.test(x)), cappedWords.filter((x) => /more/.test(x)));
await app(() => window.app.select('capped'));
check('and the inspector says so', await until(() => /largest 200 of its 230 series/.test(document.getElementById('inspector').innerText), 'the note', 5));

// A one-row table. The labels say which row it is, and the query does not.
prom.series.set('count by (job) (up)', [{ metric: { job: 'prometheus' }, fn: () => 1 }]);
prom.series.set('count(up == 1)', [{ metric: {}, fn: () => 1 }]);
prom.series.set('up', [{ metric: { __name__: 'up', instance: 'localhost:9397', job: 'prometheus' }, fn: () => 1 }]);
await openDrawing([
  { id: 'onejob', x: 40, y: 40, w: 420, h: 170, label: 'targets by job\ntable\nprod: count by (job) (up) in targets' },
  { id: 'nolabels', x: 480, y: 40, w: 420, h: 170, label: 'targets up\ntable\nprod: count(up == 1) in targets' },
  { id: 'twolabels', x: 920, y: 40, w: 480, h: 170, label: 'up\ntable\nprod: up in targets' },
]);
const oneJob = await wordsUntil('onejob', (w) => w.includes('1 targets'), 'the one row');
check('a table with one row is named by its labels', oneJob.includes('prometheus') && !oneJob.some((x) => /count by/.test(x)), oneJob);
const noLabels = await wordsUntil('nolabels', (w) => w.includes('1 targets'), 'the row with no labels');
check('a row with no labels keeps the query\'s name', noLabels.some((x) => x.startsWith('count(up')), noLabels);
const twoLabels = await wordsUntil('twolabels', (w) => w.includes('1 targets'), 'the row with two labels');
check('a row with several labels shows their values, in full where they fit', twoLabels.some((x) => /^localhost:9397 prometheus/.test(x)) && !twoLabels.some((x) => /__name__|instance=/.test(x)), twoLabels);
await app(() => window.app.select('onejob'));
check('the inspector\'s values use the same name', await until(() => /prometheus/.test(document.getElementById('inspector').querySelector('table')?.innerText ?? ''), 'the inspector', 5));
await app(() => window.app.select(null));

// Different units are separate strips, never a second axis.
await openDrawing([{ id: 'two', x: 40, y: 40, w: 800, h: 520, label: 'two units\nchart\nprod: rate_total in req/s\nprod: errors_pct in %' }]);
await until(() => window.app.plotOf('two')?.strips.every((s) => s.hasData), 'both strips to have data');
const strips = await app(() => window.app.plotOf('two').strips.map((s) => ({ unit: s.unit, min: s.min, max: s.max, y: s.y, h: s.h })));
check('two units get two strips, each with its own axis', strips.length === 2 && strips[0].unit === 'req/s' && strips[1].unit === '%' && strips[0].y + strips[0].h <= strips[1].y, strips);

// How often to ask is the label's to say.
await openDrawing([{ id: 'ev', x: 40, y: 40, w: 340, h: 170, label: 'slowly\nprod: errors_pct in %\nevery 3s' }]);
await wordsUntil('ev', (w) => w.includes('2'), 'the slow panel');
prom.calls.length = 0;
await sleep(6500);
const slowCalls = prom.calls.filter((c) => c.query === 'errors_pct').length;
check('"every 3s" asks every 3 seconds', slowCalls >= 2 && slowCalls <= 3, { slowCalls });

// A query Prometheus rejects.
await openDrawing([
  { id: 'badq', x: 40, y: 40, w: 600, h: 300, label: 'broken\nchart\nprod: rate(' },
  { id: 'badb', x: 680, y: 40, w: 340, h: 170, label: 'broken box\nprod: rate(' },
  { id: 'badt', x: 680, y: 230, w: 340, h: 170, label: 'broken table\ntable\nprod: rate(' },
  { id: 'nosuchm', x: 40, y: 360, w: 600, h: 200, label: 'no such metric\nprod: nosuchmetric_total in req/s' },
]);
const rejected = await statusUntil('badq', 'failed');
check('a rejected query says which source and why', /^prod rejected the query/.test(rejected.why) && /parse error/.test(rejected.why), rejected);
const noSuch = await statusUntil('nosuchm', 'nodata');
check('a metric that does not exist is no data, not a failure, as Prometheus answers it', /no data in this range/.test(noSuch.why), noSuch);
// Looking back: the query is no more valid then than it is now.
await app(() => window.app.setMoment(Date.now() / 1000 - 120));
await sleep(600);
for (const id of ['badq', 'badb', 'badt']) {
  const then = await statusOf(id);
  check(`looking back, ${id} still says the query was rejected`, then.level === 'failed' && /rejected the query/.test(then.why) && !/no data/.test(then.why), then);
  const drawn = await readouts(id);
  check(`and draws that, not "no data": ${id}`, drawn.some((x) => /rejected the query/.test(x)) && !drawn.some((x) => /no data/.test(x)), drawn);
  check(`and says it once: ${id}`, drawn.filter((x) => /rejected the query/.test(x)).length === 1, drawn);
}
await shot('02b-rejected-looking-back');
await app(() => window.app.setLive(true));
clearProblems();

// A source that is down when the page opens. Nothing is known about the past, so it can't say
// "no data" about it. When the source comes back, its history must load, not only what is new.
const known = 40;
prom.series.set('down_then_up', () => known);
prom.mode = '500';
await openDrawing([{ id: 'dtu', x: 40, y: 40, w: 800, h: 300, label: 'later\nchart\nprod: down_then_up in req/s' }], { span: 300 });
await statusUntil('dtu', 'failed');
await app(() => window.app.setMoment(Date.now() / 1000 - 120));
await sleep(500);
const downThen = await statusOf('dtu');
check('looking back at a range that never loaded says the source failed', downThen.level === 'failed' && /prod failed/.test(downThen.why), downThen);
await app(() => window.app.setLive(true));
prom.mode = 'ok';
await statusUntil('dtu', 'none');
const coverage = await until(() => { const c = window.app.dash.panels.get('dtu').chart; const s = c?.lines[0]?.series; return s?.n > 100 && { n: s.n, gaps: c.strips[0].gaps }; }, 'its history to load', 15);
check('a source that comes back brings its history, not only what is new', coverage.gaps.length === 0, coverage);
// A connection dropped for a few seconds, from a source that kept its data, leaves no hole.
prom.mode = '500';
await statusUntil('dtu', 'failed');
// Long enough that a hole, if one were left, is wider than the 3 s that counts as a gap.
await sleep(8000);
prom.mode = 'ok';
await statusUntil('dtu', 'none');
await sleep(1500);
const afterDrop = await app(() => window.app.plotOf('dtu').strips[0].gaps);
check('a dropped connection leaves no hole when the source still has the data', afterDrop.length === 0, afterDrop);
clearProblems();

// ===========================================================================
section('trustworthy data: gaps, staleness and failures');

// A hole in the data, then data again. Nothing is drawn across it.
const holeFrom = Math.floor(nowS()) - 240, holeTo = holeFrom + 90;
prom.series.set('holey', (t) => (t >= holeFrom && t < holeTo ? null : 40));
await openDrawing([{ id: 'g', x: 40, y: 40, w: 1100, h: 420, label: 'a hole\nchart\nprod: holey in req/s\naxis 0 to 100' }], { span: 900 });
await until(() => window.app.plotOf('g')?.strips[0].hasData, 'the holed line');
await app(() => window.app.setLive(false));
await sleep(500);
const inHole = [];
for (const k of [0.1, 0.3, 0.5, 0.7, 0.9]) inHole.push(await columnValues('g', holeFrom + 90 * k));
check('no line is drawn across a gap', inHole.every((c) => !c.found), inHole);
const beside = await columnValues('g', holeFrom - 20);
const after = await columnValues('g', holeTo + 20);
check('the line is there on both sides of it', beside.found && after.found && Math.abs(beside.low - 40) < 2, { beside, after });
const namedGaps = await app(() => window.app.plotOf('g').strips[0].gaps);
check('the gap is known to the chart, as the time it covers', namedGaps.some(([a, b]) => a <= holeFrom + 1 && b >= holeTo - 1), namedGaps);
await shot('03-gap');
await app(() => window.app.setLive(true));

// NaN is a gap too.
prom.series.set('nans', (t) => (Math.floor(t / 60) % 2 ? 'NaN' : 5));
await openDrawing([{ id: 'n', x: 40, y: 40, w: 800, h: 300, label: 'NaN\nchart\nprod: nans in req/s' }], { span: 600 });
await until(() => window.app.plotOf('n')?.strips[0].gaps.length > 2, 'NaN to become gaps', 15);
check('NaN from a source is a gap, not a zero', true);

// Data that stops. The panel must say so, and an alert must not say OK.
const stop = { at: Infinity };
prom.series.set('stops', (t) => (t >= stop.at ? null : 40));
await openDrawing([
  { id: 'stale', x: 40, y: 40, w: 800, h: 300, label: 'stops\nchart\nprod: stops in req/s\nwarn above 90 for 1s\nstale after 3s' },
  { id: 'staleBox', x: 880, y: 40, w: 340, h: 180, label: 'a box\nprod: stops in req/s\nwarn above 90 for 1s\nstale after 3s' },
  { id: 'wall-of-it', x: 880, y: 240, w: 340, h: 180, label: 'alerts' },
]);
await statusUntil('stale', 'ok');
check('a healthy shape says OK', (await statusOf('staleBox')).level === 'ok');
await wordsUntil('staleBox', (w) => w.includes('OK'), 'the word OK on the box');
stop.at = nowS();
const staled = await statusUntil('stale', 'nodata', 20);
check('stale data says no data on the panel, with how long', /no data for \d+/.test(staled.why), staled);
const staleBox = await wordsUntil('staleBox', (w) => w.includes('NO DATA') && w.some((x) => /no data for \d+/.test(x)), 'no data in words on the box');
check('a stale box does not show its old number as current', !staleBox.includes('40'), staleBox);
check('a stale chart says it in words on the plot', (await readouts('stale')).some((x) => /no data for \d+/.test(x)), await readouts('stale'));
// The frame follows on the next redraw of the board.
const dashed = await until(() => window.app.board.get('stale').strokeStyle === 'dashed' && 'dashed', 'the frame to go dashed', 5);
check('a shape with no data is dashed as well, so it does not rely on color', dashed === 'dashed', dashed);
const pill = await until(() => document.getElementById('firing').textContent, 'the pill');
check('the overview does not call no data fine', /no data/.test(pill) && !/ok/.test(pill), pill);
await shot('04-stale');
stop.at = Infinity;

// A source that fails, in each way a source can. The panel names the source and the reason.
prom.series.set('fine', () => 7);
await openDrawing([
  { id: 'f', x: 40, y: 40, w: 800, h: 300, label: 'prod panel\nchart\nprod: fine in req/s' },
  { id: 'd', x: 880, y: 40, w: 340, h: 170, label: 'dead panel\ndead: up in targets' },
  { id: 's', x: 880, y: 230, w: 340, h: 170, label: 'sneaky\nsneaky: up in targets' },
  { id: 'nosuch', x: 40, y: 360, w: 800, h: 180, label: 'nothing\nnosuch: up in targets' },
]);
await statusUntil('f', 'none');
const deadStatus = await statusUntil('d', 'failed');
check('connection refused names the source and the reason', /dead failed: connection refused/.test(deadStatus.why), deadStatus);
const sneak = await statusUntil('s', 'failed');
check('a redirect is reported, not followed', /sneaky failed/.test(sneak.why) && /redirect/.test(sneak.why), sneak);
const nosuch = await statusUntil('nosuch', 'failed');
check('a source nobody declared says so', /no source named "nosuch"/.test(nosuch.why), nosuch);
prom.mode = '500';
const failed500 = await statusUntil('f', 'failed');
check('a 500 names the source and the reason', /prod failed: it answered 500/.test(failed500.why), failed500);
await wordsUntil('f', (w) => w.some((x) => /prod failed/.test(x)), 'the failure on the plot');
const pillFail = await app(() => document.getElementById('firing').textContent);
check('the overview names what failed', /prod/.test(pillFail) && /dead/.test(pillFail), pillFail);
const noSecret = await app(() => document.body.innerText);
check('no credential or address reaches the page', !SECRETS.some((s) => noSecret.includes(s)) && !noSecret.includes(`127.0.0.1:${promPort}`));
await shot('05-failed-sources');
prom.mode = 'hang';
prom.hangMs = 4000;
const slow = await until(() => { const s = window.app.statusOf('f'); return /no answer in time/.test(s?.why ?? '') && s; }, 'a timeout to be reported', 15);
check('a source that hangs says so', /prod failed: no answer in time/.test(slow.why), slow);
prom.mode = 'ok';
const back = await statusUntil('f', 'none', 15);
check('a source that recovers clears by itself', back.level === 'none');

// The page's server going away. Nothing on the page may claim to be current.
await p.route('**/dashboard/**', (route) => route.abort());
const down = await until(() => { const t = document.getElementById('trouble'); return !t.hidden && /not answering/.test(t.textContent) && t.textContent; }, 'the page to say the server is gone', 15);
check('a server that goes away is said in words, with the last time', /not answering/.test(down) && /newer than \d\d:\d\d:\d\d/.test(down), down);
await statusUntil('f', 'nodata', 25);
check('and its shapes go to no data', true);
await p.unroute('**/dashboard/**');
await until(() => document.getElementById('trouble').hidden, 'the page to recover', 15);
clearProblems();

// A JSON URL, polled on the server.
await openDrawing([
  { id: 'j', x: 40, y: 40, w: 340, h: 170, label: 'orders\norders: qps\nerror share = orders: requests.errorPercent in %' },
  { id: 'jbad', x: 420, y: 40, w: 420, h: 170, label: 'wrong path\norders: no.such.path' },
]);
const jsonWords = await wordsUntil('j', (w) => w.includes('12.5') && w.includes('req/s') && w.includes('0.25'), 'numbers from the JSON source');
check('a JSON source shows a declared field and any path', jsonWords.includes('requests') && jsonWords.includes('error share'), jsonWords);
check('its declared header is sent', internal.hits.some((h) => h.url === '/stats' && h.key === 'SECRET-JSON-KEY'));
const wrongPath = await statusUntil('jbad', 'failed');
check('a path that is not in the answer says what is', /no number at "no\.such\.path"/.test(wrongPath.why) && /requests\.perSecond/.test(wrongPath.why), wrongPath);
internal.stats.requests.perSecond = 99;
await wordsUntil('j', (w) => w.includes('99'), 'the new JSON value');
internal.mode = 'fail';
const jsonFail = await statusUntil('j', 'failed', 15);
check('a failing JSON source names itself and the reason', /orders failed: it answered 503/.test(jsonFail.why), jsonFail);
internal.mode = 'ok';
await statusUntil('j', 'none', 15);

// An HTTP push, from outside the page.
await openDrawing([{ id: 'pu', x: 40, y: 40, w: 340, h: 170, label: 'deploys\ndeploys: count in deploys\nstale after 2s' }]);
await api('/dashboard/push', { source: 'deploys', metrics: { count: 41 } }, { Authorization: 'Bearer SECRET-PUSH-TOKEN' });
await wordsUntil('pu', (w) => w.includes('41'), 'the pushed number');
await api('/dashboard/push', { source: 'deploys', metrics: { count: 42 } }, { Authorization: 'Bearer SECRET-PUSH-TOKEN' });
await wordsUntil('pu', (w) => w.includes('42'), 'the next pushed number');
check('a pushed number reaches the drawing', true);
await statusUntil('pu', 'nodata', 15);
check('a push that stops goes stale', true);

// The config file is read again when it changes, and a mistake in it is said out loud.
const goodConfig = fs.readFileSync(configFile, 'utf8');
const withLater = JSON.parse(goodConfig);
withLater.sources.later = { type: 'push', every: '1s' };
fs.writeFileSync(configFile, JSON.stringify(withLater));
await app(() => window.app.m.refreshSources());
await until(() => window.app.m.catalog.has('later'), 'a new source to appear', 10);
check('a source added to the config appears with no restart', true);
fs.writeFileSync(configFile, '{ this is not json');
await app(() => window.app.m.refreshSources());
const configWords = await until(() => document.getElementById('config-error')?.textContent, 'the config mistake to show', 10);
check('a config file that is not JSON says so', /not valid JSON/.test(configWords), configWords);
check('and the built-in sources keep working', await app(() => window.app.m.catalog.has('machine') && window.app.m.catalog.has('demo')));
withLater.sources['bad name!'] = { type: 'push' };
withLater.sources.wrong = { type: 'graphite' };
withLater.sources.machine = { type: 'push' };
fs.writeFileSync(configFile, JSON.stringify(withLater));
await app(() => window.app.m.refreshSources());
await until(() => /can't be a source name/.test(document.getElementById('config-error')?.textContent ?? ''), 'bad names to be refused', 10);
check('a source can\'t take a built-in name or a bad one', await app(() => window.app.m.catalog.get('machine').type === 'this computer'));
const wrongType = await app(() => window.app.m.catalog.get('wrong'));
check('a source of an unknown type says so', wrongType.ok === false && /only prometheus, json and push exist/.test(wrongType.why), wrongType.why);
fs.writeFileSync(configFile, goodConfig);
await app(() => window.app.m.refreshSources());
await until(() => !window.app.m.catalog.has('later') && !document.getElementById('config-error'), 'the config to recover', 10);

// ===========================================================================
section('alerts on the drawing');

const level = steps(10);
prom.series.set('alerted', level);
await openDrawing([
  { id: 'ac', x: 40, y: 40, w: 840, h: 340, label: 'errors\nchart\nprod: alerted in %\nwarn above 50 for 2s\ncritical above 80 for 2s\naxis 0 to 100' },
  { id: 'ab', x: 920, y: 40, w: 360, h: 170, label: 'api\nprod: alerted in %\nwarn above 50 for 2s\ncritical above 80 for 2s' },
  { id: 'aa', x: 920, y: 230, w: 360, h: 300, label: 'alerts' },
], { span: 300 });
await statusUntil('ab', 'ok');
check('the shape says OK with a word', (await wordsUntil('ab', (w) => w.includes('OK'), 'OK')).includes('OK'));
level.set(60);
const pending = await statusUntil('ab', 'pending');
check('crossing a level is pending first, and says how long until it fires', /until warn/.test(pending.why), pending);
const warned = await statusUntil('ab', 'warn');
check('holding it fires, with the reason', /60% above 50%/.test(warned.why), warned);
await wordsUntil('ab', (w) => w.includes('WARN'), 'the word WARN on the box');
check('the frame changes as well as the word', await app(() => { const e = window.app.board.get('ab'); return e.strokeColor === '#a35200' && e.strokeWidth === 3; }));
const warnPill = await until(() => { const f = document.getElementById('firing'); return /warn/.test(f.textContent) && f.textContent; }, 'the overview pill');
check('the overview says what is firing', /1 warn/.test(warnPill), warnPill);
await shot('06-warn');
level.set(90);
const critical = await statusUntil('ab', 'critical');
check('critical beats warn', /90% above 80%/.test(critical.why), critical);
await wordsUntil('ab', (w) => w.includes('CRITICAL'), 'the word CRITICAL on the box');
const alertWords = await wordsUntil('aa', (w) => w.some((x) => /2 firing|1 firing/.test(x)), 'the alerts panel');
check('the alerts panel lists it', alertWords.some((x) => /api|errors/.test(x)), alertWords);
level.set(10);
await statusUntil('ab', 'ok');
const history = await until(() => { const l = window.app.m.transitions.map((t) => t.words); return l.some((w) => /critical ended/.test(w)) && l; }, 'the history of changes');
check('the history records firing and resolving', history.some((w) => /: warn$/.test(w)) && history.some((w) => /: critical$/.test(w)) && history.some((w) => /critical ended/.test(w)), history);
const changes = await app(() => document.getElementById('inspector').innerText);
check('the inspector overview shows the history', /What changed/i.test(changes), changes.slice(0, 200));
const strip = await until(() => { const c = window.app.dash.panels.get('ac').chart; return c?.strips[0].spans.some((s) => s.level === 'critical') && c.strips[0].spans.map((s) => s.level); }, 'state along the chart');
check('the chart carries the state over time', strip.includes('critical') && strip.includes('warn'), strip);
// The chart is rebuilt on the frame after new data, so give it that frame.
const marks = await until(() => { const l = window.app.dash.panels.get('ac').chart.strips[0].transitions.map((t) => t.to); return l.includes('firing') && l.includes('ok') && l; }, 'the marks on the chart', 5);
check('and marks each transition on the chart', true, marks);
await shot('07-after-alert');

// ===========================================================================
section('titles: the status gives way, not the name');

const titleLevel = steps(10);
prom.series.set('titled', titleLevel);
const rulesOn = 'prod: titled in conns\nwarn above 50\ncritical above 80\nstale after 2s';
const TITLE = 'db connections';
const titled = [
  ['t-box', `${TITLE}\n${rulesOn}`],
  ['t-stat', `${TITLE}\nstat\n${rulesOn}`],
  ['t-meter', `${TITLE}\nmeter 0 to 100\n${rulesOn}`],
  ['t-table', `${TITLE}\ntable\n${rulesOn}`],
  ['t-chart', `${TITLE}\nchart\n${rulesOn}`],
  ['t-short', `${TITLE}\n${rulesOn}`],
  ['t-shorter', `${TITLE}\nchart\n${rulesOn}`],
];
await openDrawing(titled.map(([id, label], i) => ({ id, x: 20 + (i % 6) * 260, y: id === 't-shorter' ? 240 : 40, w: 250, h: id === 't-short' || id === 't-shorter' ? 100 : 170, label })), { span: 300 });
await statusUntil('t-box', 'ok');
const titleZoom = await app(() => window.app.board.camera.zoom);
const titlesAt = async (level) => {
  for (const [id] of titled) {
    // The board redraws on the next tick of the clock, up to a second after the data says so.
    await until(([i, l]) => window.app.headerOf(i).level === l, `${id} to draw ${level}`, 5, [id, level]);
    await sleep(60);
    const head = await app((i) => window.app.headerOf(i), id);
    assert.equal(head.shown, TITLE, `${id} shows its whole title at ${level}: ${JSON.stringify(head)}`);
    assert.ok(head.title <= head.room + 0.5, `${id} has room for its title at ${level}: ${JSON.stringify(head)}`);
  }
  const words = await readouts('t-stat');
  return words;
};
check('a short title is whole when OK', (await titlesAt('ok')).length > 0, { zoom: titleZoom });
titleLevel.set(60);
await statusUntil('t-box', 'warn');
const warnWords = await titlesAt('warn');
check('and at WARN, with the word still on screen', warnWords.some((x) => /WARN/.test(x)), warnWords);
titleLevel.set(90);
await statusUntil('t-box', 'critical');
const critWords = await titlesAt('critical');
check('and at CRITICAL, with the word still on screen', critWords.some((x) => /CRITICAL/.test(x)), critWords);
check('a box that keeps only the icon says the word beside its reason', (await readouts('t-box')).some((x) => /CRITICAL/.test(x)), await readouts('t-box'));
check('as does a chart', (await readouts('t-chart')).some((x) => /CRITICAL/.test(x)), await readouts('t-chart'));
await shot('07b-titles-critical');
titleLevel.set(null);
await statusUntil('t-box', 'nodata');
await titlesAt('nodata');
check('and at NO DATA', true);
titleLevel.set(10);
await statusUntil('t-box', 'ok');
prom.mode = '500';
await statusUntil('t-box', 'failed');
await titlesAt('failed');
check('and at FAILED', true);
prom.mode = 'ok';
await statusUntil('t-box', 'ok');
clearProblems();
// A title too long for any room is cut, and it never runs under the status.
const longTitle = 'the checkout database primary connections across every region';
await openDrawing([{ id: 'longest', x: 20, y: 40, w: 250, h: 170, label: `${longTitle}\n${rulesOn}` }, { id: 'keeps', x: 1300, y: 40, w: 250, h: 170, label: `${TITLE}\n${rulesOn}` }], { span: 300 });
await statusUntil('longest', 'ok');
await sleep(300);
const cutTitle = await app(() => window.app.headerOf('longest'));
check('only a title too long for the whole row is cut, at a readable size', cutTitle.shown.endsWith('...') && cutTitle.shown.length > 5 && cutTitle.size === 14, cutTitle);
const inspected = await app(() => { window.app.select('longest'); return true; }) && await until((t) => document.getElementById('insp-bindings') && window.app.dash.panels.get('longest').title === t, 'the full title to be known', 5, longTitle);
check('and the panel still knows all of it', inspected);
await app(() => window.app.select(null));

// ===========================================================================
section('time: live, paused, ranges, zoom, crosshair and looking back');

prom.series.set('w2', (t) => 20 + 10 * Math.sin(t / 30));
await openDrawing([
  { id: 'c1', x: 40, y: 40, w: 640, h: 300, label: 'one\nchart\nprod: rate_total in req/s' },
  { id: 'c3', x: 720, y: 40, w: 640, h: 300, label: 'two\nchart\nprod: w2 in req/s' },
], { span: 900 });
await until(() => window.app.plotOf('c1')?.strips[0].hasData && window.app.plotOf('c3')?.strips[0].hasData, 'both charts');
await p.mouse.move(5, 5);

// Presets are real buttons.
await p.click('[data-span="300"]');
check('a preset changes the range', await until(() => window.app.m.time.span === 300, 'the 5m preset'));
await until(() => { const p_ = window.app.plotOf('c1'); return p_ && Math.abs((p_.t1 - p_.t0) - 300) < 0.5; }, 'the chart to follow');
const rangeWords = await app(() => document.getElementById('range').textContent);
const parts = rangeWords.match(/(\d\d):(\d\d):(\d\d) to (\d\d):(\d\d):(\d\d)/);
check('the bar shows that range', parts !== null, rangeWords);
await p.click('[data-span="900"]');

// Live and paused.
const t1Before = await app(() => window.app.m.range().t1);
await sleep(2300);
const t1After = await app(() => window.app.m.range().t1);
check('live moves on by itself', t1After > t1Before, { t1Before, t1After });
await p.click('#btn-live');
check('pause stops the range', await until(() => !window.app.m.time.live, 'pause'));
const heldT1 = await app(() => window.app.m.range().t1);
await sleep(1500);
check('and it stays stopped', await app(() => window.app.m.range().t1) === heldT1);
check('paused says so', /Paused/.test(await app(() => document.getElementById('looking').textContent)));
check('and a paused view is not mistaken for missing data', (await statusOf('c1')).level !== 'nodata', await statusOf('c1'));
check('it still shows its numbers', (await readouts('c1')).includes('req/s'), await readouts('c1'));
await p.keyboard.press('Space');
await until(() => window.app.m.time.live, 'the space bar to go live');
check('the space bar goes back to live', true);

// A crosshair across every chart, from a real mouse.
const plotA = await app(() => { const p_ = window.app.plotOf('c1'); const s = p_.strips[0]; const a = window.app.toScreen(p_.plotX + p_.plotW * 0.5, s.y + s.h * 0.5); const b = window.app.toScreen(p_.plotX + p_.plotW * 0.2, s.y + s.h * 0.5); return { a, b, t0: p_.t0, t1: p_.t1 }; });
await p.mouse.move(plotA.a.x, plotA.a.y);
const cursorT = await until(() => window.app.m.time.cursor, 'the crosshair');
check('hovering a chart sets the shared time', Math.abs(cursorT - (plotA.t0 + plotA.t1) / 2) < (plotA.t1 - plotA.t0) * 0.02, { cursorT });
await sleep(200);
const hoverA = await readouts('c1');
const hoverB = await readouts('c3');
const wantB = showValue(20 + 10 * Math.sin(Math.floor(cursorT) / 30), 'req/s').split(' ')[0];
check('the other chart shows its value at that same time', hoverB.some((x) => x.startsWith(wantB.slice(0, 3))), { hoverB, wantB });
check('the chart under the pointer shows the time too', hoverA.some((x) => /\d\d:\d\d:\d\d/.test(x)), hoverA);
await shot('08-crosshair');

// Drag on a chart to zoom, with a real mouse.
const before = await app(() => window.app.m.time.span);
await p.mouse.move(plotA.b.x, plotA.b.y);
await p.mouse.down();
await p.mouse.move(plotA.a.x, plotA.a.y, { steps: 8 });
await shot('09-zoom-band');
await p.mouse.up();
const zoomed = await until(() => { const m = window.app.m.time; return !m.live && m.span < 900 * 0.5 && m.span; }, 'the zoom');
check('dragging across a chart zooms to what you dragged', zoomed < before * 0.4 && zoomed > before * 0.2, { before, zoomed });
await until(() => window.app.plotOf('c1').strips[0].hasData, 'zoomed data');
await until(() => { const r = window.app.m.data.states.get('range\u0000prod\u0000rate_total'); return r.loaded?.step <= 1; }, 'finer data for the zoomed range');
await p.click('#btn-zoomout');
check('zoom out returns to the range before', await until(() => window.app.m.time.span === 900 && window.app.m.time.live, 'zoom out'));

// Looking back: the seeded incident, 18 minutes before the server started.
const sim = (await api('/dashboard/incident', { fail: false })).json;
const seeded = sim.incidents[0];
check('the simulation starts with an incident to find', seeded.kind === 'db-slow' && seeded.start < nowS() - 600, seeded);

await p.goto(`${DASH}#look-back`);
await p.reload();
await until(() => !!window.app, 'the page again', 60);
await until(() => window.app.m.sceneId === 'look-back' && window.app.readouts('api').length > 3, 'the look-back drawing');
await until(() => window.app.m.transitions.length > 0, 'its alert history', 20);
await shot('10-look-back-live');
const liveDb = await statusOf('db');
check('now, the database is fine', liveDb.level === 'ok', liveDb);

const inIncident = seeded.start + 150;
const tapeAt = await app((t) => {
  const r = document.getElementById('tape').getBoundingClientRect();
  const { t0, t1 } = window.app.m.range();
  return { x: r.left + 12 + ((t - t0) / (t1 - t0)) * (r.width - 24), y: r.top + r.height / 2, x2: r.left + 12 + ((t - 90 - t0) / (t1 - t0)) * (r.width - 24) };
}, inIncident);
await p.mouse.move(tapeAt.x2, tapeAt.y);
await p.mouse.down();
await p.mouse.move(tapeAt.x, tapeAt.y, { steps: 6 });
await p.mouse.up();
const moment = await until(() => window.app.m.time.at, 'a moment to be chosen');
check('dragging along the bottom picks a moment', Math.abs(moment - inIncident) < 15 && !(await app(() => window.app.m.time.live)), { moment, inIncident });
await sleep(500);
await shot('11-look-back-moment');

const incidents = { seed: sim.seed, incidents: sim.incidents };
const atMoment = async (panelId, metric, unit) => {
  const grid = await app(([k]) => window.app.m.data.states.get(`range\u0000demo\u0000${k}`)?.series.values().next().value, [metric]);
  void grid;
  const point = await app(([k, at]) => {
    const st = window.app.m.data.states.get(`range\u0000demo\u0000${k}`);
    const s = st.series.values().next().value;
    return s.at(at, st.interval * 3);
  }, [metric, moment]);
  const expected = simValue(metric, point.t, incidents);
  check(`${panelId} shows ${metric} from that moment, as the source had it`, Math.abs(point.v - expected) < 1e-9, { drawn: point.v, source: expected, t: point.t });
  const words = await readouts(panelId);
  const text = showValue(point.v, unit).split(' ')[0];
  check(`and draws it: ${panelId} ${metric} ${text}`, words.some((x) => x.replace('%', '') === text.replace('%', '')), words);
};
await atMoment('db', 'db.latency', 'ms');
await atMoment('db', 'db.connections', 'conns');
await atMoment('api', 'api.errors', '%');
await atMoment('web', 'web.errors', '%');
await atMoment('worker', 'worker.rate', 'jobs/s');
await atMoment('connections', 'db.connections', 'conns');
await atMoment('backlog', 'queue.depth', 'jobs');
const edgeWords = await readouts('api-db');
const edgePoint = await app((at) => { const st = window.app.m.data.states.get('range\u0000demo\u0000edge.api-db'); return st.series.values().next().value.at(at, st.interval * 3); }, moment);
check('an arrow shows its traffic from that moment', edgeWords.some((x) => x.startsWith(showValue(edgePoint.v, 'query/s').split(' ')[0])), { edgeWords, edgePoint });
const pastDb = await statusOf('db');
check('the database is critical at that moment, though it is fine now', pastDb.level === 'critical', pastDb);
check('and its frame shows it', await app(() => window.app.board.get('db').strokeWidth === 4));
const lookWords = await app(() => document.getElementById('looking').textContent);
check('the page says it is looking back, and what is firing now', /Every shape shows/.test(lookWords) && /ago/.test(lookWords) && /Now: nothing firing/.test(lookWords), lookWords);
const alertsThen = await readouts('alerts');
check('the alerts panel shows what was firing then', alertsThen.some((x) => /firing/.test(x)) && !alertsThen.some((x) => x === 'nothing firing'), alertsThen);

// The arrow keys step the moment, and every shape follows.
await p.keyboard.press('ArrowRight');
const stepped = await app(() => window.app.m.time.at);
check('the arrow keys move the moment', stepped > moment, { moment, stepped });

// While looking back, something fires now. The page must say so.
await p.keyboard.press('Escape');
await until(() => window.app.m.time.live, 'Escape to go back to live');
check('Escape goes back to live', true);
check('and shapes show now again', await until(() => window.app.statusOf('db').level === 'ok', 'the database to be fine again'));

const hot = steps(10);
prom.series.set('hot', hot);
await openDrawing([
  { id: 'hc', x: 40, y: 40, w: 640, h: 300, label: 'hot\nchart\nprod: hot in %\ncritical above 50 for 1s' },
  { id: 'hb', x: 720, y: 40, w: 340, h: 170, label: 'hot box\nprod: hot in %\ncritical above 50 for 1s' },
], { span: 300 });
await statusUntil('hb', 'ok');
await sleep(2000);
const clickAt = await app(() => { const p_ = window.app.plotOf('hc'); const s = p_.strips[0]; return window.app.toScreen(p_.plotX + p_.plotW * 0.9, s.y + s.h * 0.5); });
const boardBefore = await app(() => { const e = window.app.byId('hb'); return { top: window.app.board.canvas.getBoundingClientRect().top, at: window.app.toScreen(e.x, e.y) }; });
await p.mouse.click(clickAt.x, clickAt.y);
await until(() => window.app.m.time.at !== null, 'a click on a chart to look back');
check('clicking a chart looks at that moment', true);
const boardAfter = await app(() => { const e = window.app.byId('hb'); return { top: window.app.board.canvas.getBoundingClientRect().top, at: window.app.toScreen(e.x, e.y) }; });
check('and nothing moves under the pointer when it does', boardAfter.top === boardBefore.top && boardAfter.at.x === boardBefore.at.x && boardAfter.at.y === boardBefore.at.y, { boardBefore, boardAfter });
hot.set(90);
const nowFiring = await until(() => { const n = document.querySelector('#looking .now'); return /critical/.test(n?.textContent ?? '') && n.textContent; }, 'the page to say what is firing now', 20);
check('while looking back, what fires now still shows', /Now: 1 critical/.test(nowFiring), nowFiring);
check('but the shape still shows the moment you chose', (await statusOf('hb')).level === 'ok', await statusOf('hb'));
await shot('12-looking-back-while-firing');
await p.click('#btn-back');
await statusUntil('hb', 'critical', 15);
check('back to live shows it firing', true);
hot.set(10);

// Going back must not change what is known about now. A source with a 5 s interval makes it
// plain: the next answer about now is up to 5 s away when you press the button.
const saysNow = () => p.evaluate(() => ({ pill: document.getElementById('firing').textContent, now: document.querySelector('#looking .now')?.textContent ?? null }));
// Both began inside the range, so when they began is a fact that does not move with the window.
const firingFrom = nowS();
const slowFiring = steps(10), slowLong = steps(10);
slowFiring.set(60, firingFrom - 200);
slowLong.set(60, firingFrom - 700);
prom.series.set('slow_firing', slowFiring);
prom.series.set('slow_long', slowLong);
prom.series.set('quick_healthy', () => 5);
// Stale after 5 s, so by the time you come back, the range on screen has stopped long enough to count.
const quickFiring = steps(10);
quickFiring.set(60, firingFrom - 100);
prom.series.set('quick_firing', quickFiring);
await openDrawing([
  { id: 'sf', x: 40, y: 40, w: 640, h: 300, label: 'slow\nchart\nslow: slow_firing in %\nwarn above 50 for 10s' },
  { id: 'sl', x: 720, y: 40, w: 640, h: 300, label: 'slow, for a long time\nchart\nslow: slow_long in req/s\nwarn above 50 for 8m' },
  { id: 'sq', x: 40, y: 360, w: 640, h: 200, label: 'a healthy one with a quick source\nchart\nprod: quick_healthy in req/s\nwarn above 50' },
  { id: 'sr', x: 720, y: 360, w: 640, h: 200, label: 'a firing one with a quick source\nchart\nprod: quick_firing in req/s\nwarn above 50' },
], { span: 900 });
await until(() => /3 warn/.test(document.getElementById('firing').textContent), 'all three rules to be firing', 20);
const sinceBefore = await app(() => window.app.m.firingNow.map((f) => [f.binding.query, f.since]));
// Press it just after an answer, when the next one is as far away as it gets.
const seenCalls = prom.calls.length;
await (async () => { const end = Date.now() + 8000; while (prom.calls.length === seenCalls && Date.now() < end) await sleep(40); })();
await sleep(150);
const across = await p.evaluate(async (at) => {
  const read = () => ({ pill: document.getElementById('firing').textContent, now: document.querySelector('#looking .now')?.textContent ?? null });
  window.app.setMoment(at);
  const same = read();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const first = read();
  const later = [];
  const stop = performance.now() + 6500;
  while (performance.now() < stop) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    later.push(read());
  }
  return { same, first, later };
}, nowS() - 120);
check('going back leaves the pill as it was, in the same tick', /3 warn/.test(across.same.pill), across.same);
check('and on the first frame, with the Now line saying the same', /3 warn/.test(across.first.pill) && /Now: 3 warn/.test(across.first.now), across.first);
const wrongLater = across.later.filter((x) => !/3 warn/.test(x.pill) || !/Now: 3 warn/.test(x.now));
check('and at every moment until well after the next answer about now', wrongLater.length === 0, wrongLater.slice(0, 3));
const sinceDuring = await app(() => window.app.m.firingNow.map((f) => [f.binding.query, f.since]));
check('how long it has been firing does not change either', sinceDuring.length === 3 && sinceDuring.every(([q, t]) => Math.abs(t - sinceBefore.find((x) => x[0] === q)[1]) < 6), { sinceBefore, sinceDuring });
// A healthy rule stays healthy, and the moment's own end is not the data stopping.
const inHistory = await app(() => window.app.m.transitions.filter((t) => t.to === 'nodata').map((t) => t.words));
check('paused past its staleness, the range does not report the data as stopped', inHistory.length === 0, inHistory);
check('and a healthy rule still reads as healthy at the moment you chose', (await statusOf('sq')).level === 'ok', await statusOf('sq'));
// And coming back. The range on screen stopped when you left, and the page has newer numbers.
const seenCalls2 = prom.calls.length;
await (async () => { const end = Date.now() + 8000; while (prom.calls.length === seenCalls2 && Date.now() < end) await sleep(40); })();
await sleep(150);
const returning = await p.evaluate(async () => {
  const read = () => document.getElementById('firing').textContent;
  window.app.setLive(true);
  const same = read();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const first = read();
  const later = [];
  const stop = performance.now() + 6500;
  while (performance.now() < stop) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    later.push(read());
  }
  return { same, first, later };
});
check('back to live leaves the pill as it was, in the same tick', /3 warn/.test(returning.same), returning.same);
check('and on the first frame', /3 warn/.test(returning.first), returning.first);
check('and until well after the next answer', returning.later.every((x) => /3 warn/.test(x)), returning.later.filter((x) => !/3 warn/.test(x)).slice(0, 3));
// Something that starts firing while you look back still arrives.
const slowLate = steps(10);
prom.series.set('slow_late', slowLate);
await openDrawing([{ id: 'late', x: 40, y: 40, w: 640, h: 300, label: 'late\nchart\nslow: slow_late in %\nwarn above 50' }], { span: 300 });
await until(() => /1 ok/.test(document.getElementById('firing').textContent), 'the rule to be ok', 15);
await app(() => window.app.setMoment(Date.now() / 1000 - 100));
slowLate.set(60);
const lateNow = await until(() => { const n = document.querySelector('#looking .now'); return /1 warn/.test(n?.textContent ?? '') && n.textContent; }, 'what fires now to show while looking back', 15);
check('what fires now arrives while looking back, on a slow source too', /Now: 1 warn/.test(lateNow), lateNow);
// The same when the data stops while you look back: it must not be stuck on what it knew.
slowLate.set(10);
await until(() => /nothing firing/.test(document.querySelector('#looking .now')?.textContent ?? ''), 'it to clear while looking back', 15);
prom.series.set('slow_late', () => null);
const lateSilent = await until(() => { const n = document.querySelector('#looking .now'); return /no data/.test(n?.textContent ?? '') && n.textContent; }, 'data stopping now to show while looking back', 40);
check('and so does the data stopping', /Now: 1 with no data/.test(lateSilent), lateSilent);
await app(() => window.app.setLive(true));

// Paused over a long range, the tail asks for finer points than the range has. That must not
// make the chart think its own points are too far apart.
prom.series.set('long_range', () => 30);
await openDrawing([{ id: 'wide', x: 40, y: 40, w: 900, h: 300, label: 'a day\nchart\nprod: long_range in req/s' }], { span: 86400 });
await until(() => window.app.plotOf('wide')?.strips[0].hasData && window.app.m.data.states.get('range\u0000prod\u0000long_range').loaded?.step === 30, 'a day of data', 20);
await app(() => window.app.setLive(false));
const asked = prom.calls.length;
await (async () => { const end = Date.now() + 6000; while (Date.now() < end && prom.calls.slice(asked).filter((c) => c.query === 'long_range' && c.step === 1).length < 2) await sleep(60); })();
await sleep(300);
const wideGaps = await app(() => window.app.plotOf('wide').strips[0].gaps);
check('a paused chart over a long range keeps its line whole', wideGaps.length === 0, wideGaps.slice(0, 3));
check('with its numbers', (await readouts('wide')).includes('30'), await readouts('wide'));
await app(() => window.app.setLive(true));

// A table at a past moment makes an instant query at that time.
prom.calls.length = 0;
await openDrawing([
  { id: 'tt', x: 40, y: 40, w: 420, h: 260, label: 'then\ntable\nprod: up_by_job in targets' },
  { id: 'tc', x: 500, y: 40, w: 640, h: 300, label: 'then\nchart\nprod: rate_total in req/s' },
], { span: 300 });
await wordsUntil('tt', (w) => w.includes('web'), 'the table');
await until(() => window.app.plotOf('tc')?.strips[0].hasData, 'the chart');
const pinned = Math.floor(nowS()) - 100;
await app((t) => window.app.setMoment(t), pinned);
const atCall = await (async () => { const end = Date.now() + 10000; while (Date.now() < end) { const c = prom.calls.find((x) => x.path === '/api/v1/query' && x.time !== null); if (c) return c; await sleep(100); } return null; })();
check('a table looking back asks Prometheus at that time', atCall && Math.abs(atCall.time - pinned) < 1.5, atCall);
await app(() => window.app.setLive(true));

// ===========================================================================
section('flow: speed encodes the rate');

const flowA = steps(100), flowB = steps(200), flowC = steps(0);
prom.series.set('flow_a', flowA);
prom.series.set('flow_b', flowB);
prom.series.set('flow_c', flowC);
await openDrawing([
  { id: 'n1', x: 40, y: 40, w: 200, h: 90, label: 'one' },
  { id: 'n2', x: 800, y: 40, w: 200, h: 90, label: 'two' },
  { id: 'n3', x: 40, y: 240, w: 200, h: 90, label: 'three' },
  { id: 'n4', x: 800, y: 240, w: 200, h: 90, label: 'four' },
  { id: 'n5', x: 40, y: 440, w: 200, h: 90, label: 'five' },
  { id: 'n6', x: 800, y: 440, w: 200, h: 90, label: 'six' },
  { arrow: true, id: 'fa', from: 'n1', to: 'n2', label: 'prod: flow_a in req/s\nflow\nstale after 3s' },
  { arrow: true, id: 'fb', from: 'n3', to: 'n4', label: 'prod: flow_b in req/s\nflow' },
  { arrow: true, id: 'fc', from: 'n5', to: 'n6', label: 'prod: flow_c in req/s\nflow' },
], { span: 300 });
await until(() => window.app.m.flows.get('fa')?.rate === 100 && window.app.m.flows.get('fb')?.rate === 200, 'flows to read their rates');
const f = await app(() => { const g = (k) => { const x = window.app.m.flows.get(k); return { rate: x.rate, per: x.per, speed: x.speed, dps: x.dotsPerSecond, phase: x.phase }; }; return { a: g('fa'), b: g('fb'), c: g('fc') }; });
check('one dot stands for the same amount on every arrow', f.a.per === f.b.per, f);
check('twice the rate is twice the speed', Math.abs(f.b.speed / f.a.speed - 2) < 1e-9, f);
// Measure it as drawn: how far the phase really moved between two frames, over real time.
const measure = await app(async () => {
  const flows = window.app.m.flows;
  const read = () => ({ a: flows.get('fa').phase, b: flows.get('fb').phase, c: flows.get('fc').phase, at: performance.now() });
  let totalA = 0, totalB = 0, totalC = 0;
  let prev = read();
  const started = prev.at;
  await new Promise((resolve) => {
    const step = () => {
      const next = read();
      totalA += (next.a - prev.a + 1) % 1;
      totalB += (next.b - prev.b + 1) % 1;
      totalC += (next.c - prev.c + 1) % 1;
      prev = next;
      if (next.at - started > 1200) resolve(); else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  return { totalA, totalB, totalC, seconds: (prev.at - started) / 1000 };
});
check('dots really travel at their rate as they are drawn', Math.abs(measure.totalB / measure.totalA - 2) < 0.15, measure);
check('no traffic, no motion', measure.totalC === 0, measure);
await wordsUntil('fa', (w) => w.some((x) => x.startsWith('100')), 'the arrow to show its number');
const flowWords = await readouts('fb');
check('the arrow shows the number too', flowWords.some((x) => x.startsWith('200')), flowWords);
await shot('13-flow');
// No number stops the dots.
prom.series.set('flow_a', () => null);
await until(() => window.app.m.flows.get('fa')?.speed === 0, 'dots to stop when the number stops', 20);
const stoppedPhase = await app(() => window.app.m.flows.get('fa').phase);
await sleep(600);
check('stale traffic stops the dots', await app(() => window.app.m.flows.get('fa').phase) === stoppedPhase);
check('the arrow says no data', (await readouts('fa')).some((x) => /no data/.test(x)), await readouts('fa'));

// ===========================================================================
section('security: a drawing that tries to reach somewhere');

const hitsBefore = leaks().length;
prom.calls.length = 0;
const evilPng = `http://127.0.0.1:${internalPort}/image-leak.png`;
await openDrawing([
  { id: 'u1', x: 40, y: 40, w: 420, h: 170, label: `stolen\nhttp://127.0.0.1:${internalPort}/leak` },
  { id: 'u2', x: 500, y: 40, w: 420, h: 170, label: `stolen\nprod: http://127.0.0.1:${internalPort}/leak` },
  { id: 'u3', x: 40, y: 280, w: 420, h: 170, label: `stolen\nx = https://127.0.0.1:${internalPort}/leak: up` },
  { id: 'u4', x: 500, y: 280, w: 420, h: 170, label: `stolen\nlocalhost:${internalPort}/leak` },
  { id: 'u5', x: 40, y: 520, w: 420, h: 150, label: '<img src=x onerror="window.pwned=1"><script>window.pwned=2</script>\nmachine: cpu' },
], { files: { evil: { id: 'evil', mimeType: 'image/png', dataURL: evilPng } } });
const pageRequests = [];
p.on('request', (r) => pageRequests.push(r.url()));
await sleep(1500);
const issues = await app(() => window.app.dash.issues.filter((i) => i.level === 'error').map((i) => ({ id: i.id, message: i.message })));
check('each line that names an address has a message', ['u1', 'u2', 'u3', 'u4'].every((id) => issues.some((i) => i.id === id && /can't name an address/.test(i.message))), issues);
check('none of them binds to anything', await app(() => ['u1', 'u2', 'u3', 'u4'].every((id) => window.app.dash.panels.get(id).bindings.length === 0)));
check('the fake internal service was never contacted', leaks().length === hitsBefore, leaks());
check('nor was Prometheus asked about it', prom.calls.every((c) => !/127\.0\.0\.1/.test(c.query ?? '')), prom.calls.map((c) => c.query));
check('the page asked nothing of that address', !pageRequests.some((u) => u.includes(String(internalPort))), pageRequests.filter((u) => u.includes(String(internalPort))));
check('an image that is an address is dropped when the drawing loads', await app(() => Object.keys(window.app.board.files).length === 0));
await app(() => window.app.select('u1'));
await until(() => /can't name an address/.test(document.getElementById('inspector').innerText), 'the inspector to say why');
await shot('14-a-drawing-names-a-url');
await app(() => window.app.select('u5'));
await sleep(300);
const injected = await app(() => ({ pwned: window.pwned ?? null, img: document.querySelectorAll('#inspector img, #inspector script').length, text: document.getElementById('inspector').innerText }));
check('a label is text, not HTML', injected.pwned === null && injected.img === 0, injected.img);
const blocked = await app(async (url) => { try { await fetch(url, { mode: 'no-cors' }); return 'reached it'; } catch { return 'blocked'; } }, `http://127.0.0.1:${internalPort}/leak`);
check('even a bug in this page could not reach another address: the CSP blocks it', blocked === 'blocked' && leaks().length === hitsBefore, blocked);
clearProblems();

// ===========================================================================
section('making it: palette, inspector, labels, undo and save');

await app(() => window.app.m.loadBlank());
await until(() => window.app.doc.length === 0, 'a blank board');
const middleOf = (id) => app((i) => { const e = window.app.byId(i); return window.app.toScreen(e.x + e.width / 2, e.y + e.height / 2); }, id);
const titleOf = (id) => app((i) => { const e = window.app.byId(i); const r = window.app.toScreen(e.x + e.width / 2, e.y + 12 * window.app.m.unit()); return r; }, id);
const drag = async (from, to, steps = 10) => { await p.mouse.move(from.x, from.y); await p.mouse.down(); await p.mouse.move(to.x, to.y, { steps }); await p.mouse.up(); await sleep(80); };
const boardPoint = (fx, fy) => app(([fx, fy]) => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: r.left + r.width * fx, y: r.top + r.height * fy }; }, [fx, fy]);
const partAt = async (id) => { const b = await p.locator(`.part[data-part="${id}"]`).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
const metricAt = async (source, metric) => {
  const loc = p.locator(`.metric[data-source="${source}"][data-metric="${metric}"]`);
  const open = await app(([s]) => { const d = document.querySelector(`.source[data-name="${s}"] details`); if (d) d.open = true; return !!d; }, [source]);
  assert.ok(open, 'the source has a list');
  const b = await loc.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

check('the palette has every panel', await app(() => [...document.querySelectorAll('.part')].map((e) => e.dataset.part).join(',')) === PARTS.map((x) => x.id).join(','));
check('a blank board says how to start', /Start here/.test(await app(() => document.getElementById('inspector').innerText)));

// Hovering a panel says what it is, generated from the table.
await p.hover('.part[data-part="meter"]');
check('hovering a panel says what it is and what it can say', /One value against its limits/.test(await app(() => document.getElementById('inspector').innerText)) && /warn above 80 for 2m/.test(await app(() => document.getElementById('inspector').innerText)));

await drag(await partAt('box'), await boardPoint(0.25, 0.25));
const boxId = await until(() => window.app.m.selected, 'a box from the palette');
check('dragging a panel adds it, selected', await app((i) => window.app.dash.panels.get(i).kind === 'box', boxId));
await wordsUntil(boxId, (w) => w.includes('%'), 'the new box to show data');
const ins = await app(() => document.getElementById('inspector').innerText);
check('the inspector says what it is bound to, and what it understood', /What it is bound to/i.test(ins) && /machine: cpu/.test(ins) && /CPU/.test(ins), ins.slice(0, 300));
check('and what else it can say, from the table', /warn above 80 for 2m/.test(ins) && /stale after 30s/.test(ins));

await drag(await partAt('chart'), await boardPoint(0.65, 0.25));
const chartId = await app(() => window.app.m.selected);
check('a chart from the palette reads as a chart', await app((i) => window.app.dash.panels.get(i).kind === 'chart', chartId));
await shot('15-built-from-the-palette');

// Drop a metric on a shape: it joins that shape.
await drag(await metricAt('machine', 'memory'), await middleOf(boxId));
check('dropping a metric on a shape adds it to that shape', await until((i) => window.app.dash.panels.get(i).bindings.some((b) => b.query === 'memory'), 'the metric on the box', 5, boxId));
// Drop a metric on nothing: a new chart.
const beforeCount = await app(() => window.app.dash.panels.size);
await drag(await metricAt('machine', 'load'), await boardPoint(0.3, 0.75));
check('dropping a metric on nothing adds a chart of it', await until((n) => window.app.dash.panels.size === n + 1, 'a chart of it', 5, beforeCount));
const loadChart = await app(() => window.app.m.selected);
check('that chart is bound to it', await app((i) => window.app.dash.panels.get(i).bindings[0].query === 'load', loadChart));

// Type a label, with hints, using the real keyboard.
await p.keyboard.press('Escape');
const titleSpot = await titleOf(boxId);
await p.mouse.dblclick(titleSpot.x, titleSpot.y);
await until(() => window.app.editing, 'the label editor');
await p.keyboard.press('ControlOrMeta+a');
await p.keyboard.type('checkout');
await p.keyboard.press('Shift+Enter');
await p.keyboard.type('mach');
await until(() => !document.getElementById('hints').hidden && /machine:/.test(document.getElementById('hints').innerText), 'a hint for the source');
await p.keyboard.press('Tab');
check('Tab takes the hint', await app(() => document.getElementById('label').value.endsWith('machine: ')), await app(() => document.getElementById('label').value));
await p.keyboard.type('cp');
await until(() => /cpu/.test(document.getElementById('hints').innerText), 'a hint for the metric');
await p.keyboard.press('Tab');
check('metric names complete too, from the source', await app(() => document.getElementById('label').value.endsWith('machine: cpu')));
await p.keyboard.press('Shift+Enter');
await p.keyboard.type('crit');
await until(() => /critical above 95 for 30s/.test(document.getElementById('hints').innerText), 'a hint for the word');
await shot('16-typing-hints');
await p.keyboard.press('ControlOrMeta+a');
await p.keyboard.type('checkout');
await p.keyboard.press('Shift+Enter');
await p.keyboard.type('machine: cpu');
await p.keyboard.press('Shift+Enter');
await p.keyboard.type('warnn above 1000');
const liveHint = await until(() => { const r = document.querySelector('#hints .read'); return r?.classList.contains('bad') && r.textContent; }, 'the hints to say what is wrong');
check('hints say what is wrong while you type', /Did you mean "warn"/.test(liveHint), liveHint);
await p.keyboard.press('Enter');
await until(() => !window.app.editing, 'the editor to close');
const typoIssue = await app((i) => window.app.dash.issues.find((x) => x.id === i && x.level === 'error'), boxId);
check('a misspelled word gets a message on the drawing, with a fix', typoIssue?.fix?.to === 'warn', typoIssue);
await sleep(250);
await shot('17-message-on-the-drawing');

// Click the fix, on the canvas, with the mouse.
const fixAt = await until((i) => { const h = window.app.m.hot.find((x) => x.fix && x.owner === i); return h && window.app.toScreen(h.x + h.w / 2, h.y + h.h / 2); }, 'the fix to be on the drawing', 5, boxId);
await p.mouse.click(fixAt.x, fixAt.y);
await until((i) => !window.app.dash.issues.some((x) => x.id === i && x.level === 'error'), 'the fix to apply', 5, boxId);
const fixedLabel = await app((i) => window.app.dash.panels.get(i).label, boxId);
check('clicking it fixes the word', fixedLabel === 'checkout\nmachine: cpu\nwarn above 1000', fixedLabel);
check('and the rule is live', await app((i) => window.app.dash.panels.get(i).bindings[0].rules[0].value === 1000, boxId));

// Undo and redo, by keyboard and button.
await app(() => document.activeElement?.blur());
await p.keyboard.press('ControlOrMeta+z');
await until((i) => window.app.dash.issues.some((x) => x.id === i && x.level === 'error'), 'undo to bring the typo back', 5, boxId);
check('undo undoes', true);
await p.keyboard.press('ControlOrMeta+Shift+z');
await until((i) => !window.app.dash.issues.some((x) => x.id === i && x.level === 'error'), 'redo to fix it again', 5, boxId);
check('redo redoes', true);
await p.click('#btn-undo');
await p.click('#btn-redo');
check('the buttons work too', await app((i) => window.app.dash.panels.get(i).label, boxId) === 'checkout\nmachine: cpu\nwarn above 1000');

// Double-click on nothing, and a palette entry from the keyboard.
await p.keyboard.press('Escape');
const beforeDbl = await app(() => window.app.dash.panels.size);
const spot = await boardPoint(0.88, 0.9);
await p.mouse.dblclick(spot.x, spot.y);
await until(() => window.app.editing, 'the editor on a new shape');
await p.keyboard.type('new one');
await p.keyboard.press('Enter');
await until(() => !window.app.editing, 'the editor to close');
const dblId = await app(() => window.app.m.selected);
check('double-clicking nothing adds a shape to type in', await app(([i, n]) => window.app.doc.filter((e) => e.type === 'rectangle').length >= n && window.app.dash.panels.get(i)?.title === '' || window.app.dash.panels.get(i)?.label === 'new one', [dblId, beforeDbl]));
check('a shape with no source line is just part of the drawing', await app((i) => window.app.dash.panels.get(i).kind === 'plain', dblId));
await p.keyboard.press('Delete');
await until((i) => !window.app.byId(i), 'it to go', 5, dblId);
const beforeKey = await app(() => window.app.dash.panels.size);
await p.focus('.part[data-part="stat"]');
await p.keyboard.press('Enter');
await until((n) => window.app.dash.panels.size === n + 1, 'a panel from the keyboard', 5, beforeKey);
check('a palette entry works from the keyboard', true);
await p.keyboard.press('Delete');
await until((n) => window.app.dash.panels.size === n, 'that panel to go', 5, beforeKey);

// Move, with snapping, and an arrow from the blue circle.
await app((i) => window.app.select(i), boxId);
const was = await app((i) => { const e = window.app.byId(i); return { x: e.x, y: e.y }; }, boxId);
const grip = await titleOf(boxId);
await drag(grip, { x: grip.x + 37, y: grip.y + 23 });
const now_ = await app((i) => { const e = window.app.byId(i); return { x: e.x, y: e.y }; }, boxId);
check('dragging moves a shape, and it snaps to a grid', (now_.x !== was.x || now_.y !== was.y) && now_.x % 20 === 0 && now_.y % 20 === 0, { was, now_ });
await app((i) => window.app.select(i), boxId);
await sleep(150);
const circle = await app((i) => { const c = window.app.m.connectAt(window.app.byId(i)); return window.app.toScreen(c[0], c[1]); }, boxId);
const blankChart = await (async () => { await drag(await partAt('chart'), await boardPoint(0.68, 0.72)); return app(() => window.app.m.selected); })();
await app((i) => window.app.m.editLabelOf(i), blankChart);
await until(() => window.app.editing, 'the editor');
await p.keyboard.press('ControlOrMeta+a');
await p.keyboard.type('chart');
await p.keyboard.press('Enter');
await until(() => !window.app.editing, 'the editor to close');
const empties = await app((i) => window.app.dash.panels.get(i).problems.find((x) => x.empty)?.message, blankChart);
check('a chart with nothing to show says what to do', /Add a line such as "machine: cpu"/.test(empties ?? ''), empties);
await app((i) => window.app.select(i), boxId);
await sleep(150);
await drag(circle, await middleOf(blankChart), 8);
const madeArrow = await until(() => { const s = window.app.m.selected; return s && window.app.byId(s)?.type === 'arrow' && s; }, 'an arrow from the blue circle', 5);
check('pulling the blue circle to a shape draws an arrow', true, madeArrow);
check('and the chart now reads the box it joins', await until((i) => window.app.dash.panels.get(i).bindings[0]?.query === 'cpu', 'the chart to read the box', 5, blankChart));
await until((i) => window.app.plotOf(i)?.strips[0].hasData, 'that chart to have data', 15, blankChart);

// Pull an arrow's end to another shape.
await app((i) => window.app.select(i), madeArrow);
await sleep(150);
const arrowEnd = await app((i) => { const a = window.app.byId(i); const q = a.points[a.points.length - 1]; return window.app.toScreen(a.x + q[0], a.y + q[1]); }, madeArrow);
await drag(arrowEnd, await middleOf(chartId), 8);
check('dragging an arrow\'s end rewires it', await until(([a, c]) => window.app.byId(a).endBinding?.elementId === c, 'the arrow to rewire', 5, [madeArrow, chartId]));
await app(() => window.app.undo());
await until(([a, c]) => window.app.byId(a).endBinding?.elementId === c, 'undo of the rewire', 5, [madeArrow, blankChart]);

// A note is just words.
await drag(await partAt('note'), await boardPoint(0.5, 0.92));
const noteId = await until(() => { const s = window.app.m.selected; return s && window.app.byId(s)?.type === 'text' && s; }, 'a note', 5);
check('a note says it does nothing', /does nothing/.test(await app(() => document.getElementById('inspector').innerText)));
await p.keyboard.press('Delete');
await until((i) => !window.app.byId(i), 'the note to go', 5, noteId);

// Grid of charts, copy, resize and delete.
const countBefore = await app(() => window.app.dash.panels.size);
await drag(await partAt('grid'), await boardPoint(0.5, 0.5));
check('a grid of charts adds four, lined up', await until((n) => window.app.dash.panels.size === n + 4, 'four charts', 5, countBefore));
const gridded = await app(() => [...window.app.dash.panels.values()].slice(-4).map((x) => ({ x: x.el.x, y: x.el.y, w: x.el.width, h: x.el.height })));
check('they share edges', gridded[0].y === gridded[1].y && gridded[2].y === gridded[3].y && gridded[0].x === gridded[2].x && gridded[1].x === gridded[3].x, gridded);
await shot('18-grid');
await app(() => window.app.undo());
await until((n) => window.app.dash.panels.size === n, 'undo of the grid', 5, countBefore);

await app((i) => window.app.select(i), chartId);
await p.keyboard.press('ControlOrMeta+d');
const copied = await until((i) => window.app.m.selected !== i && window.app.m.selected, 'a copy', 5, chartId);
check('Ctrl+D copies a shape with its label', await app(([a, b]) => window.app.dash.panels.get(a).label === window.app.dash.panels.get(b).label, [copied, chartId]));
await p.keyboard.press('Delete');
check('Delete removes it', await until((i) => !window.app.byId(i), 'the copy to go', 5, copied));
const corner = await app((i) => { window.app.select(i); const c = window.app.m.resizeAt(window.app.byId(i)); return window.app.toScreen(c[0], c[1]); }, chartId);
await sleep(150);
const sizeBefore = await app((i) => window.app.byId(i).width, chartId);
await drag(corner, { x: corner.x + 60, y: corner.y + 30 }, 6);
check('dragging the corner resizes', await app((i) => window.app.byId(i).width, chartId) > sizeBefore, await app((i) => window.app.byId(i).width, chartId));

// Save, then reopen the file and see it run.
const downloadPromise = p.waitForEvent('download');
await p.click('#btn-save');
const download = await downloadPromise;
const savedPath = path.join(configDir, download.suggestedFilename());
await download.saveAs(savedPath);
const savedText = fs.readFileSync(savedPath, 'utf8');
const saved = JSON.parse(savedText);
check('save writes a plain Excalidraw file', saved.type === 'excalidraw' && Array.isArray(saved.elements) && saved.elements.every((e) => typeof e.id === 'string' && typeof e.type === 'string'));
check('every element has the fields Excalidraw writes', saved.elements.filter((e) => e.type !== 'text').every((e) => ['x', 'y', 'width', 'height', 'seed', 'strokeColor', 'backgroundColor', 'version', 'groupIds'].every((k) => k in e)));
check('the binding is in plain label text you can type in Excalidraw', saved.elements.some((e) => e.type === 'text' && e.text.includes('machine: cpu') && e.containerId));
check('a saved file has no credential, no address and no data', !SECRETS.some((s) => savedText.includes(s)) && !/https?:\/\//.test(savedText));
const panelsBefore = await app(() => [...window.app.dash.panels.values()].map((x) => ({ id: x.id, kind: x.kind, label: x.label })));
await app(() => window.app.m.loadBlank());
await until(() => window.app.doc.length === 0, 'blank again');
await p.setInputFiles('#file', savedPath);
await until((n) => window.app.m.title === n, 'the saved file to open', 10, path.basename(savedPath));
const panelsAfter = await app(() => [...window.app.dash.panels.values()].map((x) => ({ id: x.id, kind: x.kind, label: x.label })));
assert.deepEqual(panelsAfter, panelsBefore);
check('it reopens with every panel and label as saved', true, { panels: panelsAfter.length });
await wordsUntil(boxId, (w) => w.includes('%') && w.includes('CPU'), 'the reopened box to show live numbers');
await until((i) => window.app.plotOf(i)?.strips[0].hasData, 'the reopened chart', 15, blankChart);
check('and it runs', (await statusOf(boxId)).level === 'ok', await statusOf(boxId));
await app(() => window.app.m.openFile('not-a-drawing.txt', 'this is not json'));
check('a file that is not a drawing leaves the board alone', await until(() => /not an Excalidraw drawing/.test(document.getElementById('toast').textContent), 'the message', 5) && await app(() => window.app.m.dash.panels.size > 0));

// ===========================================================================
section('saying what is allowed: reference, table view and gallery');

await p.keyboard.press('?');
await until(() => !document.getElementById('reference').hidden, 'the reference');
const refRows = await app(() => [...document.querySelectorAll('#reference tr[data-word]')].map((tr) => ({ id: tr.dataset.word, code: tr.querySelector('code').textContent })));
const inTable = WORDS.filter((w) => w.id !== 'name' || true);
for (const word of inTable) assert.ok(refRows.some((r) => r.id === word.id && r.code === word.example), `the reference has ${word.id}`);
check('the reference has every word, from the table', refRows.length === WORDS.length, refRows.length);
check('it lists the sources on this machine, by name only', await app(() => /prod:/.test(document.getElementById('ref-sources').innerText) && /machine:/.test(document.getElementById('ref-sources').innerText)) && !(await app(() => document.getElementById('reference').innerText.includes('SECRET'))));
await p.fill('#ref-search', 'threshold');
const shownRows = await app(() => [...document.querySelectorAll('#reference tr[data-word]')].filter((tr) => !tr.hidden).map((tr) => tr.dataset.word));
check('searching finds a word by another name', shownRows.includes('warn') && shownRows.length < 5, shownRows);
await shot('19-reference');
await p.keyboard.press('Escape');

await p.click('#btn-table');
const tableRows2 = await until(() => !document.getElementById('tableview').hidden && document.querySelectorAll('#tableview tbody tr').length, 'the table view');
check('every number is also in a table', tableRows2 > 1, tableRows2);
const firstRow = await app(() => document.querySelector('#tableview tbody tr').innerText);
check('with what it is bound to, its value and state', /machine: cpu/.test(firstRow), firstRow);
await p.keyboard.press('Escape');

await p.click('#btn-gallery');
const cards = await until(() => document.querySelectorAll('#gallery .card').length, 'the gallery');
check('the gallery has every example, and a blank board', cards >= 6, cards);
await sleep(600);
const painted = await app(() => { const c = document.querySelector('#gallery [data-scene="checkout"] canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let ink = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) ink++; return ink; });
check('its thumbnails are drawn', painted > 100, painted);
await shot('20-gallery');
await p.click('#gallery [data-scene="grid"]');
await until(() => window.app.m.sceneId === 'grid' && window.app.dash.panels.size === 9, 'the grid example');
check('an example opens from the gallery', true);
await until(() => window.app.readouts('cell-5').includes('req/s'), 'the grid to fill');
await shot('21-grid-example');

// Every example opens without a page error, and its labels have no mistakes.
const scenes = JSON.parse(fs.readFileSync(path.join(here, '../experiments/dashboard/scenes/scenes.json'), 'utf8'));
for (const s of scenes) {
  await app((id) => window.app.loadScene(id), s.id);
  await until((id) => window.app.m.sceneId === id, `${s.id} to open`, 15, s.id);
  await sleep(200);
  // The Prometheus example names a source you have not declared yet, which is its point.
  const errors = await app(() => window.app.dash.issues.filter((i) => i.level === 'error' && !/no source named "prom"/.test(i.message)));
  check(`${s.id}: no mistakes in its labels`, errors.length === 0, errors);
  const cut = await app(() => [...window.app.dash.panels.values()].filter((x) => x.kind !== 'plain' && x.texts.length).map((x) => window.app.headerOf(x.id)).filter((x) => x.shown !== x.full));
  check(`${s.id}: every title is whole`, cut.length === 0, cut);
}

// ===========================================================================
section('dark mode and the wall');

await app(() => window.app.loadScene('checkout'));
await until(() => window.app.m.sceneId === 'checkout' && window.app.readouts('api').length > 3, 'checkout');
await p.keyboard.press('d');
await until(() => document.documentElement.dataset.theme === 'dark', 'dark mode');
const inkOnDark = await app(() => { const e = window.app.board.get('api'); return { bg: window.app.board.background, stroke: e.strokeColor, fill: e.backgroundColor }; });
check('dark mode changes the board and shapes', inkOnDark.bg === '#1a1a19' && inkOnDark.stroke !== '#343a40', inkOnDark);
const darkPixel = await until(() => { const c = window.app.board.canvas; const d = [...c.getContext('2d').getImageData(4, 4, 1, 1).data].slice(0, 3); return d.every((v) => v < 50) && d; }, 'the canvas to go dark', 5);
check('the canvas really is dark', true, darkPixel);
const savedDark = await app(() => JSON.parse(window.app.save()).elements.find((e) => e.id === 'api').strokeColor);
check('dark mode does not change the saved file', savedDark === '#343a40', savedDark);
await shot('22-dark');
await p.click('#btn-incident');
await until(() => !document.getElementById('incident-menu').hidden, 'the incident menu');
await p.click('#incident-menu [data-kind="db-slow"]');
const darkCritical = await statusUntil('db', 'critical', 60);
check('an incident you start reaches the drawing', /above/.test(darkCritical.why), darkCritical);
const connectionsCritical = await statusUntil('connections', 'critical', 60);
check('the meter is critical too', /above/.test(connectionsCritical.why), connectionsCritical);
await sleep(300);
const onBoard = await app(() => window.app.headerOf('connections'));
check('on the board, "db connections" is whole beside CRITICAL', onBoard.shown === 'db connections' && (await readouts('connections')).includes('CRITICAL'), { onBoard, words: await readouts('connections') });
await shot('23-dark-incident');

await p.keyboard.press('f');
await until(() => window.app.m.wall && !document.getElementById('wallbar').hidden, 'the wall');
await sleep(400);
const wallLayout = await app(() => { const r = window.app.board.canvas.getBoundingClientRect(); return { w: r.width, viewport: innerWidth, bar: getComputedStyle(document.getElementById('bar')).display, left: getComputedStyle(document.getElementById('left')).display, insp: getComputedStyle(document.getElementById('inspector')).display, text: document.getElementById('wallbar').innerText }; });
const onWall = await app(() => window.app.headerOf('connections'));
check('on the wall, "db connections" is whole too', onWall.shown === 'db connections', onWall);
check('the wall hides the controls and fills the screen', wallLayout.bar === 'none' && wallLayout.left === 'none' && wallLayout.insp === 'none' && wallLayout.w === wallLayout.viewport, wallLayout);
const shapeOfCanvas = await until(() => { const c = window.app.board.canvas; const r = c.getBoundingClientRect(); return Math.abs(c.width / r.width - c.height / r.height) < 0.02 && { px: [c.width, c.height], css: [r.width, r.height] }; }, 'the canvas to match its box', 5);
check('the canvas is redrawn at its new size, not stretched', true, shapeOfCanvas);
check('the wall says what is firing, by name', /critical/.test(wallLayout.text) && /database|api/.test(wallLayout.text), wallLayout.text);
const named = wallLayout.text.split('\n').find((l) => /database|api/.test(l)).split(', ');
check('and names each thing once', new Set(named).size === named.length, named);
await shot('24-wall-firing');
await app(() => window.app.m.incident({ recover: true }));
await p.route('**/dashboard/**', (route) => route.abort());
const wallDown = await until(() => /NOT UPDATING/.test(document.getElementById('wallbar').innerText) && document.getElementById('wallbar').innerText, 'the wall to say it stopped updating', 30);
check('a wall that stops updating says so, large', /NOT UPDATING/.test(wallDown), wallDown);
await shot('25-wall-not-updating');
await p.unroute('**/dashboard/**');
await until(() => !/NOT UPDATING/.test(document.getElementById('wallbar').innerText), 'the wall to recover', 20);
await p.keyboard.press('Escape');
await until(() => !window.app.m.wall, 'leaving the wall');
await p.keyboard.press('d');
check('Escape leaves the wall', true);
clearProblems();

// The simulation can also fail on request, for trying out what that looks like.
await p.click('#btn-incident');
await p.click('#incident-menu [data-fail="1"]');
const demoFailed = await statusUntil('api', 'failed', 15);
check('a simulated failure names the source and the reason', /demo failed/.test(demoFailed.why), demoFailed);
await p.click('#btn-incident');
await p.click('#incident-menu [data-recover="1"]');
await statusUntil('api', 'ok', 20);
check('recover ends it', true);

// ===========================================================================
section('load: 30 panels, a second apart, with thousands of points each');

const SPAN = 3600;
for (let i = 0; i < 30; i++) prom.series.set(`load_${i}`, (t) => 50 + 40 * Math.sin(t / (20 + i)) + 5 * Math.sin(t * 1.7 + i));
const cellsLoad = [];
for (let i = 0; i < 30; i++) cellsLoad.push({ id: `L${i}`, x: 20 + (i % 6) * 300, y: 20 + Math.floor(i / 6) * 190, w: 290, h: 180, label: `metric ${i}\nchart\nprod: load_${i} in req/s\nwarn above 95 for 5s` });
await openDrawing(cellsLoad, { span: SPAN });
await until(() => [...window.app.dash.panels.values()].every((x) => x.chart?.strips[0].hasData), 'all 30 charts to fill', 60);
const counted = await app(() => { let total = 0, most = 0; for (const panel of window.app.dash.panels.values()) { const n = panel.chart.lines[0].series.n; total += n; most = Math.max(most, n); } return { total, most }; });
check('each chart holds thousands of points', counted.most >= 3000, counted);
await shot('26-thirty-panels');
const perf = await p.evaluate(async () => {
  const board = window.app.board;
  const frames = [];
  const renders = [];
  let last = performance.now();
  // Measure what a wall does in steady state: a data update every second, and redraws.
  const stop = performance.now() + 6000;
  await new Promise((resolve) => {
    const tick = (now) => {
      frames.push(now - last);
      last = now;
      if (board.frameMs) renders.push(board.frameMs);
      board.invalidate();
      if (now < stop) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
  const pct = (list, q) => { const s = [...list].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(1); };
  return { frames: frames.length, intervalP50: pct(frames, 0.5), intervalP95: pct(frames, 0.95), intervalMax: pct(frames, 1), renderP50: pct(renders, 0.5), renderP95: pct(renders, 0.95), renderMax: pct(renders, 1) };
});
console.log('    every frame redrawn, 30 charts:', JSON.stringify({ ...perf, points: counted.total }), 'load average', os.loadavg()[0].toFixed(1));
check('30 charts hold the frame rate while redrawing every frame', perf.renderP95 < 50 && perf.intervalP95 < 34, perf);
// Reading a pixel makes the browser finish drawing, so this is the whole cost of a frame.
const fullCost = await p.evaluate(async () => {
  const board = window.app.board;
  const ctx = board.canvas.getContext('2d');
  const times = [];
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const start = performance.now();
    board.render();
    ctx.getImageData(0, 0, 1, 1);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { p50: +times[20].toFixed(1), p95: +times[38].toFixed(1) };
});
console.log('    a whole frame, drawn and rasterized:', JSON.stringify(fullCost));
check('a whole frame, rasterized, stays inside 16 ms at the middle', fullCost.p50 < 16, fullCost);
// And with the crosshair moving across all of them, from a real mouse.
const cross = await p.evaluate(async () => { window.__renders = []; const stop = performance.now() + 2500; const tick = () => { window.__renders.push(window.app.board.frameMs); if (performance.now() < stop) requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; });
void cross;
const movePlot = await app(() => { const p_ = window.app.plotOf('L14'); const s = p_.strips[0]; return { a: window.app.toScreen(p_.plotX + 4, s.y + s.h / 2), b: window.app.toScreen(p_.plotX + p_.plotW - 4, s.y + s.h / 2) }; });
await p.mouse.move(movePlot.a.x, movePlot.a.y);
await p.mouse.move(movePlot.b.x, movePlot.b.y, { steps: 40 });
await sleep(1000);
const crossP95 = await app(() => { const s = [...window.__renders].sort((a, b) => a - b); return { p50: +s[Math.floor(s.length / 2)].toFixed(1), p95: +s[Math.floor(s.length * 0.95)].toFixed(1) }; });
console.log('    with the crosshair moving:', JSON.stringify(crossP95));
check('the crosshair stays quick across all 30', crossP95.p95 < 60, crossP95);
await p.mouse.move(2, 2);
// The drawing lays one line per panel, not one element per point.
const elementCount = await app(() => window.app.board.elements().length);
check('no element per data point: the stage holds only frames and titles', elementCount <= 61, elementCount);

// With dots moving, the frame loop runs all the time.
await app(() => window.app.loadScene('checkout'));
await until(() => window.app.m.sceneId === 'checkout' && window.app.m.flows.size === 5, 'checkout to run', 20);
const moving = await p.evaluate(async () => {
  const board = window.app.board;
  const frames = [];
  const renders = [];
  let last = performance.now();
  const stop = last + 3000;
  await new Promise((resolve) => {
    const tick = (now) => { frames.push(now - last); last = now; renders.push(board.frameMs); if (now < stop) requestAnimationFrame(tick); else resolve(); };
    requestAnimationFrame(tick);
  });
  const pct = (list, q) => +[...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(list.length * q))].toFixed(1);
  return { intervalP95: pct(frames, 0.95), renderP95: pct(renders, 0.95) };
});
console.log('    checkout with its dots moving:', JSON.stringify(moving));
check('moving dots hold the frame rate', moving.intervalP95 < 34 && moving.renderP95 < 20, moving);

// ===========================================================================
section('phone-sized window');

await p.setViewportSize({ width: 390, height: 780 });
await sleep(500);
const scroll = await app(() => ({ page: document.documentElement.scrollWidth, width: innerWidth }));
check('a narrow window has no sideways page scroll', scroll.page <= scroll.width, scroll);
await shot('27-narrow');
await p.setViewportSize({ width: 1600, height: 900 });

check('no page errors in the whole run', p.problems.length === 0, p.problems);
console.log(`\n${passed} checks passed. Screenshots in ${out}`);
await close();
promServer.close();
internalServer.close();
process.exit(0);
