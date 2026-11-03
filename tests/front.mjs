// The front page draws a card per experiment and each built one opens.
// node tests/front.mjs [screenshot dir]
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { open, page } from './browser.mjs';

const out = process.argv[2] ?? tmpdir();
const { base, context, close } = await open();
const p = await page(context);
await p.goto(`${base}/`);
await p.waitForFunction('window.app');
await p.waitForTimeout(1500);
await p.screenshot({ path: `${out}/front.png` });
const middleOf = (id) => p.evaluate((id) => { const c = window.app.stage.get(id); return { x: c.x + c.width / 2, y: c.y + c.height / 2 }; }, id);
const dashboard = await middleOf('dashboard');
await p.mouse.click(dashboard.x, dashboard.y);
await p.waitForURL('**/experiments/dashboard/**');
await p.goto(`${base}/`);
await p.waitForFunction('window.app');
const card = await middleOf('explorable');
await p.mouse.click(card.x, card.y);
await p.waitForURL('**/experiments/explorable/');
assert.deepEqual(p.problems, [], 'the page reports no errors');
console.log('front page ok');
await close();
