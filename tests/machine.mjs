// O8: the drawing is the program. Drives the real page with real mouse and keyboard.
// node tests/machine.mjs [screenshot dir]
import fs from 'fs';
import assert from 'assert/strict';
import { open, page, shots } from './browser.mjs';

const out = process.argv[2] ?? shots('machine');
fs.mkdirSync(out, { recursive: true });
const { base, browser, context, close } = await open();
const p = await page(context);
let passed = 0;
const check = (name, ok, detail = '') => { assert.ok(ok, `${name} ${JSON.stringify(detail)}`); passed++; console.log(`ok  ${name}${detail !== '' ? ' ' + JSON.stringify(detail) : ''}`); };
const section = (name) => console.log(`\n---- ${name}`);

const MACHINE = `${base}/experiments/machine/`;
await p.goto(`${MACHINE}#queue`);
await p.waitForFunction('window.app');

const screen = (x, y) => p.evaluate(([x, y]) => window.app.toScreen(x, y), [x, y]);
const middleOf = (id) => p.evaluate((id) => { const e = window.app.byId(id); return window.app.toScreen(e.x + e.width / 2, e.y + e.height / 2); }, id);
const endOf = (id, end) => p.evaluate(([id, end]) => { const e = window.app.byId(id); const pt = end === 'start' ? e.points[0] : e.points[e.points.length - 1]; return window.app.toScreen(e.x + pt[0], e.y + pt[1]); }, [id, end]);
const stats = () => p.evaluate(() => { const s = window.app.sim.stats(); return { ...s, bottleneck: s.bottleneck && { ...s.bottleneck } }; });
const forward = (s) => p.evaluate((s) => window.app.fastForward(s), s);
// With the page's clock held, only forward() moves the program, so a check gives the same
// answer on any machine at any load. Without this, the page keeps stepping between forward()
// calls, and how far depends on how long a screenshot or a mouse move took.
const holdClock = (on) => p.evaluate((on) => window.app.holdClock(on), on);
// A capture can stall when the machine is busy, which says nothing about the page. A page
// that has stopped answering is a real failure, so that is what a retry checks for.
const shot = async (name, q = p) => {
  await q.waitForTimeout(350);
  try {
    await q.screenshot({ path: `${out}/${name}.png`, timeout: 12000 });
  } catch (err) {
    const alive = await Promise.race([q.evaluate(() => { const t = window.app?.sim?.time; return { t }; }), new Promise((r) => setTimeout(() => r(null), 5000))]);
    assert.ok(alive, `the page stopped answering during ${name}`);
    console.log(`    capture of ${name} stalled, but the page is answering`, alive);
    await q.screenshot({ path: `${out}/${name}.png`, timeout: 30000 });
  }
};
const drag = async (from, to, steps = 12) => { await p.mouse.move(from.x, from.y); await p.mouse.down(); await p.mouse.move(to.x, to.y, { steps }); await p.mouse.up(); await p.waitForTimeout(60); };
const textMiddle = (id) => p.evaluate((id) => { const t = window.app.byId(id); return window.app.toScreen(t.x + t.width / 2, t.y + t.height / 2); }, id);
const editLabel = async (at, lines) => {
  await p.mouse.dblclick(at.x, at.y);
  await p.waitForFunction(() => window.app.editing);
  await p.keyboard.press('ControlOrMeta+a');
  for (let i = 0; i < lines.length; i++) {
    await p.keyboard.type(lines[i]);
    if (i < lines.length - 1) await p.keyboard.press('Shift+Enter');
  }
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => !window.app.editing);
};
const panelButton = async (id) => {
  const at = await p.evaluate((id) => { const e = window.app.panel.get(id); const r = window.app.panel.canvas.getBoundingClientRect(); const v = window.app.panel.view; return { x: r.left + ((e.x + e.width / 2) * v.scale + v.ox) / v.css, y: r.top + ((e.y + e.height / 2) * v.scale + v.oy) / v.css }; }, id);
  await p.mouse.click(at.x, at.y);
};
const openDemo = async (id) => {
  await p.click('#btn-demos');
  await p.waitForSelector(`#gallery [data-demo="${id}"]`);
  await p.click(`#gallery [data-demo="${id}"]`);
  await p.waitForFunction((id) => location.hash === `#${id}` && window.app.m.demo === id, id);
  await p.waitForTimeout(150);
};
const trayPart = (tab, part) => p.evaluate(([tab, part]) => {
  const e = window.app.tray.get(`part-${tab}-${part}`);
  const r = window.app.tray.canvas.getBoundingClientRect();
  const v = window.app.tray.view;
  return { x: r.left + ((e.x + e.width / 2) * v.scale + v.ox) / v.css, y: r.top + ((e.y + e.height / 2) * v.scale + v.oy) / v.css };
}, [tab, part]);
const dropPart = async (tab, part, at) => {
  await p.click(`#tabs [data-tab="${tab}"]`);
  await p.waitForTimeout(40);
  await drag(await trayPart(tab, part), at, 10);
};
// Hover a shape, then pull its blue circle onto another shape.
const connect = async (fromId, toId) => {
  const from = await middleOf(fromId);
  await p.mouse.move(from.x, from.y);
  await p.waitForTimeout(30);
  const circle = await p.evaluate((id) => { const e = window.app.byId(id); const w = e.width, h = e.height; let c; if (e.type === 'rectangle') c = [e.x + w + 13, e.y - 13]; else { const k = e.type === 'ellipse' ? Math.SQRT1_2 : 0.5; c = [e.x + w / 2 + (w / 2) * k + 13, e.y + h / 2 - (h / 2) * k - 13]; } return window.app.toScreen(c[0], c[1]); }, fromId);
  const to = await middleOf(toId);
  await p.mouse.move(circle.x, circle.y, { steps: 3 });
  await p.waitForTimeout(20);
  await p.mouse.down();
  await p.mouse.move(to.x, to.y, { steps: 10 });
  await p.mouse.up();
  await p.waitForTimeout(60);
};
const dropFile = (name, contents) => p.evaluate(async ([name, contents]) => {
  const dt = new DataTransfer();
  dt.items.add(new File([contents], name, { type: 'application/json' }));
  dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 200));
}, [name, contents]);
const clickBubble = async (index = 0) => {
  await p.waitForFunction((i) => window.app.m.bubbles.length > i, index);
  const at = await p.evaluate((i) => { const b = window.app.m.bubbles[i]; return b ? window.app.toScreen(b.x + b.w / 2, b.y + b.h / 2) : null; }, index);
  assert.ok(at, 'a message is on the drawing');
  await p.mouse.click(at.x, at.y);
  await p.waitForTimeout(60);
};

// Frames, and how long this page's own code took in each. A frame can only be late because
// of the page if its own work took a long time, so that is checked on any machine. Frame rate
// is judged against what an empty board gets right now, which says how busy the machine is.
const frames = (count) => p.evaluate(async (count) => {
  const { board } = window.app;
  const real = board.advance;
  const work = [];
  board.advance = function advance(dt) { const t0 = performance.now(); real.call(this, dt); work.push(performance.now() - t0); };
  const times = [];
  let last = performance.now();
  for (let i = 0; i < count; i++) {
    await new Promise(requestAnimationFrame);
    const now = performance.now();
    times.push(now - last);
    last = now;
  }
  delete board.advance;
  times.sort((a, b) => a - b);
  work.sort((a, b) => a - b);
  return { medianFrameMs: +times[Math.floor(count / 2)].toFixed(1), p95FrameMs: +times[Math.floor(count * 0.95)].toFixed(1), fps: +(1000 / times[Math.floor(count / 2)]).toFixed(1), workMs: +work[Math.floor(work.length * 0.95)].toFixed(2) };
}, count);
const idleFrames = async () => {
  await p.evaluate(() => window.app.loadBlank());
  await p.waitForTimeout(150);
  return frames(40);
};
const atSpeed = (got, idle, { median = 17.5, p95 = 22, work = 10 } = {}) => got.workMs < work && got.medianFrameMs < Math.max(median, idle.medianFrameMs * 1.15) && got.p95FrameMs < Math.max(p95, idle.p95FrameMs * 1.5);

// ---------------------------------------------------------------------------
section('the drawing is read as a program');
const kinds = await p.evaluate(() => Object.fromEntries([...window.app.graph.nodes.values()].map((n) => [n.id, n.kind])));
check('queue drawing reads as a flow', (await p.evaluate(() => window.app.graph.mode)) === 'flow');
assert.deepEqual(kinds, { requests: 'source', queue: 'queue', workers: 'workers', check: 'router', done: 'sink', failed: 'idle' });
check('every shape gets a role from its label and arrows', true, kinds);

const early = await p.evaluate(() => ({ time: window.app.sim.time, inFlight: window.app.sim.moving.length }));
await p.waitForFunction((t) => window.app.sim.time > t + 2.5 && window.app.sim.state('queue').arrivals.length > 0, early.time, { timeout: 60000 });
const later = await p.evaluate(() => ({ time: window.app.sim.time, inFlight: window.app.sim.moving.length, atQueue: window.app.sim.state('queue').arrivals.length, panel: window.app.panel.get('finished')?.text }));
check('it runs on the real clock, with nothing but the page moving it', later.time - early.time > 2.5 && later.atQueue > 0, { early, later });
await holdClock(true);
const heldAt = await p.evaluate(() => window.app.sim.time);
await p.waitForTimeout(200);
check('holding the clock stops it, so the checks below do not depend on this machine\'s speed', (await p.evaluate(() => window.app.sim.time)) === heldAt);

const twice = await p.evaluate(() => {
  const run = () => { window.app.restart(); window.app.fastForward(40); return JSON.stringify(window.app.sim.snapshot()); };
  return [run(), run()];
});
check('the same drawing and seed give the same run', twice[0] === twice[1] && twice[0].length > 50);

// ---------------------------------------------------------------------------
section('change the drawing and the behaviour changes');
await p.evaluate(() => window.app.restart());
await forward(90);
const three = await stats();
check('3 workers keep up', three.verdict === 'keeping up' && three.waiting < 20 && three.finished > 150, { waiting: three.waiting, finished: three.finished, capacity: three.bottleneck.capacity, demand: +three.bottleneck.demand.toFixed(2) });
await shot('01-three-workers');

const label = await textMiddle('workers-t');
await editLabel(label, ['workers 2', 'takes 0.75s']);
const two = await p.evaluate(() => window.app.graph.nodes.get('workers').params);
check('editing the label changes the program', two.workers === 2 && two.takes === 0.75, two);
check('the edited label is still native text', (await p.evaluate(() => window.app.byId('workers-t').originalText)) === 'workers 2\ntakes 0.75s');
await forward(40);
const short = await stats();
check('removing one worker makes the queue back up', short.verdict === 'backing up' && short.waiting > three.waiting + 10, { waiting: short.waiting, slope: +short.slope.toFixed(2), capacity: +short.bottleneck.capacity.toFixed(2), demand: +short.bottleneck.demand.toFixed(2) });
await forward(40);
const shorter = await stats();
check('and it keeps growing', shorter.waiting > short.waiting + 5, { before: short.waiting, after: shorter.waiting });
await shot('02-two-workers-backing-up');

const oneFewer = await p.evaluate(async () => {
  const { readGraph, infer } = await import('/experiments/machine/graph.js');
  const { FlowSim, STEP } = await import('/experiments/machine/sim.js');
  const data = await (await fetch('/experiments/machine/scenes/queue.excalidraw')).json();
  const base = infer(data.elements);
  const withWorkers = (n) => readGraph(base.map((e) => (e.id === 'workers-t' ? { ...e, text: `workers ${n}\ntakes 0.75s` } : e)));
  const g3 = withWorkers(3), g2 = withWorkers(2);
  // Three workers until an edit, then `after` for `seconds` more.
  const run = (seed, editAtStep, then, seconds) => {
    const sim = new FlowSim(g3, seed);
    for (let i = 0; i < editAtStep; i++) sim.step(STEP);
    const before = sim.stats().waiting;
    sim.setGraph(then);
    for (let i = 0; i < seconds * 60; i++) sim.step(STEP);
    const s = sim.stats();
    return { before, waiting: s.waiting, verdict: s.verdict };
  };
  const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
  const seeds = Array.from({ length: 40 }, (_, i) => 11 + i * 101);
  const two = seeds.map((seed) => run(seed, 90 * 60, g2, 120));
  const three = seeds.map((seed) => run(seed, 90 * 60, g3, 120));
  // The same edit one frame at a time, over ten seconds. This is what a slow machine does.
  const drift = [];
  for (let frame = 0; frame <= 600; frame += 2) drift.push(run(7, 90 * 60 + frame, g2, 40).waiting);
  let jump = 0;
  for (let i = 1; i < drift.length; i++) jump = Math.max(jump, Math.abs(drift[i] - drift[i - 1]));
  return {
    twoMedian: median(two.map((r) => r.waiting)), twoGrew: two.filter((r) => r.waiting > r.before + 20).length,
    threeMedian: median(three.map((r) => r.waiting)),
    falseCalm: two.concat(three).filter((r) => r.waiting >= 8 && r.verdict === 'keeping up').length,
    seeds: seeds.length, driftMin: Math.min(...drift), driftMax: Math.max(...drift), jump,
  };
});
check('across 40 seeds, 2 workers back up and 3 do not', oneFewer.twoMedian > 50 && oneFewer.twoGrew >= oneFewer.seeds * 0.9 && oneFewer.threeMedian < 8, oneFewer);
check('no seed calls a long line "keeping up"', oneFewer.falseCalm === 0, oneFewer.falseCalm);
check('moving an edit by one frame barely changes what happens next', oneFewer.jump <= 5 && oneFewer.driftMax - oneFewer.driftMin <= 15, { jump: oneFewer.jump, min: oneFewer.driftMin, max: oneFewer.driftMax });

