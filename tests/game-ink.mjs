// Plays the ink game in Chrome with the real mouse and keyboard.
//   node tests/game-ink.mjs [screenshot directory]
// Every level is played with no ink, which must not win, and with each scripted
// solution, which must reach the flag. Physics runs on the game's fixed timestep,
// stepped by the test, so a run is repeatable to the step.

import assert from 'node:assert/strict';
import { open, page } from './browser.mjs';
import { SOLUTIONS, tracePath } from '../experiments/game-ink/solutions.js';
import { LEVELS } from '../experiments/game-ink/levels.js';

const out = process.argv[2];
const { base, context, close } = await open();
const p = await page(context);
const shot = async (name) => { if (out) await p.screenshot({ path: `${out}/${name}.png` }); };

async function pen(path, { lift = true } = {}) {
  const pts = tracePath(path);
  await p.mouse.move(...pts[0]);
  await p.mouse.down();
  for (const q of pts.slice(1)) await p.mouse.move(...q);
  if (lift) await p.mouse.up();
}
const status = () => p.evaluate(() => window.app.status());
const runToEnd = (seconds = 20) => p.evaluate((max) => {
  const { app } = window;
  for (let i = 0; i < max && app.world.state === 'run'; i += 30) app.steps(30);
  return app.status();
}, seconds * 120);
const center = (id) => p.evaluate((id) => { const e = window.app.stage.get(id); return [e.x + e.width / 2, e.y + e.height / 2]; }, id);
const clickEl = async (id) => { const [x, y] = await center(id); await p.mouse.click(x, y); };
const openLevel = async (i) => { await p.evaluate((i) => window.app.load(i), i); await p.waitForTimeout(30); };
const levelIndex = (id) => LEVELS.findIndex((l) => l.id === id);

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const equal = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };

await p.goto(`${base}/experiments/game-ink/?test=1`);
await p.waitForFunction('window.app');

// ------------------------------------------------------------------ every level

const table = [];
for (let i = 0; i < LEVELS.length; i++) {
  const level = LEVELS[i];
  await openLevel(i);
  await p.keyboard.press('Space');
  const none = await runToEnd(15);
  ok(none.state !== 'won', `${level.id}: must not win with no ink, got ${none.state}`);
  await p.keyboard.press('KeyR');

  ok(SOLUTIONS[level.id].length >= 2, `${level.id}: needs two solutions`);
  for (const solution of SOLUTIONS[level.id]) {
    await p.keyboard.press('KeyR');
    for (const stroke of solution.strokes) await pen(stroke);
    const planned = await status();
    equal(planned.strokes.length, solution.strokes.length, `${level.id} ${solution.name}: every stroke became a body`);
    await p.keyboard.press('Space');
    const end = await runToEnd();
    equal(end.state, 'won', `${level.id} ${solution.name}: ended ${end.state} ${end.reason ?? ''} with the ball at ${end.ball}`);

    // The same strokes again reach the flag on the same step.
    await p.keyboard.press('KeyR');
    for (const stroke of solution.strokes) await pen(stroke);
    await p.keyboard.press('Space');
    const again = await runToEnd();
    equal(again.steps, end.steps, `${level.id} ${solution.name}: repeatable`);
    table.push({ level: level.id, solution: solution.name, ink: end.ink, of: level.ink, stars: end.stars, seconds: +(end.steps / 120).toFixed(2) });
  }
  await p.waitForTimeout(800);
  await shot(`won-${level.id}`);
}
console.table(table);

// ------------------------------------------------------------------ the pen

await openLevel(levelIndex('gap'));
await pen([[300, 150], [500, 150]]);
let s = await status();
equal(s.strokes.length, 1);
ok(!s.strokes[0].closed, 'an open stroke is a line');
ok(s.ink >= 190 && s.ink <= 200, `ink is the line's length, got ${s.ink}`);
await p.keyboard.press('KeyZ');
s = await status();
equal(s.ink, 0, 'undo refunds');
equal(s.strokes.length, 0);

// A loop near its start closes, and is heavier than the same line.
await pen([[600, 200], [700, 200], [700, 290], [600, 290], [600, 205]]);
s = await status();
ok(s.strokes[0].closed, 'a loop becomes a solid');
await shot('solid');
const masses = await p.evaluate(() => { const w = window.app.world; return [...w.bodies.values()].map((b) => b.mass); });
ok(masses[0] > 30, `a solid is heavy, got ${masses[0]}`);
await p.keyboard.press('KeyZ');

// A loop round the ball would crush it, so it stays a line.
await pen([[40, 200], [170, 200], [170, 280], [40, 280], [40, 205]]);
s = await status();
equal(s.strokes.length, 1);
ok(!s.strokes[0].closed, 'a loop round the ball stays a line');
await p.keyboard.press('KeyZ');

