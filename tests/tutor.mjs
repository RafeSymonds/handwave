// The tutor's tests. By default they replay recorded op streams and use no model calls.
//   node tests/tutor.mjs             validator and browser tests on recordings
//   node tests/tutor.mjs --live      real model calls and a latency table (spends subscription)
//       --models=claude-haiku-5-5    limit the models      --only=dns,sky    limit the questions
//   node tests/tutor.mjs --followup  a real follow-up that points at an element (2 model calls)
//   node tests/tutor.mjs --voice     real speechSynthesis at zero volume, no model calls
import assert from 'assert';
import fs from 'fs';
import http from 'http';
import os from 'os';
import { open, page, shots } from './browser.mjs';
import { startServer } from '../server.mjs';
import { refusal } from '../experiments/tutor/server.mjs';
import { Board, Lines, parseLine } from '../experiments/tutor/ops.mjs';

const OUT = shots('tutor');
fs.mkdirSync(OUT, { recursive: true });
const argv = process.argv.slice(2);
const LIVE = argv.includes('--live');
const FOLLOWUP = argv.includes('--followup');
const VOICE = argv.includes('--voice');
const passed = [];
const ok = (name) => { passed.push(name); console.log(`  ok  ${name}`); };
// Stopping the tutor cancels its request on purpose, and the browser logs that as a failure.
const realProblems = (p) => p.problems.filter((x) => !(x.startsWith('failed:') && x.endsWith('/tutor/ask')));

// ---------------------------------------------------------------- the validator

function validatorTests() {
  const b = new Board();
  const run = (raw) => b.apply(raw);
  assert.equal(run(null).ops.length, 0);
  assert.equal(run([1, 2]).ops.length, 0);
  assert.equal(run({ op: 'explode' }).ops.length, 0);
  assert.equal(run({ op: 'draw', kind: 'hexagon', id: 'x' }).ops.length, 0);
  assert.equal(run({ op: 'draw', kind: 'box', id: 'has spaces' }).ops.length, 0);
  ok('validator rejects junk');

  const clamped = run({ op: 'draw', kind: 'box', id: 'a', col: 99, row: -5, label: 'A', tone: 'purple' }).ops[0].item;
  assert.deepEqual([clamped.col, clamped.row, clamped.tone], [3, 0, 'gray']);
  const moved = run({ op: 'draw', kind: 'box', id: 'b', col: 3, row: 0, label: 'B' });
  assert.ok(moved.notes[0].startsWith('moved'));
  assert.notDeepEqual([moved.ops[0].item.col, moved.ops[0].item.row], [3, 0]);
  ok('validator clamps out-of-range cells and moves items off taken cells');

  // A span must fit and must not land on anything.
  const wide = run({ op: 'draw', kind: 'box', id: 'w', col: 2, row: 1, cols: 9, rows: 1, label: 'Wide' }).ops[0].item;
  assert.ok(wide.col + wide.cols <= 4);

  // An arrow to something not drawn yet waits, then appears.
  assert.equal(run({ op: 'draw', kind: 'arrow', id: 'wait', from: 'a', to: 'later' }).ops.length, 0);
  const later = run({ op: 'draw', kind: 'box', id: 'later', col: 0, row: 3, label: 'L' });
  assert.deepEqual(later.ops.map((o) => o.item.id), ['later', 'wait']);
  ok('an arrow drawn before its target waits for it');

  assert.equal(run({ op: 'draw', kind: 'arrow', id: 'never', from: 'a', to: 'nope' }).ops.length, 0);
  assert.deepEqual(b.endTurn(), ['arrow never never had both ends']);
  assert.equal(run({ op: 'draw', kind: 'arrow', id: 'self', from: 'a', to: 'a' }).ops.length, 0);
  ok('an arrow with a missing end or to itself is never drawn');

  // Removing an item takes its arrows with it.
  const removed = run({ op: 'remove', id: 'later' }).ops[0];
  assert.deepEqual(removed.ids.sort(), ['later', 'wait']);
  ok('removing an item removes its arrows');

  // Rewind: the board returns to what the page had applied.
  const c = new Board();
  c.apply({ op: 'draw', kind: 'box', id: 'one', col: 0, row: 0, label: '1' });
  c.apply({ op: 'draw', kind: 'box', id: 'two', col: 1, row: 0, label: '2' });
  c.apply({ op: 'update', id: 'one', tone: 'amber' });
  c.apply({ op: 'remove', id: 'two' });
  c.rewind(2);
  assert.ok(c.items.has('two'));
  assert.equal(c.items.get('one').tone, 'gray');
  assert.equal(c.log.length, 2);
  ok('rewind restores the state at an earlier op');

  // A delta boundary can fall anywhere in a line.
  const lines = new Lines();
  assert.deepEqual(lines.push('{"op":"sa'), []);
  assert.deepEqual(lines.push('y"}\n{"op'), ['{"op":"say"}']);
  assert.deepEqual(lines.flush(), ['{"op']);
  assert.deepEqual(parseLine('```json').ops, []);
  assert.equal(parseLine('{"op":"say"').ops.length, 0);
  assert.equal(parseLine('{"a":1}{"b":2}').ops.length, 2);
  assert.equal(parseLine('Plain words here.').ops[0].op, 'say');
  ok('line splitter and parser handle fences, partial lines and prose');
}

