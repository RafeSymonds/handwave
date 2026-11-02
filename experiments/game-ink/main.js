// O12. Ink. What you draw becomes solid. A line is a beam, a closed loop is a heavy
// block, and a line through a nail pivots on it. Spend as little ink as you can to
// get the ball to the flag.

import { createStage } from '/lib/stage.js';
import { drawElement } from '/lib/render.js';
import { box, color, ellipse, rect, text } from '/lib/draw.js';
import { LEVELS } from './levels.js';
import { BALL_RADIUS, closesLoop, STEPS_PER_SECOND, World } from './world.js';
import { drawAt, drawBall, drawPin, hatch, impactMark, levelArt, machineArt, paintHatch, starLine, starPoints, strokeArt, strokeElement } from './art.js';
import * as sound from './sound.js';

const params = new URLSearchParams(location.search);
const MANUAL = params.has('test');      // A test steps the physics itself.
const STORAGE = 'handwave-ink-best';

const canvas = document.getElementById('stage');
const stage = await createStage(canvas, { width: 1600, height: 900 });

const ghost = { customData: { handwave: { ghost: true } } };
const best = (() => {
  try { return JSON.parse(localStorage.getItem(STORAGE)) ?? {}; } catch { return {}; }
})();

let index = Math.max(0, Math.min(LEVELS.length - 1, Number(params.get('level') ?? 1) - 1));
let world, art, machines;
let intro = 0;             // Seconds since the level appeared.
let accumulator = 0;
let retryAt = null;
let winAt = null;
let panelOpen = false;
let roll = 0;              // The ball's drawn spin, from how far it has travelled.
let marks = [];
let markId = 0;
let lastMarkStep = -100;
let physicsMs = 0;
let lastPen = null;
let trail = [];            // Where the ball has been in this attempt.
let lastTrail = [];        // And in the one before: what to plan against.
const shown = new Map();   // Each body's drawn pose, which ignores resting jitter.

// ------------------------------------------------------------------ levels

function load(i) {
  index = i;
  trail = [];
  lastTrail = [];
  const level = LEVELS[i];
  world = new World(level);
  world.onEvent = onWorldEvent;
  art = levelArt(level);
  machines = machineArt(level);
  intro = MANUAL ? 10 : 0;
  afterReset();
  stage.show(hud(), { instant: MANUAL, stagger: 0.004, morphSeconds: 0.2 });
}

function afterReset() {
  accumulator = 0;
  retryAt = null;
  winAt = null;
  panelOpen = false;
  roll = 0;
  marks = [];
  shown.clear();
  overlayStars = [];
}

function onWorldEvent(e) {
  if (e.type === 'impact') {
    sound.thud(e.speed);
    // One mark at a time, or a rattling ball would fill the page.
    if (world.steps - lastMarkStep < 12 || e.speed < 4) return;
    lastMarkStep = world.steps;
    const tone = e.ball ? color.blue.stroke : color.gray.stroke;
    marks.push({ born: stage.time, elements: impactMark(`m${markId++}`, e.x, e.y, e.speed, tone) });
    if (marks.length > 8) marks.shift();
  } else if (e.type === 'fail') {
    sound.failed();
    retryAt = stage.time + 0.9;
    refresh();
  } else if (e.type === 'won') {
    const id = LEVELS[index].id;
    if (!best[id] || e.stars > best[id].stars || (e.stars === best[id].stars && e.ink < best[id].ink)) {
      best[id] = { stars: e.stars, ink: Math.round(e.ink) };
      try { localStorage.setItem(STORAGE, JSON.stringify(best)); } catch { /* Private mode. */ }
    }
    sound.won(e.stars);
    winAt = stage.time;
    buildOverlayStars(e.stars);
    refresh();
  }
}

const PANEL_DELAY = 0.7;    // Long enough to see the ball arrive.

// ------------------------------------------------------------------ the HUD

const INK_X = 470, INK_W = 540, INK_Y = 40, INK_H = 26;

