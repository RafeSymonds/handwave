// O8: the drawing is the program. Drives the real page with real mouse and keyboard.
// node tests/machine.mjs [screenshot dir]
import fs from 'fs';
import assert from 'assert/strict';
import { open, page, shots } from './browser.mjs';

const out = process.argv[2] ?? shots('machine');
fs.mkdirSync(out, { recursive: true });
const { base, context, close } = await open();
const p = await page(context);
let passed = 0;
const check = (name, ok, detail = '') => { assert.ok(ok, `${name} ${JSON.stringify(detail)}`); passed++; console.log(`ok  ${name}${detail !== '' ? ' ' + JSON.stringify(detail) : ''}`); };

await p.goto(`${base}/experiments/machine/`);
await p.waitForFunction('window.app');

const screen = (x, y) => p.evaluate(([x, y]) => window.app.toScreen(x, y), [x, y]);
const middleOf = (id) => p.evaluate((id) => { const e = window.app.byId(id); return window.app.toScreen(e.x + e.width / 2, e.y + e.height / 2); }, id);
const endOf = (id, end) => p.evaluate(([id, end]) => { const e = window.app.byId(id); const pt = end === 'start' ? e.points[0] : e.points[e.points.length - 1]; return window.app.toScreen(e.x + pt[0], e.y + pt[1]); }, [id, end]);
const stats = () => p.evaluate(() => { const s = window.app.sim.stats(); return { ...s, bottleneck: s.bottleneck && { ...s.bottleneck } }; });
const forward = (s) => p.evaluate((s) => window.app.fastForward(s), s);
const shot = async (name) => { await p.waitForTimeout(350); await p.screenshot({ path: `${out}/${name}.png` }); };
const drag = async (from, to, steps = 12) => { await p.mouse.move(from.x, from.y); await p.mouse.down(); await p.mouse.move(to.x, to.y, { steps }); await p.mouse.up(); await p.waitForTimeout(60); };
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

// ---- The drawing is read as a program
const kinds = await p.evaluate(() => Object.fromEntries([...window.app.graph.nodes.values()].map((n) => [n.id, n.kind])));
check('queue drawing reads as a flow', (await p.evaluate(() => window.app.graph.mode)) === 'flow');
assert.deepEqual(kinds, { requests: 'source', queue: 'queue', workers: 'workers', check: 'router', done: 'sink', failed: 'idle' });
check('every shape gets a role from its label and arrows', true, kinds);

// ---- It runs by itself, on the real clock, once the drawing has drawn in
await p.waitForTimeout(600);
const early = await p.evaluate(() => ({ time: window.app.sim.time, inFlight: window.app.sim.moving.length }));
await p.waitForTimeout(3000);
const later = await p.evaluate(() => ({ time: window.app.sim.time, inFlight: window.app.sim.moving.length, atQueue: window.app.sim.state('queue').arrivals.length, panel: window.app.panel.get('finished')?.text }));
check('it runs on the real clock', later.time - early.time > 2.5 && later.atQueue > 0, { early, later });

// ---- Deterministic
const twice = await p.evaluate(() => {
  const run = () => { window.app.restart(); window.app.fastForward(40); return JSON.stringify(window.app.sim.snapshot()); };
  return [run(), run()];
});
check('the same drawing and seed give the same run', twice[0] === twice[1] && twice[0].length > 50);

// ---- Baseline: three workers keep up
await p.evaluate(() => window.app.restart());
await forward(90);
const three = await stats();
check('3 workers keep up', three.verdict === 'keeping up' && three.waiting < 20 && three.finished > 150, { waiting: three.waiting, finished: three.finished, capacity: three.bottleneck.capacity, demand: +three.bottleneck.demand.toFixed(2) });
await shot('01-three-workers');

// ---- Remove a worker by editing the label: the point of the demo
const label = await p.evaluate(() => { const t = window.app.byId('workers-t'); return window.app.toScreen(t.x + t.width / 2, t.y + t.height / 2); });
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