// ---------------------------------------------------------------- who may call the model

/** POST with exact headers, returning the status. A browser would not let a test forge Origin. */
function post(address, port, path, headers, body = JSON.stringify({ session: 'security-test', question: 'q', model: 'replay:fixture', speed: 50 })) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: address, port, path, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function securityTests() {
  // The rule itself, including what a real connection cannot easily produce.
  const req = (remoteAddress, host, origin) => ({ socket: { remoteAddress }, headers: { host, ...(origin === undefined ? {} : { origin }) } });
  assert.equal(refusal(req('127.0.0.1', 'localhost:4173', 'http://localhost:4173')), null);
  assert.equal(refusal(req('::1', '[::1]:4173', 'http://[::1]:4173')), null);
  assert.equal(refusal(req('::ffff:127.0.0.1', '127.0.0.1:4173', 'http://127.0.0.1:4173')), null);
  assert.ok(refusal(req('35.1.2.3', 'localhost:4173', 'http://localhost:4173')), 'public address');
  assert.ok(refusal(req('192.168.1.5', '192.168.1.5:4173', 'http://192.168.1.5:4173')), 'LAN address with matching origin');
  assert.ok(refusal(req('127.0.0.1', 'localhost:4173', 'https://evil.example')), 'other site');
  assert.ok(refusal(req('127.0.0.1', 'localhost:4173', 'http://localhost:9999')), 'other port');
  assert.ok(refusal(req('127.0.0.1', 'localhost:4173')), 'no Origin');
  assert.ok(refusal(req('127.0.0.1', 'localhost:4173', 'null')), 'sandboxed page');
  assert.ok(refusal(req('127.0.0.1', 'evil.example:4173', 'http://evil.example:4173')), 'DNS rebinding');
  ok('the rule refuses other machines, other origins, no origin and rebinding');

  // Over real sockets, on both routes.
  const local = await startServer(0, { host: '127.0.0.1', quiet: true });
  const own = `127.0.0.1:${local.port}`;
  for (const path of ['/tutor/ask', '/tutor/warm']) {
    const evil = await post('127.0.0.1', local.port, path, { Host: own, Origin: 'https://evil.example' });
    assert.equal(evil.status, 403, `${path} with another origin`);
    const none = await post('127.0.0.1', local.port, path, { Host: own });
    assert.equal(none.status, 403, `${path} with no origin`);
  }
  const rebound = await post('127.0.0.1', local.port, '/tutor/ask', { Host: `evil.example:${local.port}`, Origin: `http://evil.example:${local.port}` });
  assert.equal(rebound.status, 403);
  // The same request from its own page goes through, so the refusals above mean something.
  const fine = await post('127.0.0.1', local.port, '/tutor/ask', { Host: own, Origin: `http://${own}` });
  assert.equal(fine.status, 200);
  assert.match(fine.text, /"meta":"done"/);
  await local.close();
  ok('a real request with a foreign or missing origin gets 403, and its own page gets 200');

  // A real connection from another address: this machine's own network address, which
  // is not loopback, with an Origin that matches, as a page on that address would send.
  const lan = Object.values(os.networkInterfaces()).flat().find((n) => n.family === 'IPv4' && !n.internal)?.address;
  if (!lan) {
    console.log('  --  no network interface here, so the real non-loopback connection was not tried');
  } else {
    const exposed = await startServer(0, { host: lan, quiet: true });
    const where = `${lan}:${exposed.port}`;
    for (const path of ['/tutor/ask', '/tutor/warm']) {
      const res = await post(lan, exposed.port, path, { Host: where, Origin: `http://${where}` });
      assert.equal(res.status, 403, `${path} from ${lan}`);
    }
    await exposed.close();
    ok(`a real connection from a non-loopback address (${lan.replace(/\.\d+$/, '.x')}) gets 403`);
  }
}

