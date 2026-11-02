// Drives O7 with a real mouse and fails if the search does not follow it.
// node tests/explorable.mjs [screenshot dir]
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { open, page } from './browser.mjs';

const out = process.argv[2] ?? tmpdir();
const { base, context, close } = await open();
const p = await page(context);
await p.goto(`${base}/experiments/explorable/`);
await p.waitForFunction('window.app');
await p.waitForTimeout(800);
await p.screenshot({ path: `${out}/explorable-1.png` });

const read = () => p.evaluate(() => {
  const { state, targetOf, search, valuesFor } = window.app;
  const target = targetOf(state);
  return { n: state.n, target, rows: search(valuesFor(state.n), target).length };
});
const center = (id) => p.evaluate((id) => {
  const k = window.app.stage.get(id);
  return { x: k.x + k.width / 2, y: k.y + k.height / 2 };
}, id);
const click = async (id) => { const c = await center(id); await p.mouse.click(c.x, c.y); await p.waitForTimeout(500); };

const before = await read();
assert.deepEqual(before, { n: 15, target: 65, rows: 4 });

// Drag the knob left. The viewport maps 1:1 to stage coordinates.
const knob = await center('knob');
await p.mouse.move(knob.x, knob.y);
await p.mouse.down();
let slowest = 0;
for (let i = 1; i <= 40; i++) {
  await p.mouse.move(knob.x - i * 12, knob.y);
  slowest = Math.max(slowest, await p.evaluate(() => window.app.stage.frameMs));
}
await p.mouse.up();
await p.waitForTimeout(500);
const dragged = await read();
assert.equal(dragged.target, 20, 'dragging moves the target');
assert.equal(await p.evaluate(() => window.app.stage.get('hint')), undefined, 'the hint leaves after the first drag');
await p.screenshot({ path: `${out}/explorable-2.png` });

await click('n127');
const big = await read();
assert.equal(big.n, 127, 'a size button changes the count');
assert.equal(big.rows, 7, '127 numbers take 7 checks here');
await p.screenshot({ path: `${out}/explorable-3.png` });

await click('n31');
await click('r0-b3');
const clicked = await read();
const value = await p.evaluate(() => window.app.valuesFor(31)[3]);
assert.equal(clicked.target, value, 'clicking a number makes it the target');

assert.deepEqual(p.problems, [], 'the page reports no errors');
console.log(`explorable ok, slowest frame during drag ${slowest.toFixed(1)} ms`);
await close();
