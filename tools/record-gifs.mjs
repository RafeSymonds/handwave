#!/usr/bin/env node
// Record the README's GIFs by driving each experiment with real input in Chrome.
//   node tools/record-gifs.mjs              all of them, into media/
//   node tools/record-gifs.mjs machine lesson
//
// Frames come from Chrome's screencast with their real timestamps, so a GIF plays
// at the speed the page ran. A drawn pointer shows where the input goes, because
// the screencast has no system cursor. Needs ffmpeg.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-generator';
import { open, page } from '../tests/browser.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(root, 'media');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- recording

class Recorder {
  constructor(p, name) {
    this.p = p;
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), `handwave-${name}-`));
    this.frames = [];
  }

  async start() {
    this.cdp = await this.p.context().newCDPSession(this.p);
    this.cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
      if (this.stopped) return;   // A frame can arrive after stop, when its folder may be gone.
      const file = path.join(this.dir, `${String(this.frames.length).padStart(5, '0')}.png`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      this.frames.push({ file, t: metadata.timestamp });
      await this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await this.cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  }

  async stop() {
    this.stopped = true;
    await this.cdp.send('Page.stopScreencast');
    await sleep(100);
  }

  /** A list ffmpeg can read, running from `from` to `to` in screencast time. */
  concat(from, to) {
    const lines = [];
    this.frames.forEach((frame, i) => {
      const start = i === 0 ? from : frame.t;
      const end = i + 1 < this.frames.length ? this.frames[i + 1].t : to;
      lines.push(`file '${frame.file}'`, `duration ${Math.max(0.001, end - start).toFixed(4)}`);
    });
    lines.push(`file '${this.frames.at(-1).file}'`);
    const list = path.join(this.dir, 'list.txt');
    fs.writeFileSync(list, lines.join('\n'));
    return list;
  }
}

const PALETTE = 'split[a][b];[a]palettegen=max_colors=96:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle';

function encode(name, recorders, filter, { hold = 1.2 } = {}) {
  const from = Math.min(...recorders.map((r) => r.frames[0].t));
  const to = Math.max(...recorders.map((r) => r.frames.at(-1).t)) + hold;
  const inputs = recorders.flatMap((r) => ['-f', 'concat', '-safe', '0', '-i', r.concat(from, to)]);
  const out = path.join(OUT, `${name}.gif`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-loop', '0', out], { stdio: ['ignore', 'inherit', 'inherit'] });
  const count = recorders[0].frames.length;
  console.log(`${name}.gif  ${(fs.statSync(out).size / 1e6).toFixed(1)} MB, ${(to - from).toFixed(1)} s, ${count} frames captured`);
  for (const r of recorders) fs.rmSync(r.dir, { recursive: true, force: true });
}

const single = (width = 800, fps = 15, crop = '') => `[0:v]${crop}fps=${fps},scale=${width}:-1:flags=lanczos,${PALETTE}`;

// ---------------------------------------------------------------- input

// A drawn pointer, since the screencast does not show the system's. It follows the
// mouse, and a ring marks each press and touch.
const POINTER = () => {
  const start = () => {
    const pointer = document.createElement('div');
    pointer.style.cssText = 'position:fixed;left:0;top:0;width:28px;height:28px;z-index:99999;pointer-events:none;display:none';
    pointer.innerHTML = '<svg width="28" height="28" viewBox="0 0 28 28"><path d="M3 2 L3 22 L9 17 L13 26 L17 24 L13 15 L21 15 Z" fill="#1B2547" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(pointer);
    const place = (e) => { pointer.style.display = 'block'; pointer.style.transform = `translate(${e.clientX - 3}px, ${e.clientY - 2}px)`; };
    window.addEventListener('mousemove', place, true);
    window.addEventListener('pointermove', place, true);
    window.addEventListener('pointerdown', (e) => {
      const ring = document.createElement('div');
      ring.style.cssText = `position:fixed;left:${e.clientX - 20}px;top:${e.clientY - 20}px;width:40px;height:40px;border:3px solid #a35200;border-radius:50%;z-index:99998;pointer-events:none;transition:opacity .35s;opacity:.9`;
      document.documentElement.appendChild(ring);
      requestAnimationFrame(() => { ring.style.opacity = '0'; });
      setTimeout(() => ring.remove(), 400);
    }, true);
  };
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
};

async function glide(p, from, to, ms = 500, { points = 24 } = {}) {
  for (let i = 1; i <= points; i++) {
    const t = i / points;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await p.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
    await sleep(ms / points);
  }
  return to;
}

const center = (p, id) => p.evaluate((id) => {
  const e = window.app.stage.get(id);
  return { x: e.x + e.width / 2, y: e.y + e.height / 2 };
}, id);

async function dragTo(p, from, to, ms = 700) {
  await p.mouse.move(from.x, from.y);
  await p.mouse.down();
  await glide(p, from, to, ms);
  await p.mouse.up();
}

// The deck's recordings show a stand-in address, so this machine's real one stays out
// of the repository.
function deckContexts(browser) {
  const JOIN = 'http://192.168.1.20:4173/join';
  const code = qrcode(0, 'Q');
  code.addData(JOIN);
  code.make();
  const n = code.getModuleCount();
  const rows = Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => (code.isDark(r, c) ? '1' : '0')).join(''));
  const standIn = async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, reachable: true, lan: '192.168.1.20', joinUrl: JOIN, qr: rows } });
  };
  return {
    screenContext: async (viewport) => {
      const c = await browser.newContext({ viewport });
      await c.route('**/live-deck/info*', standIn);
      await c.addInitScript(POINTER);
      return c;
    },
    phoneContext: async () => {
      const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
      await c.addInitScript(POINTER);
      return c;
    },
  };
}

