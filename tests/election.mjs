// Drives the election page with a real mouse. It fails if the seats disagree with the
// totals, if pointing at a state does not read that state, or if any state's panel
// runs out of its frame.
// node tests/election.mjs [screenshot dir]
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { open, page, shots } from './browser.mjs';

const out = process.argv[2] ?? shots('election');
const results = JSON.parse(readFileSync(new URL('../experiments/election/results.json', import.meta.url)));
const { base, context, close } = await open();
const p = await page(context);
await p.goto(`${base}/experiments/election/`);
await p.waitForFunction('window.app');
await p.waitForTimeout(1500);

const middle = (id) => p.evaluate((id) => { const e = window.app.stage.get(id); return { x: e.x + e.width / 2, y: e.y + e.height / 2 }; }, id);
const point = async (id) => { const c = await middle(id); await p.mouse.move(c.x, c.y); await p.waitForTimeout(60); };
const away = async () => { await p.mouse.move(790, 10); await p.waitForTimeout(60); };
const clickOn = async (id) => { const c = await middle(id); await p.mouse.click(c.x, c.y); await p.waitForTimeout(800); };

// What the seats on screen add up to, read back from the drawing.
const drawnSeats = () => p.evaluate(() => {
  const all = window.app.stage.elements().filter((e) => /^seat-\d+$/.test(e.id));
  const fills = {};
  for (const e of all) fills[e.backgroundColor] = (fills[e.backgroundColor] ?? 0) + 1;
  return { total: all.length, fills };
});
const panelWords = () => p.evaluate(() => window.app.stage.elements().filter((e) => e.id.startsWith('panel-t-')).map((e) => e.text).join(' | '));

// Each kind of seat in one tab, as the data says it should be drawn.
const PALE = { D: '#e7f5ff', R: '#fff5f5' }, KEPT = { D: '#4dabf7', R: '#ff6b6b' }, FLIP = { D: '#1971c2', R: '#e03131' };
function expectedSeats(tab) {
  const { races, notUp } = results[tab];
  const fills = {};
  const add = (fill, n) => { if (n) fills[fill] = (fills[fill] ?? 0) + n; };
  for (const party of ['D', 'R']) {
    add(PALE[party], notUp?.[party] ?? 0);
    add(KEPT[party], races.filter((r) => r.winner === party && !r.flip).length);
    add(FLIP[party], races.filter((r) => r.winner === party && r.flip).length);
  }
  add('#ffffff', races.filter((r) => !r.called).length);
  return fills;
}

// The seats match the data, and the data matches the published totals. Each tab is
// reached with the mouse.
for (const [tab, seats, won] of [['senate', 100, results.senate.won], ['house', 435, results.house.won], ['governors', 50, results.governors.won]]) {
  if (await p.evaluate(() => window.app.state.tab) !== tab) await clickOn(`tab-${tab}`);
  await away();
  const drawn = await drawnSeats();
  assert.equal(drawn.total, seats, `${tab} draws every seat`);
  assert.deepEqual(drawn.fills, expectedSeats(tab), `${tab} seats have the right fills`);
  const open = results[tab].races.filter((r) => !r.called).length;
  assert.equal(won.D + won.R + open, seats, `${tab} totals account for every seat`);
  await p.screenshot({ path: `${out}/${tab}.png` });
}

// The page's own claims about each race.
await clickOn('tab-senate');
await point('tile-TX');
let words = await panelWords();
assert.match(words, /Texas Senate/, 'pointing at Texas reads its race');
assert.match(words, /Talarico \(D\)/);
assert.match(words, /Flipped to Democrats/);
await point('tile-MS');
words = await panelWords();
assert.match(words, /Too close to call/, 'an open race says so');
assert.match(words, /Colom ahead by/);
await away();
assert.match(await panelWords(), /7 seats flipped/, 'moving away returns to the summary');

// A click keeps a state after the pointer leaves, and a second click lets it go.
await clickOn('tile-OH');
await away();
assert.match(await panelWords(), /Ohio Senate \(special\)/, 'a click keeps the state');
await clickOn('tile-OH');
await away();
assert.match(await panelWords(), /7 seats flipped/, 'a second click lets it go');

// A seat reads its own race, and a small target is forgiving.
await clickOn('tab-house');
const flipSeat = await p.evaluate(() => {
  const { seats, size } = window.app.SEATS.house;
  const i = seats.findIndex((s) => s.race?.st === 'PA' && s.race?.district === 10);
  return { x: seats[i].x, y: seats[i].y, size };
});
await p.mouse.move(flipSeat.x, flipSeat.y);
await p.waitForTimeout(60);
words = await panelWords();
assert.match(words, /Pennsylvania District 10/, 'a seat reads its district');
await point('tile-CA');
assert.match(await panelWords(), /California House/, 'in the House a state lists its seats');