// ---- Drag a shape: arrows follow, the sim keeps running
const beforeMove = await p.evaluate(() => ({ s: { ...window.app.byId('workers') }, take: { ...window.app.byId('take') }, out: { ...window.app.byId('out') } }));
const from = await middleOf('workers');
await drag(from, { x: from.x + 40, y: from.y + 60 });
const afterMove = await p.evaluate(() => ({ s: { ...window.app.byId('workers') }, take: { ...window.app.byId('take') }, out: { ...window.app.byId('out') }, label: { ...window.app.byId('workers-t') } }));
check('a dragged shape moves', Math.abs(afterMove.s.x - beforeMove.s.x - 40) < 3 && Math.abs(afterMove.s.y - beforeMove.s.y - 60) < 3, { dx: afterMove.s.x - beforeMove.s.x, dy: afterMove.s.y - beforeMove.s.y });
const takeEnd = [afterMove.take.x + afterMove.take.points[1][0], afterMove.take.y + afterMove.take.points[1][1]];
check('the arrow into it follows and still meets its edge', Math.abs(takeEnd[0] - afterMove.s.x) < 14 && takeEnd[1] > afterMove.s.y && takeEnd[1] < afterMove.s.y + afterMove.s.height, { end: takeEnd.map(Math.round), left: Math.round(afterMove.s.x) });
check('the arrow out of it follows', afterMove.out.x > afterMove.s.x + afterMove.s.width - 2 && afterMove.out.x < afterMove.s.x + afterMove.s.width + 14, { start: Math.round(afterMove.out.x) });
check('its label goes with it', Math.abs(afterMove.label.x + afterMove.label.width / 2 - (afterMove.s.x + afterMove.s.width / 2)) < 2);
check('dragging keeps the bindings', afterMove.take.endBinding.elementId === 'workers' && afterMove.out.startBinding.elementId === 'workers');
await shot('03-moved-workers');

// ---- Rewire: letting go over nothing puts the arrow back
const retryEnd = await endOf('retry', 'end');
const before = await p.evaluate(() => { const a = window.app.byId('retry'); return { x: a.x, y: a.y, points: a.points }; });
await drag(retryEnd, { x: retryEnd.x + 60, y: 40 });
const reverted = await p.evaluate(() => { const a = window.app.byId('retry'); return { x: a.x, y: a.y, points: a.points, to: window.app.graph.edges.get('retry').to }; });
check('an arrow dropped on nothing goes back', reverted.to === 'queue' && Math.abs(reverted.points.at(-1)[0] - before.points.at(-1)[0]) < 0.5);

// ---- Rewire: retries now fail instead of coming back
await p.evaluate(() => window.app.restart());
await forward(60);
const retried = await p.evaluate(() => { let n = 0; const s = window.app.sim; for (const st of s.states.values()) { n += st.queue.filter((t) => t.retries > 0).length; n += st.busy.filter((b) => b.token.retries > 0).length; } return { retried: n, failed: s.state('failed').done, demand: s.bottleneck().demand }; });
check('before rewiring, failures come back round as retries', retried.failed === 0 && retried.retried > 0, retried);
const failedAt = await middleOf('failed');
const retryEnd2 = await endOf('retry', 'end');
await p.mouse.move(retryEnd2.x, retryEnd2.y);
await p.mouse.down();
await p.mouse.move(failedAt.x - 30, failedAt.y, { steps: 14 });
await p.waitForTimeout(250);
await p.screenshot({ path: `${out}/04-rewiring-in-progress.png` });
await p.mouse.up();
await p.waitForTimeout(60);
const rewired = await p.evaluate(() => { const g = window.app.graph; const a = window.app.byId('retry'); const q = window.app.byId('queue'), f = window.app.byId('failed'); return { to: g.edges.get('retry').to, kind: g.nodes.get('failed').kind, binding: a.endBinding.elementId, qBound: q.boundElements.some((b) => b.id === 'retry'), fBound: f.boundElements.some((b) => b.id === 'retry') }; });
check('an arrow dropped on a shape rewires it', rewired.to === 'failed' && rewired.kind === 'sink' && rewired.binding === 'failed' && !rewired.qBound && rewired.fBound, rewired);
const onBoard = await p.evaluate(() => { const a = window.app.byId('retry'); const c = window.app.board.camera; const pts = a.points.map(([x, y]) => [a.x + x, a.y + y]); return { maxY: Math.max(...pts.map((q) => q[1])), bottom: c.y + 640 / c.zoom }; });
check('a rewired bent arrow stays on the board', onBoard.maxY < onBoard.bottom, onBoard);
await forward(40);
const afterRewire = await p.evaluate(() => ({ failed: window.app.sim.state('failed').done, done: window.app.sim.state('done').done }));
check('rewiring changes the behavior', afterRewire.failed > 3, afterRewire);
await shot('05-rewired-to-failed');