async function deckTo(presenter, id) {
  const { SLIDES } = await import('../experiments/live-deck/meta.js');
  const index = SLIDES.findIndex((slide) => slide.id === id);
  while ((await presenter.evaluate(() => window.app.state.index)) < index) { await presenter.keyboard.press('ArrowRight'); await sleep(40); }
}

// Where a shape's blue arrow handle sits, and the middle of the first message on the drawing.
const MACHINE_CIRCLE = (id) => {
  const e = window.app.byId(id);
  const w = e.width, h = e.height;
  let c;
  if (e.type === 'rectangle') c = [e.x + w + 13, e.y - 13];
  else {
    const k = e.type === 'ellipse' ? Math.SQRT1_2 : 0.5;
    c = [e.x + w / 2 + (w / 2) * k + 13, e.y + h / 2 - (h / 2) * k - 13];
  }
  return window.app.toScreen(c[0], c[1]);
};
const MACHINE_BUBBLE = () => {
  const b = window.app.m.bubbles[0];
  return window.app.toScreen(b.x + b.w / 2, b.y + b.h / 2);
};

const machineText = (p, id) => p.evaluate((id) => {
  const t = window.app.byId(id);
  return window.app.toScreen(t.x + t.width / 2, t.y + t.height / 2);
}, id);

// ---------------------------------------------------------------- the scripts