// Every panel the page can show stays inside its frame and has no overlapping words.
const problems = await p.evaluate(async () => {
  const { state, update, stage, PANEL, TABS, SEATS, GRID } = window.app;
  const found = [];
  const check = (label) => {
    update({ instant: true });
    const words = stage.elements().filter((e) => e.id.startsWith('panel-t-'));
    for (const t of words) {
      if (t.x < PANEL.x || t.x + t.width > PANEL.x + PANEL.w || t.y < PANEL.y || t.y + t.height > PANEL.y + PANEL.h) found.push(`${label}: "${t.text}" leaves the panel`);
    }
    words.forEach((a, i) => words.slice(i + 1).forEach((b) => {
      const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y + 3 < b.y + b.height && b.y + 3 < a.y + a.height;
      if (overlap) found.push(`${label}: "${a.text}" overlaps "${b.text}"`);
    }));
  };
  for (const { id } of TABS) {
    state.tab = id;
    state.pinned = null;
    state.hover = null;
    check(`${id} summary`);
    for (const st of Object.keys(GRID)) { state.hover = { st }; check(`${id} ${st}`); }
    for (let seat = 0; seat < SEATS[id].seats.length; seat++) { state.hover = { seat }; check(`${id} seat ${seat}`); }
  }
  state.tab = 'senate';
  state.hover = null;
  update({ instant: true });
  return found;
});
assert.deepEqual(problems, [], 'every panel fits');

// Nothing on the page runs off the stage or into another block.
const offStage = await p.evaluate(() => {
  const { state, update, stage, TABS } = window.app;
  const found = [];
  for (const { id } of TABS) {
    state.tab = id;
    update({ instant: true });
    for (const e of stage.elements()) if (e.x < 0 || e.y < 0 || e.x + e.width > 1600 || e.y + e.height > 900) found.push(`${id}: ${e.id}`);
    const card = (t) => stage.elements().filter((e) => e.id.startsWith(`tab-${t.id}-`) && e.type === 'text');
    for (const t of TABS) {
      const [title, ...numbers] = card(t);
      for (const n of numbers) if (n.x - 26 < title.x + title.width) found.push(`${t.id}: its numbers run into its title`);
    }
  }
  state.tab = 'senate';
  update({ instant: true });
  return found;
});
assert.deepEqual(offStage, [], 'everything stays on the stage');

// Save writes a document Excalidraw can read, holding what is on screen. A real download.
await away();
const save = await middle('save');
const [download] = await Promise.all([p.waitForEvent('download'), p.mouse.click(save.x, save.y)]);
assert.equal(download.suggestedFilename(), 'election-2026-senate.excalidraw');
const saved = JSON.parse(readFileSync(await download.path(), 'utf8'));
assert.equal(saved.type, 'excalidraw');
assert.equal(saved.elements.filter((e) => /^seat-\d+$/.test(e.id)).length, 100, 'the file holds every seat');
assert.ok(saved.elements.every((e) => ['rectangle', 'ellipse', 'line', 'text'].includes(e.type) && e.seed), 'every element is a native Excalidraw one');

// The file edits like a drawing. A tile's label is part of the tile, so they move together.
const isBound = (doc, st) => {
  const tile = doc.elements.find((e) => e.id === `tile-${st}`), label = doc.elements.find((e) => e.id === `tile-${st}-t`);
  return label.containerId === tile.id && tile.boundElements.some((b) => b.id === label.id && b.type === 'text') && label.originalText === st;
};
const groupOf = (doc, match) => [...new Set(doc.elements.filter((e) => match.test(e.id)).map((e) => e.groupIds.join()))];
for (const st of Object.keys(results.house.states)) assert.ok(isBound(saved, st), `the ${st} label is bound to its tile`);
assert.deepEqual(groupOf(saved, /^seat-\d+$/), ['arc'], 'the seats move as one');
assert.deepEqual(groupOf(saved, /^tab-house/), ['card-house'], 'a card moves as one');
assert.deepEqual(groupOf(saved, /^panel/), ['panel'], 'the panel moves as one');
assert.deepEqual(groupOf(saved, /^tile-TX/), [''], 'a tile with only a label needs no group, so a double-click edits it');
assert.ok(!saved.elements.some((e) => ['save', 'save-t', 'map-hint'].includes(e.id)), 'the live page controls stay out of the file');
assert.ok(!saved.elements.some((e) => e.customData), 'the page settings stay out of the file');
const houseFile = JSON.parse(await p.evaluate(() => { window.app.setTab('house'); return window.app.savedScene(); }));
assert.ok(isBound(houseFile, 'CA'), 'a House tile binds its label too');
assert.deepEqual(groupOf(houseFile, /^tile-CA/), ['tile-CA'], 'a House tile moves with its count and bar');
await p.evaluate(() => window.app.setTab('senate'));

// A screen reader gets the same results as a table.
const rows = await p.evaluate(() => document.querySelectorAll('#stage table tr').length);
assert.equal(rows, 1 + results.senate.races.length + results.house.races.length + results.governors.races.length, 'the fallback table has every race');

assert.deepEqual(p.problems, [], 'the page reports no errors');
console.log(`election ok, screenshots in ${out}`);
await close();
