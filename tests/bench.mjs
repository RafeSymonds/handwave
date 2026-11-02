import { open, page } from './browser.mjs';
const { base, context, close } = await open();
const p = await page(context);
await p.goto(`${base}/experiments/_bench/`);
await p.waitForFunction('window.ready');
for (const [n, mode] of [[100,'move'],[500,'move'],[2000,'move'],[100,'resize'],[500,'resize'],[100,'hatch'],[500,'hatch']]) {
  console.log(JSON.stringify(await p.evaluate(([n, mode]) => window.bench(n, mode), [n, mode])));
}
if (p.problems.length) console.log('PROBLEMS', p.problems);
await close();
