// A real browser and a server on a free port, for tests and benchmarks.
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../server.mjs';

export async function open({ headless = true, viewport = { width: 1600, height: 900 } } = {}) {
  const srv = await startServer(0, { host: '127.0.0.1', quiet: true });
  const browser = await chromium.launch({ channel: 'chrome', headless, args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport });
  const base = `http://127.0.0.1:${srv.port}`;
  return { base, browser, context, close: async () => { await browser.close(); await srv.close(); } };
}

/** A page that records its errors in page.problems. */
export async function page(context) {
  const p = await context.newPage();
  p.problems = [];
  p.on('pageerror', (e) => p.problems.push(`pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') p.problems.push(`console: ${m.text()}`); });
  p.on('requestfailed', (r) => p.problems.push(`failed: ${r.url()}`));
  p.on('response', (r) => { if (r.status() >= 400) p.problems.push(`${r.status()}: ${r.url()}`); });
  return p;
}

/** A folder for one test's screenshots. SHOTS overrides where they go. */
export function shots(name) {
  const dir = join(process.env.SHOTS ?? join(tmpdir(), 'handwave'), name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