// ---------------------------------------------------------------- helpers

const URL_REPLAY = (name, extra = '') => `/experiments/tutor/?model=replay:${name}&mute=1&pace=0.25${extra}`;
const idle = (p) => p.evaluate(() => new Promise((resolve) => {
  const m = window.app.metrics.current;
  if (m && m.finished !== undefined) resolve();
  else window.addEventListener('tutor-idle', resolve, { once: true });
}));
const center = (p, id) => p.evaluate((id) => {
  const { stage } = window.app;
  const el = stage.get(id);
  const r = stage.canvas.getBoundingClientRect();
  const v = stage.view;
  return { x: r.left + ((el.x + el.width / 2) * v.scale + v.ox) / v.css, y: r.top + ((el.y + el.height / 2) * v.scale + v.oy) / v.css };
}, id);
const clickEl = async (p, id) => { const c = await center(p, id); await p.mouse.click(c.x, c.y); };
const setModel = (p, value) => p.evaluate((value) => {
  const s = document.getElementById('model');
  if (![...s.options].some((o) => o.value === value)) s.add(new Option(value, value));
  s.value = value;
}, value);

async function askByKeyboard(p, words) {
  await p.click('#question');
  await p.keyboard.type(words);
  await p.keyboard.press('Enter');
}

// ---------------------------------------------------------------- recorded streams