// ---- Lower the arrival rate: the queue drains
const sourceLabel = await p.evaluate(() => { const t = window.app.byId('requests-t'); return window.app.toScreen(t.x + t.width / 2, t.y + t.height / 2); });
const bigQueue = (await stats()).waiting;
await editLabel(sourceLabel, ['requests', 'rate 1/s']);
await forward(25);
const drain = await stats();
check('less work drains the line', drain.waiting < bigQueue - 10, { before: bigQueue, after: drain.waiting });

// ---- Native round trip: edits survive being saved and read back
const round = await p.evaluate(() => { const json = window.app.save(); const g = window.app.graphOf(json); const parsed = JSON.parse(json); return { type: parsed.type, retryTo: g.edges.get('retry').to, workers: g.nodes.get('workers').params.workers, rate: g.nodes.get('requests').params.rate, arrow: parsed.elements.find((e) => e.id === 'retry').endBinding.elementId, text: parsed.elements.find((e) => e.id === 'workers-t').containerId }; });
check('the edited drawing saves as a native file that reads back the same', round.type === 'excalidraw' && round.retryTo === 'failed' && round.workers === 2 && round.rate === 1 && round.arrow === 'failed' && round.text === 'workers', round);

// ---- Label on an arrow with no label yet
const takeMid = await p.evaluate(() => { const a = window.app.byId('in'); return window.app.toScreen(a.x + a.width / 2, a.y); });
await p.mouse.dblclick(takeMid.x, takeMid.y);
await p.waitForFunction(() => window.app.editing);
await p.keyboard.type('new');
await p.keyboard.press('Escape');
check('Escape cancels an edit', await p.evaluate(() => !window.app.doc.some((e) => e.type === 'text' && e.containerId === 'in')));

