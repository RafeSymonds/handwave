// The game's physics, on a fixed 120 Hz step, with no physics library and no
// page. The player is three stacked circles, which walk up slopes, roll over
// small bumps and fit under ledges without special cases.

import { CELL, keyOf } from './level.js';

export const STEP = 1 / 120;
export const R = 14;
export const CIRCLES = [0, 22, 44];   // heights of the circle centers above the foot circle
export const HEIGHT = 44 + R * 2;

export const TUNING = {
  RUN: 430,
  ACCEL: 3800, DECEL: 4800, TURN: 7000,
  AIR_ACCEL: 2800, AIR_DRAG: 800,
  GRAVITY: 2700, FALL_MULT: 1.15, CUT_MULT: 2.9, MAX_FALL: 1300,
  JUMP: 1000,
  COYOTE: 0.1, BUFFER: 0.12,
  BOUNCE: 1500, BOUNCE_HOLD: 1.12,
  SWIM: 620, LEAP: 860, WATER_FALL: 200, WATER_DIVE: 360, WATER_GRAVITY: 0.22, WATER_DRAG: 2.2, WATER_SPEED: 0.62, STROKE_EVERY: 0.32,
  SNAP: 5,
  VERTEX_COS: Math.cos((35 * Math.PI) / 180),
  RESPAWN: 0.55,
};

const T = TUNING;
const WALKABLE = -0.5;               // a surface is floor if its normal's y is below this
const LAND_ON_VERTEX = -0.82;        // corners catch you only if you land nearly on top

const approach = (v, target, amount) => (v < target ? Math.min(v + amount, target) : Math.max(v - amount, target));

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function closestOnSegment(px, py, seg, out) {
  const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
  const t = Math.max(0, Math.min(1, ((px - seg.x1) * dx + (py - seg.y1) * dy) / (dx * dx + dy * dy)));
  out.t = t;
  out.x = seg.x1 + dx * t;
  out.y = seg.y1 + dy * t;
  return Math.hypot(px - out.x, py - out.y);
}

const q = { t: 0, x: 0, y: 0 };

export class Sim {
  constructor(level) {
    this.level = level;
    this.time = 0;
    this.collected = new Set();
    this.reachedCheckpoints = new Set();
    this.deaths = 0;
    this.won = false;
    this.wonAt = 0;
    this.events = [];
    this.quiet = false;
    this.spawn = this._freeSpawn(level.start.x, level.start.y);
    this._stamp = 0;
    this._near = [];
    this.player = this._newPlayer(this.spawn);
    this._updateMovers();
  }

  _newPlayer(at) {
    return {
      x: at.x, y: at.y, vx: 0, vy: 0, gs: 0,
      grounded: false, nx: 0, ny: -1, body: null,
      face: 1, coyote: 0, buffer: 0, jumpHeld: false, downHeld: false, canCut: false, dropTimer: 0,
      inWater: false, strokeTimer: 0, dead: false, deadTimer: 0, landed: 0,
    };
  }

  // Lift the start out of anything it was drawn inside.
  _freeSpawn(x, y) {
    let footY = y - R;
    for (let tries = 0; tries < 400; tries++) {
      const stuck = this.level.closedSolids.some((b) => !b.mover && CIRCLES.some((h) => pointInPolygon(x, footY - h, b.points)));
      if (!stuck) break;
      footY -= 8;
    }
    return { x, y: footY };
  }

  emit(event) { if (!this.quiet) this.events.push(event); }

  // ------------------------------------------------------------------ movers

  _updateMovers() {
    for (const m of this.level.movers) {
      const [px, py] = m.offsetAt(Math.max(0, this.time - STEP));
      const [ox, oy] = m.offsetAt(this.time);
      m.ox = ox; m.oy = oy;
      m.dx = ox - px; m.dy = oy - py;
      m.vx = m.dx / STEP; m.vy = m.dy / STEP;
    }
    for (const seg of this.level.moving) {
      const m = seg.body.mover;
      seg.x1 = seg.ax + m.ox; seg.y1 = seg.ay + m.oy;
      seg.x2 = seg.bx + m.ox; seg.y2 = seg.by + m.oy;
    }
  }