function hud() {
  const level = LEVELS[index];
  const out = [];
  out.push(text('title', 40, 14, `${index + 1}  ${level.name}`, { size: 42, ...ghost }));
  const running = world.state === 'run' || world.state === 'failed';
  const won = world.state === 'won';
  let hint = level.hint;
  if (world.pen && world.state === 'run') hint = 'Time stops while you draw.';
  else if (world.state === 'failed') hint = world.failReason === 'hazard' ? 'Ouch. Your plan is still there.' : 'Missed. Your plan is still there.';
  else if (world.state === 'run' && world.stuck) hint = 'Stuck. Press space to change your plan.';
  out.push(text('hint', 42, 76, hint, { size: 24, color: world.state === 'failed' ? color.rose.stroke : color.muted, ...ghost }));

  // Ink left, on a bar with the star limits marked.
  const left = world.inkLeft / level.ink;
  const dry = world.inkLeft <= 0;
  out.push(rect('ink-box', INK_X, INK_Y, INK_W, INK_H, { strokeColor: color.muted, roughness: 0.7, roundness: null, ...ghost }));
  out.push(rect('ink-bar', INK_X, INK_Y, Math.max(2, left * INK_W), INK_H, { tone: dry ? color.rose : color.blue, roundness: null, roughness: 0.7, ...ghost }));
  out.push(text('ink-left', INK_X + INK_W + 12, INK_Y - 2, dry ? 'dry' : `${Math.round(world.inkLeft)}`, { size: 26, color: dry ? color.rose.stroke : color.blue.stroke, ...ghost }));
  level.stars.forEach((limit, i) => {
    const count = 3 - i;
    const x = INK_X + (1 - limit / level.ink) * INK_W;
    const earned = world.inkUsed <= limit;
    out.push({ ...rect(`ink-tick${i}`, x - 1, INK_Y - 2, 2, INK_H + 4, { strokeColor: color.amber.stroke, strokeWidth: 1.5, roughness: 0, roundness: null, ...ghost }) });
    for (let s = 0; s < count; s++) out.push(starLine(`ink-star${i}${s}`, x - (count - 1) * 7 + s * 14, INK_Y - 13, 7, { strokeColor: earned ? color.amber.stroke : '#ced4da', strokeWidth: 1.5, roughness: 0.3, ...ghost }));
  });

  // Levels, each with the stars it has earned.
  LEVELS.forEach((l, i) => {
    const x = 1150 + i * 54;
    const current = i === index;
    out.push(...box(`level-${i}`, x, 12, 46, 38, String(i + 1), { size: 22, tone: current ? color.amber : color.gray, roughness: 0.8 }));
    for (let s = 0; s < 3; s++) out.push(starLine(`level-${i}-star${s}`, x + 9 + s * 14, 60, 6, { strokeColor: (best[l.id]?.stars ?? 0) > s ? color.amber.stroke : '#dee2e6', strokeWidth: 1.5, roughness: 0.3, ...ghost }));
  });

  // Controls.
  const planning = world.state === 'plan';
  out.push(...box('btn-go', 1150, 74, 186, 40, running ? 'Try again (space)' : 'Let go (space)', { size: 20, tone: running ? color.gray : color.green, opacity: won ? 40 : 100, roughness: 0.8 }));
  out.push(...box('btn-undo', 1344, 74, 112, 40, 'Undo (Z)', { size: 20, tone: color.gray, opacity: planning && world.plan.length ? 100 : 40, roughness: 0.8 }));
  out.push(...box('btn-restart', 1464, 74, 110, 40, 'Clear (R)', { size: 20, tone: color.gray, roughness: 0.8 }));

  if (panelOpen) out.push(...winPanel());
  return out;
}

const PANEL = { x: 480, y: 232, w: 640, h: 372 };

function winPanel() {
  const level = LEVELS[index];
  const ink = Math.round(world.winInk);
  const last = index === LEVELS.length - 1;
  const stars = world.starsFor(world.winInk);
  const { x, y, w } = PANEL;
  let line = `You used ${ink} of ${level.ink} ink.`;
  if (stars < 3) line += `\nThree stars takes ${level.stars[0]} or less.`;
  const total = Object.values(best).reduce((sum, b) => sum + b.stars, 0);
  const enter = { customData: { handwave: { enter: 'fade', ghost: true } } };
  return [
    rect('panel', x, y, w, PANEL.h, { strokeColor: color.ink, backgroundColor: '#ffffff', strokeWidth: 3, customData: { handwave: { enter: 'fade' } } }),
    text('panel-title', x + w / 2, y + 24, last ? 'That was the last level' : 'Flag reached', { size: 44, align: 'center', color: color.green.stroke, ...enter }),
    text('panel-line', x + w / 2, y + 188, last ? `${line}\n${total} of ${LEVELS.length * 3} stars so far.` : line, { size: 25, align: 'center', ...enter }),
    ...box('btn-again', x + 60, y + 302, 240, 46, 'Change plan (space)', { size: 24, tone: color.gray, customData: { handwave: { enter: 'fade' } } }),
    ...box('btn-next', x + 340, y + 302, 240, 46, last ? 'Level 1 (enter)' : 'Next level (enter)', { size: 24, tone: color.green, customData: { handwave: { enter: 'fade' } } }),
  ];
}