const beforeMove = await p.evaluate(() => ({ s: { ...window.app.byId('workers') }, take: { ...window.app.byId('take') }, out: { ...window.app.byId('out') } }));
const from = await middleOf('workers');
const zoomNow = await p.evaluate(() => { const b = window.app.board; return (b.view.scale * b.camera.zoom) / b.view.css; });
await drag(from, { x: from.x + 40 * zoomNow, y: from.y + 60 * zoomNow });
const afterMove = await p.evaluate(() => ({ s: { ...window.app.byId('workers') }, take: { ...window.app.byId('take') }, out: { ...window.app.byId('out') }, label: { ...window.app.byId('workers-t') } }));
check('a dragged shape moves', Math.abs(afterMove.s.x - beforeMove.s.x - 40) < 3 && Math.abs(afterMove.s.y - beforeMove.s.y - 60) < 3, { dx: afterMove.s.x - beforeMove.s.x, dy: afterMove.s.y - beforeMove.s.y });
const takeEnd = [afterMove.take.x + afterMove.take.points[1][0], afterMove.take.y + afterMove.take.points[1][1]];
check('the arrow into it follows and still meets its edge', Math.abs(takeEnd[0] - afterMove.s.x) < 14 && takeEnd[1] > afterMove.s.y && takeEnd[1] < afterMove.s.y + afterMove.s.height, { end: takeEnd.map(Math.round), left: Math.round(afterMove.s.x) });
check('the arrow out of it follows', afterMove.out.x > afterMove.s.x + afterMove.s.width - 2 && afterMove.out.x < afterMove.s.x + afterMove.s.width + 14, { start: Math.round(afterMove.out.x) });
check('its label goes with it', Math.abs(afterMove.label.x + afterMove.label.width / 2 - (afterMove.s.x + afterMove.s.width / 2)) < 2);
check('dragging keeps the bindings', afterMove.take.endBinding.elementId === 'workers' && afterMove.out.startBinding.elementId === 'workers');
await shot('03-moved-workers');

const retryEnd = await endOf('retry', 'end');
const before = await p.evaluate(() => { const a = window.app.byId('retry'); return { x: a.x, y: a.y, points: a.points }; });
await drag(retryEnd, { x: retryEnd.x + 60, y: 60 });
const reverted = await p.evaluate(() => { const a = window.app.byId('retry'); return { x: a.x, y: a.y, points: a.points, to: window.app.graph.edges.get('retry').to }; });
check('an arrow dropped on nothing goes back', reverted.to === 'queue' && Math.abs(reverted.points.at(-1)[0] - before.points.at(-1)[0]) < 0.5);

await p.evaluate(() => window.app.restart());
await forward(60);
const retried = await p.evaluate(() => { let n = 0; const s = window.app.sim; for (const st of s.states.values()) { n += st.queue.filter((t) => t.retries > 0).length; n += st.busy.filter((b) => b.token.retries > 0).length; } return { retried: n, failed: s.state('failed').done, demand: s.bottleneck().demand }; });
check('before rewiring, failures come back round as retries', retried.failed === 0 && retried.retried > 0, retried);
const failedAt = await middleOf('failed');
const retryEnd2 = await endOf('retry', 'end');
await p.mouse.move(retryEnd2.x, retryEnd2.y);
await p.mouse.down();
await p.mouse.move(failedAt.x - 20, failedAt.y, { steps: 14 });
await shot('04-rewiring-in-progress');
await p.mouse.up();
await p.waitForTimeout(60);
const rewired = await p.evaluate(() => { const g = window.app.graph; const a = window.app.byId('retry'); const q = window.app.byId('queue'), f = window.app.byId('failed'); return { to: g.edges.get('retry').to, kind: g.nodes.get('failed').kind, binding: a.endBinding.elementId, qBound: q.boundElements.some((b) => b.id === 'retry'), fBound: f.boundElements.some((b) => b.id === 'retry') }; });
check('an arrow dropped on a shape rewires it', rewired.to === 'failed' && rewired.kind === 'sink' && rewired.binding === 'failed' && !rewired.qBound && rewired.fBound, rewired);
const onBoard = await p.evaluate(() => { const a = window.app.byId('retry'); const b = window.app.board; const c = b.camera; const pts = a.points.map(([x, y]) => [a.x + x, a.y + y]); return { maxY: Math.max(...pts.map((q) => q[1])), bottom: c.y + b.height / c.zoom }; });
check('a rewired bent arrow stays on the board', onBoard.maxY < onBoard.bottom, onBoard);
await forward(40);
const afterRewire = await p.evaluate(() => ({ failed: window.app.sim.state('failed').done, done: window.app.sim.state('done').done }));
check('rewiring changes the behavior', afterRewire.failed > 3, afterRewire);
await shot('05-rewired-to-failed');

const sourceLabel = await textMiddle('requests-t');
const bigQueue = (await stats()).waiting;
await editLabel(sourceLabel, ['requests', 'rate 1/s']);
await forward(25);
const drain = await stats();
check('less work drains the line', drain.waiting < bigQueue - 10, { before: bigQueue, after: drain.waiting });

const round = await p.evaluate(() => { const json = window.app.save(); const g = window.app.graphOf(json); const parsed = JSON.parse(json); return { type: parsed.type, retryTo: g.edges.get('retry').to, workers: g.nodes.get('workers').params.workers, rate: g.nodes.get('requests').params.rate, arrow: parsed.elements.find((e) => e.id === 'retry').endBinding.elementId, text: parsed.elements.find((e) => e.id === 'workers-t').containerId }; });
check('the edited drawing saves as a native file that reads back the same', round.type === 'excalidraw' && round.retryTo === 'failed' && round.workers === 2 && round.rate === 1 && round.arrow === 'failed' && round.text === 'workers', round);

const takeMid = await p.evaluate(() => { const a = window.app.byId('in'); return window.app.toScreen(a.x + a.width / 2, a.y); });
await p.mouse.dblclick(takeMid.x, takeMid.y);
await p.waitForFunction(() => window.app.editing);
await p.keyboard.type('new');
await p.keyboard.press('Escape');
check('Escape cancels an edit', await p.evaluate(() => !window.app.doc.some((e) => e.type === 'text' && e.containerId === 'in')));

await editLabel(sourceLabel, ['requests', 'rate lots']);
const issue = await p.evaluate(() => window.app.graph.issues[0]?.message);
check('an unreadable label is called out', /can't read/.test(issue ?? ''), issue);
await shot('06-bad-label');

await p.evaluate(() => window.app.loadDemo('queue'));
await p.waitForTimeout(100);
await editLabel(await textMiddle('queue-t'), ['queue limit 5']);
await editLabel(await textMiddle('workers-t'), ['workers 1', 'takes 1s']);
await forward(30);
const limited = await stats();
check('a limit on a queue turns work away and says so', limited.waiting <= 5 && limited.dropped > 5 && limited.verdict === 'turning away', { waiting: limited.waiting, dropped: limited.dropped, verdict: limited.verdict });
await shot('07-limit');

// ---------------------------------------------------------------------------
section('what is allowed: the table is the single source');
const table = await p.evaluate(async () => {
  const { WORDS, PARTS, readLabel, KINDS } = await import('/experiments/machine/vocab.js');
  const bad = [];
  let count = 0;
  for (const w of WORDS) {
    if (!w.forms.length) continue;
    count++;
    const modes = w.modes ?? [w.mode];
    for (const mode of modes.map((x) => (x === 'any' ? 'flow' : x))) {
      const r = readLabel(w.example, w.on, mode);
      if (!r.hits.some((h) => h.word.id === w.id) || r.problems.length) bad.push(`${w.id}: ${w.example} in ${mode}`);
    }
    if (!w.means) bad.push(`${w.id} has no meaning`);
  }
  const words = WORDS.filter((w) => w.forms.length).length;
  return { bad, count, words, kinds: Object.keys(KINDS).length };
});
check('every word in the table parses from its own example, in every mode it claims', table.bad.length === 0 && table.count > 35, table);

await p.keyboard.press('?');
await p.waitForSelector('#reference:not([hidden])');
await shot('15-reference');
const visibleRows = await p.evaluate(() => ({ visible: [...document.querySelectorAll('#reference tr[data-word]')].filter((tr) => tr.getBoundingClientRect().height > 0).length, search: document.getElementById('ref-search').value }));
check('opening the reference with ? shows every word, with nothing typed in its search box', visibleRows.visible > 35 && visibleRows.search === '', visibleRows);
const refCheck = await p.evaluate(async () => {
  const { WORDS } = await import('/experiments/machine/vocab.js');
  const rows = [...document.querySelectorAll('#reference tr[data-word]')];
  const shown = new Map(rows.map((tr) => [tr.dataset.word, tr.querySelector('code').textContent]));
  const missing = WORDS.filter((w) => w.forms.length && !shown.has(w.id)).map((w) => w.id);
  const wrong = WORDS.filter((w) => shown.has(w.id) && shown.get(w.id) !== w.example).map((w) => w.id);
  return { rows: rows.length, missing, wrong };
});
check('the reference is generated from the same table', refCheck.missing.length === 0 && refCheck.wrong.length === 0 && refCheck.rows > 35, refCheck);
await p.fill('#ref-search', 'timeout');
const searched = await p.evaluate(() => [...document.querySelectorAll('#reference tr[data-word]')].filter((tr) => !tr.hidden).map((tr) => tr.dataset.word));
check('searching the reference finds a word by another name', searched.includes('after'), searched);
await p.fill('#ref-search', '');
await p.click('#ref-close');
check('the reference closes', await p.evaluate(() => document.getElementById('reference').hidden));
const readme = fs.readFileSync(new URL('../experiments/machine/README.md', import.meta.url), 'utf8');
const readmeMissing = await p.evaluate(async (readme) => (await import('/experiments/machine/vocab.js')).WORDS.filter((w) => w.forms.length && !readme.includes(`\`${w.example}\``)).map((w) => w.example), readme);
check('the README lists every word in the table', readmeMissing.length === 0, readmeMissing);

await p.evaluate(() => window.app.loadDemo('queue'));
await p.waitForTimeout(1000);

// Hover shows what a shape is, with no click.
const qAt = await middleOf('queue');
await p.mouse.move(qAt.x, qAt.y);
await p.waitForFunction(() => /queue/.test(document.getElementById('insp-what')?.textContent ?? ''));
const hoverInfo = await p.evaluate(() => ({ what: document.getElementById('insp-what').textContent, says: document.getElementById('insp-says').textContent, why: document.getElementById('insp-why').textContent, adds: [...document.querySelectorAll('#inspector .add-word code')].map((c) => c.textContent) }));
check('hovering a shape says what the program thinks it is and why', /queue/.test(hoverInfo.what) && /no other word/.test(hoverInfo.why), hoverInfo);
check('and what else it could say', hoverInfo.adds.includes('limit 20') && hoverInfo.adds.includes('priority gold'), hoverInfo.adds);
await shot('16-hover-queue');

const wAt = await p.evaluate(() => { const e = window.app.byId('workers'); return window.app.toScreen(e.x + e.width / 2, e.y + 90); });
await p.mouse.click(wAt.x, wAt.y);
const picked = await p.evaluate(() => ({ selected: window.app.m.selected, words: [...document.querySelectorAll('#inspector .word-ok code')].map((c) => c.textContent) }));
check('clicking a shape shows which words it understood', picked.selected === 'workers' && picked.words.join() === 'workers 3,takes 0.75s', picked);
await shot('17-selected-workers');

// A slider changes the number in the drawing's own label. One undo takes it all back.
const slider = await p.$('#inspector .word-ok .scrub input');
const box = await slider.boundingBox();
await p.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
await p.mouse.down();
await p.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 8 });
await p.mouse.up();
await p.waitForTimeout(80);
const scrubbed = await p.evaluate(() => ({ workers: window.app.graph.nodes.get('workers').params.workers, text: window.app.byId('workers-t').text, past: window.app.m.past.length }));
check('dragging a slider rewrites the label and the program', scrubbed.workers > 3 && scrubbed.text.includes(`workers ${scrubbed.workers}`), scrubbed);
await p.keyboard.press('ControlOrMeta+z');
const unscrubbed = await p.evaluate(() => ({ workers: window.app.graph.nodes.get('workers').params.workers, past: window.app.m.past.length }));
check('one undo takes the whole slider drag back', unscrubbed.workers === 3 && unscrubbed.past === scrubbed.past - 1, unscrubbed);

// A misspelled word gets a message on the drawing, with a fix.
await p.evaluate(() => window.app.loadDemo('queue'));
await p.waitForTimeout(500);
await editLabel(await textMiddle('queue-t'), ['queue', 'limt 20']);
const spelled = await p.evaluate(() => ({ issue: window.app.graph.issues[0], bubbles: window.app.m.bubbles.length, limit: window.app.graph.nodes.get('queue').params.limit }));
check('a misspelled word is flagged with a suggestion', /Did you mean "limit 20"/.test(spelled.issue.message) && spelled.limit === undefined, spelled.issue.message);
await shot('18-misspelled-word');
await clickBubble();
const fixed = await p.evaluate(() => ({ text: window.app.byId('queue-t').text, limit: window.app.graph.nodes.get('queue').params.limit, issues: window.app.graph.issues.length }));
check('clicking the message on the drawing fixes it', fixed.text === 'queue\nlimit 20' && fixed.limit === 20 && fixed.issues === 0, fixed);
await p.keyboard.press('ControlOrMeta+z');
check('and the fix can be undone', (await p.evaluate(() => window.app.byId('queue-t').text)) === 'queue\nlimt 20');