async function replayTests(context, base) {
  const p = await page(context);
  const bodies = [];
  p.on('request', (r) => { if (r.url().endsWith('/tutor/ask')) bodies.push(JSON.parse(r.postData())); });
  await p.goto(base + URL_REPLAY('fixture'));
  await p.waitForFunction('window.app');
  await p.waitForTimeout(900);
  await p.screenshot({ path: `${OUT}/1-intro.png` });

  // Clicking a suggestion asks it.
  await clickEl(p, 'suggest-0');

  // The drawing grows while the stream is still arriving.
  const samples = [];
  for (let i = 0; i < 80; i++) {
    samples.push(await p.evaluate(() => ({ items: window.app.board.items.size, ended: window.app.metrics.current?.streamEnded !== undefined })));
    if (samples.at(-1).ended) break;
    await p.waitForTimeout(50);
  }
  const during = samples.filter((s) => !s.ended).map((s) => s.items);
  assert.ok(during.some((n) => n > 0), `nothing drew before the stream ended: ${during}`);
  assert.ok(new Set(during).size > 1, 'the board did not grow during the stream');
  ok(`drawing grows during the stream (items seen: ${[...new Set(during)].join(', ')})`);

  await p.screenshot({ path: `${OUT}/2-midway.png` });
  await idle(p);
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${OUT}/3-answer.png` });
  const problems = await p.evaluate(() => window.app.audit());
  assert.deepEqual(problems, []);
  ok('finished board has no overlaps, overflow or crossing arrows');

  // Point at an element with the mouse.
  await clickEl(p, 'cache');
  await p.waitForTimeout(300);
  assert.deepEqual(await p.evaluate(() => window.app.board.selected), ['cache']);
  assert.ok(await p.evaluate(() => !!window.app.stage.get('ring-cache')));
  assert.match(await p.textContent('#pointing'), /Cache/);
  await clickEl(p, 'a5-t');
  assert.deepEqual(await p.evaluate(() => window.app.board.selected), ['cache', 'a5']);
  await clickEl(p, 'a5');
  assert.deepEqual(await p.evaluate(() => window.app.board.selected), ['cache']);
  await p.screenshot({ path: `${OUT}/4-pointing.png` });
  ok('clicking an element points at it, and clicking again lets go');

  // The follow-up carries what is pointed at to the model.
  await setModel(p, 'replay:fixture-followup');
  await askByKeyboard(p, 'why does this one go there?');
  await p.waitForFunction(() => window.app.metrics.current.prompt);
  const prompt = await p.evaluate(() => window.app.metrics.current.prompt);
  assert.match(prompt, /POINTING AT\ncache \(Cache\)/);
  assert.match(prompt, /BOARD\ntitle: A lookup is a chain of questions/);
  assert.match(prompt, /a5: arrow resolver -> cache/);
  assert.equal(bodies.at(-1).pointing[0].id, 'cache');
  ok('a follow-up sends the pointed-at elements and the board to the model');

  await p.waitForFunction(() => window.app.board.items.get('cache').tone === 'amber');
  await p.waitForTimeout(100);
  const dim = await p.evaluate(() => [window.app.board.focus.has('cache'), window.app.stage.get('browser').opacity, window.app.stage.get('cache').opacity]);
  assert.deepEqual(dim, [true, 25, 100]);
  await p.screenshot({ path: `${OUT}/5-followup-focus.png` });
  await idle(p);
  assert.equal(await p.evaluate(() => window.app.board.focus.size), 0);
  assert.deepEqual(await p.evaluate(() => window.app.board.selected), []);
  assert.match(await p.evaluate(() => window.app.board.items.get('n1').text), /everyone nearby/);
  ok('a follow-up updates and focuses without redrawing');

  // Esc stops mid-answer, and the server's board goes back to match the page.
  await setModel(p, 'replay:fixture');
  await p.click('#new-board');
  await askByKeyboard(p, 'tell me again');
  await p.waitForFunction(() => window.app.board.items.size >= 3);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);
  const stopped = await p.evaluate(() => ({ items: [...window.app.board.items.keys()], queue: window.app.queue.length, seq: window.app.appliedSeq, caption: document.getElementById('caption').textContent }));
  assert.equal(stopped.queue, 0);
  assert.equal(stopped.caption, '');
  assert.ok(stopped.items.length < 10);
  await p.waitForTimeout(500);
  assert.equal(await p.evaluate(() => window.app.board.items.size), stopped.items.length, 'the board kept growing after stop');
  ok(`Esc stops mid-answer with ${stopped.items.length} items drawn`);

  await setModel(p, 'replay:fixture-followup');
  await askByKeyboard(p, 'what were you going to say?');
  await p.waitForFunction(() => window.app.metrics.current.prompt);
  const afterStop = await p.evaluate(() => window.app.metrics.current.prompt);
  assert.equal(bodies.at(-1).applied, stopped.seq);
  assert.match(afterStop, /free cells/);
  // Items the page never drew must not be on the model's board.
  for (const id of ['root', 'tld', 'auth', 'cache', 'n1']) {
    if (!stopped.items.includes(id)) assert.ok(!afterStop.includes(`${id}:`), `${id} is on the model's board but not on the page`);
  }
  assert.match(afterStop, /The student interrupted you/);
  ok('after a stop the model is told what was really said and drawn');
  await idle(p);

  // New board starts over.
  await p.click('#new-board');
  await p.waitForTimeout(300);
  assert.equal(await p.evaluate(() => window.app.board.items.size), 0);
  assert.ok(await p.evaluate(() => !!window.app.stage.get('suggest-0')));
  ok('new board clears the page');

  // A stream of garbage cannot break the board.
  await setModel(p, 'replay:garbage');
  await askByKeyboard(p, 'garbage please');
  await idle(p);
  await p.waitForTimeout(500);
  const g = await p.evaluate(() => ({ ids: [...window.app.board.items.keys()], notes: window.app.metrics.current.notes, error: window.app.metrics.current.error, audit: window.app.audit() }));
  for (const id of ['good1', 'good2', 'late', 'wild', 'arr']) assert.ok(g.ids.includes(id), `${id} missing from ${g.ids}`);
  for (const id of ['h1', 'lost', 'self', 'short', 'empty']) assert.ok(!g.ids.includes(id), `${id} should have been dropped`);
  assert.ok(g.notes.length >= 10, `notes: ${g.notes.length}`);
  assert.equal(g.error, undefined);
  assert.deepEqual(realProblems(p), []);
  await p.screenshot({ path: `${OUT}/6-garbage.png` });
  ok(`garbage stream: ${g.notes.length} bad lines dropped or fixed, board intact`);

  // Arrows into a strip never pass over its other cells.
  await p.click('#new-board');
  await setModel(p, 'replay:fixture-cells');
  await askByKeyboard(p, 'cells');
  await idle(p);
  await p.waitForTimeout(500);
  assert.deepEqual(await p.evaluate(() => window.app.audit()), []);
  await p.screenshot({ path: `${OUT}/7-cells.png` });
  ok('arrows reach a cell from above or below, over the strip when level');

  // A failing backend shows up as words, not a crash.
  await setModel(p, 'replay:does-not-exist');
  await askByKeyboard(p, 'and now?');
  await p.waitForFunction(() => /stopped/.test(document.getElementById('caption').textContent));
  assert.ok((await p.evaluate(() => window.app.board.items.size)) > 0);
  ok('a backend failure shows in the caption and keeps the board');
  assert.deepEqual(realProblems(p), []);
  await p.close();

  await syncTest(context, base);
  await micTest(context, base);
}