  // ------------------------------------------------------------------ the step

  /** Advance one fixed step. `input` is {left, right, jump, down}. */
  step(input) {
    const p = this.player;
    const dt = STEP;
    this.time += dt;
    this._updateMovers();
    if (this.won) {
      if (p.grounded && p.body?.mover) { p.x += p.body.mover.dx; p.y += p.body.mover.dy; }
      return;
    }
    if (p.dead) {
      p.deadTimer -= dt;
      if (p.deadTimer <= 0) this._respawn();
      return;
    }

    if (p.grounded && p.body?.mover) { p.x += p.body.mover.dx; p.y += p.body.mover.dy; }

    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    if (dir) p.face = dir;
    if (input.jump && !p.jumpHeld) p.buffer = T.BUFFER; else p.buffer = Math.max(0, p.buffer - dt);
    p.jumpHeld = !!input.jump;
    const dropPressed = input.down && !p.downHeld;
    p.downHeld = !!input.down;
    p.dropTimer = Math.max(0, p.dropTimer - dt);
    p.coyote = p.grounded ? T.COYOTE : Math.max(0, p.coyote - dt);
    p.landed = Math.max(0, p.landed - dt);
    const wasInWater = p.inWater;
    this._checkWater(p);

    // Holding jump keeps swimming, and breaking the surface while holding it is a leap.
    if (p.inWater && input.jump) {
      p.strokeTimer -= dt;
      if (p.strokeTimer <= 0) { p.buffer = T.BUFFER; p.strokeTimer = T.STROKE_EVERY; }
    } else p.strokeTimer = 0;
    if (wasInWater && !p.inWater && p.vy < 0 && input.jump && !p.grounded) p.vy = Math.min(p.vy, -T.LEAP);

    // Drop through a dashed surface.
    if (dropPressed && p.grounded && p.body?.role === 'oneway') {
      this._leaveGround(p, true);
      p.dropTimer = 0.22;
      p.coyote = 0;
    }

    if (p.grounded) this._moveOnGround(p, dir, dt); else this._moveInAir(p, dir, dt, input);
    const jumped = this._tryJump(p);

    p.x += p.vx * dt;
    p.y += p.vy * dt;

    this._gather(p);
    this._collide(p);
    if (jumped) p.grounded = false; else this._findGround(p);
    this._triggers(p);
  }

  _checkWater(p) {
    const midY = p.y - CIRCLES[1];
    const headY = p.y - CIRCLES[2] - R;
    p.inWater = false;
    p.headOut = true;
    for (const w of this.level.waters) {
      const ox = w.mover?.ox ?? 0, oy = w.mover?.oy ?? 0;
      if (p.x < w.minX + ox || p.x > w.maxX + ox) continue;
      if (midY >= w.minY + oy && midY <= w.maxY + oy) { p.inWater = true; p.headOut = headY < w.minY + oy; }
    }
  }

  _moveOnGround(p, dir, dt) {
    const tx = -p.ny, ty = p.nx;
    const uphill = dir !== 0 && ty * dir < 0;
    const slope = Math.abs(ty);
    let target = dir * T.RUN * (uphill ? 1 - 0.2 * slope : 1 + 0.12 * slope);
    if (p.inWater) target *= T.WATER_SPEED;
    const rate = dir === 0 ? T.DECEL : Math.sign(p.gs) === -dir ? T.TURN : T.ACCEL;
    p.gs = approach(p.gs, target, rate * dt);
    p.vx = p.gs * tx;
    p.vy = p.gs * ty;
  }