// The pen stops at solid ground and picks up again only from a free path.
await pen([[300, 380], [300, 700], [300, 760]], { lift: false });
const blocked = await p.evaluate(() => ({ blocked: window.app.world.pen.blocked, last: window.app.world.pen.points.at(-1) }));
ok(blocked.blocked, 'the pen knows it is blocked');
ok(blocked.last[1] < 450, `the line stopped at the ground, last point ${blocked.last}`);
await shot('blocked');
await p.mouse.up();
await p.keyboard.press('KeyZ');

// Ink runs out mid-line.
await pen([[100, 150], [1500, 150], [1500, 200], [100, 200]], { lift: false });
const dry = await p.evaluate(() => ({ dry: window.app.world.pen.dry, left: window.app.world.inkLeft }));
ok(dry.dry, 'the pen runs dry');
equal(Math.round(dry.left), 0, 'no ink left');
await shot('dry');
await p.mouse.up();
s = await status();
ok(s.ink <= LEVELS[levelIndex('gap')].ink, `never spends more than the level gives, spent ${s.ink}`);
await p.keyboard.press('KeyR');

// ------------------------------------------------------------------ nails

await openLevel(levelIndex('nails'));
await pen([[230, 322], [640, 490]]);
s = await status();
equal(s.strokes[0].nails, 2, 'a line through two nails uses both');
ok(await p.evaluate(() => [...window.app.world.bodies.values()][0].isStatic), 'two nails fix it');
await p.keyboard.press('KeyZ');
await pen([[100, 330], [400, 330]]);
s = await status();
equal(s.strokes[0].nails, 1, 'a line through one nail uses it');
const before = await p.evaluate(() => [...window.app.world.bodies.values()][0].position.y);
ok(!(await p.evaluate(() => [...window.app.world.bodies.values()][0].isStatic)), 'one nail lets it swing');
await p.keyboard.press('Space');
await p.evaluate(() => window.app.steps(120));
const swing = await p.evaluate(() => { const b = [...window.app.world.bodies.values()][0]; return { angle: b.angle, y: b.position.y }; });
ok(Math.abs(swing.angle) > 0.2, `it swung, angle ${swing.angle}`);
ok(swing.y !== before, 'it moved');
const pinGap = await p.evaluate(() => { const w = window.app.world; const c = w.engine.world.constraints[0]; const end = { x: c.bodyA.position.x + c.pointA.x, y: c.bodyA.position.y + c.pointA.y }; return Math.hypot(end.x - c.pointB.x, end.y - c.pointB.y); });
ok(pinGap < 1.5, `it stays on the nail, off by ${pinGap}`);

// ------------------------------------------------------------------ failing and trying again

await openLevel(levelIndex('gap'));
await pen([[1000, 300], [1100, 300]]);
await p.keyboard.press('Space');
const fell = await runToEnd();
equal(fell.state, 'failed');
await shot('failed');
await p.keyboard.press('Space');
s = await status();
equal(s.state, 'plan', 'space goes back to the plan');
equal(s.strokes.length, 1, 'the plan survives a miss');
equal(s.ball, [96, 290], 'the ball is back at the start');
ok((await p.evaluate(() => window.app.lastTrail.length)) > 10, 'the last attempt leaves its path to plan against');
await p.waitForTimeout(100);
await shot('trail');
await p.keyboard.press('KeyR');
equal(await p.evaluate(() => window.app.lastTrail.length), 0, 'clearing also clears the path');

// ------------------------------------------------------------------ drawing during a run stops time, and is forgotten by a retry

await openLevel(levelIndex('gap'));
await p.keyboard.press('Space');
await p.evaluate(() => window.app.steps(60));
await pen([[1000, 300], [1100, 300]], { lift: false });
const during = await status();
await p.evaluate(() => { window.app.world.step(); window.app.world.step(); });
const after = await status();
equal(after.steps, during.steps, 'time stops while the pen is down');
await shot('time-stopped');
await p.mouse.up();
await p.evaluate(() => window.app.steps(5));
const resumed = await status();
ok(resumed.steps > during.steps, 'time resumes when the pen lifts');
equal(resumed.strokes.length, 1);
await p.keyboard.press('Space');
s = await status();
equal(s.strokes.length, 0, 'a stroke from the run is forgotten');
equal(s.ink, 0, 'and refunded');

// ------------------------------------------------------------------ the rescue: bridge the gap while the ball is on its way

await openLevel(levelIndex('gap'));
await p.keyboard.press('Space');
await p.evaluate(() => { const { app } = window; while (app.world.ball.position.x < 300) app.steps(1); });
await pen(SOLUTIONS.gap[0].strokes[0]);
const rescue = await runToEnd();
equal(rescue.state, 'won', `a line drawn during the run saves it, ended ${rescue.state} at ${rescue.ball}`);
ok(rescue.ink > 0, 'and its ink counts');
await p.waitForTimeout(900);

// ------------------------------------------------------------------ the panel, the stars and moving on