const GIFS = {
  async explorable({ base, context }) {
    const p = await page(context);
    await p.goto(`${base}/experiments/explorable/`);
    const rec = new Recorder(p, 'explorable');
    await p.waitForFunction('window.app');
    await rec.start();
    await sleep(1300);
    const knob = await center(p, 'knob');
    await p.mouse.move(knob.x + 200, knob.y + 120);
    await glide(p, { x: knob.x + 200, y: knob.y + 120 }, knob, 350);
    await p.mouse.down();
    await glide(p, knob, { x: 320, y: knob.y }, 1500);
    await glide(p, { x: 320, y: knob.y }, { x: 1040, y: knob.y }, 2000);
    await p.mouse.up();
    await sleep(500);
    for (const size of ['n31', 'n63', 'n127']) {
      const b = await center(p, size);
      await p.mouse.move(b.x, b.y);
      await sleep(250);
      await p.mouse.down();
      await p.mouse.up();
      await sleep(1100);
    }
    const k2 = await center(p, 'knob');
    await p.mouse.move(k2.x, k2.y);
    await p.mouse.down();
    await glide(p, k2, { x: 500, y: k2.y }, 1600);
    await p.mouse.up();
    await sleep(600);
    await rec.stop();
    encode('explorable', [rec], single());
    await p.close();
  },

  async machine({ base, context }) {
    const p = await page(context);
    await p.goto(`${base}/experiments/machine/#queue`);
    await p.waitForFunction(() => window.app?.m?.demo === 'queue');
    await sleep(400);
    await p.evaluate(() => window.app.fastForward(12));
    const rec = new Recorder(p, 'machine');
    await rec.start();
    await sleep(3500);
    const at = await machineText(p, 'workers-t');
    await glide(p, { x: at.x + 180, y: at.y + 200 }, at, 500);
    await sleep(200);
    await p.mouse.dblclick(at.x, at.y);
    await p.waitForFunction(() => window.app.editing);
    await p.keyboard.press('ControlOrMeta+a');
    await p.keyboard.type('workers 1', { delay: 70 });
    await p.keyboard.press('Shift+Enter');
    await p.keyboard.type('takes 0.75s', { delay: 25 });
    await sleep(300);
    await p.keyboard.press('Enter');
    await p.mouse.move(at.x + 120, at.y + 330);
    await sleep(11000);
    await rec.stop();
    encode('machine', [rec], single(1000));
    await p.close();
  },

  // Start from nothing: parts, arrows, a misspelled word and its fix.
  async 'machine-build'({ base, context }) {
    const p = await page(context);
    await p.goto(`${base}/experiments/machine/`);
    await p.waitForSelector('#gallery [data-demo="blank"]');
    await p.click('#gallery [data-demo="blank"]');
    await sleep(300);
    const rec = new Recorder(p, 'machine-build');
    await rec.start();
    await sleep(900);
    const bo = await p.evaluate(() => { const r = window.app.board.canvas.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
    const spot = (fx, fy) => ({ x: bo.l + bo.w * fx, y: bo.t + bo.h * fy });
    const part = (name) => p.evaluate((name) => {
      const e = window.app.tray.get(`part-work-${name}`);
      const r = window.app.tray.canvas.getBoundingClientRect();
      const v = window.app.tray.view;
      return { x: r.left + ((e.x + e.width / 2) * v.scale + v.ox) / v.css, y: r.top + ((e.y + e.height / 2) * v.scale + v.oy) / v.css };
    }, name);
    for (const [name, at] of [['source', spot(0.14, 0.4)], ['workers', spot(0.5, 0.4)], ['end', spot(0.86, 0.4)]]) {
      await dragTo(p, await part(name), at, 550);
      await sleep(250);
    }
    const nodes = await p.evaluate(() => [...window.app.graph.nodes.values()].map((n) => n.id));
    const middle = (id) => p.evaluate((id) => { const e = window.app.byId(id); return window.app.toScreen(e.x + e.width / 2, e.y + e.height / 2); }, id);
    for (const [from, to] of [[nodes[0], nodes[1]], [nodes[1], nodes[2]]]) {
      const start = await middle(from);
      await glide(p, { x: start.x, y: start.y + 90 }, start, 250);
      await sleep(150);
      const circle = await p.evaluate(MACHINE_CIRCLE, from);
      await p.mouse.move(circle.x, circle.y, { steps: 4 });
      await sleep(120);
      await dragTo(p, circle, await middle(to), 500);
      await sleep(250);
    }
    await p.mouse.move(spot(0.5, 0.75).x, spot(0.5, 0.75).y);
    await sleep(4000);
    // A misspelled word gets a message on the drawing, and clicking it fixes it.
    const label = await machineText(p, await p.evaluate((id) => window.app.doc.find((e) => e.type === 'text' && e.containerId === id)?.id ?? `${id}-t`, nodes[1]));
    await glide(p, spot(0.5, 0.75), label, 400);
    await p.mouse.dblclick(label.x, label.y);
    await p.waitForFunction(() => window.app.editing);
    await p.keyboard.press('ControlOrMeta+a');
    await p.keyboard.type('workerz 2', { delay: 80 });
    await sleep(250);
    await p.keyboard.press('Enter');
    await sleep(2200);
    const bubble = await p.evaluate(MACHINE_BUBBLE);
    await glide(p, label, bubble, 450);
    await sleep(250);
    await p.mouse.click(bubble.x, bubble.y);
    await p.mouse.move(spot(0.5, 0.8).x, spot(0.5, 0.8).y);
    await sleep(5000);
    await rec.stop();
    encode('machine-build', [rec], single(1000));
    await p.close();
  },

  // The same drawing rules run a circuit, and the page shows all the demos.
  async 'machine-logic'({ base, context }) {
    const p = await page(context);
    await p.goto(`${base}/experiments/machine/`);
    await p.waitForSelector('#gallery .card canvas');
    await sleep(1800);
    await p.screenshot({ path: path.join(OUT, 'machine-gallery.png') });
    console.log('machine-gallery.png');
    await p.goto(`${base}/experiments/machine/#counter`);
    await p.reload();
    await p.waitForFunction(() => window.app?.m?.demo === 'counter');
    const rec = new Recorder(p, 'machine-logic');
    await sleep(300);
    await rec.start();
    await sleep(9000);
    await rec.stop();
    encode('machine-logic', [rec], single(1000));
    await p.close();
  },

  async lesson({ base, context }) {
    const p = await page(context);
    await p.goto(`${base}/experiments/lesson/`);
    await p.waitForFunction('window.app');
    await p.waitForFunction(() => window.app.ready.size >= 30, undefined, { timeout: 15000 });
    await p.evaluate(() => { window.app.audio.muted = true; });
    const click = async (id) => {
      const c = await center(p, id);
      await p.mouse.move(c.x, c.y);
      await sleep(200);
      await p.mouse.down();
      await p.mouse.up();
    };
    await click('start');
    // Skip the introduction to the first question.
    for (let i = 0; i < 30 && !(await p.evaluate(() => window.app.player.waiting)); i++) {
      await p.keyboard.press('ArrowRight');
      await sleep(350);
    }
    await p.waitForFunction(() => window.app.player.waiting, undefined, { timeout: 30000 });
    const rec = new Recorder(p, 'lesson');
    await sleep(600);
    await rec.start();
    await sleep(1600);
    const first = await center(p, 'ring/tld');
    await glide(p, { x: first.x - 400, y: first.y + 200 }, first, 600);
    await sleep(150);
    await p.mouse.down();
    await p.mouse.up();
    await p.waitForFunction(() => !window.app.player.waiting);
    await p.waitForFunction(() => window.app.player.waiting, undefined, { timeout: 40000 });
    await sleep(1000);
    const right = await center(p, 'ring/root');
    await glide(p, first, right, 600);
    await sleep(150);
    await p.mouse.down();
    await p.mouse.up();
    await sleep(5000);
    await rec.stop();
    encode('lesson', [rec], single());
    await p.close();
  },

  async tutor({ base, browser }) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.addInitScript(POINTER);
    const p = await page(context);
    await p.goto(`${base}/experiments/tutor/?model=replay:live-sonnet-hash&mute=1&pace=0.55`);
    await p.waitForFunction('window.app');
    await sleep(700);
    const rec = new Recorder(p, 'tutor');
    await rec.start();
    await sleep(600);
    await p.click('#question');
    await p.keyboard.type('How does a hash table work?', { delay: 45 });
    await sleep(250);
    await p.keyboard.press('Enter');
    await p.waitForFunction(() => /ask/i.test(document.getElementById('caption')?.textContent ?? '') === false, undefined, { timeout: 5000 }).catch(() => {});
    await sleep(15000);
    await rec.stop();
    encode('tutor', [rec], single());
    await context.close();
  },

  async 'game-ink'({ base, context }) {
    const p = await page(context);
    await p.goto(`${base}/experiments/game-ink/`);
    await p.waitForFunction('window.app');
    const { SOLUTIONS, tracePath } = await import('../experiments/game-ink/solutions.js');
    const { LEVELS } = await import('../experiments/game-ink/levels.js');
    const rec = new Recorder(p, 'game-ink');
    let started = false;
    for (const [id, which] of [['wall', 1], ['hammer', 0]]) {
      await p.evaluate((i) => window.app.load(i), LEVELS.findIndex((l) => l.id === id));
      await sleep(300);
      if (!started) { await rec.start(); started = true; }
      await sleep(1200);
      for (const stroke of SOLUTIONS[id][which].strokes) {
        const pts = tracePath(stroke);
        await glide(p, { x: pts[0][0] + 90, y: pts[0][1] - 90 }, { x: pts[0][0], y: pts[0][1] }, 300);
        await p.mouse.down();
        for (const q of pts.slice(1)) { await p.mouse.move(q[0], q[1]); await sleep(11); }
        await p.mouse.up();
        await sleep(300);
      }
      await sleep(400);
      await p.keyboard.press('Space');
      await p.waitForFunction(() => window.app.status().state === 'won', undefined, { timeout: 30000, polling: 100 });
      await sleep(1800);
    }
    await rec.stop();
    encode('game-ink', [rec], single());
    await p.close();
  },

  async 'game-platformer'({ base, context }) {
    const p = await page(context);
    await p.goto(`${base}/experiments/game-platformer/`);
    await p.waitForFunction('window.app');
    const solution = JSON.parse(fs.readFileSync(path.join(root, 'experiments/game-platformer/solutions/2-springs-and-ponds.json'), 'utf8'));
    await p.keyboard.press('Digit2');
    await sleep(500);
    await p.evaluate(() => window.app.stage.pause());
    const rec = new Recorder(p, 'game-platformer');
    await rec.start();
    await sleep(200);
    // The winning keys go through the real keyboard. Steps run at the game's own 120 a second.
    const KEY = { L: 'ArrowLeft', R: 'ArrowRight', J: ' ', D: 'ArrowDown' };
    const held = new Set();
    for (const [n, keys] of solution.steps) {
      const want = new Set([...keys].map((k) => KEY[k]));
      for (const k of held) if (!want.has(k)) { await p.keyboard.up(k); held.delete(k); }
      for (const k of want) if (!held.has(k)) { await p.keyboard.down(k); held.add(k); }
      await p.evaluate(async (n) => {
        const { game, stage } = window.app;
        let left = n;
        let last = performance.now();
        while (left > 0) {
          await new Promise(requestAnimationFrame);
          const now = performance.now();
          const steps = Math.min(left, Math.max(1, Math.round((now - last) * 0.12)));
          last = now;
          stage.time += steps / 120;
          game.stepFixed(steps);
          left -= steps;
        }
      }, n);
    }
    for (const k of held) await p.keyboard.up(k);
    await p.evaluate(async () => { const { game, stage } = window.app; for (let i = 0; i < 90; i++) { await new Promise(requestAnimationFrame); stage.time += 1 / 60; game.stepFixed(2); } });
    await rec.stop();
    encode('game-platformer', [rec], single(720, 12), { hold: 2 });
    await p.close();
  },

  // The big screen and one phone, side by side.
  async 'live-deck'({ base, browser }) {
    const PATH = '/experiments/live-deck/';
    const { screenContext, phoneContext } = deckContexts(browser);

    const presenter = await page(await screenContext({ width: 1940, height: 900 }));
    await presenter.goto(`${base}${PATH}`);
    await presenter.waitForFunction(() => window.app?.state);
    const audience = await page(await screenContext({ width: 1600, height: 900 }));
    await audience.goto(`${base}${PATH}?role=audience`);
    await audience.waitForFunction(() => window.app?.state);
    const phone = await page(await phoneContext());

    const big = new Recorder(audience, 'deck-big');
    const small = new Recorder(phone, 'deck-phone');
    await big.start();
    await sleep(1500);
    await phone.goto(`${base}/join`);
    await phone.waitForFunction(() => window.app?.state);
    await small.start();
    const crowd = [];
    for (let i = 0; i < 6; i++) {
      await sleep(350);
      const other = await page(await phoneContext());
      await other.goto(`${base}/join`);
      await other.waitForFunction(() => window.app?.state);
      crowd.push(other);
    }
    await sleep(900);

    const { SLIDES } = await import('../experiments/live-deck/meta.js');
    const voteAt = SLIDES.findIndex((slide) => slide.id === 'survive');
    while ((await presenter.evaluate(() => window.app.state.index)) < voteAt) { await presenter.keyboard.press('ArrowRight'); await sleep(60); }
    await sleep(1200);

    const tap = async (p, option) => {
      const at = await p.evaluate((id) => {
        const { stage } = window.app;
        const e = stage.get(id);
        return stage.toScreen ? stage.toScreen(e.x + e.width / 2, e.y + e.height / 2) : { x: (e.x + e.width / 2) * stage.view.scale / stage.view.css + stage.view.ox / stage.view.css, y: (e.y + e.height / 2) * stage.view.scale / stage.view.css + stage.view.oy / stage.view.css };
      }, `opt-survive-${option}`);
      await p.touchscreen.tap(at.x, at.y);
    };
    await tap(phone, 3);
    for (const [i, other] of crowd.entries()) {
      await sleep(550);
      await tap(other, [3, 1, 3, 0, 3, 1][i]);
    }
    await sleep(1400);
    await presenter.keyboard.press('ArrowRight');
    await sleep(2400);
    await big.stop();
    await small.stop();
    encode('live-deck', [big, small], `[0:v]fps=15,scale=800:450:flags=lanczos,pad=820:450:0:0:white[a];[1:v]fps=15,scale=-2:450:flags=lanczos[b];[a][b]hstack=inputs=2,${PALETTE}`);

    // Off script, seen by the presenter with the panel cropped away.
    const layerAt = SLIDES.findIndex((slide) => slide.id === 'layer');
    while ((await presenter.evaluate(() => window.app.state.index)) < layerAt) { await presenter.keyboard.press('ArrowRight'); await sleep(40); }
    await sleep(1400);
    const rec = new Recorder(presenter, 'deck-off');
    await rec.start();
    await sleep(600);
    const from = await center(presenter, 'drag-me');
    await glide(presenter, { x: from.x + 300, y: from.y + 300 }, from, 500);
    await dragTo(presenter, from, { x: from.x + 330, y: from.y + 260 }, 1100);
    await sleep(500);
    const a = { x: 1000, y: 560 }, b = { x: 760, y: 760 };
    await glide(presenter, { x: from.x + 330, y: from.y + 260 }, a, 400);
    await dragTo(presenter, a, b, 700);
    await sleep(200);
    await dragTo(presenter, { x: 800, y: 790 }, { x: 1120, y: 600 }, 700);
    await sleep(900);
    await presenter.keyboard.press('Escape');
    await sleep(1800);
    await rec.stop();
    encode('live-deck-offscript', [rec], single(800, 15, 'crop=1600:900:0:0,'));
  },

  // The room as a crowd on the slide. The presenter's ink is the bridge.
  async 'live-deck-race'({ base, browser }) {
    const { connectPhones, raceBots } = await import('../experiments/live-deck/simulated-phones.mjs');
    const { screenContext } = deckContexts(browser);
    const presenter = await page(await screenContext({ width: 1940, height: 900 }));
    await presenter.goto(`${base}/experiments/live-deck/`);
    await presenter.waitForFunction(() => window.app?.state);
    const bots = await connectPhones(Number(new URL(base).port), 'main', 16);
    await deckTo(presenter, 'race');
    await sleep(1500);
    const rec = new Recorder(presenter, 'deck-race');
    await rec.start();
    await presenter.keyboard.press('ArrowRight');   // Starts the race, from the first box.
    const stop = raceBots(bots);
    await sleep(6500);
    await glide(presenter, { x: 1000, y: 800 }, { x: 805, y: 578 }, 500);
    await dragTo(presenter, { x: 805, y: 578 }, { x: 1300, y: 476 }, 1200);
    await presenter.mouse.move(1000, 800);
    await sleep(11000);
    await rec.stop();
    encode('live-deck-race', [rec], single(800, 15, 'crop=1600:900:0:0,'));
    stop();
    bots.forEach((b) => b.ws.close());
  },

  // Every phone is a worker. The line backs up when the room stops tapping.
  async 'live-deck-workers'({ base, browser }) {
    const { connectPhones, queueBots } = await import('../experiments/live-deck/simulated-phones.mjs');
    const { screenContext } = deckContexts(browser);
    const presenter = await page(await screenContext({ width: 1940, height: 900 }));
    await presenter.goto(`${base}/experiments/live-deck/`);
    await presenter.waitForFunction(() => window.app?.state);
    const audience = await page(await screenContext({ width: 1600, height: 900 }));
    await audience.goto(`${base}/experiments/live-deck/?role=audience`);
    await audience.waitForFunction(() => window.app?.state);
    const bots = await connectPhones(Number(new URL(base).port), 'main', 30);
    await deckTo(presenter, 'queue');
    let stop = queueBots(bots);
    await sleep(4000);
    const rec = new Recorder(audience, 'deck-workers');
    await rec.start();
    await sleep(2500);
    await presenter.keyboard.press('ArrowRight');   // 90% of what the room can finish.
    await sleep(4500);
    await presenter.keyboard.press('ArrowRight');   // Everyone stops.
    stop();
    await sleep(8000);
    await presenter.keyboard.press('ArrowRight');   // Back to 50%.
    stop = queueBots(bots);
    await sleep(7000);
    await rec.stop();
    encode('live-deck-workers', [rec], single());
    stop();
    bots.forEach((b) => b.ws.close());
  },
};

// ---------------------------------------------------------------- run

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(GIFS);
const { base, browser, context, close } = await open();
await context.addInitScript(POINTER);
for (const name of names) {
  if (!GIFS[name]) throw new Error(`no GIF called ${name}`);
  await GIFS[name]({ base, browser, context });
}
await close();