// The drawing waits for the voice. Fake speech lets the test end each sentence itself.
async function syncTest(context, base) {
  const p = await page(context);
  await p.addInitScript(() => {
    window.__spoken = [];
    const fake = {
      getVoices: () => [],
      addEventListener() {},
      cancel() { window.__current = null; },
      speak(u) { window.__spoken.push(u.text); window.__current = u; setTimeout(() => u.onstart?.({}), 0); },
    };
    Object.defineProperty(window, 'speechSynthesis', { value: fake });
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    window.__endSentence = () => { const u = window.__current; window.__current = null; u?.onend?.({}); };
  });
  await p.goto(`${base}/experiments/tutor/?model=replay:fixture&pace=0.1&speed=6`);
  await p.waitForFunction('window.app');
  await clickEl(p, 'suggest-1');
  // The whole stream arrives while the first sentence is still being spoken.
  await p.waitForFunction(() => window.app.metrics.current?.streamEnded !== undefined);
  await p.waitForTimeout(300);
  let s = await p.evaluate(() => ({ spoken: window.__spoken.length, items: [...window.app.board.items.keys()], caption: document.getElementById('caption').textContent }));
  assert.equal(s.spoken, 1);
  assert.deepEqual(s.items, ['browser', 'resolver', 'a1']);
  assert.match(s.caption, /asking a resolver/);
  ok('with the stream finished, only the first sentence and its drawing are out');
  await p.evaluate(() => window.__endSentence());
  await p.waitForFunction(() => window.__spoken.length === 2);
  await p.waitForTimeout(200);
  s = await p.evaluate(() => ({ items: [...window.app.board.items.keys()] }));
  assert.deepEqual(s.items, ['browser', 'resolver', 'a1', 'root', 'a2']);
  ok('the next beat draws when the voice reaches its sentence');
  for (let i = 0; i < 2; i++) {
    await p.evaluate(() => window.__endSentence());
    await p.waitForFunction((n) => window.__spoken.length === n, i + 3);
  }
  await p.waitForTimeout(300);
  await p.evaluate(() => window.__endSentence());
  await p.waitForFunction(() => window.app.metrics.current.finished !== undefined);
  const spoken = await p.evaluate(() => window.__spoken);
  assert.equal(spoken.length, 4);
  assert.equal(await p.evaluate(() => window.app.metrics.current.speech), 'voice');
  ok('all four sentences spoken in order, then the turn ends');
  assert.deepEqual(realProblems(p), []);
  await p.close();
}