  _moveInAir(p, dir, dt, input) {
    const water = p.inWater;
    const target = dir * T.RUN * (water ? T.WATER_SPEED : 1);
    const beyond = Math.abs(p.vx) > T.RUN && Math.sign(p.vx) === dir;
    const rate = beyond ? T.AIR_DRAG * 0.3 : dir === 0 ? T.AIR_DRAG : T.AIR_ACCEL;
    p.vx = approach(p.vx, target, rate * dt);
    if (water) {
      p.vy += T.GRAVITY * T.WATER_GRAVITY * dt;
      if (p.vy < 0) p.vy *= Math.exp(-T.WATER_DRAG * dt);
      const sink = input.down ? T.WATER_DIVE : T.WATER_FALL;
      if (p.vy > sink) p.vy = approach(p.vy, sink, 3600 * dt);
      else if (input.down) p.vy = approach(p.vy, sink, 1400 * dt);
      p.canCut = false;
      return;
    }
    let g = T.GRAVITY;
    if (p.vy < 0 && p.canCut && !input.jump) g *= T.CUT_MULT;
    else if (p.vy > 0) g *= T.FALL_MULT;
    p.vy = Math.min(T.MAX_FALL, p.vy + g * dt);
  }

  _tryJump(p) {
    if (p.buffer <= 0) return false;
    // Under water a press is a stroke. With your head out it is a leap for the bank.
    if (p.inWater && (!p.grounded || !p.headOut)) {
      if (p.grounded) p.vx = p.gs * -p.ny;
      p.vy = p.headOut ? -T.LEAP : -T.SWIM;
      p.grounded = false;
      p.body = null;
      p.coyote = 0;
      p.buffer = 0;
      p.canCut = false;
      this.emit({ type: 'swim' });
      return true;
    }
    if (!p.grounded && p.coyote <= 0) return false;
    const m = p.grounded ? p.body?.mover : null;
    if (p.grounded) p.vx = p.gs * -p.ny + (m?.vx ?? 0);
    p.vy = -T.JUMP + Math.min(0, m?.vy ?? 0);
    p.grounded = false;
    p.coyote = 0;
    p.buffer = 0;
    p.canCut = true;
    p.body = null;
    this.emit({ type: 'jump' });
    return true;
  }

  // Everything that could touch the player this step.
  _gather(p) {
    const margin = R + 24;
    const near = this._near;
    near.length = 0;
    const stamp = ++this._stamp;
    const x0 = p.x - margin, x1 = p.x + margin, y0 = p.y - CIRCLES[2] - margin, y1 = p.y + margin;
    const { grid, moving } = this.level;
    for (let ix = Math.floor(x0 / CELL); ix <= Math.floor(x1 / CELL); ix++) {
      for (let iy = Math.floor(y0 / CELL); iy <= Math.floor(y1 / CELL); iy++) {
        const cell = grid.get(keyOf(ix, iy));
        if (!cell) continue;
        for (const seg of cell) if (seg.stamp !== stamp) { seg.stamp = stamp; near.push(seg); }
      }
    }
    for (const seg of moving) {
      if (Math.max(seg.x1, seg.x2) < x0 || Math.min(seg.x1, seg.x2) > x1 || Math.max(seg.y1, seg.y2) < y0 || Math.min(seg.y1, seg.y2) > y1) continue;
      near.push(seg);
    }
  }

  _oneWayBlocks(p, seg, cx, cy, isFoot) {
    if (!isFoot || p.dropTimer > 0) return false;
    const bodyVy = seg.body.mover?.vy ?? 0;
    if (!p.grounded && p.vy < bodyVy - 1) return false;
    return (cx - seg.x1) * seg.ux + (cy - seg.y1) * seg.uy >= R * 0.35;
  }