const stars = await p.evaluate(() => window.app.best.gap);
ok(stars?.stars >= 1, 'the best score is kept');
ok(await p.evaluate(() => JSON.parse(localStorage.getItem('handwave-ink-best')).gap.stars >= 1), 'and saved');
await shot('panel');
await clickEl('btn-again');
s = await status();
equal(s.state, 'plan', 'change plan by mouse goes back to the plan');
equal(s.strokes.length, 0, 'a stroke from the run was not part of the plan');
await pen(SOLUTIONS.gap[0].strokes[0]);
await p.keyboard.press('Space');
equal((await runToEnd()).state, 'won');
await p.keyboard.press('Space');
s = await status();
equal(s.state, 'plan', 'space after a win goes back to the plan');
equal(s.strokes.length, 1, 'and keeps it');
await p.keyboard.press('Space');
equal((await runToEnd()).state, 'won');
await p.waitForTimeout(900);
await clickEl('btn-next');
await p.waitForTimeout(50);
equal(await p.evaluate(() => window.app.index), levelIndex('gap') + 1, 'next level by mouse');
await p.keyboard.press('Digit1');
equal(await p.evaluate(() => window.app.index), 0, 'a level by its number key');
await p.keyboard.press('Digit2');
await clickEl('level-5');
await p.waitForTimeout(50);
equal(await p.evaluate(() => window.app.index), 5, 'a level by its number');
await pen([[1100, 300], [1200, 300]]);
await clickEl('btn-undo');
equal((await status()).strokes.length, 0, 'undo by mouse');
await pen([[1100, 300], [1200, 300]]);
await clickEl('btn-go');
equal((await status()).state, 'run', 'let go by mouse');
await clickEl('btn-go');
equal((await status()).state, 'plan', 'try again by mouse');
await clickEl('btn-restart');
equal((await status()).strokes.length, 0, 'clear by mouse');
ok(p.problems.length === 0, `no page errors: ${p.problems.join('; ')}`);
await p.close();

// ------------------------------------------------------------------ on the real clock

const live = await page(context);
await live.goto(`${base}/experiments/game-ink/?level=1`);
await live.waitForFunction('window.app');
await live.waitForTimeout(700);
const liveSolution = SOLUTIONS.gap[0];
for (const stroke of liveSolution.strokes) {
  const pts = tracePath(stroke);
  await live.mouse.move(...pts[0]);
  await live.mouse.down();
  for (const q of pts.slice(1)) await live.mouse.move(...q);
  await live.mouse.up();
}
const liveBefore = await live.evaluate(() => window.app.status());
await live.keyboard.press('Space');
await live.waitForFunction(() => window.app.world.state !== 'run', null, { timeout: 15000 });
const liveEnd = await live.evaluate(() => window.app.status());
const manualRow = table.find((t) => t.level === 'gap' && t.solution === liveSolution.name);
equal(liveEnd.state, 'won', 'wins on the real clock');
equal(+(liveEnd.steps / 120).toFixed(2), manualRow.seconds, 'on the same step as the stepped test');
ok(liveBefore.ink === manualRow.ink, 'with the same ink');

// Nothing at rest moves: two frames a second apart are the same pixels, in a plan
// and at the end of a run with bodies resting on each other.
const samePixels = async (label) => {
  const a = await live.evaluate(() => document.getElementById('stage').toDataURL());
  await live.waitForTimeout(1000);
  const b = await live.evaluate(() => document.getElementById('stage').toDataURL());
  ok(a === b, `${label}: resting drawings must not move`);
};
await live.evaluate(() => window.app.load(2));
await live.waitForTimeout(900);
for (const stroke of [[[900, 500], [1100, 700]], [[1200, 500], [1250, 500], [1250, 550], [1200, 550], [1200, 500]], [[1205, 400], [1255, 400], [1255, 450], [1205, 450], [1205, 400]]]) {
  const pts = tracePath(stroke);
  await live.mouse.move(...pts[0]);
  await live.mouse.down();
  for (const q of pts.slice(1)) await live.mouse.move(...q);
  await live.mouse.up();
}
await live.mouse.move(800, 300);
await live.waitForTimeout(500);
await samePixels('a plan');
await live.keyboard.press('Space');
await live.waitForTimeout(6000);
if (out) await live.screenshot({ path: `${out}/resting.png` });
await samePixels('a stack at rest');
ok(live.problems.length === 0, `no page errors: ${live.problems.join('; ')}`);

// ------------------------------------------------------------------ what a frame costs

const costs = [];
for (const [lines, solids] of [[20, 10], [60, 40], [150, 100]]) costs.push({ lines, solids, ...(await live.evaluate(([l, s]) => window.app.stress(l, s, 3), [lines, solids])) });
console.table(costs);
if (out) await live.screenshot({ path: `${out}/stress.png` });

console.log(`${checks} checks passed`);
await close();