async function micTest(context, base) {
  const p = await page(context);
  await p.addInitScript(() => {
    window.SpeechRecognition = class {
      start() {
        setTimeout(() => {
          this.onresult({ results: [Object.assign([{ transcript: 'how does' }], { isFinal: false })] });
          setTimeout(() => {
            this.onresult({ results: [Object.assign([{ transcript: 'how does the web work' }], { isFinal: true })] });
            this.onend();
          }, 30);
        }, 30);
      }
      stop() { this.onend(); }
    };
  });
  await p.goto(base + URL_REPLAY('fixture', '&speed=8'));
  await p.waitForFunction('window.app');
  await p.click('#mic');
  await p.waitForFunction(() => window.app.metrics.current?.question === 'how does the web work');
  assert.equal(await p.getAttribute('#mic', 'aria-pressed'), 'false');
  await idle(p);
  ok('the talk button sends a spoken question (with a fake recognizer)');
  await p.close();

  const q = await page(context);
  await q.addInitScript(() => {
    Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined });
    Object.defineProperty(window, 'SpeechRecognition', { value: undefined });
  });
  await q.goto(base + URL_REPLAY('fixture'));
  await q.waitForFunction('window.app');
  assert.equal(await q.isHidden('#mic'), true);
  ok('the talk button is hidden where the browser has no recognition');
  await q.close();
}

// ---------------------------------------------------------------- real speech, silent

async function voiceTest(context, base) {
  const p = await page(context);
  await p.goto(`${base}/experiments/tutor/?model=replay:fixture&volume=0&speed=1`);
  await p.waitForFunction('window.app');
  const voices = await p.evaluate(() => new Promise((resolve) => {
    const read = () => speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en')).map((v) => `${v.name}${v.localService ? '' : ' (remote)'}`);
    if (read().length) resolve(read());
    else {
      speechSynthesis.addEventListener('voiceschanged', () => resolve(read()), { once: true });
      setTimeout(() => resolve(read()), 1500);
    }
  }));
  console.log(`  voices in this browser: ${voices.length}`, voices.slice(0, 5));
  await clickEl(p, 'suggest-0');
  await p.waitForFunction(() => window.app.metrics.current?.firstSpoken !== undefined, null, { timeout: 15000 });
  const m = await p.evaluate(() => { const m = window.app.metrics.current; return { how: m.speech, firstOpAt: m.firstOpAt, firstSpoken: m.firstSpoken }; });
  console.log('  speech start', m, `from the op arriving to the voice starting: ${m.firstSpoken - m.firstOpAt} ms`);
  await p.close();
}

// ---------------------------------------------------------------- real model calls

const QUESTIONS = [
  ['dns', 'How does a website get its address?'],
  ['sky', 'Why is the sky blue?'],
  ['hash', 'What does a hash table do?'],
];

const metricsOf = (p) => p.evaluate(() => {
  const { prompt, ...m } = window.app.metrics.current;
  return { ...m, items: window.app.board.items.size, audit: window.app.audit() };
});

function report(rows, row, m) {
  rows.push(row);
  console.log(JSON.stringify(row));
  if (m.trace) console.log('    trace:', JSON.stringify(m.trace), 'apiMs', m.apiMs, 'usage', JSON.stringify(m.usage));
  if (m.notes?.length) console.log('    notes:', m.notes);
  if (m.audit.length) console.log('    audit:', m.audit);
  if (m.error) console.log('    error:', m.error);
}

