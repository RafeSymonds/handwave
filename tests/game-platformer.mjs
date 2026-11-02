// Real browser, real keys. Replays each level's saved solution through the
// keyboard on the fixed timestep, so "beatable" is proven by the shipped page.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { open, page, shots } from './browser.mjs';

const OUT = process.env.OUT ?? shots('game-platformer');
fs.mkdirSync(OUT, { recursive: true });
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'experiments', 'game-platformer');

const { base, context, close } = await open();
const p = await page(context);
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`); if (!ok) failures++; };

const KEY = { L: 'ArrowLeft', R: 'ArrowRight', J: ' ', D: 'ArrowDown' };
const steps = (n) => p.evaluate((n) => window.app.game.stepFixed(n), n);
const player = () => p.evaluate(() => { const s = window.app.game.sim; const q = s.player; return { x: q.x, y: q.y, vx: q.vx, vy: q.vy, grounded: q.grounded, dead: q.dead, won: s.won, coins: s.collected.size, deaths: s.deaths, gs: q.gs }; });
const load = async (doc, name = 'test') => p.evaluate(([doc, name]) => { window.app.game.load(doc, name); window.app.stage.pause(); window.app.game.input = { left: false, right: false, jump: false, down: false }; }, [doc, name]);

// Holds keys through the keyboard, then advances exactly the given steps.
async function replay(script, shots = null) {
  const held = new Set();
  let total = 0, next = 0;
  for (const [n, keys] of script) {
    const want = new Set([...keys].map((k) => KEY[k]));
    for (const k of held) if (!want.has(k)) { await p.keyboard.up(k); held.delete(k); }
    for (const k of want) if (!held.has(k)) { await p.keyboard.down(k); held.add(k); }
    let left = n;
    while (left > 0) {
      const chunk = Math.min(left, shots ? 60 : 240);
      await steps(chunk);
      left -= chunk; total += chunk;
      if (shots && next < shots.at.length && total >= shots.at[next]) { await p.screenshot({ path: `${OUT}/${shots.name}-${next + 1}.png` }); next++; }
    }
  }
  for (const k of held) await p.keyboard.up(k);
  return total;
}

// ---------------------------------------------------------------- free running

await p.goto(`${base}/experiments/game-platformer/`);
await p.waitForFunction('window.app?.game?.sim');
await p.waitForTimeout(400);
await p.screenshot({ path: `${OUT}/level1-start.png` });
const x0 = (await player()).x;
await p.keyboard.down('ArrowRight');
await p.waitForTimeout(500);
const x1 = (await player()).x;
await p.screenshot({ path: `${OUT}/running.png` });
await p.keyboard.up('ArrowRight');
check('real time: holding right runs', x1 - x0 > 120, `moved ${(x1 - x0).toFixed(0)}px in 0.5s`);
await p.keyboard.down(' ');
await p.waitForTimeout(150);
const up = await player();
await p.keyboard.up(' ');
check('real time: space jumps', up.vy < 0 || !up.grounded, `vy ${up.vy.toFixed(0)}`);
const fps = await p.evaluate(async () => { const t = []; for (let i = 0; i < 90; i++) { const a = performance.now(); await new Promise(requestAnimationFrame); t.push(performance.now() - a); } t.sort((a, b) => a - b); const stage = window.app.stage; return { medianFrame: t[45], p95Frame: t[85], renderMs: stage.frameMs }; });
check('frame cadence holds 60fps', fps.p95Frame < 20, `median ${fps.medianFrame.toFixed(1)}ms p95 ${fps.p95Frame.toFixed(1)}ms, render ${fps.renderMs.toFixed(1)}ms`);
await p.evaluate(() => window.app.stage.pause());

// ---------------------------------------------------------------- controls on a test page

const E = (o) => ({ angle: 0, strokeColor: '#343a40', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, seed: 7, groupIds: [], roundness: null, ...o });
const flat = { elements: [
  E({ id: 'g1', type: 'rectangle', x: 0, y: 700, width: 800, height: 100 }),
  E({ id: 'g2', type: 'rectangle', x: 1100, y: 700, width: 800, height: 100 }),
  E({ id: 'start', type: 'text', x: 100, y: 640, width: 60, height: 30, text: 'start', fontSize: 24, fontFamily: 5, textAlign: 'left', lineHeight: 1.25 }),
] };

await load(flat);
await steps(60);
let s = await player();
check('settles on the ground', s.grounded && Math.abs(s.y - 686) < 1, `y ${s.y.toFixed(1)}`);
const y0 = s.y;

async function jumpHeight(holdSteps) {
  await load(flat); await steps(60);
  await p.keyboard.down(' ');
  let top = Infinity;
  for (let i = 0; i < 90; i++) {
    if (i === holdSteps) await p.keyboard.up(' ');
    await steps(2);
    top = Math.min(top, (await player()).y);
  }
  await p.keyboard.up(' ');
  return y0 - top;
}
const low = await jumpHeight(6), high = await jumpHeight(60);
check('variable jump height', high > low * 1.5 && high > 170, `tap ${low.toFixed(0)}px, hold ${high.toFixed(0)}px`);

// Coyote time: run off the ledge, jump just after leaving it.
await load(flat); await steps(30);
await p.keyboard.down('ArrowRight');
let off = await player();
while (off.grounded) { await steps(1); off = await player(); }
await steps(6);
const afterEdge = await player();
await p.keyboard.down(' ');
await steps(1);
const coy = await player();
await p.keyboard.up(' '); await p.keyboard.up('ArrowRight');
check('coyote time: jump works just after the edge', !afterEdge.grounded && coy.vy < -800, `vy ${afterEdge.vy.toFixed(0)} -> ${coy.vy.toFixed(0)}`);

// No coyote after the window.
await load(flat); await steps(30);
await p.keyboard.down('ArrowRight');
off = await player();
while (off.grounded) { await steps(1); off = await player(); }
await steps(18);
const lateBefore = await player();
await p.keyboard.down(' ');
await steps(1);
const late = await player();
await p.keyboard.up(' '); await p.keyboard.up('ArrowRight');
check('coyote time ends', late.vy >= lateBefore.vy, `vy ${lateBefore.vy.toFixed(0)} -> ${late.vy.toFixed(0)}`);

// Jump buffering: press just before landing, jump on the landing step.
await load(flat); await steps(60);
await p.keyboard.down(' '); await steps(40); await p.keyboard.up(' ');
let fall = await player();
while (fall.y < 686 - 18 || fall.vy <= 0) { await steps(1); fall = await player(); }
check('falling toward the floor', !fall.grounded && fall.vy > 0, `y ${fall.y.toFixed(0)}`);
await p.keyboard.down(' ');
let lifted = false;
for (let i = 0; i < 12 && !lifted; i++) { await steps(1); if ((await player()).vy < -800) lifted = true; }
await p.keyboard.up(' ');
check('jump buffering: a press before landing still jumps', lifted);

// Slopes: a curved line is walkable both up and down, without leaving the ground.
const hill = { elements: [
  E({ id: 'g', type: 'rectangle', x: 0, y: 700, width: 400, height: 100 }),
  E({ id: 'c', type: 'line', x: 400, y: 700, width: 1000, height: 220, roundness: { type: 2 }, strokeWidth: 3, points: [[0, 0], [260, -110], [500, -220], [760, -100], [1000, 0]] }),
  E({ id: 'g2', type: 'rectangle', x: 1400, y: 700, width: 400, height: 100 }),
  E({ id: 'start', type: 'text', x: 100, y: 640, width: 60, height: 30, text: 'start', fontSize: 24, fontFamily: 5, textAlign: 'left', lineHeight: 1.25 }),
] };
await load(hill); await steps(60);
await p.keyboard.down('ArrowRight');
let air = 0, topY = Infinity, n = 0;
for (s = await player(); s.x < 1500 && n < 900; n++) { await steps(2); s = await player(); if (s.x > 420 && s.x < 1380 && !s.grounded) air++; topY = Math.min(topY, s.y); }
await p.keyboard.up('ArrowRight');
check('walks up and down a curved line', air === 0 && topY < 700 - 14 - 190 && s.x >= 1500, `summit y ${topY.toFixed(0)}, airborne samples ${air}`);
await p.screenshot({ path: `${OUT}/slope.png` });

// A steep line is a wall, not a floor.
const steep = { elements: [
  E({ id: 'g', type: 'rectangle', x: 0, y: 700, width: 800, height: 100 }),
  E({ id: 'wall', type: 'line', x: 500, y: 700, width: 90, height: 300, points: [[0, 0], [90, -300]] }),
  E({ id: 'start', type: 'text', x: 100, y: 640, width: 60, height: 30, text: 'start', fontSize: 24, fontFamily: 5, textAlign: 'left', lineHeight: 1.25 }),
] };
await load(steep); await steps(60);
await p.keyboard.down('ArrowRight'); await steps(240); await p.keyboard.up('ArrowRight');
s = await player();
check('a steep line stops you', s.x < 520 && s.y > 620, `x ${s.x.toFixed(0)} y ${s.y.toFixed(0)}`);

// Dashed lines: up through from below, stand on top, drop with down.
const dash = { elements: [
  E({ id: 'g', type: 'rectangle', x: 0, y: 700, width: 800, height: 100 }),
  E({ id: 'd', type: 'line', x: 50, y: 600, width: 400, height: 0, strokeStyle: 'dashed', points: [[0, 0], [400, 0]] }),
  E({ id: 'start', type: 'text', x: 100, y: 640, width: 60, height: 30, text: 'start', fontSize: 24, fontFamily: 5, textAlign: 'left', lineHeight: 1.25 }),
] };
await load(dash); await steps(60);
await p.keyboard.down(' '); await steps(50); await p.keyboard.up(' '); await steps(100);
s = await player();
check('jumps up through a dashed line and stands on it', s.grounded && Math.abs(s.y - (600 - 14)) < 1.5, `y ${s.y.toFixed(1)}`);
await p.keyboard.down('ArrowDown'); await steps(4); await p.keyboard.up('ArrowDown'); await steps(80);
s = await player();
check('down drops back through', s.grounded && Math.abs(s.y - 686) < 1.5, `y ${s.y.toFixed(1)}`);

// Hazards kill and respawn. A falling player respawns too.
const danger = { elements: [
  E({ id: 'g', type: 'rectangle', x: 0, y: 700, width: 400, height: 100 }),
  E({ id: 'h', type: 'rectangle', x: 260, y: 640, width: 60, height: 60, strokeColor: '#c92a2a', backgroundColor: '#ffe3e3' }),
  E({ id: 'start', type: 'text', x: 100, y: 640, width: 60, height: 30, text: 'start', fontSize: 24, fontFamily: 5, textAlign: 'left', lineHeight: 1.25 }),
] };
await load(danger); await steps(60);
const spawnX = (await player()).x;
await p.keyboard.down('ArrowRight');
n = 0;
for (s = await player(); !s.dead && n < 300; n++) { await steps(2); s = await player(); }
await p.keyboard.up('ArrowRight');
check('red kills', s.dead && s.deaths === 1, `deaths ${s.deaths}`);
await steps(30);
await p.screenshot({ path: `${OUT}/death.png` });
await steps(60);
await steps(60);
s = await player();
check('respawns at the start', !s.dead && Math.abs(s.x - spawnX) < 1, `x ${s.x.toFixed(0)}`);

// Moving platform: stand still and it carries you. Standing still means the
// figure's limbs and all drawings hold their exact points (no boil).
const carry = { elements: [
  E({ id: 'g', type: 'rectangle', x: 0, y: 700, width: 300, height: 100 }),
  E({ id: 'plat', type: 'rectangle', x: 320, y: 700, width: 200, height: 30, boundElements: [{ id: 'mv', type: 'arrow' }] }),
  E({ id: 'mv', type: 'arrow', x: 524, y: 715, width: 500, height: 0, points: [[0, 0], [500, 0]], startBinding: { elementId: 'plat', focus: 0, gap: 4 }, endBinding: null, endArrowhead: 'arrow' }),
  E({ id: 'start', type: 'text', x: 360, y: 620, width: 60, height: 30, text: 'start', fontSize: 24, fontFamily: 5, textAlign: 'left', lineHeight: 1.25 }),
] };
await load(carry);
await steps(40);
let c0 = await player();
await steps(240);
let c1 = await player();
check('a moving platform carries you', c1.grounded && c1.x - c0.x > 200, `carried ${(c1.x - c0.x).toFixed(0)}px`);

await load(flat); await steps(180);
const rigA = await p.evaluate(() => JSON.stringify(window.app.game.rig.elements()));
await steps(120);
const rigB = await p.evaluate(() => JSON.stringify(window.app.game.rig.elements()));
check('a figure standing still does not move at all', rigA === rigB);
const pixA = await p.screenshot();
await steps(60);
const pixB = await p.screenshot();
check('a resting frame is pixel-identical later on', pixA.equals(pixB));

// The run cycle follows speed: feet separate and swing when running.
await load(flat); await steps(60);
await p.keyboard.down('ArrowRight');
const feet = [];
for (let i = 0; i < 24; i++) { await steps(4); feet.push(await p.evaluate(() => window.app.game.rig.feet[0][0])); }
await p.keyboard.up('ArrowRight');
const span = Math.max(...feet) - Math.min(...feet);
check('run cycle swings the feet', span > 25, `front foot swings over ${span.toFixed(0)}px`);
await p.screenshot({ path: `${OUT}/run-frame.png` });


// Water: slow sink, a stroke rises, and a leap clears the bank.
const pond = { elements: [
  E({ id: 'bankL', type: 'rectangle', x: 0, y: 500, width: 400, height: 500 }),
  E({ id: 'floor', type: 'rectangle', x: 400, y: 900, width: 500, height: 100 }),
  E({ id: 'w', type: 'rectangle', x: 400, y: 500, width: 500, height: 400, strokeColor: '#1971c2', backgroundColor: '#a5d8ff' }),
  E({ id: 'bankR', type: 'rectangle', x: 900, y: 450, width: 400, height: 550 }),
  E({ id: 'start', type: 'text', x: 200, y: 440, width: 60, height: 30, text: 'start', fontSize: 24, fontFamily: 5, textAlign: 'left', lineHeight: 1.25 }),
] };
await load(pond); await steps(30);
await p.keyboard.down('ArrowRight');
let wet = await player(), guard = 0;
while (wet.x < 620 && guard++ < 400) { await steps(2); wet = await player(); }
await p.keyboard.up('ArrowRight');
await steps(90);
wet = await player();
check('water slows the fall', wet.vy > 0 && wet.vy <= 201 && !wet.grounded, `vy ${wet.vy.toFixed(0)}`);
const before = wet.y;
await p.keyboard.down(' '); await steps(1); await p.keyboard.up(' '); await steps(40);
wet = await player();
check('a stroke rises in water', wet.y < before - 60, `rose ${(before - wet.y).toFixed(0)}px`);
await p.screenshot({ path: `${OUT}/swimming.png` });
// Swim up against the far bank and leap out.
await p.keyboard.down('ArrowRight');
await p.keyboard.down(' ');
guard = 0;
for (wet = await player(); wet.x < 930 && guard++ < 300; ) { await steps(2); wet = await player(); }
await p.keyboard.up(' ');
await p.keyboard.up('ArrowRight');
await steps(90);
wet = await player();
check('swims across and leaps up the far bank', wet.x > 900 && wet.y < 450 && wet.grounded, `x ${wet.x.toFixed(0)} y ${wet.y.toFixed(0)}`);

// A spring throws higher than a jump, and a checkpoint moves the respawn.
const toys = { elements: [
  E({ id: 'g', type: 'rectangle', x: 0, y: 700, width: 1500, height: 100 }),
  E({ id: 'cp', type: 'diamond', x: 500, y: 620, width: 54, height: 72, strokeColor: '#f08c00', backgroundColor: '#ffec99' }),
  E({ id: 'sp', type: 'ellipse', x: 800, y: 670, width: 110, height: 30, strokeColor: '#1971c2', backgroundColor: '#a5d8ff' }),
  E({ id: 'bad', type: 'rectangle', x: 1200, y: 640, width: 60, height: 60, strokeColor: '#e03131' }),
  E({ id: 'start', type: 'text', x: 100, y: 640, width: 60, height: 30, text: 'start', fontSize: 24, fontFamily: 5, textAlign: 'left', lineHeight: 1.25 }),
] };
await load(toys); await steps(30);
await p.keyboard.down('ArrowRight');
let top = Infinity;
guard = 0;
let t = await player();
while (t.x < 880 && guard++ < 400) { await steps(2); t = await player(); top = Math.min(top, t.y); }
await p.keyboard.up('ArrowRight');
for (let i = 0; i < 60; i++) { await steps(2); t = await player(); top = Math.min(top, t.y); }
check('a spring throws higher than a jump', 686 - top > 300, `rose ${(686 - top).toFixed(0)}px`);
await steps(300);
await p.keyboard.down('ArrowRight');
guard = 0;
for (t = await player(); !t.dead && guard++ < 500; ) { await steps(2); t = await player(); }
await p.keyboard.up('ArrowRight');
await steps(90);
t = await player();
check('a checkpoint moves the respawn', !t.dead && Math.abs(t.x - 527) < 3, `respawned at x ${t.x.toFixed(0)}`);

// What a real Excalidraw file can hold: a turned box as a ramp, a freehand stroke,
// a moving box with a bound label, a group that rides together, a filled hazard.
const real = { elements: [
  E({ id: 'g', type: 'rectangle', x: 0, y: 700, width: 500, height: 100 }),
  E({ id: 'ramp', type: 'rectangle', x: 450, y: 620, width: 500, height: 40, angle: -0.35 }),
  E({ id: 'ink', type: 'freedraw', x: 930, y: 530, width: 500, height: 20, points: Array.from({ length: 26 }, (_, i) => [i * 20, Math.sin(i / 3) * 8]), pressures: [], simulatePressure: true, strokeColor: '#1e1e1e' }),
  E({ id: 'plat', type: 'rectangle', x: 1500, y: 530, width: 200, height: 40, boundElements: [{ id: 'lab', type: 'text' }, { id: 'go', type: 'arrow' }] }),
  E({ id: 'lab', type: 'text', x: 1570, y: 538, width: 60, height: 25, text: 'ride', fontSize: 20, fontFamily: 5, textAlign: 'center', lineHeight: 1.25, containerId: 'plat' }),
  E({ id: 'go', type: 'arrow', x: 1704, y: 550, width: 300, height: 0, points: [[0, 0], [300, 0]], startBinding: { elementId: 'plat', focus: 0, gap: 4 }, endArrowhead: 'arrow' }),
  E({ id: 'tree', type: 'ellipse', x: 200, y: 600, width: 80, height: 80, strokeColor: '#2f9e44', backgroundColor: '#b2f2bb' }),
  E({ id: 'cloud', type: 'ellipse', x: 300, y: 300, width: 200, height: 70, opacity: 30 }),
  E({ id: 'fire', type: 'rectangle', x: 2300, y: 450, width: 50, height: 50, backgroundColor: '#ffc9c9' }),
  E({ id: 'start', type: 'text', x: 100, y: 640, width: 60, height: 30, text: 'start', fontSize: 24, fontFamily: 5, textAlign: 'left', lineHeight: 1.25 }),
] };
await load(real); await steps(30);
const roles = await p.evaluate(() => Object.fromEntries(window.app.game.level.bodies.map((b) => [b.id, b.role])));
check('real file: each element reads as what it looks like', roles.ramp === 'solid' && roles.ink === 'solid' && roles.plat === 'solid' && roles.fire === 'hazard' && !roles.tree && !roles.cloud && !roles.go, JSON.stringify(roles));
const labelMoves = await p.evaluate(() => window.app.game.level.movers[0].ids.includes('lab'));
check('real file: a bound label rides with its platform', labelMoves);
await p.keyboard.down('ArrowRight');
guard = 0;
let walked = await player(), maxAir = 0, airRun = 0;
while (walked.x < 1400 && guard++ < 500) { await steps(2); walked = await player(); if (walked.x > 520 && !walked.grounded) { airRun++; maxAir = Math.max(maxAir, airRun); } else airRun = 0; }
await p.keyboard.up('ArrowRight');
check('real file: walks up a turned box and along a freehand stroke', walked.x >= 1400 && walked.y < 540, `x ${walked.x.toFixed(0)} y ${walked.y.toFixed(0)}, longest hop ${maxAir * 2} steps`);
await p.screenshot({ path: `${OUT}/real-file.png` });
await steps(1);
const shown = await p.evaluate(() => window.app.stage.get('start') === undefined);
check('the start word is hidden while playing', shown);

// ---------------------------------------------------------------- beat every level

const names = fs.readdirSync(path.join(root, 'levels')).filter((f) => f.endsWith('.excalidraw')).sort();
for (let i = 0; i < names.length; i++) {
  const name = names[i].replace('.excalidraw', '');
  const { steps: script } = JSON.parse(fs.readFileSync(path.join(root, 'solutions', `${name}.json`), 'utf8'));
  await p.keyboard.press(String(i + 1));
  await p.waitForFunction((i) => window.app.game.levelIndex === i, i);
  await p.evaluate(() => { window.app.stage.pause(); window.app.game.restart(); });
  const extent = await p.evaluate(() => window.app.game.level.extent);
  const total = script.reduce((a, [n]) => a + n, 0);
  const at = [Math.round(total * 0.2), Math.round(total * 0.45), Math.round(total * 0.7), Math.round(total * 0.9)];
  const cam0 = await p.evaluate(() => ({ ...window.app.game.camera }));
  await replay(script, { name: `play-${i + 1}`, at });
  await steps(1);
  const cam1 = await p.evaluate(() => ({ ...window.app.game.camera }));
  const scrolled = Math.hypot(cam1.x - cam0.x, cam1.y - cam0.y);
  check(`level ${i + 1} camera follows`, scrolled > 1000, `camera moved ${(cam1.x - cam0.x).toFixed(0)}, ${(cam1.y - cam0.y).toFixed(0)}`);
  const end = await player();
  check(`level ${i + 1} beaten through the keyboard`, end.won, `${name}: ${(total / 120).toFixed(1)}s, ${end.coins} coins, ${end.deaths} deaths, spans ${(extent.maxX - extent.minX).toFixed(0)}x${(extent.maxY - extent.minY).toFixed(0)}`);
  check(`level ${i + 1} scrolls beyond one screen`, extent.maxX - extent.minX > 1600);
  await p.evaluate(() => { const { stage, game } = window.app; stage.render(); });
  await p.screenshot({ path: `${OUT}/won-${i + 1}.png` });
  // The whole page at once, for looking at by eye.
  await p.evaluate(() => {
    const { stage, game } = window.app;
    const e = game.level.extent;
    const zoom = Math.min(stage.width / (e.maxX - e.minX + 300), stage.height / (e.maxY - e.minY + 400));
    game.camera = { x: e.minX - 150 - (stage.width / zoom - (e.maxX - e.minX + 300)) / 2, y: e.minY - 300, zoom };
    game.drawCamera();
    stage.render();
  });
  await p.screenshot({ path: `${OUT}/overview-${i + 1}.png` });
}

// ---------------------------------------------------------------- Enter goes to the next page

await p.keyboard.press('1');
await p.waitForFunction(() => window.app.game.levelIndex === 0);
await p.evaluate(() => { window.app.stage.pause(); window.app.game.restart(); });
await replay(JSON.parse(fs.readFileSync(path.join(root, 'solutions/1-first-steps.json'), 'utf8')).steps);
await p.keyboard.press('Enter');
await p.waitForFunction(() => window.app.game.levelIndex === 1);
check('Enter opens the next page after winning', true);

// ---------------------------------------------------------------- drop a file

const dropped = { type: 'excalidraw', elements: [
  E({ id: 'g', type: 'rectangle', x: 0, y: 700, width: 2200, height: 100, roundness: { type: 3 } }),
  E({ id: 'coin', type: 'ellipse', x: 600, y: 640, width: 34, height: 34, strokeColor: '#f08c00', backgroundColor: '#ffec99' }),
  E({ id: 'g-goal', type: 'diamond', x: 1900, y: 590, width: 90, height: 110, strokeColor: '#2f9e44', backgroundColor: '#b2f2bb' }),
  E({ id: 'start', type: 'text', x: 100, y: 640, width: 60, height: 30, text: 'start', fontSize: 24, fontFamily: 5, textAlign: 'left', lineHeight: 1.25 }),
] };
const transfer = await p.evaluateHandle((text) => { const dt = new DataTransfer(); dt.items.add(new File([text], 'my-doodle.excalidraw', { type: 'application/json' })); return dt; }, JSON.stringify(dropped));
await p.dispatchEvent('canvas#stage', 'dragover', { dataTransfer: transfer });
await p.dispatchEvent('canvas#stage', 'drop', { dataTransfer: transfer });
await p.waitForFunction(() => window.app.game.name === 'my-doodle');
await p.evaluate(() => { window.app.stage.pause(); window.app.game.restart(); });
await p.keyboard.down('ArrowRight');
await steps(600);
await p.keyboard.up('ArrowRight');
s = await player();
check('a dropped .excalidraw file plays, with coin and goal', s.won && s.coins === 1, `won ${s.won}, coins ${s.coins}`);
await p.screenshot({ path: `${OUT}/dropped.png` });

// A bad file says so and leaves the game running.
const bad = await p.evaluateHandle(() => { const dt = new DataTransfer(); dt.items.add(new File(['{not json'], 'notes.txt')); return dt; });
await p.dispatchEvent('canvas#stage', 'drop', { dataTransfer: bad });
await p.waitForFunction(() => window.app.game.message.includes('notes.txt'));
check('a bad file gives a message and the game keeps its level', await p.evaluate(() => window.app.game.name === 'my-doodle'));

// ---------------------------------------------------------------- edit mode

// On this page you cannot cross a wide gap until you drag the far block closer.
const gappy = { elements: [
  E({ id: 'near', type: 'rectangle', x: 0, y: 700, width: 800, height: 100 }),
  E({ id: 'far', type: 'rectangle', x: 1300, y: 700, width: 500, height: 100 }),
  E({ id: 'goal', type: 'diamond', x: 1500, y: 600, width: 84, height: 100, strokeColor: '#2b8a3e', backgroundColor: '#d3f9d8' }),
  E({ id: 'start', type: 'text', x: 100, y: 640, width: 60, height: 30, text: 'start', fontSize: 24, fontFamily: 5, textAlign: 'left', lineHeight: 1.25 }),
] };
const crossAttempt = async () => {
  await steps(40);
  await p.keyboard.down('ArrowRight');
  let g = await player(), guard = 0;
  while (g.x < 700 && guard++ < 400) { await steps(2); g = await player(); }
  await p.keyboard.down(' '); await steps(60); await p.keyboard.up(' ');
  await steps(120);
  await p.keyboard.up('ArrowRight');
  return player();
};
await load(gappy);
const a1 = await crossAttempt();
check('before editing the gap is too wide', a1.deaths === 1 || a1.dead, `deaths ${a1.deaths}`);
await p.evaluate(() => { const { game, stage } = window.app; game.camera = { x: 0, y: 200, zoom: 1 }; game.drawCamera(); });
await p.keyboard.press('e');
check('E enters edit mode', await p.evaluate(() => window.app.game.mode === 'edit'));
await p.evaluate(() => { const { game, stage } = window.app; game.camera = { x: 500, y: 200, zoom: 1 }; game.drawCamera(); stage.advance(1); stage.render(); });
await p.screenshot({ path: `${OUT}/edit-before.png` });
// Drag the far block 420px left with the mouse, in page pixels (viewport is 1:1).
await p.mouse.move(1300 - 500 + 200, 750 - 200);
await p.mouse.down();
for (let i = 1; i <= 21; i++) await p.mouse.move(1300 - 500 + 200 - i * 20, 750 - 200);
await p.mouse.up();
await p.evaluate(() => { const { stage } = window.app; stage.advance(0.5); stage.render(); });
await p.screenshot({ path: `${OUT}/edit-after.png` });
const moved = await p.evaluate(() => window.app.game.doc.elements.find((e) => e.id === 'far').x);
check('dragging moves the element in the drawing', Math.abs(moved - 880) < 1, `far block x ${moved}`);
await p.keyboard.press('e');
check('E returns to play at once from the start', await p.evaluate(() => { const g = window.app.game; return g.mode === 'play' && g.sim.time === 0; }));
const a2 = await crossAttempt();
check('after dragging, the same inputs cross the gap', a2.deaths === 0 && a2.x > 880, `x ${a2.x.toFixed(0)}, deaths ${a2.deaths}`);

// Del removes what you clicked, R brings it back, and the start word is there to drag.
await p.keyboard.press('e');
await p.evaluate(() => { const { game, stage } = window.app; game.camera = { x: 500, y: 200, zoom: 1 }; game.drawCamera(); stage.advance(0.5); });
check('the start word shows while editing', await p.evaluate(() => !!window.app.stage.get('start')));
await p.mouse.move(1542 - 500, 650 - 200);
await p.mouse.down(); await p.mouse.up();
check('clicking selects an element', await p.evaluate(() => window.app.game.selected === 'goal'));
await p.keyboard.press('Delete');
check('Del removes it', await p.evaluate(() => !window.app.game.doc.elements.some((e) => e.id === 'goal')));
await p.keyboard.press('r');
check('R reverts to the loaded drawing', await p.evaluate(() => { const d = window.app.game.doc.elements; return d.some((e) => e.id === 'goal') && d.find((e) => e.id === 'far').x === 1300; }));
await p.mouse.move(1000 + 300 - 500 + 200, 750 - 200);
await p.mouse.down();
for (let i = 1; i <= 21; i++) await p.mouse.move(1000 + 300 - 500 + 200 - i * 20, 750 - 200);
await p.mouse.up();
await p.keyboard.press('e');

// The edited drawing can be saved as a file that loads again.
await p.keyboard.press('e');
const [download] = await Promise.all([p.waitForEvent('download'), p.keyboard.press('s')]);
const saved = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
check('S saves the edited drawing', saved.type === 'excalidraw' && saved.elements.find((e) => e.id === 'far').x === 880, download.suggestedFilename());
await p.keyboard.press('e');

// ---------------------------------------------------------------- free running again

// The busiest page, running for real, with edit mode swapped in and out.
await p.keyboard.press('4');
await p.waitForFunction(() => window.app.game.levelIndex === 3);
await p.evaluate(() => window.app.stage.play());
await p.keyboard.down('ArrowRight');
const busy = await p.evaluate(async () => {
  const { stage } = window.app;
  const gaps = [], renders = [];
  for (let i = 0; i < 150; i++) { const a = performance.now(); await new Promise(requestAnimationFrame); gaps.push(performance.now() - a); renders.push(stage.frameMs); }
  gaps.sort((a, b) => a - b); renders.sort((a, b) => a - b);
  return { p95: gaps[142], renderP95: renders[142], renderMax: renders[149] };
});
await p.keyboard.up('ArrowRight');
check('the busiest page holds 60fps while running', busy.p95 < 20, `frame p95 ${busy.p95.toFixed(1)}ms, render p95 ${busy.renderP95.toFixed(1)}ms, max ${busy.renderMax.toFixed(1)}ms`);
const beforeEdit = await player();
await p.keyboard.press('e');
await p.waitForTimeout(350);
await p.screenshot({ path: `${OUT}/edit-level4.png` });
await p.keyboard.press('e');
await p.waitForTimeout(100);
await p.keyboard.down('ArrowRight');
await p.waitForTimeout(400);
await p.keyboard.up('ArrowRight');
const afterEdit = await player();
check('free-running play works after an edit round trip', afterEdit.x > 150, `x before ${beforeEdit.x.toFixed(0)}, now ${afterEdit.x.toFixed(0)}`);

check('no page errors', p.problems.length === 0, p.problems.join(' | '));
console.log(failures ? `${failures} FAILED` : 'all passed');
await close();
process.exit(failures ? 1 : 0);