// ---- A bad label says so
await editLabel(sourceLabel, ['requests', 'rate lots']);
const issue = await p.evaluate(() => window.app.graph.issues[0]);
check('an unreadable label is called out', /can't read/.test(issue ?? ''), issue);
await shot('06-bad-label');

// ---- A limit turns work away
await p.evaluate(() => window.app.loadDemo('queue'));
await p.waitForTimeout(100);
const qLabel = await p.evaluate(() => { const t = window.app.byId('queue-t'); return window.app.toScreen(t.x + t.width / 2, t.y + t.height / 2); });
await editLabel(qLabel, ['queue limit 5']);
const wl = await p.evaluate(() => { const t = window.app.byId('workers-t'); return window.app.toScreen(t.x + t.width / 2, t.y + t.height / 2); });
await editLabel(wl, ['workers 1', 'takes 1s']);
await forward(30);
const limited = await stats();
check('a limit on a queue turns work away and says so', limited.waiting <= 5 && limited.dropped > 5 && limited.verdict === 'turning away', { waiting: limited.waiting, dropped: limited.dropped, verdict: limited.verdict });
await shot('07-limit');

// ---- State machine
await panelButton('demo-breaker');
await p.waitForTimeout(150);
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

// Edit an arrow's label: one failure is now enough
const trip = await p.evaluate(() => { const t = window.app.byId('trip-t'); return window.app.toScreen(t.x + t.width / 2, t.y + t.height / 2); });
await editLabel(trip, ['fail x1']);
await panelButton('event-fail');
await settle();
check('editing "fail x3" to "fail x1" trips it at once', (await current()) === 'open');
const cool = await p.evaluate(() => { const t = window.app.byId('cool-t'); return window.app.toScreen(t.x + t.width / 2, t.y + t.height / 2); });
await editLabel(cool, ['after 1s']);
await forward(1.6);
check('editing "after 5s" to "after 1s" shortens the wait', (await current()) === 'half-open');

// Two arrows between the same shapes stay on their own sides when a shape moves
const apart = () => p.evaluate(() => { const mid = (a) => { const n = a.points.length - 1; return [a.x + a.points[n][0] / 2, a.y + a.points[n][1] / 2]; }; const m = mid(window.app.byId('cool')), r = mid(window.app.byId('reopen')); return Math.hypot(m[0] - r[0], m[1] - r[1]); });
const halfAt = await middleOf('half-open');
const beforeApart = await apart();
await drag(halfAt, { x: halfAt.x - 30, y: halfAt.y + 10 });
const afterApart = await apart();
check('parallel arrows stay apart when a shape moves', afterApart > 30, { before: Math.round(beforeApart), after: Math.round(afterApart) });
await shot('10b-half-open-moved');

// Rewire: a good trial now goes back to open
const resetEnd = await endOf('reset', 'end');
const openAt = await middleOf('open');
await drag(resetEnd, { x: openAt.x + 60, y: openAt.y + 40 }, 20);
check('rewiring a transition', (await p.evaluate(() => window.app.graph.edges.get('reset').to)) === 'open');
const clear = await p.evaluate(() => { const a = window.app.byId('reset'); const n = a.points.length - 1; const m = [a.x + a.points[n][0] / 2, a.y + a.points[n][1] / 2]; const near = (b) => { const k = b.points.length - 1; const q = [b.x + b.points[k][0] / 2, b.y + b.points[k][1] / 2]; return Math.hypot(m[0] - q[0], m[1] - q[1]); }; return { cool: near(window.app.byId('cool')), reopen: near(window.app.byId('reopen')) }; });
check('a rewired arrow does not land on top of another', clear.cool > 25 && clear.reopen > 25, clear);
await panelButton('event-ok');
await settle();
check('the rewired arrow takes effect', (await current()) === 'open');
await shot('11-breaker-rewired');

// ---- Drop files
const dropFile = (name, contents) => p.evaluate(async ([name, contents]) => {
  const dt = new DataTransfer();
  dt.items.add(new File([contents], name, { type: 'application/json' }));
  dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 200));
}, [name, contents]);

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
await drag(crew, { x: crew.x, y: crew.y + 80 });
const a2 = await p.evaluate(() => { const a = window.app.byId('a2'), c = window.app.byId('crew'); return { endY: a.y + a.points.at(-1)[1], top: c.y, bottom: c.y + c.height }; });
check('the dropped file can be dragged too', a2.endY > a2.top && a2.endY < a2.bottom, a2);

const dns = fs.readFileSync(new URL('../../excalive/examples/dns/scenes/lookup.excalidraw', import.meta.url), 'utf8');
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
check('a drawing with no arrows says there is nothing to run', (await p.evaluate(() => window.app.graph.mode)) === 'none' && /Nothing to run/.test(await p.evaluate(() => window.app.graph.issues[0])));
await p.evaluate(() => window.app.loadDemo('queue'));

// ---- Frame time with a long line
await p.evaluate(() => { window.app.restart(); });
await p.waitForTimeout(100);
await p.evaluate(() => { const g = window.app; g.fastForward(1); });
const heavy = await p.evaluate(async () => {
  const { sim, board } = window.app;
  // Very busy: many tokens waiting and moving.
  for (let i = 0; i < 400; i++) sim.states.get('queue').queue.push({ id: 1e6 + i, born: sim.time, retries: i % 3 ? 0 : 1, seen: new Set(), reservedAt: null });
  const times = [];
  let last = performance.now();
  for (let i = 0; i < 90; i++) {
    await new Promise(requestAnimationFrame);
    const now = performance.now();
    times.push(now - last);
    last = now;
  }
  times.sort((a, b) => a - b);
  return { waiting: sim.waiting(), medianFrameMs: +times[45].toFixed(1), p95FrameMs: +times[85].toFixed(1), renderMs: +board.frameMs.toFixed(2) };
});
check('a line of 400 tokens holds frame rate', heavy.p95FrameMs < 25, heavy);
await shot('14-long-line');

check('no page errors', p.problems.length === 0, p.problems);
console.log(`\n${passed} checks passed`);
await close();