// Other kinds of mistake, each with a specific message.
const mistakes = await p.evaluate(async () => {
  const { readLabel } = await import('/experiments/machine/vocab.js');
  const say = (l, on, mode) => readLabel(l, on, mode).problems.map((x) => x.message)[0] ?? '';
  return {
    synonym: say('threads 4', 'shape', 'flow'),
    place: say('workers 3', 'arrow', 'flow'),
    unknown: say('blorp 3', 'shape', 'flow'),
    arrow: say('aftr 5s', 'arrow', 'states'),
    badExpr: say('if ((', 'arrow', 'flow'),
    aName: say('checkout', 'shape', 'flow'),
    aServer: say('server 1\nworkers 2', 'shape', 'flow'),
  };
});
check('another word for something points at the right word', /workers 4/.test(mistakes.synonym), mistakes.synonym);
check('a word in the wrong place says where it goes', /goes on a shape/.test(mistakes.place), mistakes.place);
check('an unknown word with a number says it is only a name', /just a name/.test(mistakes.unknown) && /workers/.test(mistakes.unknown), mistakes.unknown);
check('a misspelled arrow word is caught in a state machine', /after 5s/.test(mistakes.arrow), mistakes.arrow);
check('a broken expression says why', /can't read/.test(mistakes.badExpr), mistakes.badExpr);
check('a plain name is not a mistake', mistakes.aName === '' && mistakes.aServer === '', mistakes);

// A word that reads but can't do anything where it is.
await p.evaluate(() => window.app.loadDemo('queue'));
await p.waitForTimeout(300);
await editLabel(await textMiddle('requests-t'), ['requests', 'rate 3/s', 'limit 5']);
const misplaced = await p.evaluate(() => window.app.graph.issues[0]?.message);
check('a word that does nothing on this shape says what it works on', /does nothing on a source/.test(misplaced) && /queue/.test(misplaced), misplaced);

// Typing gets live hints from the table.
await p.evaluate(() => window.app.loadDemo('queue'));
await p.waitForTimeout(300);
const qText = await textMiddle('queue-t');
await p.mouse.dblclick(qText.x, qText.y);
await p.waitForFunction(() => window.app.editing);
await p.keyboard.press('End');
await p.keyboard.press('Shift+Enter');
await p.keyboard.type('lim');
await p.waitForSelector('#hints:not([hidden])');
const hintWords = await p.evaluate(() => [...document.querySelectorAll('#hints .hint code')].map((c) => c.textContent));
check('typing shows hints for what starts that way', hintWords[0] === 'limit 20', hintWords);
await shot('19-hints-while-typing');
await p.keyboard.press('Tab');
await p.keyboard.type('7');
const editing = await p.evaluate(() => ({ value: document.getElementById('label').value, read: document.querySelector('#hints .read').textContent }));
check('Tab takes the hint with its number selected, ready to retype', editing.value === 'queue\nlimit 7' && /limit 7/.test(editing.read), editing);
await p.keyboard.press('Enter');
check('and it reads as the program', (await p.evaluate(() => window.app.graph.nodes.get('queue').params.limit)) === 7);

// The inspector's add buttons.
await p.mouse.click(qAt.x, qAt.y + 40);
await p.click('#inspector .add-word[data-words="priority gold"]');
const added = await p.evaluate(() => ({ text: window.app.byId('queue-t').text, priority: window.app.graph.nodes.get('queue').params.priority }));
check('clicking an allowed word adds it to the label', added.priority === 'gold' && added.text.endsWith('priority gold'), added);

// ---------------------------------------------------------------------------
section('build a program from nothing, with the mouse');
await p.click('#btn-demos');
await p.waitForSelector('#gallery [data-demo="blank"]');
await p.click('#gallery [data-demo="blank"]');
await p.waitForTimeout(150);
await shot('20-blank-board');
check('a blank board has nothing to run and says what to do', await p.evaluate(() => window.app.doc.length === 0 && window.app.m.nextStep().includes('Drag a part')));

const bo = await p.evaluate(() => { const r = window.app.board.canvas.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
const spot = (fx, fy) => ({ x: bo.l + bo.w * fx, y: bo.t + bo.h * fy });
await dropPart('work', 'source', spot(0.12, 0.35));
await dropPart('work', 'workers', spot(0.5, 0.35));
await dropPart('work', 'end', spot(0.86, 0.35));
const built = await p.evaluate(() => [...window.app.graph.nodes.values()].map((n) => ({ id: n.id, kind: n.kind, name: n.name })));
const idOf = (kindWanted) => built.find((n) => n.name === kindWanted)?.id;
check('parts dragged from the palette land as shapes with their labels', built.length === 3, built.map((n) => n.name));
const srcId = idOf('requests'), workId = idOf('workers'), endId = idOf('done');
assert.ok(srcId && workId && endId, 'found the three parts');
await shot('21-parts-before-arrows');
const srcIssue = await p.evaluate(() => window.app.graph.issues.map((i) => i.message));
check('a source with no arrow says so', srcIssue.some((m) => /no arrow out/.test(m)), srcIssue);

await connect(srcId, workId);
await connect(workId, endId);
const wired = await p.evaluate(() => [...window.app.graph.edges.values()].map((e) => [e.from, e.to]));
check('dragging from the blue circle draws a bound arrow', wired.length === 2 && wired[0][0] === srcId && wired[0][1] === workId && wired[1][0] === workId && wired[1][1] === endId, wired);
check('the arrows are bound in the file too', await p.evaluate(([s, w]) => { const a = window.app.doc.find((e) => e.type === 'arrow' && e.startBinding?.elementId === s); const shape = window.app.byId(s), target = window.app.byId(w); return a.endBinding.elementId === w && shape.boundElements.some((b) => b.id === a.id) && target.boundElements.some((b) => b.id === a.id); }, [srcId, workId]));
await forward(30);
const homemade = await stats();
check('the drawing just made runs', homemade.finished > 20 && (await p.evaluate(() => window.app.graph.mode)) === 'flow', { finished: homemade.finished, verdict: homemade.verdict });
await shot('22-built-from-nothing');

// Drop a part on an arrow to put it in line.
const arrowMid = await p.evaluate(([w, e]) => { const a = window.app.doc.find((x) => x.type === 'arrow' && x.startBinding?.elementId === w && x.endBinding?.elementId === e); return window.app.toScreen(a.x + a.points.at(-1)[0] / 2, a.y + a.points.at(-1)[1] / 2); }, [workId, endId]);
await dropPart('work', 'delay', arrowMid);
const inserted = await p.evaluate(([w, e]) => { const g = window.app.graph; const delay = [...g.nodes.values()].find((n) => n.kind === 'delay'); return { delay: delay?.id, intoDelay: [...g.edges.values()].some((x) => x.from === w && x.to === delay?.id), outOfDelay: [...g.edges.values()].some((x) => x.from === delay?.id && x.to === e), direct: [...g.edges.values()].some((x) => x.from === w && x.to === e), edges: g.edges.size }; }, [workId, endId]);
check('a part dropped on an arrow goes in line', inserted.intoDelay && inserted.outOfDelay && !inserted.direct && inserted.edges === 3, inserted);
await forward(20);
const delayTime = await p.evaluate((d) => window.app.sim.metrics(window.app.graph.nodes.get(d)).done === 0 && window.app.sim.state(d).through > 5, inserted.delay);
check('and work goes through it', delayTime);

// Undo walks back, redo walks forward.
const beforeUndo = await p.evaluate(() => ({ nodes: window.app.graph.nodes.size, edges: window.app.graph.edges.size }));
await p.keyboard.press('ControlOrMeta+z');
const afterUndo = await p.evaluate(() => ({ nodes: window.app.graph.nodes.size, edges: window.app.graph.edges.size }));
check('undo takes the part back out', afterUndo.nodes === beforeUndo.nodes - 1 && afterUndo.edges === beforeUndo.edges - 1, afterUndo);
await p.click('#btn-redo');
const afterRedo = await p.evaluate(() => ({ nodes: window.app.graph.nodes.size, edges: window.app.graph.edges.size }));
check('redo puts it back', afterRedo.nodes === beforeUndo.nodes && afterRedo.edges === beforeUndo.edges, afterRedo);

// Delete by keyboard removes a shape, its label and its arrows.
const delayAt = await middleOf(inserted.delay);
await p.mouse.click(delayAt.x, delayAt.y);
await p.keyboard.press('Delete');
const deleted = await p.evaluate((d) => ({ shape: !!window.app.byId(d), texts: window.app.doc.filter((e) => e.containerId === d).length, dangling: window.app.doc.filter((e) => e.type === 'arrow' && (e.startBinding?.elementId === d || e.endBinding?.elementId === d)).length, refs: window.app.doc.filter((e) => (e.boundElements ?? []).some((b) => !window.app.byId(b.id))).length }), inserted.delay);
check('Delete removes a shape, its label and its arrows, and leaves no dangling references', !deleted.shape && deleted.texts === 0 && deleted.dangling === 0 && deleted.refs === 0, deleted);
await p.keyboard.press('ControlOrMeta+z');
check('undo restores all of it', await p.evaluate((d) => !!window.app.byId(d) && window.app.graph.edges.size === 3, inserted.delay));

// An arrow can be selected and deleted too, and a copy keeps its label.
const anEdge = await p.evaluate(([s, w]) => { const a = window.app.doc.find((x) => x.type === 'arrow' && x.startBinding?.elementId === s && x.endBinding?.elementId === w); return { id: a.id, at: window.app.toScreen(a.x + a.points.at(-1)[0] / 2, a.y + a.points.at(-1)[1] / 2) }; }, [srcId, workId]);
await p.mouse.click(anEdge.at.x, anEdge.at.y);
const arrowPanel = await p.evaluate(() => ({ selected: window.app.m.selected, says: document.getElementById('insp-says')?.textContent, adds: [...document.querySelectorAll('#inspector .add-word code')].map((c) => c.textContent) }));
check('selecting an arrow lists what its label can say', arrowPanel.selected === anEdge.id && arrowPanel.adds.includes('90%') && arrowPanel.adds.includes('if retries < 3'), arrowPanel);
check('and leaves out words that do nothing on this arrow', !arrowPanel.adds.includes('hit') && !arrowPanel.adds.includes('over') && !arrowPanel.adds.includes('after 5s'), arrowPanel.adds);
await shot('23-arrow-selected');
await p.keyboard.press('Backspace');
check('Backspace deletes the selected arrow', await p.evaluate((a) => !window.app.byId(a), anEdge.id));
await p.keyboard.press('ControlOrMeta+z');
await p.mouse.click(spot(0.5, 0.9).x, spot(0.5, 0.9).y);
const wAgain = await middleOf(workId);
await p.mouse.click(wAgain.x, wAgain.y - 40);
await p.keyboard.press('ControlOrMeta+d');
const copied = await p.evaluate(() => { const id = window.app.m.selected; const n = window.app.graph.nodes.get(id); return { id, kind: n?.kind, workers: n?.params.workers, text: n?.label }; });
check('a copy is a new shape with its own label', copied.id !== workId && copied.kind && copied.workers === 2, copied);
await p.keyboard.press('Delete');

// A selected shape's corner resizes it.
await p.mouse.click(wAgain.x, wAgain.y - 40);
const sizeBefore = await p.evaluate((id) => { const e = window.app.byId(id); const t = window.app.doc.find((x) => x.containerId === id); const a = window.app.doc.find((x) => x.type === 'arrow' && x.startBinding?.elementId === id); return { w: e.width, h: e.height, x: e.x, corner: window.app.toScreen(e.x + e.width + 3, e.y + e.height + 3), labelMiddle: t.x + t.width / 2 }; }, workId);
await drag(sizeBefore.corner, { x: sizeBefore.corner.x + 50, y: sizeBefore.corner.y + 30 });
const sizeAfter = await p.evaluate((id) => { const e = window.app.byId(id); const t = window.app.doc.find((x) => x.containerId === id); const a = window.app.doc.find((x) => x.type === 'arrow' && x.startBinding?.elementId === id); return { w: e.width, h: e.height, right: e.x + e.width, labelMiddle: t.x + t.width / 2, middle: e.x + e.width / 2, arrowStart: a.x }; }, workId);
check('dragging the corner resizes a shape, and its label and arrows follow', sizeAfter.w > sizeBefore.w + 40 && sizeAfter.h > sizeBefore.h + 20 && Math.abs(sizeAfter.labelMiddle - sizeAfter.middle) < 2 && Math.abs(sizeAfter.arrowStart - sizeAfter.right) < 14, { before: sizeBefore.w, after: sizeAfter });
await p.keyboard.press('ControlOrMeta+z');
check('undo restores the size', (await p.evaluate((id) => window.app.byId(id).width, workId)) === sizeBefore.w);

// A note is free text that does nothing, wherever it goes.
await dropPart('work', 'note', spot(0.5, 0.2));
await p.waitForFunction(() => window.app.editing);
await p.keyboard.press('ControlOrMeta+a');
await p.keyboard.type('workers 9');
await p.keyboard.press('Enter');
const noted = await p.evaluate(() => { const n = window.app.doc.find((e) => e.text === 'workers 9'); return { id: n.id, attached: !!(n.containerId || n.customData?.machine?.owner), graphWorkers: [...window.app.graph.nodes.values()].map((x) => x.params.workers), at: window.app.toScreen(n.x + n.width / 2, n.y + n.height / 2), x: n.x }; });
check('a note can say anything and changes nothing', !noted.attached && !noted.graphWorkers.includes(9), noted);
await p.mouse.move(noted.at.x, noted.at.y);
await p.waitForFunction(() => /note/.test(document.getElementById('insp-what')?.textContent ?? ''));
check('hovering a note says it does nothing', /does nothing/.test(await p.evaluate(() => document.getElementById('insp-says').textContent)));
await drag(noted.at, { x: noted.at.x + 60, y: noted.at.y + 40 });
check('a note can be dragged', (await p.evaluate((id) => window.app.byId(id).x, noted.id)) > noted.x + 30);
const notedAt = await p.evaluate((id) => { const n = window.app.byId(id); return window.app.toScreen(n.x + n.width / 2, n.y + n.height / 2); }, noted.id);
await p.mouse.click(notedAt.x, notedAt.y);
await p.keyboard.press('Delete');
check('and deleted', await p.evaluate((id) => !window.app.byId(id), noted.id));

// Double-clicking nothing makes a shape to type into.
await p.mouse.dblclick(spot(0.5, 0.82).x, spot(0.5, 0.82).y);
await p.waitForFunction(() => window.app.editing);
await p.keyboard.type('note to self');
await p.keyboard.press('Enter');
const typed = await p.evaluate(() => [...window.app.graph.nodes.values()].some((n) => n.name === 'note to self'));
check('double-clicking nothing adds a shape and starts typing its label', typed);

// ---------------------------------------------------------------------------
section('build a state machine and a circuit with the mouse');
await p.evaluate(() => window.app.save());
const savedBuilt = await p.evaluate(() => window.app.save());
await p.evaluate(() => window.app.loadBlank());
await p.waitForTimeout(100);
await dropPart('states', 'state', spot(0.3, 0.45));
await dropPart('states', 'state', spot(0.7, 0.45));
const twoStates = await p.evaluate(() => window.app.doc.filter((e) => e.type === 'rectangle').map((e) => e.id));
await connect(twoStates[0], twoStates[1]);
await connect(twoStates[1], twoStates[0]);
const smMode = await p.evaluate(() => ({ mode: window.app.graph.mode, current: window.app.sim.current, events: window.app.sim.events() }));
check('two shapes and two unlabelled arrows make a state machine that moves on "next"', smMode.mode === 'states' && smMode.current === twoStates[0] && smMode.events.join() === 'next', smMode);
await connect(twoStates[0], twoStates[0]);
const loop = await p.evaluate((id) => { const a = window.app.doc.find((e) => e.type === 'arrow' && e.startBinding?.elementId === id && e.endBinding?.elementId === id); return { id: a?.id, points: a?.points.length, edges: window.app.graph.edges.size }; }, twoStates[0]);
check('an arrow dragged back to its own shape makes a loop', loop.id && loop.points === 3, loop);
const stateAt = await middleOf(twoStates[0]);
const loopBefore = await p.evaluate((id) => window.app.byId(id).y, loop.id);
await drag(stateAt, { x: stateAt.x, y: stateAt.y + 50 });
check('the loop moves with its shape', (await p.evaluate((id) => window.app.byId(id).y, loop.id)) > loopBefore + 30);
await shot('40-self-loop');
await p.evaluate(() => window.app.m.select(null));
const loopLabelAt = await p.evaluate((id) => { const a = window.app.byId(id); return window.app.toScreen(a.x + a.points[1][0], a.y + a.points[1][1]); }, loop.id);
await p.mouse.dblclick(loopLabelAt.x, loopLabelAt.y);
await p.waitForFunction(() => window.app.editing);
await p.keyboard.type('coin / money += 25');
await p.keyboard.press('Enter');
await p.keyboard.press('1');
await p.keyboard.press('1');
const coins = await p.evaluate(() => { window.app.fastForward(1); return { events: window.app.sim.events(), money: window.app.sim.vars.money }; });
check('a label typed on the loop gives it an event and an action', coins.events.includes('coin'), coins);

await dropPart('states', 'start', await middleOf(twoStates[1]));
const started = await p.evaluate((b) => { const g = window.app.graph; const e = [...g.edges.values()].find((x) => !x.from && x.to === b); window.app.restart(); return { edge: !!e, current: window.app.sim.current }; }, twoStates[1]);
check('the start arrow from the palette marks where it begins', started.edge && started.current === twoStates[1], started);

await p.evaluate(() => window.app.loadBlank());
await p.waitForTimeout(100);
await dropPart('logic', 'switch', spot(0.15, 0.3));
await dropPart('logic', 'button', spot(0.15, 0.65));
await dropPart('logic', 'or', spot(0.45, 0.5));
await dropPart('logic', 'not', spot(0.65, 0.5));
await dropPart('logic', 'lamp', spot(0.85, 0.5));
const parts = await p.evaluate(() => Object.fromEntries([...window.app.graph.nodes.values()].map((n) => [n.kind, n.id])));
check('logic parts from the palette make a circuit', (await p.evaluate(() => window.app.graph.mode)) === 'logic' && parts.switch && parts.lamp, parts);
check('a part with no name of its own is called what it is', (await p.evaluate((id) => window.app.graph.nodes.get(id).name, parts.switch)) === 'switch');
await connect(parts.switch, parts.or);
await connect(parts.button, parts.or);
await connect(parts.or, parts.not);
await connect(parts.not, parts.lamp);
await forward(2);
const lampOf = () => p.evaluate((id) => window.app.sim.value(id), parts.lamp);
check('switch off, button up: or is 0, not is 1, lamp on', (await lampOf()) === 1);
const swMid = await middleOf(parts.switch);
await p.mouse.click(swMid.x, swMid.y);
await forward(2);
check('click the switch: the lamp goes off', (await lampOf()) === 0);
await shot('41-built-circuit');
await p.mouse.click(swMid.x, swMid.y);
await forward(2);
const btnMid = await middleOf(parts.button);
await p.mouse.move(btnMid.x, btnMid.y);
await p.mouse.down();
await forward(2);
const whileHeld = await lampOf();
await p.mouse.up();
await forward(2);
check('a button is on only while held', whileHeld === 0 && (await lampOf()) === 1, { whileHeld });
const flowWord = await p.evaluate(async () => (await import('/experiments/machine/vocab.js')).readLabel('and', 'shape', 'flow').problems[0]?.message);
check('a logic word in a flow says why it does nothing', /logic word/.test(flowWord ?? ''), flowWord);
await p.evaluate(() => window.app.loadDemo('queue'));
await p.waitForTimeout(150);

// The open button takes the same file a drop does.
const opened = await p.evaluate(() => window.app.save());
await p.setInputFiles('#file', { name: 'opened.excalidraw', mimeType: 'application/json', buffer: Buffer.from(opened) });
await p.waitForFunction(() => window.app.title === 'opened.excalidraw');
check('the open button loads a file', (await p.evaluate(() => window.app.graph.nodes.size)) === 6);

// ---------------------------------------------------------------------------
section('save writes a file that really reopens');
await dropFile('built.excalidraw', savedBuilt);
const [download] = await Promise.all([p.waitForEvent('download'), p.click('#btn-save')]);
const savedPath = `${out}/saved.excalidraw`;
await download.saveAs(savedPath);
const savedText = fs.readFileSync(savedPath, 'utf8');
const saved = JSON.parse(savedText);
check('save downloads a file named .excalidraw', download.suggestedFilename().endsWith('.excalidraw') && saved.type === 'excalidraw' && saved.version === 2, download.suggestedFilename());
const FIELDS = ['id', 'type', 'x', 'y', 'width', 'height', 'angle', 'strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'seed', 'version', 'versionNonce', 'isDeleted', 'updated', 'link', 'locked', 'groupIds', 'frameId', 'roundness', 'boundElements'];
const lacking = saved.elements.flatMap((e) => FIELDS.filter((f) => !(f in e)).map((f) => `${e.id}.${f}`));
check('every element has every field Excalidraw writes', lacking.length === 0, lacking.slice(0, 6));
const ids = new Set(saved.elements.map((e) => e.id));
const broken = saved.elements.flatMap((e) => [
  ...(e.boundElements ?? []).filter((b) => !ids.has(b.id)).map((b) => `${e.id} > ${b.id}`),
  ...(e.startBinding && !ids.has(e.startBinding.elementId) ? [`${e.id} start`] : []),
  ...(e.endBinding && !ids.has(e.endBinding.elementId) ? [`${e.id} end`] : []),
  ...(e.containerId && !ids.has(e.containerId) ? [`${e.id} container`] : []),
]);
check('every binding in the file points at something real', broken.length === 0, broken);
const twoWay = saved.elements.filter((e) => e.type === 'arrow').every((a) => [a.startBinding, a.endBinding].every((b) => !b || saved.elements.find((x) => x.id === b.elementId).boundElements.some((r) => r.id === a.id)));
check('arrows and shapes point at each other, as Excalidraw needs', twoWay);

const beforeReload = await p.evaluate(() => [...window.app.graph.nodes.values()].map((n) => [n.id, n.kind, JSON.stringify(n.params)]).sort());
await dropFile('saved.excalidraw', savedText);
const afterReload = await p.evaluate(() => [...window.app.graph.nodes.values()].map((n) => [n.id, n.kind, JSON.stringify(n.params)]).sort());
assert.deepEqual(afterReload, beforeReload);
check('the saved file reads back as the same program', true, afterReload.length);
await forward(30);
const reran = await stats();
check('and runs', reran.finished > 15, { finished: reran.finished, verdict: reran.verdict });
await shot('24-reopened');

// ---------------------------------------------------------------------------
section('pause, step and speed');
await p.evaluate(() => window.app.loadDemo('queue'));
await holdClock(false);
await p.waitForFunction(() => window.app.sim.time > 0.2, null, { timeout: 60000 });
await p.click('#btn-run');
await p.waitForTimeout(60);
const paused = await p.evaluate(() => ({ time: window.app.sim.time, label: document.getElementById('btn-run').textContent }));
await p.waitForTimeout(500);
const stillPaused = await p.evaluate(() => window.app.sim.time);
check('pause stops the clock and the button says run', stillPaused === paused.time && paused.label === 'run', { paused, stillPaused });
await shot('25-paused');
await p.click('#btn-step');
const stepped = await p.evaluate(() => window.app.sim.time);
check('step moves on a tenth of a second and stays paused', Math.abs(stepped - paused.time - 0.1) < 0.001 && (await p.evaluate(() => !window.app.running)), { stepped });
await p.keyboard.press('.');
check('the . key steps too', Math.abs((await p.evaluate(() => window.app.sim.time)) - stepped - 0.1) < 0.001);
await p.keyboard.press('Space');
await p.waitForTimeout(40);
check('Space runs it again', await p.evaluate(() => window.app.running));
// Speed is measured against the stage's clock, moved by hand, so it doesn't depend on frame rate.
const secondsFor = (frames) => p.evaluate((frames) => { const { board, sim } = window.app; const from = sim.time; board.pause(); for (let i = 0; i < frames; i++) board.advance(1 / 60); board.play(); return sim.time - from; }, frames);
await p.click('[data-speed="5"]');
const at5 = await secondsFor(120);
check('5x moves the program ten seconds in two seconds of clock', Math.abs(at5 - 10) < 0.05, +at5.toFixed(3));
await p.click('[data-speed="0.5"]');
const atHalf = await secondsFor(120);
check('half speed moves it one second in two', Math.abs(atHalf - 1) < 0.05, +atHalf.toFixed(3));
await p.click('[data-speed="1"]');
const atOne = await secondsFor(120);
check('1x moves it two seconds in two', Math.abs(atOne - 2) < 0.05, +atOne.toFixed(3));
await holdClock(true);

// ---------------------------------------------------------------------------
section('click a worker to kill it');
await p.evaluate(() => { window.app.restart(); window.app.fastForward(30); });
const slotPoint = (node, i) => p.evaluate(async ([node, i]) => {
  const { slotLayout } = await import('/experiments/machine/overlay.js');
  const n = window.app.graph.nodes.get(node);
  const s = slotLayout(n, window.app.sim.state(n.id))[i];
  return window.app.toScreen(s.x + s.size / 2, s.y + s.size / 2);
}, [node, i]);
const k0 = await slotPoint('workers', 0);
await p.mouse.click(k0.x, k0.y);
const k1 = await slotPoint('workers', 1);
await p.mouse.click(k1.x, k1.y);
const killed = await p.evaluate(() => { const s = window.app.sim; const st = s.state('workers'); return { dead: [...st.dead], capacity: s.bottleneck().capacity, doc: window.app.graph.nodes.get('workers').params.workers, message: window.app.message?.words }; });
check('clicking two boxes kills two workers without changing the drawing', killed.dead.length === 2 && Math.abs(killed.capacity - 4 / 3) < 0.01 && killed.doc === 3, killed);
await forward(40);
const crippled = await stats();
check('the rest cannot keep up', crippled.verdict === 'backing up' && crippled.waiting > 15, { waiting: crippled.waiting, verdict: crippled.verdict });
await shot('26-two-workers-killed');
await p.mouse.click(k0.x, k0.y);
check('clicking again brings one back', (await p.evaluate(() => window.app.sim.state('workers').dead.size)) === 1);
await p.click('#btn-restart');
check('restart heals everything', (await p.evaluate(() => window.app.sim.state('workers').dead.size)) === 0);

// ---------------------------------------------------------------------------
section('each new word does what the reference says');
const flowOf = async (labelsByShape, seconds, fn, runSeed = 3) => p.evaluate(async ([labels, seconds, fnText, runSeed]) => {
  const { readGraph, infer } = await import('/experiments/machine/graph.js');
  const { FlowSim, STEP } = await import('/experiments/machine/sim.js');
  const data = await (await fetch(`/experiments/machine/scenes/${labels.scene}.excalidraw`)).json();
  let elements = infer(data.elements);
  for (const [from, to] of labels.swap) elements = elements.map((e) => (e.type === 'text' && e.text === from ? { ...e, text: to } : e));
  const graph = readGraph(elements);
  const sim = new FlowSim(graph, runSeed);
  for (let i = 0, n = Math.round(seconds / STEP); i < n; i++) sim.step(STEP);
  return new Function('sim', 'graph', `return (${fnText})(sim, graph)`)(sim, graph);
}, [labelsByShape, seconds, fn.toString(), runSeed]);

const inLine = await flowOf({ scene: 'lines', swap: [] }, 240, (sim, g) => ({ shared: sim.metrics(g.nodes.get('a-done')).time, own: sim.metrics(g.nodes.get('b-done')).time }));
check('one shared line gets jobs through faster than one line per worker', inLine.own > inLine.shared * 1.3, inLine);

const stormOn = await flowOf({ scene: 'storm', swap: [] }, 150, (sim) => { const s = sim.stats(); return { verdict: s.verdict, goodRate: s.goodRate, wasteRate: s.wasteRate, wasted: s.wasted, waiting: s.waiting }; });
check('retries with no cancelling keep it down long after the burst, doing wasted work', stormOn.verdict === 'wasting' && stormOn.goodRate < 0.5 && stormOn.wasteRate > 3, stormOn);
const stormFix = await flowOf({ scene: 'storm', swap: [['copy after 5s', 'after 5s']] }, 150, (sim) => { const s = sim.stats(); return { verdict: s.verdict, goodRate: s.goodRate, wasted: s.wasted, waiting: s.waiting }; });
check('moving work instead of copying it recovers from the same burst', stormFix.wasted === 0 && stormFix.waiting < 15 && stormFix.goodRate > 2, stormFix);
const stormCalm = await flowOf({ scene: 'storm', swap: [['clients\nrate 3/s\nburst 40 at 15s', 'clients\nrate 3/s']] }, 150, (sim) => { const s = sim.stats(); return { wasted: s.wasted, waiting: s.waiting, goodRate: s.goodRate }; });
check('with no burst, the very same retries are harmless', stormCalm.waiting < 15 && stormCalm.goodRate > 2, stormCalm);

const fanned = {};
for (const n of [1, 8, 32]) fanned[n] = await flowOf({ scene: 'fanout', swap: [['split 8', `split ${n}`], ['workers 16\ntakes 0.2s\nslow 2% x50', 'workers 40\ntakes 0.2s\nslow 2% x50']] }, 400, (sim) => sim.stats().average);
check('split and merge: the wait follows the slowest part', fanned[32] > fanned[8] && fanned[8] > fanned[1] * 1.3, fanned);
const hedged = await flowOf({ scene: 'fanout', swap: [['merge', 'merge\nfirst 7']] }, 300, (sim) => sim.stats().average);
const whole = await flowOf({ scene: 'fanout', swap: [] }, 300, (sim) => sim.stats().average);
check('"first 7" stops waiting for the slowest part', hedged < whole * 0.8, { hedged, whole });

const batchAt = {};
for (const n of [1, 5, 16]) batchAt[n] = await flowOf({ scene: 'batch', swap: [['batch 4', `batch ${n}`]] }, 200, (sim) => sim.stats().average);
check('batch: too small and too big both lose to the middle', batchAt[1] > batchAt[5] * 3 && batchAt[16] > batchAt[5], batchAt);
const batchWait = await flowOf({ scene: 'batch', swap: [['batch 4', 'batch 100 or 1s'], ['items\nrate 3/s', 'items\nrate 1/s']] }, 60, (sim) => ({ done: sim.finished, avg: sim.stats().average }));
check('"or 1s" sends a part-full batch instead of waiting for 100', batchWait.done > 30 && batchWait.avg < 6, batchWait);

const pri = await flowOf({ scene: 'priority', swap: [] }, 200, (sim, g) => ({ gold: sim.metrics(g.nodes.get('gold-done')).time, rest: sim.metrics(g.nodes.get('rest-done')).time }));
check('priority: named work goes first and the rest wait', pri.rest > pri.gold * 3, pri);
const fair = await flowOf({ scene: 'priority', swap: [['queue\npriority gold', 'queue']] }, 200, (sim, g) => ({ gold: sim.metrics(g.nodes.get('gold-done')).time, rest: sim.metrics(g.nodes.get('rest-done')).time }));
check('take out "priority gold" and everyone waits about the same', Math.abs(fair.gold - fair.rest) < fair.rest * 0.35, fair);

const limited2 = await flowOf({ scene: 'limit', swap: [] }, 100, (sim, g) => ({ through: sim.state('gate').through, over: sim.state('sorry').done, waiting: sim.waiting() }));
check('rate limit: lets through about what it says, sends the rest along "over"', Math.abs(limited2.through / 100 - 3) < 0.4 && limited2.over > 200 && limited2.waiting < 10, limited2);
const unlimited = await flowOf({ scene: 'limit', swap: [['rate limit 3/s', 'gate']] }, 60, (sim) => sim.stats().waiting);
check('without the limit the same load backs up', unlimited > 40, unlimited);

const mix = await flowOf({ scene: 'priority', swap: [['queue\npriority gold', 'queue']] }, 200, (sim) => ({ gold: sim.state('gold-done').done, rest: sim.state('rest-done').done }));
check('mix and if: about 30% of work is gold, and "if gold" and "else" sort it', Math.abs(mix.gold / (mix.gold + mix.rest) - 0.3) < 0.08, mix);

const guarded = await p.evaluate(async () => {
  const { readGraph } = await import('/experiments/machine/graph.js');
  const { FlowSim, STEP } = await import('/experiments/machine/sim.js');
  const el = (id, type, x, extra = {}) => ({ id, type, x, y: 0, width: 100, height: 60, strokeColor: '#000', backgroundColor: 'transparent', ...extra });
  const text = (id, owner, words) => ({ id, type: 'text', x: 0, y: 0, width: 10, height: 10, text: words, containerId: owner });
  const arrow = (id, a, b) => ({ id, type: 'arrow', x: 0, y: 0, width: 10, height: 10, points: [[0, 0], [90, 0]], startBinding: { elementId: a }, endBinding: { elementId: b }, endArrowhead: 'arrow', strokeColor: '#000' });
  const elements = [el('s', 'ellipse', 0), text('st', 's', 'rate 5/s'), el('w', 'rectangle', 200), text('wt', 'w', 'workers 50\ntakes 0.1s'), el('d', 'diamond', 400), arrow('a1', 's', 'w'), arrow('a2', 'w', 'd'), arrow('back', 'd', 'w'), text('bt', 'back', 'if retries < 2'), el('end', 'ellipse', 600), arrow('a3', 'd', 'end'), text('a3t', 'a3', 'else')];
  const g = readGraph(elements);
  const sim = new FlowSim(g, 3);
  for (let i = 0; i < 60 * 40; i++) sim.step(STEP);
  return { done: sim.state('end').done, kinds: g.nodes.get('d').kind, issues: g.issues.map((x) => x.message), passes: sim.state('w').through };
});
check('if retries < 2 sends work round twice, then else lets it out', guarded.done > 120 && guarded.passes > guarded.done * 2.5 && guarded.issues.length === 0, guarded);

const lb = await p.evaluate(async () => {
  const { readGraph, infer } = await import('/experiments/machine/graph.js');
  const { FlowSim, STEP } = await import('/experiments/machine/sim.js');
  const data = await (await fetch('/experiments/machine/scenes/balance.excalidraw')).json();
  const run = (policy) => {
    const g = readGraph(infer(data.elements).map((e) => (e.type === 'text' && e.text === 'round robin' ? { ...e, text: policy } : e)));
    const sim = new FlowSim(g, 5);
    for (let i = 0; i < 60 * 20; i++) sim.step(STEP);
    sim.poke('w-a', 'kill', 0);
    sim.poke('w-a', 'kill', 1);
    for (let i = 0; i < 60 * 60; i++) sim.step(STEP);
    return { policy, stuck: sim.state('w-a').queue.length, verdict: sim.stats().verdict, chosen: g.nodes.get('lb').params.policy };
  };
  return ['round robin', 'random', 'least busy', 'two choices'].map(run);
});
const byPolicy = Object.fromEntries(lb.map((r) => [r.policy, r]));
check('load balancer: taking turns keeps feeding a dead worker', byPolicy['round robin'].stuck > 40 && byPolicy['round robin'].verdict === 'backing up', byPolicy['round robin']);
check('picking at random does too', byPolicy.random.stuck > 30, byPolicy.random);
check('least busy routes around it', byPolicy['least busy'].stuck < 12 && byPolicy['least busy'].verdict === 'keeping up', byPolicy['least busy']);
check('two random choices mostly routes around it', byPolicy['two choices'].stuck < byPolicy['round robin'].stuck * 0.6, byPolicy['two choices']);

// ---------------------------------------------------------------------------
section('no label can freeze the page');
const hostile = await p.evaluate(async () => {
  const { readGraph } = await import('/experiments/machine/graph.js');
  const { simFor, STEP } = await import('/experiments/machine/sim.js');
  const { slotLayout } = await import('/experiments/machine/overlay.js');
  const shape = (id, x, type = 'rectangle') => ({ id, type, x, y: 0, width: 200, height: 120, strokeColor: '#000', backgroundColor: 'transparent' });
  const text = (id, owner, words) => ({ id, type: 'text', x: 0, y: 0, width: 10, height: 10, text: words, containerId: owner });
  const arrow = (id, a, b) => ({ id, type: 'arrow', x: 0, y: 0, width: 90, height: 1, points: [[0, 0], [90, 0]], startBinding: a ? { elementId: a } : null, endBinding: { elementId: b }, endArrowhead: 'arrow', strokeColor: '#000' });
  const flow = (source, middle, extra = []) => [shape('s', 0, 'ellipse'), text('st', 's', source), shape('m', 300), text('mt', 'm', middle), shape('e', 600, 'ellipse'), arrow('a', 's', 'm'), arrow('b', 'm', 'e'), ...extra];
  const cases = {
    'batch 0': flow('rate 5/s', 'batch 0'), 'workers 0': flow('rate 5/s', 'workers 0'), 'takes 0': flow('rate 5/s', 'takes 0s'), 'delay 0': flow('rate 5/s', 'delay 0s'),
    'split 0': flow('rate 5/s', 'split 0'), 'cache 0': flow('rate 5/s', 'cache 0'), 'cache 0%': flow('rate 5/s', 'cache 0%'), 'limit 0': flow('rate 5/s', 'queue\nlimit 0'), 'rate 0': flow('rate 0/s', 'queue'),
    'rate limit 0': flow('rate 5/s', 'rate limit 0/s'), 'first 0': flow('rate 5/s', 'merge\nfirst 0'), 'slow': flow('rate 5/s', 'workers 2\nslow 100% x1000'),
    'huge rate': flow('rate 100000000/s', 'queue'), 'huge burst': flow('burst 1000000000 at 0s', 'queue'), 'huge split': flow('rate 50/s', 'split 100000000'), 'huge workers': flow('rate 50/s', 'workers 100000000'), 'huge batch': flow('rate 50/s', 'batch 100000000'),
    'copy storm': [...flow('rate 50/s', 'queue'), arrow('c', 'm', 'm'), text('ct', 'c', 'copy after 0s')],
    'tiny walk': [shape('p', 0), shape('q', 300), arrow('w', null, 'p'), text('wt', 'w', 'start 100000000\nevery 0s'), arrow('x', 'p', 'q'), text('xt', 'x', '50%'), arrow('y', 'q', 'p'), text('yt', 'y', '50%')],
    'tiny clock': [shape('c', 0), text('ct', 'c', 'clock 0s'), shape('l', 300), text('lt', 'l', 'lamp'), arrow('z', 'c', 'l')],
    'state loop': [shape('p', 0), shape('q', 300), arrow('f', 'p', 'q'), text('ft', 'f', '[1]'), arrow('g', 'q', 'p'), text('gt', 'g', '[1] / n += 1')],
    'after 0': [shape('p', 0), shape('q', 300), arrow('f', 'p', 'q'), text('ft', 'f', 'after 0s'), arrow('g', 'q', 'p'), text('gt', 'g', 'after 0s')],
  };
  const out = {};
  for (const [name, elements] of Object.entries(cases)) {
    const started = performance.now();
    const g = readGraph(elements);
    const sim = simFor(g, 3);
    let worst = 0, boxes = 0;
    for (let i = 0; i < 600; i++) {
      const t0 = performance.now();
      sim.step(STEP);
      worst = Math.max(worst, performance.now() - t0);
    }
    for (const n of g.nodes.values()) if (n.kind === 'workers') boxes = Math.max(boxes, slotLayout(n, sim.state(n.id)).length);
    out[name] = { ms: Math.round(performance.now() - started), worstStepMs: +worst.toFixed(1), tokens: sim.moving?.length, boxes };
  }
  return out;
});
const slowCases = Object.entries(hostile).filter(([, r]) => r.ms > 10000 || r.worstStepMs > 500);
check('ten seconds of every hostile label runs in moments, with no step that could freeze a frame', slowCases.length === 0, slowCases.length ? slowCases : Object.fromEntries(Object.entries(hostile).map(([k, r]) => [k, r.worstStepMs])));
check('a huge rate is held to what can be drawn', hostile['huge rate'].tokens <= 5000, hostile['huge rate']);
check('a huge number of workers draws a bounded number of boxes', hostile['huge workers'].boxes <= 120, hostile['huge workers']);
const idleBeforeFlood = await idleFrames();
await openDemo('queue');
await p.waitForTimeout(300);
await editLabel(await textMiddle('workers-t'), ['batch 0']);
await forward(5);
check('typing "batch 0" on the page leaves it running', (await p.evaluate(() => window.app.graph.nodes.get('workers').kind)) === 'batch' && (await p.evaluate(() => window.app.sim.time)) > 4);
await editLabel(await textMiddle('requests-t'), ['rate 100000000/s']);
await forward(3);
await holdClock(false);
const floodFrames = await frames(40);
await holdClock(true);
const flooded = { ...floodFrames, moving: await p.evaluate(() => window.app.sim.moving.length), turnedAway: await p.evaluate(() => window.app.sim.stats().dropped) };
check('and a flood of work is turned away with the page still at speed', atSpeed(floodFrames, idleBeforeFlood, { median: 30, p95: 50, work: 25 }) && flooded.turnedAway > 0, { ...flooded, idle: idleBeforeFlood.medianFrameMs });
await shot('44-flood');

// ---------------------------------------------------------------------------
section('expressions cannot do anything but arithmetic');
const safe = await p.evaluate(async () => {
  const { parseExpr, parseActions, evaluate } = await import('/experiments/machine/expr.js');
  const tryIt = (s, scope = {}) => { try { return evaluate(parseExpr(s), scope); } catch (e) { return `refused: ${e.message}`; } };
  window.__pwned = 0;
  const vars = Object.create(null);
  return {
    math: tryIt('1 + 2 * 3'), parens: tryIt('(1 + 2) * 3'), compare: tryIt('2 >= 2 and not 0'), scope: tryIt('a + 1', { a: 41 }), unset: tryIt('nope'), min: tryIt('min(4, 2)'), div0: tryIt('5 / 0'),
    ctor: tryIt('constructor'), proto: tryIt('__proto__'), call: tryIt('alert(1)'), member: tryIt('window.__pwned'), semi: tryIt('1; __pwned = 1'), bracket: tryIt('x["y"]'), str: tryIt('"a"'), fn: tryIt('constructor(1)'), assign: tryIt('__pwned = 1'),
    actions: (() => { const a = parseActions('x = 2; x *= 5; y = x - 1'); for (const { name, value } of a) vars[name] = evaluate(value, vars); return { ...vars }; })(),
    pwned: window.__pwned,
  };
});
check('expressions do arithmetic, comparisons and logic', safe.math === 7 && safe.parens === 9 && safe.compare === 1 && safe.scope === 42 && safe.unset === 0 && safe.min === 2 && safe.div0 === 0, safe);
check('nothing reaches outside the scope', safe.ctor === 0 && safe.proto === 0 && /no function/.test(safe.call) && /refused/.test(safe.member) && /refused/.test(safe.semi) && /refused/.test(safe.bracket) && /refused/.test(safe.str) && /no function/.test(safe.fn) && safe.pwned === 0, safe);
check('actions assign in order', safe.actions.x === 10 && safe.actions.y === 9, safe.actions);
const source = fs.readdirSync(new URL('../experiments/machine/', import.meta.url)).filter((f) => f.endsWith('.js'));
const evals = source.filter((f) => /\beval\s*\(|new Function/.test(fs.readFileSync(new URL(`../experiments/machine/${f}`, import.meta.url), 'utf8')));
check('no eval or new Function anywhere in the experiment', evals.length === 0, evals);

// ---------------------------------------------------------------------------
section('state machines: buttons, timers, guards, counters and actions');
await openDemo('breaker');
const sm = await p.evaluate(() => ({ mode: window.app.graph.mode, current: window.app.sim.current, events: window.app.sim.events() }));
check('breaker drawing reads as a state machine with its arrow labels as events', sm.mode === 'states' && sm.current === 'closed' && sm.events.join() === 'fail,ok', sm);
const current = () => p.evaluate(() => window.app.sim.current);
const settle = () => forward(0.5);
await p.waitForTimeout(1000); // the drawing draws in before it runs
await shot('08-breaker-closed');
await panelButton('event-fail');
await panelButton('event-fail');
await p.waitForTimeout(250);
check('2 of 3 failures stay closed', (await current()) === 'closed' && (await p.evaluate(() => window.app.sim.counts.get('trip'))) === 2);
await shot('09-two-failures');
await panelButton('event-ok');
check('a success resets the count', (await p.evaluate(() => window.app.sim.counts.get('trip'))) === undefined);
await panelButton('event-fail'); await panelButton('event-fail');
await settle();
check('still closed after 2 more', (await current()) === 'closed');
await p.keyboard.press('1'); // key 1 is the first event
await settle();
check('the third in a row, from the keyboard, opens it', (await current()) === 'open');
await p.waitForTimeout(100);
const fill = await p.evaluate(() => window.app.board.get('open').backgroundColor);
check('the current state is drawn in amber', fill !== '#f1f3f5', fill);
await p.evaluate(() => window.app.fastForward(2.5));
await shot('10-open-timer-running');
await panelButton('event-ok');
check('open ignores ok', (await current()) === 'open' && (await p.evaluate(() => window.app.sim.note)) !== '');
await forward(3);
check('after 5s it moves by itself', (await current()) === 'half-open');
await panelButton('event-fail');
await settle();
check('a failed trial reopens it', (await current()) === 'open');
await forward(6);
await panelButton('event-ok');
await settle();
check('a good trial closes it', (await current()) === 'closed');

// Click an arrow the machine can take, and it fires.
const tripAt = await p.evaluate(() => { const a = window.app.byId('trip'); return window.app.toScreen(a.x + a.points.at(-1)[0] * 0.25, a.y + a.points.at(-1)[1] * 0.25); });
await p.mouse.click(tripAt.x, tripAt.y);
check('clicking an arrow out of the current state fires its event', (await p.evaluate(() => window.app.sim.counts.get('trip'))) === 1);
await panelButton('event-ok');

await editLabel(await textMiddle('trip-t'), ['fail x1']);
await panelButton('event-fail');
await settle();
check('editing "fail x3" to "fail x1" trips it at once', (await current()) === 'open');
await editLabel(await textMiddle('cool-t'), ['after 1s']);
await forward(1.6);
check('editing "after 5s" to "after 1s" shortens the wait', (await current()) === 'half-open');

const apart = () => p.evaluate(() => { const mid = (a) => { const n = a.points.length - 1; return [a.x + a.points[n][0] / 2, a.y + a.points[n][1] / 2]; }; const m = mid(window.app.byId('cool')), r = mid(window.app.byId('reopen')); return Math.hypot(m[0] - r[0], m[1] - r[1]); });
const halfAt = await middleOf('half-open');
const beforeApart = await apart();
await drag(halfAt, { x: halfAt.x - 20, y: halfAt.y + 6 });
const afterApart = await apart();
check('parallel arrows stay apart when a shape moves', afterApart > 30, { before: Math.round(beforeApart), after: Math.round(afterApart) });
await shot('10b-half-open-moved');

const resetEnd = await endOf('reset', 'end');
const openAt = await middleOf('open');
await drag(resetEnd, { x: openAt.x + 40, y: openAt.y + 25 }, 20);
check('rewiring a transition', (await p.evaluate(() => window.app.graph.edges.get('reset').to)) === 'open');
const clear = await p.evaluate(() => { const a = window.app.byId('reset'); const n = a.points.length - 1; const m = [a.x + a.points[n][0] / 2, a.y + a.points[n][1] / 2]; const near = (b) => { const k = b.points.length - 1; const q = [b.x + b.points[k][0] / 2, b.y + b.points[k][1] / 2]; return Math.hypot(m[0] - q[0], m[1] - q[1]); }; return { cool: near(window.app.byId('cool')), reopen: near(window.app.byId('reopen')) }; });
check('a rewired arrow does not land on top of another', clear.cool > 25 && clear.reopen > 25, clear);
await panelButton('event-ok');
await settle();
check('the rewired arrow takes effect', (await current()) === 'open');
await shot('11-breaker-rewired');

await openDemo('backoff');
await p.waitForTimeout(1000);
const backoff = () => p.evaluate(() => ({ current: window.app.sim.current, wait: window.app.sim.vars.wait, tries: window.app.sim.vars.tries, enabled: window.app.sim.enabled('fail') }));
const b0 = await backoff();
check('an action on the start arrow sets the first values', b0.wait === 1 && b0.tries === 0 && b0.current === 'calling', b0);
const seen = [];
for (let i = 0; i < 4; i++) {
  await panelButton('event-fail');
  await forward(0.5);
  const state = await backoff();
  seen.push(state.wait);
  assert.equal(state.current, 'waiting');
  await forward(state.wait + 0.5); // the wait, then the walk along the arrow
  assert.equal((await backoff()).current, 'calling');
}
check('a counter and a doubling timer: each failure waits twice as long', seen.join() === '2,4,8,16', seen);
await shot('27-backoff-long-wait');
await panelButton('event-fail');
await forward(0.5);
check('a guard chooses another arrow once tries reach 4', (await backoff()).current === 'gave-up', await backoff());
await p.evaluate(() => window.app.restart());
await forward(0.1);
await panelButton('event-ok');
await forward(0.5);
check('restart begins again, and ok takes the other arrow', (await backoff()).current === 'finished');
const guardStuck = await p.evaluate(async () => {
  const { readGraph } = await import('/experiments/machine/graph.js');
  const { StateSim, STEP } = await import('/experiments/machine/sim.js');
  const el = (id, x) => ({ id, type: 'rectangle', x, y: 0, width: 100, height: 60, strokeColor: '#000', backgroundColor: 'transparent' });
  const arrow = (id, a, b) => ({ id, type: 'arrow', x: 0, y: 0, width: 10, height: 10, points: [[0, 0], [90, 0]], startBinding: a ? { elementId: a } : null, endBinding: { elementId: b }, endArrowhead: 'arrow', strokeColor: '#000' });
  const text = (id, owner, words) => ({ id, type: 'text', x: 0, y: 0, width: 10, height: 10, text: words, containerId: owner });
  const elements = [el('idle', 0), el('vend', 300), arrow('coin', 'idle', 'idle'), text('ct', 'coin', 'coin / money += 25'), arrow('buy', 'idle', 'vend'), text('bt', 'buy', 'buy [money >= 75] / money -= 75'), arrow('auto', 'vend', 'idle'), text('at', 'auto', '[money >= 0]')];
  const g = readGraph(elements);
  const s = new StateSim(g, 1);
  const run = (t) => { for (let i = 0; i < t * 60; i++) s.step(STEP); };
  s.fire('buy'); const blocked = { current: s.current, note: s.note };
  s.fire('coin'); run(0.5); s.fire('coin'); run(0.5); s.fire('coin'); run(0.5);
  const money = s.vars.money;
  s.fire('buy'); run(0.5);
  const atVend = s.current;
  const left = s.vars.money;
  run(0.5);
  return { blocked, money, atVend: atVend === 'vend' || s.current === 'idle', left, back: s.current, issues: g.issues };
});
check('a guard blocks an event until it is true, and says why', guardStuck.blocked.current === 'idle' && /blocked/.test(guardStuck.blocked.note), guardStuck.blocked);
check('a self-loop counts money, buying spends it, and a guard alone moves by itself', guardStuck.money === 75 && guardStuck.left === 0 && guardStuck.back === 'idle' && guardStuck.issues.length === 0, guardStuck);
const unset = await p.evaluate(() => window.app.readLabel && window.app.graphOf(JSON.stringify({ elements: [{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 60, strokeColor: '#000' }, { id: 'b', type: 'rectangle', x: 300, y: 0, width: 100, height: 60, strokeColor: '#000' }, { id: 'e', type: 'arrow', x: 100, y: 0, width: 100, height: 1, points: [[0, 0], [200, 0]], startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' }, endArrowhead: 'arrow', strokeColor: '#000' }, { id: 'f', type: 'arrow', x: 100, y: 0, width: 100, height: 1, points: [[0, 0], [200, 0]], startBinding: { elementId: 'b' }, endBinding: { elementId: 'a' }, endArrowhead: 'arrow', strokeColor: '#000' }, { id: 't', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'go / tries = 1', containerId: 'e', fontSize: 20, fontFamily: 5 }, { id: 'u', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'back [trys > 0]', containerId: 'f', fontSize: 20, fontFamily: 5 }] })).issues.map((i) => i.message));
check('a misspelled variable gets a suggestion', unset.some((m) => /Did you mean "tries"/.test(m)), unset);

// ---------------------------------------------------------------------------
section('chance: a walk that forgets where it started');
await openDemo('weather');
await p.waitForTimeout(1000);
check('% arrows make a chance walk', (await p.evaluate(() => window.app.graph.mode)) === 'chain');
const walked = await p.evaluate(() => { window.app.fastForward(30.5); const s = window.app.sim; const names = ['sunny', 'cloudy', 'rainy']; return { sum: names.reduce((a, n) => a + s.share(n), 0), shares: names.map((n) => +s.share(n).toFixed(3)), long: names.map((n) => +s.longRun.get(n).toFixed(3)), steps: s.steps }; });
check('shares always add up to 100%', Math.abs(walked.sum - 1) < 1e-9, walked.sum);
check('the walkers settle near the long-run shares', walked.shares.every((v, i) => Math.abs(v - walked.long[i]) < 0.12) && walked.steps === 30, walked);
await shot('28-weather');
const startEnd = await endOf('begin-walk', 'end');
const rainyAt = await middleOf('rainy');
await drag(startEnd, rainyAt, 16);
const moved = await p.evaluate(() => ({ start: window.app.sim.startId, rainy: window.app.sim.share('rainy'), steps: window.app.sim.steps }));
check('dragging the start arrow onto rainy starts every walker there', moved.start === 'rainy' && moved.rainy === 1 && moved.steps === 0, moved);
const reconverged = await p.evaluate(() => { window.app.fastForward(30); const s = window.app.sim; return ['sunny', 'cloudy', 'rainy'].map((n) => +(s.share(n) - s.longRun.get(n)).toFixed(3)); });
check('and they end up in the same place', reconverged.every((d) => Math.abs(d) < 0.12), reconverged);
await shot('29-weather-from-rainy');

// ---------------------------------------------------------------------------
section('logic: a drawing that computes');
const gate = await p.evaluate(async () => {
  const { readGraph } = await import('/experiments/machine/graph.js');
  const { LogicSim, STEP } = await import('/experiments/machine/sim.js');
  const el = (id, x, y) => ({ id, type: 'rectangle', x, y, width: 100, height: 60, strokeColor: '#000', backgroundColor: 'transparent' });
  const text = (id, owner, words) => ({ id, type: 'text', x: 0, y: 0, width: 10, height: 10, text: words, containerId: owner });
  const arrow = (id, a, b) => ({ id, type: 'arrow', x: 0, y: 0, width: 10, height: 10, points: [[0, 0], [80, 0]], startBinding: { elementId: a }, endBinding: { elementId: b }, endArrowhead: 'arrow', strokeColor: '#000' });
  const table = {};
  for (const name of ['and', 'or', 'xor', 'nand', 'nor']) {
    const elements = [el('a', 0, 0), text('at', 'a', 'switch'), el('b', 0, 100), text('bt', 'b', 'switch'), el('g', 200, 50), text('gt', 'g', name), el('l', 400, 50), text('lt', 'l', 'lamp'), arrow('w1', 'a', 'g'), arrow('w2', 'b', 'g'), arrow('w3', 'g', 'l')];
    const g = readGraph(elements);
    const s = new LogicSim(g);
    const out = [];
    for (const [x, y] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
      if (s.value('a') !== x) s.poke('a', 'click');
      if (s.value('b') !== y) s.poke('b', 'click');
      for (let i = 0; i < 90; i++) s.step(STEP);
      out.push(s.value('l'));
    }
    table[name] = out.join('');
  }
  const ring = readGraph([el('n1', 0, 0), text('t1', 'n1', 'not'), el('n2', 200, 0), text('t2', 'n2', 'not'), el('n3', 400, 0), text('t3', 'n3', 'not'), arrow('r1', 'n1', 'n2'), arrow('r2', 'n2', 'n3'), arrow('r3', 'n3', 'n1')]);
  const rs = new LogicSim(ring);
  let flips = 0, last = rs.value('n1');
  for (let i = 0; i < 60 * 10; i++) { rs.step(STEP); if (rs.value('n1') !== last) { flips++; last = rs.value('n1'); } }
  return { table, flips, mode: ring.mode };
});
assert.deepEqual(gate.table, { and: '0001', or: '0111', xor: '0110', nand: '1110', nor: '1000' });
check('every gate has the right truth table', true, gate.table);
check('three not gates in a ring oscillate, because wires take time', gate.flips > 10, gate.flips);

await openDemo('latch');
await p.waitForTimeout(1000);
const lamp = () => p.evaluate(() => window.app.sim.value('lamp-q'));
const clickShape = async (id) => { const at = await middleOf(id); await p.mouse.click(at.x, at.y); await forward(2); };
check('the latch starts off', (await lamp()) === 0);
await clickShape('set');
check('clicking set lights the lamp', (await lamp()) === 1);
await shot('30-latch-set');
await clickShape('set');
check('it stays lit after set is off: it remembers', (await lamp()) === 1);
await shot('31-latch-remembers');
await clickShape('reset');
check('clicking reset turns it off', (await lamp()) === 0);
await clickShape('reset');
check('and it stays off', (await lamp()) === 0);
check('a lit shape is a change of look only, so the saved file does not record it', await p.evaluate(() => { const parsed = JSON.parse(window.app.save()); return parsed.elements.find((e) => e.id === 'lamp-q').backgroundColor !== '#ffd43b'; }));

await openDemo('counter');
await p.waitForTimeout(1000);
const counts = await p.evaluate(() => { window.app.restart(); const out = []; for (let i = 0; i < 18; i++) { window.app.fastForward(1); const v = (b) => window.app.sim.value(`lamp-${b}`); out.push(8 * v(8) + 4 * v(4) + 2 * v(2) + v(1)); } return out; });
const expected = counts.map((_, i) => (i + 0) % 16);
check('flip-flops chained from a clock count up in binary', counts.every((n, i) => n === expected[i] || n === (expected[i] + 1) % 16) && new Set(counts).size >= 15, counts);
await shot('32-counter');

// ---------------------------------------------------------------------------
section('the cache');
await openDemo('cache');
await p.waitForTimeout(1000);
await forward(90);
const warm = await p.evaluate(() => { const g = window.app.graph; const s = window.app.sim; return { hit: s.metrics(g.nodes.get('memo')).hitrate, db: s.metrics(g.nodes.get('db')).inside }; });
check('a cache earns its hit rate from what it remembers', warm.hit > 50 && warm.hit < 90 && warm.db < 25, warm);
const memoAt = await middleOf('memo');
await p.mouse.click(memoAt.x, memoAt.y);
await p.click('#act-poke');
await forward(12);
const cold = await p.evaluate(() => { const g = window.app.graph; const s = window.app.sim; return { db: s.metrics(g.nodes.get('db')).inside, kept: s.state('memo').lru.size }; });
check('emptying it floods the database', cold.db > warm.db + 8, { warm, cold });
await shot('33-cache-emptied');
const fixedRate = await flowOf({ scene: 'cache', swap: [['cache 200', 'cache 50%']] }, 100, (sim, g) => sim.metrics(g.nodes.get('memo')).hitrate);
check('cache 50% hits about half the time', Math.abs(fixedRate - 50) < 20, fixedRate);

// ---------------------------------------------------------------------------
section('probes: chart any shape');
await openDemo('queue');
await p.waitForTimeout(1000);
await forward(20);
const queueAt = await middleOf('queue');
await p.mouse.click(queueAt.x, queueAt.y + 30);
await p.click('#act-chart');
const charted = await p.evaluate(() => { const g = window.app.graph; const chart = [...g.nodes.values()].find((n) => n.kind === 'chart'); return { id: chart?.id, watching: chart?.watching, edge: [...g.edges.values()].find((e) => e.watch)?.id, routed: g.nodes.get('queue').out.filter((e) => e.watch).length }; });
check('"add a chart" makes a native shape joined by an arrow, with nothing flowing along it', charted.watching?.[0] === 'queue' && charted.edge && charted.routed === 0, charted);
await editLabel(await textMiddle('workers-t'), ['workers 2', 'takes 0.75s']);
await forward(60);
const series = await p.evaluate(() => { const s = window.app.sim.series('queue'); return { n: s.length, last: s.at(-1).waiting }; });
check('it samples every shape as the program runs', series.n > 100 && series.last > 5, series);
await shot('34-chart-a-queue');
const chartParts = await p.evaluate(async () => {
  const parts = (await import('/experiments/machine/vocab.js')).PARTS;
  const { readLabel } = await import('/experiments/machine/vocab.js');
  const bad = [];
  for (const [tab, list] of Object.entries(parts)) {
    for (const part of list) {
      if (!part.label) continue;
      const mode = tab === 'work' ? 'flow' : tab === 'logic' ? 'logic' : 'states';
      const r = readLabel(part.label, 'shape', mode);
      if (r.problems.length) bad.push(`${tab}/${part.id}: ${r.problems[0].message}`);
    }
  }
  return bad;
});
check('every part in the palette has a label the parser understands', chartParts.length === 0, chartParts);
const partKinds = await p.evaluate(async () => {
  const { PARTS } = await import('/experiments/machine/vocab.js');
  const out = [];
  for (const part of PARTS.work.filter((x) => x.type !== 'text')) {
    window.app.loadBlank();
    window.app.m.doc = (await import('/experiments/machine/edit.js')).addPart([], part, 500, 300).list;
    if (part.id !== 'source') {
      const e = await import('/experiments/machine/edit.js');
      const made = e.addPart(window.app.m.doc, { id: 'src', type: 'ellipse', tone: 'blue', w: 100, h: 60, label: 'rate 1/s' }, 100, 100);
      const end = e.addPart(made.list, { id: 'end', type: 'ellipse', tone: 'green', w: 100, h: 60, label: 'end' }, 900, 100);
      let list = end.list;
      const id = window.app.m.doc[0].id;
      list = e.addArrow(list, made.id, id).list;
      if (part.kind !== 'sink') list = e.addArrow(list, id, end.id).list;
      window.app.m.doc = list;
    }
    const { readGraph } = await import('/experiments/machine/graph.js');
    const g = readGraph(window.app.m.doc);
    out.push({ part: part.id, want: part.kind, got: [...g.nodes.values()].find((n) => n.el.id.startsWith(part.id))?.kind });
  }
  window.app.loadDemo('queue');
  return out;
});
const wrongKinds = partKinds.filter((x) => x.want !== x.got);
check('every work part reads as the kind the palette says it is', wrongKinds.length === 0, wrongKinds);

// ---------------------------------------------------------------------------
section('what if');
const idleBeforeWhatIf = await idleFrames();
await openDemo('queue');
await p.waitForTimeout(800);
await editLabel(await textMiddle('workers-t'), ['workers 4', 'takes 1s']);
await p.click('#btn-whatif');
await p.waitForSelector('#whatif:not([hidden])');
await p.waitForFunction(() => window.app.m.whatif?.done, null, { timeout: 180000 });
const fut = await p.evaluate(() => { const w = window.app.m.whatif; return { type: w.type, runs: w.runs.length, low: w.low, median: w.median, high: w.high, words: document.getElementById('wi-words').textContent, finals: w.runs.map((r) => r.final), lens: w.runs[0].waiting.length }; });
check('what if runs many seeded futures and says the spread', fut.runs === 40 && fut.lens > 30 && fut.high >= fut.low && /8 runs out of 10/.test(fut.words), { runs: fut.runs, low: fut.low, median: fut.median, high: fut.high, words: fut.words });
check('the futures really differ', new Set(fut.finals).size > 5, new Set(fut.finals).size);
await shot('35-what-if-futures');
await p.evaluate(() => window.app.ui.futures());
await holdClock(false);
const frameDuring = await frames(60);
await holdClock(true);
check('the board keeps its frame rate while futures run, because they run in a worker', atSpeed(frameDuring, idleBeforeWhatIf, { median: 18, p95: 34 }), { ...frameDuring, idle: idleBeforeWhatIf.medianFrameMs });
await p.waitForFunction(() => window.app.m.whatif?.done, null, { timeout: 180000 });
const repeat = await p.evaluate(() => window.app.m.whatif.runs.map((r) => r.final));
check('the same drawing gives the same futures', JSON.stringify(repeat) === JSON.stringify(fut.finals));
await p.click('#wi-close');
check('it closes', await p.evaluate(() => document.getElementById('whatif').hidden));
const wiOff = await p.evaluate(() => { window.app.loadDemo('breaker'); return new Promise((r) => setTimeout(() => r(document.getElementById('btn-whatif').disabled), 300)); });
check('what if is off for a state machine, which has no luck to vary', wiOff);

await openDemo('batch');
await p.waitForTimeout(800);
const groupAt = await middleOf('group');
await p.mouse.click(groupAt.x, groupAt.y);
await p.click('#inspector .compare');
await p.waitForFunction(() => window.app.m.whatif?.done, null, { timeout: 180000 });
const cmp = await p.evaluate(() => { const w = window.app.m.whatif; return { type: w.type, values: w.values, medians: w.medians.map((x) => +x.toFixed(2)), best: w.best, words: document.getElementById('wi-words').textContent }; });
const lowAt = cmp.medians[0], bestAt = cmp.medians[cmp.values.indexOf(cmp.best)], lastAt = cmp.medians.at(-1);
check('compare finds the best batch size, and it is neither end', cmp.best > 1 && cmp.best < cmp.values.at(-1) && lowAt > bestAt * 2 && lastAt >= bestAt, cmp);
await shot('36-what-if-compare');
const col = await p.evaluate(() => { const c = document.getElementById('wi-chart'); const r = c.getBoundingClientRect(); const w = window.app.m.whatif; const i = w.values.indexOf(w.best); return { x: r.left + w.layout[i].x, y: r.top + r.height / 2, best: w.best }; });
await p.mouse.click(col.x, col.y);
await p.waitForTimeout(100);
const applied = await p.evaluate(() => ({ batch: window.app.graph.nodes.get('group').params.batch, open: !document.getElementById('whatif').hidden }));
check('clicking a column uses that value', applied.batch === col.best && !applied.open, applied);

// ---------------------------------------------------------------------------
section('the gallery shows the range');
await p.goto(MACHINE);
await p.reload();
await p.waitForFunction('window.app');
await p.waitForSelector('#gallery .card canvas');
await p.waitForTimeout(600);
await shot('37-gallery');
const gallery = await p.evaluate(async () => {
  const cards = [...document.querySelectorAll('#gallery .card')];
  const inView = cards.filter((c) => { const r = c.getBoundingClientRect(); return r.bottom <= innerHeight + 1; }).length;
  const drawn = cards.slice(1).filter((c) => { const v = c.querySelector('canvas'); const px = v.getContext('2d').getImageData(0, 0, v.width, v.height).data; for (let i = 3; i < px.length; i += 4) if (px[i]) return true; return false; }).length;
  return { cards: cards.length, inView, drawn, ids: cards.map((c) => c.dataset.demo), groups: [...new Set(cards.map((c) => c.querySelector('i').textContent))] };
});
check('a first visit opens on the gallery, with every demo drawn', gallery.cards >= 15 && gallery.drawn === gallery.cards - 1, gallery);
check('it covers work, states, chance and logic', ['work', 'states', 'chance', 'logic'].every((g) => gallery.groups.includes(g)), gallery.groups);
check('all of it fits on a 1600x900 screen at once', gallery.inView === gallery.cards, { inView: gallery.inView, cards: gallery.cards });
const misplaced2 = [];
for (const id of gallery.ids.slice(1)) {
  const file = JSON.parse(fs.readFileSync(new URL(`../experiments/machine/scenes/${id}.excalidraw`, import.meta.url), 'utf8'));
  const by = new Map(file.elements.map((e) => [e.id, e]));
  for (const e of file.elements) {
    if (e.type !== 'text' || !e.containerId) continue;
    const o = by.get(e.containerId);
    const pts = o.points ? o.points.map(([x, y]) => [o.x + x, o.y + y]) : [[o.x, o.y], [o.x + o.width, o.y + o.height]];
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    const cx = e.x + e.width / 2, cy = e.y + e.height / 2;
    if (cx < Math.min(...xs) - 8 || cx > Math.max(...xs) + 8 || cy < Math.min(...ys) - 8 || cy > Math.max(...ys) + 8) misplaced2.push(`${id}/${e.id}`);
  }
}
check('every label in every scene file is stored on its shape, so Excalidraw draws it there', misplaced2.length === 0, misplaced2);

const clean = [];
for (const id of gallery.ids.slice(1)) {
  await p.click('#btn-demos').catch(() => {});
  await p.waitForSelector(`#gallery [data-demo="${id}"]`);
  await p.click(`#gallery [data-demo="${id}"]`);
  await p.waitForFunction((id) => window.app.m.demo === id, id);
  await p.waitForTimeout(100);
  await p.waitForTimeout(950); // the drawing draws in first
  const result = await p.evaluate(() => { window.app.fastForward(25); return { mode: window.app.graph.mode, issues: window.app.graph.issues.map((i) => i.message), demo: window.app.m.demo, noteTry: !!window.app.byId('try') }; });
  clean.push(result);
  if (result.issues.length) console.log('    issues in', id, result.issues);
  await shot(`demo-${id}`);
}
check('every demo loads, runs and has nothing wrong with it', clean.every((r) => r.issues.length === 0 && r.mode !== 'none'), clean.map((r) => r.demo));
check('every demo says what to try, in the drawing', clean.every((r) => r.noteTry));

// ---------------------------------------------------------------------------
section('dropped files');
await openDemo('breaker');
await dropFile('junk.excalidraw', 'this is not json');
const junk = await p.evaluate(() => ({ message: window.app.message?.words, mode: window.app.graph.mode }));
check('a bad file is refused and the board stays', /not an Excalidraw/.test(junk.message) && junk.mode === 'states', junk);

const real = fs.readFileSync(new URL('../experiments/machine/scenes/from-excalidraw.excalidraw', import.meta.url), 'utf8');
await dropFile('from-excalidraw.excalidraw', real);
const dropped = await p.evaluate(() => ({ mode: window.app.graph.mode, kinds: Object.fromEntries([...window.app.graph.nodes.values()].map((n) => [n.id, n.kind])), workers: window.app.graph.nodes.get('crew').params, title: window.app.title }));
check('a file from Excalidraw\'s own converter runs as dropped', dropped.mode === 'flow' && dropped.kinds.src === 'source' && dropped.kinds.wait === 'queue' && dropped.kinds.crew === 'workers' && dropped.kinds.end === 'sink', dropped);
await forward(30);
const droppedRun = await stats();
check('and it runs: rate 4/s into 2 workers backs up', droppedRun.verdict === 'backing up' && droppedRun.waiting > 20, { waiting: droppedRun.waiting, finished: droppedRun.finished });
await p.waitForTimeout(1000);
await shot('12-dropped-excalidraw-file');
const crew = await middleOf('crew');
await drag(crew, { x: crew.x, y: crew.y + 60 });
const a2 = await p.evaluate(() => { const a = window.app.byId('a2'), c = window.app.byId('crew'); return { endY: a.y + a.points.at(-1)[1], top: c.y, bottom: c.y + c.height }; });
check('the dropped file can be dragged too', a2.endY > a2.top && a2.endY < a2.bottom, a2);

const dns = fs.readFileSync(new URL('../experiments/_bench/scenes/lookup.excalidraw', import.meta.url), 'utf8');
await dropFile('lookup.excalidraw', dns);
const dnsRun = await p.evaluate(() => ({ mode: window.app.graph.mode, current: window.app.sim.current, events: window.app.sim.events(), linked: [...window.app.graph.edges.values()].filter((e) => e.from && e.to).length }));
check('an unbound hand-placed scene is bound by position and runs', dnsRun.mode === 'states' && dnsRun.linked === 8 && dnsRun.current === 'browser', dnsRun);
await p.waitForTimeout(1000);
await shot('13-dropped-dns-scene');
await p.evaluate(() => window.app.fire('example.com?'));
await forward(0.6);
check('its arrow labels are its events', (await p.evaluate(() => window.app.sim.current)) === 'resolver');

const empty = JSON.stringify({ type: 'excalidraw', version: 2, elements: [{ id: 'r', type: 'rectangle', x: 10, y: 10, width: 100, height: 60, strokeColor: '#000', backgroundColor: 'transparent', seed: 1 }], files: {} });
await dropFile('blank.excalidraw', empty);
await p.waitForTimeout(100);
check('a drawing with no arrows says there is nothing to run', (await p.evaluate(() => window.app.graph.mode)) === 'none' && /Nothing to run/.test(await p.evaluate(() => window.app.graph.issues[0]?.message)));

// ---------------------------------------------------------------------------
section('frame time');
const idle = await idleFrames();
console.log('    an empty board, for comparison', JSON.stringify(idle));
await p.evaluate(() => window.app.loadDemo('queue'));
await p.waitForTimeout(1100);
await p.evaluate(() => window.app.fastForward(1));
await holdClock(false);
await p.evaluate(() => { const { sim } = window.app; for (let i = 0; i < 400; i++) sim.states.get('queue').queue.push({ id: 1e6 + i, born: sim.time, retries: i % 3 ? 0 : 1, seen: new Set(), reservedAt: null }); });
const heavy = { ...(await frames(90)), waiting: await p.evaluate(() => window.app.sim.waiting()) };
check('a line of 400 tokens holds frame rate', atSpeed(heavy, idle), heavy);
await shot('14-long-line');

// A busy scene at 5x: a retry storm, with hundreds on screen, charts and bubbles.
await p.evaluate(async () => {
  await window.app.loadDemo('storm');
  window.app.fastForward(70);
});
await p.waitForTimeout(1100);
await p.click('[data-speed="5"]');
const busy = { ...(await frames(240)), waiting: await p.evaluate(() => window.app.sim.waiting()) };
check('a retry storm at 5x holds 60fps', atSpeed(busy, idle) && busy.waiting >= 100, busy);
await p.click('[data-speed="1"]');
await shot('38-busy-storm');

// As busy as a drawing gets: hundreds of tokens on arrows, 200 workers, charts on every part.
const crowd = () => {
  const shape = (id, type, x, y, w, h) => ({ id, type, x, y, width: w, height: h, strokeColor: '#1864ab', backgroundColor: '#d0ebff', seed: 7 + x + y, roughness: 1, strokeWidth: 2, strokeStyle: 'solid', fillStyle: 'solid', opacity: 100, angle: 0, boundElements: [], roundness: null });
  const text = (id, owner, words, size = 24) => ({ id, type: 'text', x: 0, y: 0, width: 10, height: 10, text: words, originalText: words, fontSize: size, fontFamily: 5, textAlign: 'center', verticalAlign: 'top', lineHeight: 1.25, containerId: owner, strokeColor: '#1B2547', opacity: 100, angle: 0, seed: 1 });
  const arrow = (id, a, b, pts) => { const [ox, oy] = pts[0]; const local = pts.map(([x, y]) => [x - ox, y - oy]); return { id, type: 'arrow', x: ox, y: oy, width: Math.abs(local.at(-1)[0]), height: Math.abs(local.at(-1)[1]), points: local, startBinding: { elementId: a, focus: 0, gap: 8 }, endBinding: { elementId: b, focus: 0, gap: 8 }, startArrowhead: null, endArrowhead: 'arrow', strokeColor: '#1B2547', backgroundColor: 'transparent', seed: 3, roughness: 1, strokeWidth: 2, strokeStyle: 'solid', fillStyle: 'solid', opacity: 100, angle: 0, roundness: null }; };
  const out = [shape('src', 'ellipse', 20, 330, 190, 110), text('src-t', 'src', 'rate 80/s')];
  out.push(shape('fan', 'diamond', 280, 310, 170, 150), text('fan-t', 'fan', 'least busy'));
  out.push(arrow('a0', 'src', 'fan', [[210, 385], [280, 385]]));
  for (let i = 0; i < 6; i++) {
    const y = 20 + i * 150;
    out.push(shape(`q${i}`, 'rectangle', 560, y, 300, 130), text(`q${i}t`, `q${i}`, 'queue'));
    out.push(shape(`w${i}`, 'rectangle', 980, y, 300, 130), text(`w${i}t`, `w${i}`, 'workers 12, takes 1.05s', 20));
    out.push(arrow(`i${i}`, 'fan', `q${i}`, [[450, 385], [560, y + 65]]));
    out.push(arrow(`m${i}`, `q${i}`, `w${i}`, [[860, y + 65], [980, y + 65]]));
    out.push(arrow(`o${i}`, `w${i}`, 'end', [[1280, y + 65], [1420, 385]]));
    out.push(shape(`c${i}`, 'rectangle', 1500, y, 280, 130), text(`c${i}t`, `c${i}`, 'chart'));
    out.push(arrow(`w-c${i}`, `c${i}`, `w${i}`, [[1500, y + 30], [1280, y + 30]]));
  }
  out.push(shape('end', 'ellipse', 1420, 340, 70, 80));
  return JSON.stringify({ type: 'excalidraw', version: 2, elements: out, files: {} });
};
await dropFile('crowd.excalidraw', crowd());
await p.waitForTimeout(1100);
await forward(30);
const measureFrames = async () => {
  const got = await frames(180);
  return { ...got, ...(await p.evaluate(() => { let held = 0; for (const st of window.app.sim.states.values()) held += st.queue.length + st.busy.length; return { tokens: window.app.sim.moving.length + held, shapes: window.app.doc.length }; })) };
};
const crowded = await measureFrames();
check('80 tokens a second into 72 workers and six charts holds 60fps', atSpeed(crowded, idle) && crowded.tokens > 400, crowded);
await shot('42-crowded');
const dragging = (async () => {
  const q = await middleOf('w2');
  await p.mouse.move(q.x, q.y);
  await p.mouse.down();
  for (let i = 0; i < 170; i++) {
    await p.mouse.move(q.x + 40 * Math.sin(i / 12), q.y + 25 * Math.cos(i / 9));
    await p.waitForTimeout(16);
  }
  await p.mouse.up();
})();
const whileDragging = await measureFrames();
await dragging;
check('and holds it while a shape is dragged through the middle of it', atSpeed(whileDragging, idle, { median: 18, p95: 26 }), whileDragging);

check('no page errors', p.problems.length === 0, p.problems);

// ---------------------------------------------------------------------------
section('touch');
const touchContext = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: false });
const t = await page(touchContext);
await t.goto(`${MACHINE}#blank`);
await t.waitForFunction('window.app');
const cdp = await touchContext.newCDPSession(t);
const touchDrag = async (from, to, steps = 8) => {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }] });
    await t.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await t.waitForTimeout(60);
};
const tTray = (part) => t.evaluate((part) => { const e = window.app.tray.get(`part-work-${part}`); const r = window.app.tray.canvas.getBoundingClientRect(); const v = window.app.tray.view; return { x: r.left + ((e.x + e.width / 2) * v.scale + v.ox) / v.css, y: r.top + ((e.y + e.height / 2) * v.scale + v.oy) / v.css }; }, part);
const tBoard = await t.evaluate(() => { const r = window.app.board.canvas.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
await touchDrag(await tTray('source'), { x: tBoard.l + tBoard.w * 0.2, y: tBoard.t + tBoard.h * 0.5 });
await touchDrag(await tTray('workers'), { x: tBoard.l + tBoard.w * 0.75, y: tBoard.t + tBoard.h * 0.5 });
const tNodes = await t.evaluate(() => [...window.app.graph.nodes.values()].map((n) => ({ id: n.id, kind: n.kind })));
check('touch: dragging parts from the palette works', tNodes.length === 2, tNodes);
const tSrc = tNodes.find((n) => n.kind === 'source' || n.id.startsWith('source')).id;
const tWork = tNodes.find((n) => n.id !== tSrc).id;
const tMid = (id) => t.evaluate((id) => { const e = window.app.byId(id); return window.app.toScreen(e.x + e.width / 2, e.y + e.height / 2); }, id);
const sAt = await tMid(tSrc);
await t.touchscreen.tap(sAt.x, sAt.y);
await t.waitForTimeout(80);
check('touch: a tap selects and fills the inspector', (await t.evaluate(() => window.app.m.selected)) === tSrc && /source/.test(await t.evaluate(() => document.getElementById('insp-what').textContent)));
const circle = await t.evaluate((id) => { const e = window.app.byId(id); const k = Math.SQRT1_2; return window.app.toScreen(e.x + e.width / 2 + (e.width / 2) * k + 13, e.y + e.height / 2 - (e.height / 2) * k - 13); }, tSrc);
await touchDrag(circle, await tMid(tWork));
const tEdges = await t.evaluate(() => [...window.app.graph.edges.values()].map((e) => [e.from, e.to]));
check('touch: dragging the selected shape\'s circle draws an arrow', tEdges.length === 1 && tEdges[0][0] === tSrc && tEdges[0][1] === tWork, tEdges);
const beforeTouchMove = await t.evaluate((id) => window.app.byId(id).y, tWork);
const wMid = await tMid(tWork);
await touchDrag({ x: wMid.x, y: wMid.y - 20 }, { x: wMid.x, y: wMid.y + 50 });
check('touch: dragging moves a shape', (await t.evaluate((id) => window.app.byId(id).y, tWork)) > beforeTouchMove + 30);
await t.evaluate(() => window.app.fastForward(10));
const tSlot = await t.evaluate(async (id) => { const { slotLayout } = await import('/experiments/machine/overlay.js'); const n = window.app.graph.nodes.get(id); const s = slotLayout(n, window.app.sim.state(id))[0]; return window.app.toScreen(s.x + s.size / 2, s.y + s.size / 2); }, tWork);
await t.touchscreen.tap(tSlot.x, tSlot.y);
await t.waitForTimeout(80);
check('touch: tapping a worker kills it', (await t.evaluate((id) => window.app.sim.state(id).dead.size, tWork)) === 1);
await t.tap('#act-edit');
await t.waitForFunction(() => window.app.editing);
check('touch: "edit label" is a way in without a double-click', true);
await t.keyboard.press('Escape');
await shot('39-touch-tablet', t);
await t.goto(`${MACHINE}#latch`);
await t.reload();
await t.waitForFunction('window.app');
await t.waitForTimeout(1100);
const swAt = await tMid('set');
await t.touchscreen.tap(swAt.x, swAt.y);
await t.evaluate(() => window.app.fastForward(2));
check('touch: tapping a switch flips it', (await t.evaluate(() => window.app.sim.value('lamp-q'))) === 1);
const noOverflow = await t.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight);
check('touch: the tablet layout has no page scroll', noOverflow);
check('touch: no page errors', t.problems.length === 0, t.problems);
await touchContext.close();

// A phone is not a target yet, but the page must still fit and work.
const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const phone = await page(phoneContext);
await phone.goto(`${MACHINE}#queue`);
await phone.waitForFunction('window.app');
await phone.waitForFunction(() => window.app.sim.time > 0, null, { timeout: 60000 });
const fits = await phone.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, iw: innerWidth, ih: innerHeight, board: window.app.board.canvas.getBoundingClientRect().height, running: window.app.sim.time > 0 }));
check('phone: the page fits with no page scroll, and it runs', fits.sw <= fits.iw && fits.sh <= fits.ih && fits.board > 250 && fits.running, fits);
await shot('43-phone', phone);
check('phone: no page errors', phone.problems.length === 0, phone.problems);
await phoneContext.close();

console.log(`\n${passed} checks passed`);
await close();