  // Push out of whatever the circles overlap, deepest first, and stop moving into it.
  _collide(p) {
    let spring = null;
    for (let iter = 0; iter < 6; iter++) {
      let pen = 0.001, nx = 0, ny = 0, hit = null;
      for (let c = 0; c < CIRCLES.length; c++) {
        const cx = p.x, cy = p.y - CIRCLES[c];
        for (const seg of this._near) {
          if (seg.oneway && !this._oneWayBlocks(p, seg, cx, cy, c === 0)) continue;
          const d = closestOnSegment(cx, cy, seg, q);
          if (d >= R) continue;
          const depth = R - d;
          if (depth <= pen) continue;
          pen = depth;
          hit = seg;
          if (d > 1e-6) { nx = (cx - q.x) / d; ny = (cy - q.y) / d; } else { nx = seg.ux; ny = seg.uy; }
        }
      }
      if (!hit) break;
      if (hit.body.role === 'bounce' && ny < 0.5) spring = hit;
      p.x += nx * pen;
      p.y += ny * pen;
      const vn = p.vx * nx + p.vy * ny;
      if (vn < 0) { p.vx -= vn * nx; p.vy -= vn * ny; }
      // A wall or ceiling stops the run. A floor only steers it.
      if (p.grounded && ny > WALKABLE) p.gs = p.vx * -p.ny + p.vy * p.nx;
    }
    // Walking or falling into the side of a spring sets it off too. It throws you up.
    if (spring && p.vy >= (spring.body.mover?.vy ?? 0) - 1) { this._bounce(p, spring, 0, -1); return; }
    // Squeezed inside something solid by a moving platform.
    for (const b of this.level.closedSolids) {
      if (!b.mover && !this.level.movers.length) break;
      const ox = b.mover?.ox ?? 0, oy = b.mover?.oy ?? 0;
      const midY = p.y - CIRCLES[1];
      if (p.x < b.minX + ox || p.x > b.maxX + ox || midY < b.minY + oy || midY > b.maxY + oy) continue;
      if (pointInPolygon(p.x - ox, midY - oy, b.points)) { this._die(p, 'crushed'); return; }
    }
  }

  _findGround(p) {
    const was = p.grounded;
    const reach = R + (was ? T.SNAP : 0.75);
    let best = null, bestD = Infinity, bestInterior = false, bx = 0, by = 0;
    for (const seg of this._near) {
      const bodyVy = seg.body.mover?.vy ?? 0;
      if (!was && p.vy < bodyVy - 1) continue;
      if (seg.oneway && !this._oneWayBlocks(p, seg, p.x, p.y, true)) continue;
      const d = closestOnSegment(p.x, p.y, seg, q);
      if (d >= reach) continue;
      const nx = d > 1e-6 ? (p.x - q.x) / d : seg.ux;
      const ny = d > 1e-6 ? (p.y - q.y) / d : seg.uy;
      const interior = q.t > 0 && q.t < 1;
      if (interior) {
        if (ny > WALKABLE) continue;
      } else if (was) {
        if (nx * p.nx + ny * p.ny < T.VERTEX_COS) continue;
      } else if (ny > LAND_ON_VERTEX) continue;
      if (d < bestD - 1e-6 || (Math.abs(d - bestD) <= 1e-6 && interior && !bestInterior)) {
        best = seg; bestD = d; bestInterior = interior; bx = nx; by = ny;
      }
    }
    if (!best) {
      if (was) this._leaveGround(p, false);
      return;
    }
    if (bestD > R) { p.x -= bx * (bestD - R); p.y -= by * (bestD - R); }
    if (best.body.role === 'bounce') { this._bounce(p, best, bx, by); return; }
    if (bestInterior) { p.nx = bx; p.ny = by; } else if (!was) {
      if (best.uy < WALKABLE) { p.nx = best.ux; p.ny = best.uy; } else { p.nx = 0; p.ny = -1; }
    }
    p.body = best.body;
    if (!was) {
      const m = best.body.mover;
      const relVx = p.vx - (m?.vx ?? 0);
      const tx = -p.ny;
      p.gs = Math.max(-T.RUN * 1.25, Math.min(T.RUN * 1.25, relVx / Math.max(tx, 0.5)));
      p.landed = 0.18;
      this.emit({ type: 'land', speed: p.vy });
      p.canCut = false;
      p.grounded = true;
      p.vy = p.gs * p.nx;
      p.vx = p.gs * -p.ny;
    }
  }