let overlayStars = [];
function buildOverlayStars(count) {
  overlayStars = [0, 1, 2].map((i) => {
    const cx = PANEL.x + PANEL.w / 2 + (i - 1) * 118, cy = PANEL.y + 132, r = 46;
    const earned = i < count;
    return {
      el: starLine(`win-star${i}`, cx, cy, r, { strokeColor: earned ? color.amber.stroke : '#ced4da', strokeWidth: 3, roughness: 0.8 }),
      fill: earned ? hatch(starPoints(cx, cy, r), { fill: '#f08c00', style: 'zigzag', gap: 6, weight: 2.4, angle: -35, seed: 40 + i }) : null,
      cx, cy, r, delay: 0.25 + i * 0.28,
    };
  });
}

const refresh = () => stage.show(hud(), { morphSeconds: 0.14, stagger: 0.002, exit: 0.1 });

// ------------------------------------------------------------------ drawing the world

function drawWorld(ctx) {
  const level = LEVELS[index];
  const reveal = Math.min(1, intro / 0.55);

  ctx.save();
  ctx.globalAlpha = reveal;
  for (const h of art.under) paintHatch(ctx, h);
  ctx.restore();
  for (const el of art.lines) drawElement(ctx, el, reveal < 1 ? { outline: reveal } : null);

  const used = new Set();
  for (const s of [...world.plan, ...world.extra]) for (const pin of s.nails ?? []) used.add(pin);
  for (const pin of level.pins ?? []) drawPin(ctx, pin, used.has(pin));

  if (machines.gate) {
    const g = level.gate;
    drawAt(ctx, machines.gate, g.x, g.y - world.gateOpen * g.h);
  }
  if (machines.plate) {
    const p = level.plate;
    drawAt(ctx, machines.plate, p.x, p.y + (world.plateLoad >= p.load ? 3 : 0));
  }

  // The last attempt's path, so the next plan can answer it.
  if (lastTrail.length && world.state === 'plan') {
    ctx.fillStyle = color.blue.stroke;
    ctx.globalAlpha = 0.28;
    for (const [tx, ty] of lastTrail) {
      ctx.beginPath();
      ctx.arc(tx, ty, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  for (const stroke of [...world.plan, ...world.extra]) drawStroke(ctx, stroke);
  drawPen(ctx);

  const ball = world.ball.position;
  drawBall(ctx, ball.x, ball.y, roll, BALL_RADIUS);

  // A ring goes round the flag on arrival.
  if (winAt !== null) {
    const { x, y } = level.flag;
    flagRing = flagRing?.id === `ring-${level.id}` ? flagRing : ellipse(`ring-${level.id}`, x - 82, y - 148, 170, 176, { strokeColor: color.green.stroke, strokeWidth: 3.5 });
    drawElement(ctx, flagRing, { outline: Math.min(1, (stage.time - winAt) / 0.4) });
  }

  // Hits fade out where they happened.
  marks = marks.filter((m) => stage.time - m.born < 0.28);
  for (const m of marks) {
    const opacity = 100 * (1 - (stage.time - m.born) / 0.28);
    for (const el of m.elements) drawElement(ctx, { ...el, opacity });
  }
}

function drawStroke(ctx, stroke) {
  const body = world.bodies.get(stroke.id);
  if (!body) return;
  const { el, fill } = strokeArt(stroke);
  // Hold the drawn pose until the body has really moved, so nothing at rest shivers.
  const pose = shown.get(stroke.id);
  let x = body.position.x, y = body.position.y, a = body.angle;
  if (pose && Math.abs(pose.x - x) < 0.35 && Math.abs(pose.y - y) < 0.35 && Math.abs(pose.a - a) < 0.0025) ({ x, y, a } = pose);
  else shown.set(stroke.id, { x, y, a });
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  if (fill) paintHatch(ctx, fill);
  drawElement(ctx, el);
  ctx.restore();
}

function drawPen(ctx) {
  const pen = world.pen;
  if (!pen) return;
  if (pen.points.length > 1) drawElement(ctx, strokeElement(`s${world.nextStroke}`, pen.points));
  const [tx, ty] = pen.tip;
  if (pen.blocked || pen.dry) {
    ctx.save();
    ctx.strokeStyle = color.rose.stroke;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(tx, ty, 13, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  // Show that lifting the pen here will close the loop.
  if (closesLoop(pen.points)) {
    const [sx, sy] = pen.points[0];
    ctx.save();
    ctx.strokeStyle = color.amber.stroke;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([6, 7]);
    ctx.beginPath();
    ctx.arc(sx, sy, 40, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawOverlay(ctx) {
  if (!panelOpen) return;
  const since = stage.time - winAt - PANEL_DELAY;
  for (const star of overlayStars) {
    const t = Math.max(0, Math.min(1, (since - star.delay) / 0.3));
    if (star.fill && t > 0) {
      ctx.save();
      // The scribble goes on from left to right.
      ctx.beginPath();
      ctx.rect(star.cx - star.r - 4, star.cy - star.r - 4, (star.r * 2 + 8) * t, star.r * 2 + 8);
      ctx.clip();
      paintHatch(ctx, star.fill);
      ctx.restore();
    }
    drawElement(ctx, star.el, since < 0.25 ? { outline: since / 0.25 } : null);
  }
}

stage.layer('under', drawWorld);
stage.layer('over', drawOverlay);

// ------------------------------------------------------------------ the clock

function stepPhysics() {
  const started = performance.now();
  world.step();
  physicsMs = performance.now() - started;
  // The ball has no friction, so its drawn spin comes from its travel.
  if (world.state === 'run' || world.state === 'won') roll += (world.ball.velocity.x / 2) / BALL_RADIUS;
  if (world.state === 'run' && world.steps % 8 === 0) trail.push([world.ball.position.x, world.ball.position.y]);
}

let wasStuck = false;
let flagRing = null;
stage.onFrame((dt) => {
  intro += dt;
  if (!MANUAL) {
    accumulator = Math.min(accumulator + dt, 0.1);
    while (accumulator >= 1 / STEPS_PER_SECOND) {
      stepPhysics();
      accumulator -= 1 / STEPS_PER_SECOND;
    }
    if (retryAt !== null && stage.time >= retryAt && world.state === 'failed') tryAgain();
  }
  if (world.stuck !== wasStuck) { wasStuck = world.stuck; refresh(); }
  if (winAt !== null && !panelOpen && stage.time - winAt >= PANEL_DELAY) { panelOpen = true; refresh(); }
  // The pen is silent when it stops moving.
  if (lastPen && performance.now() - lastPen.t > 60) sound.scratch(0);
});

// ------------------------------------------------------------------ actions

function letGoOrRetry() {
  if (world.state === 'plan') {
    world.go();
    sound.letGo();
    refresh();
  } else tryAgain();
}

function tryAgain() {
  if (trail.length > 4) lastTrail = trail;
  trail = [];
  world.retry();
  afterReset();
  refresh();
}

function clearLevel() {
  trail = [];
  lastTrail = [];
  world.restart();
  afterReset();
  refresh();
}

function next() {
  load((index + 1) % LEVELS.length);
}

function undo() {
  if (world.undo()) {
    afterReset();
    refresh();
  }
}

// ------------------------------------------------------------------ input

const isControl = (el) => !!el && (el.id.startsWith('btn-') || el.id.startsWith('level-') || el.id === 'panel');

stage.on('down', '*', ({ el, x, y }) => {
  sound.unlock();
  if (isControl(el) || world.state === 'won' || world.state === 'failed') return;
  world.penDown(x, y);
  lastPen = { x, y, t: performance.now() };
  refresh();
});
stage.on('drag', '*', ({ x, y }) => {
  if (!world.pen) return;
  const before = world.pen.points.length;
  world.penMove(x, y);
  if (world.pen.points.length !== before || world.pen.blocked || world.pen.dry) refresh();
  const now = performance.now();
  if (lastPen && now > lastPen.t) sound.scratch(Math.hypot(x - lastPen.x, y - lastPen.y) / (now - lastPen.t) / 2);
  lastPen = { x, y, t: now };
});
stage.on('up', '*', () => {
  if (!world.pen) return;
  world.penUp();
  sound.scratch(0);
  refresh();
});

stage.on('click', 'btn-go', letGoOrRetry);
stage.on('click', 'btn-undo', undo);
stage.on('click', 'btn-restart', clearLevel);
stage.on('click', 'btn-again', tryAgain);
stage.on('click', 'btn-next', next);
LEVELS.forEach((_, i) => stage.on('click', `level-${i}`, () => load(i)));

addEventListener('keydown', (e) => {
  sound.unlock();
  if (e.repeat && e.code !== 'KeyZ') return;
  if (e.code === 'Space') { e.preventDefault(); letGoOrRetry(); }
  else if (e.code === 'KeyZ') undo();
  else if (e.code === 'KeyR') clearLevel();
  else if ((e.code === 'Enter' || e.code === 'KeyN') && world.state === 'won') next();
  else if (e.code === 'KeyM') sound.setMuted(!sound.isMuted());
  else if (/^Digit[1-9]$/.test(e.code)) {
    const i = Number(e.code.slice(5)) - 1;
    if (i < LEVELS.length) load(i);
  }
});

load(index);

// ------------------------------------------------------------------ for tests

window.app = {
  stage,
  LEVELS,
  get world() { return world; },
  get index() { return index; },
  get best() { return best; },
  get physicsMs() { return physicsMs; },
  /** Advance the fixed timestep by hand. Stops at the end of a run. */
  steps(count) {
    for (let i = 0; i < count && world.state === 'run'; i++) stepPhysics();
    return this.status();
  },
  status() {
    return {
      level: LEVELS[index].id,
      state: world.state,
      reason: world.failReason ?? null,
      steps: world.endStep ?? world.steps,
      ink: Math.round(world.inkUsed),
      stars: world.state === 'won' ? world.starsFor(world.winInk) : 0,
      strokes: [...world.plan, ...world.extra].map((s) => ({ closed: s.closed, length: Math.round(s.length), points: s.points.length, nails: s.nails?.length ?? 0 })),
      ball: [Math.round(world.ball.position.x), Math.round(world.ball.position.y)],
    };
  },
  load,
  /** Fill the page with falling strokes and report what a frame costs. */
  async stress(lines, solids, seconds = 3) {
    const level = { id: 'stress', name: 'Stress', hint: '', ground: [[[-40, 860], [1640, 860]]], blocks: [[[0, 130], [30, 130], [30, 860], [0, 860]], [[1570, 130], [1600, 130], [1600, 860], [1570, 860]]], ball: { x: 800, y: 150 }, flag: { x: 4000, y: 860 }, ink: 1e9, stars: [1, 2] };
    world = new World(level);
    world.onEvent = () => {};
    art = levelArt(level);
    machines = {};
    afterReset();
    let placed = 0;
    for (let i = 0; i < lines + solids; i++) {
      const x = 60 + (i * 137) % 1400, y = 140 + (i % 30) * 22;
      const pts = i < lines
        ? [[x, y], [x + 40, y + 8], [x + 80, y], [x + 120, y + 8]]
        : [[x, y], [x + 34, y], [x + 34, y + 34], [x, y + 34], [x, y]];
      world.penDown(...pts[0]);
      for (const [px, py] of pts.slice(1)) { const a = world.pen.points.at(-1) ?? pts[0]; for (let k = 1; k <= 4; k++) world.penMove(a[0] + (px - a[0]) * k / 4, a[1] + (py - a[1]) * k / 4); }
      if (world.penUp()) placed++;
    }
    world.go();
    const frames = [], physics = [], renders = [];
    const started = performance.now();
    await new Promise((resolve) => {
      let last = performance.now();
      const tick = () => {
        const now = performance.now();
        frames.push(now - last);
        last = now;
        const t0 = performance.now();
        stepPhysics();
        stepPhysics();
        physics.push(performance.now() - t0);
        renders.push(stage.frameMs);
        if (now - started > seconds * 1000) resolve(); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const percentile = (list, p) => list.slice().sort((a, b) => a - b)[Math.floor(list.length * p)];
    const round = (v) => +v.toFixed(2);
    return { bodies: placed, frames: frames.length, frameMedianMs: round(percentile(frames, 0.5)), frameP95Ms: round(percentile(frames, 0.95)), physicsMedianMs: round(percentile(physics, 0.5)), physicsP95Ms: round(percentile(physics, 0.95)), renderMedianMs: round(percentile(renders, 0.5)), renderP95Ms: round(percentile(renders, 0.95)) };
  },
  get lastTrail() { return lastTrail; },
};
