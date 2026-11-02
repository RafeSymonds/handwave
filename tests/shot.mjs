// node tests/shot.mjs <path> <out.png> [waitSeconds]
import { open, page } from './browser.mjs';
const [, , url, out, wait = '1'] = process.argv;
const { base, context, close } = await open();
const p = await page(context);
await p.goto(base + url);
await p.waitForTimeout(+wait * 1000);
await p.screenshot({ path: out });
if (p.problems.length) console.log(p.problems.join('\n'));
await close();