  _leaveGround(p, dropping) {
    const m = p.body?.mover;
    if (m) { p.vx += m.vx; p.vy += m.vy; }
    p.grounded = false;
    p.canCut = false;
    p.body = null;
    if (dropping) p.y += 1;
  }

  _bounce(p, seg, nx, ny) {
    const power = T.BOUNCE * (p.jumpHeld ? T.BOUNCE_HOLD : 1);
    const m = seg.body.mover;
    p.vx += nx * power * 0.55 + (m?.vx ?? 0);
    p.vy = -power * Math.max(0.6, -ny) + Math.min(0, m?.vy ?? 0);
    p.grounded = false;
    p.canCut = false;
    p.body = null;
    p.coyote = 0;
    this.emit({ type: 'bounce', id: seg.body.id });
  }

  // ------------------------------------------------------------------ touching things

  _distanceToCapsule(p, x, y) {
    const top = p.y - CIRCLES[2];
    const cy = Math.max(top, Math.min(p.y, y));
    return Math.hypot(x - p.x, y - cy);
  }

  _touchesHazard(p, body) {
    const ox = body.mover?.ox ?? 0, oy = body.mover?.oy ?? 0;
    const rr = R - 4;
    if (p.x + rr < body.minX + ox || p.x - rr > body.maxX + ox) return false;
    if (p.y + rr < body.minY + oy || p.y - CIRCLES[2] - rr > body.maxY + oy) return false;
    for (const h of CIRCLES) {
      const x = p.x - ox, y = p.y - h - oy;
      if (body.closed && pointInPolygon(x, y, body.points)) return true;
      for (const seg of body.segs) {
        const dx = seg.bx - seg.ax, dy = seg.by - seg.ay;
        const t = Math.max(0, Math.min(1, ((x - seg.ax) * dx + (y - seg.ay) * dy) / (dx * dx + dy * dy)));
        if (Math.hypot(x - seg.ax - dx * t, y - seg.ay - dy * t) < rr) return true;
      }
    }
    return false;
  }

  _touchesRound(p, body) {
    const ox = body.mover?.ox ?? 0, oy = body.mover?.oy ?? 0;
    return this._distanceToCapsule(p, body.cx + ox, body.cy + oy) < R + body.radius;
  }

  _triggers(p) {
    if (p.dead) return;
    const { hazards, coins, goals, checkpoints, extent } = this.level;
    for (const body of hazards) if (this._touchesHazard(p, body)) { this._die(p, 'hazard'); return; }
    if (p.y > extent.maxY + 700) { this._die(p, 'fell'); return; }
    for (const coin of coins) {
      if (this.collected.has(coin.id) || !this._touchesRound(p, coin)) continue;
      this.collected.add(coin.id);
      this.emit({ type: 'coin', id: coin.id });
    }
    for (const cp of checkpoints) {
      if (this.reachedCheckpoints.has(cp.id) || !this._touchesRound(p, cp)) continue;
      this.reachedCheckpoints.add(cp.id);
      this.spawn = this._freeSpawn(cp.cx, cp.maxY);
      this.emit({ type: 'checkpoint', id: cp.id });
    }
    for (const goal of goals) {
      if (!this._touchesRound(p, goal)) continue;
      this.won = true;
      this.wonAt = this.time;
      p.vx = 0; p.gs = 0;
      this.emit({ type: 'win' });
      return;
    }
  }

  _die(p, why) {
    p.dead = true;
    p.deadTimer = T.RESPAWN;
    this.deaths++;
    this.emit({ type: 'die', why });
  }

  _respawn() {
    const face = this.player.face;
    this.player = this._newPlayer(this.spawn);
    this.player.face = face;
    this.emit({ type: 'respawn' });
  }

  // ------------------------------------------------------------------ for the solver

  snapshot() {
    return { time: this.time, player: { ...this.player }, won: this.won };
  }

  restore(s) {
    this.time = s.time;
    this.player = { ...s.player };
    this.won = s.won;
    this._updateMovers();
  }
}