async function liveTests(context, base) {
  const only = argv.find((a) => a.startsWith('--only='))?.slice(7);
  const models = (argv.find((a) => a.startsWith('--models='))?.slice(9) ?? 'claude-haiku-5-5,claude-sonnet-5-5').split(',');
  const rows = [];
  for (const model of models) {
    for (const [name, question] of QUESTIONS) {
      if (only && !only.split(',').includes(name)) continue;
      const short = model.replace('claude-', '').replace('-5-5', '');
      const p = await page(context);
      p.on('requestfailed', (r) => console.log('    request failed:', r.url(), r.failure()?.errorText));
      await p.goto(`${base}/experiments/tutor/?model=${model}&mute=1&record=live-${short}-${name}`);
      await p.waitForFunction('window.app');
      await p.click('#question');
      await p.keyboard.type(question);
      // Someone finishes typing before they press Enter, and typing is what warms the process.
      await p.waitForTimeout(1200);
      await p.keyboard.press('Enter');
      await idle(p);
      await p.waitForTimeout(800);
      const m = await metricsOf(p);
      await p.screenshot({ path: `${OUT}/live-${short}-${name}.png` });
      report(rows, { model: short, q: name, spawned: m.spawned, firstDelta: m.serverFirstDelta, firstSay: m.firstSpoken, firstShape: m.firstDrawn, streamEnd: m.streamEnded, finished: m.finished, items: m.items, cost: m.cost, notes: m.notes?.length, audit: m.audit.length }, m);
      if (p.problems.length) console.log('    problems:', p.problems);
      await p.close();
    }
  }
  console.table(rows);
}

async function followupTest(context, base) {
  const model = argv.find((a) => a.startsWith('--models='))?.slice(9) ?? 'claude-haiku-5-5';
  const short = model.replace('claude-', '').replace('-5-5', '');
  const p = await page(context);
  await p.goto(`${base}/experiments/tutor/?model=${model}&mute=1&pace=0.2`);
  await p.waitForFunction('window.app');
  const rows = [];
  await p.click('#question');
  await p.keyboard.type('What does a hash table do?');
  await p.waitForTimeout(1200);
  await p.keyboard.press('Enter');
  await idle(p);
  await p.waitForTimeout(500);
  let m = await metricsOf(p);
  report(rows, { turn: 1, firstDelta: m.serverFirstDelta, firstShape: m.firstDrawn, cost: m.cost, audit: m.audit.length }, m);
  const ids = await p.evaluate(() => [...window.app.board.items.values()].filter((i) => i.kind === 'box' || i.kind === 'cells').map((i) => i.kind === 'cells' ? `${i.id}.1` : i.id));
  console.log('    pointing at', ids[1] ?? ids[0]);
  await clickEl(p, ids[1] ?? ids[0]);
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/live-${short}-followup-1.png` });
  await p.click('#question');
  await p.keyboard.type('why does this one matter?');
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => window.app.metrics.current.firstDrawn !== undefined || window.app.metrics.current.finished !== undefined, null, { timeout: 60000 });
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${OUT}/live-${short}-followup-2.png` });
  await idle(p);
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${OUT}/live-${short}-followup-3.png` });
  m = await metricsOf(p);
  report(rows, { turn: 2, spawned: m.spawned, firstDelta: m.serverFirstDelta, firstSay: m.firstSpoken, firstShape: m.firstDrawn, cost: m.cost, audit: m.audit.length }, m);
  const said = await p.evaluate(() => window.app.metrics.current.question);
  console.log('    question was', said);
  await p.close();
}

// ----------------------------------------------------------------

validatorTests();
await securityTests();
const { base, context, close } = await open({ viewport: { width: 1600, height: 1000 } });
try {
  if (VOICE) await voiceTest(context, base);
  else if (LIVE) await liveTests(context, base);
  else if (FOLLOWUP) await followupTest(context, base);
  else await replayTests(context, base);
  console.log(`${passed.length} checks passed`);
} finally {
  await close();
}
process.exit(0);
