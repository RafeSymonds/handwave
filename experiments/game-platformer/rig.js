// The player is a stick figure made of Excalidraw lines. Every limb is placed by
// what the body is doing: the run cycle advances with distance covered, so feet
// plant at the speed the ground passes under them, and a figure standing still
// is perfectly still.

import { line, ellipse, color } from '/lib/draw.js';
import { R, TUNING } from './sim.js';

const HIP = 30, NECK = 15, HEAD_UP = 13, HEAD_R = 12;
const THIGH = 18, SHIN = 18, UPPER = 12, FORE = 12;
const STROKE = { strokeColor: color.ink, strokeWidth: 3, roughness: 0.7, customData: { handwave: { change: 'none', exit: 'none', enter: 'none' } } };
const PARTS = ['p-arm-b', 'p-leg-b', 'p-torso', 'p-head', 'p-eye', 'p-leg-f', 'p-arm-f'];

const blend = (rate, dt) => 1 - Math.exp(-rate * dt);
const lerp = (a, b, t) => a + (b - a) * t;

// Two bones from a joint toward a target, bending to one side.
function reach(ax, ay, bx, by, a, b, bend) {
  const dx = bx - ax, dy = by - ay;
  const d = Math.max(0.001, Math.min(a + b - 0.01, Math.hypot(dx, dy)));
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const along = (a * a - b * b + d * d) / (2 * d);
  const side = Math.sqrt(Math.max(0, a * a - along * along));
  return [[ax, ay], [ax + ux * along - uy * side * bend, ay + uy * along + ux * side * bend], [ax + ux * d, ay + uy * d]];
}

export class Rig {
  constructor() {
    this.reset();
  }

  reset() {
    this.phase = 0;
    this.face = 1;
    this.feet = [[-6, 0], [6, 0]];
    this.hands = [[-3, 20], [3, 20]];
    this.squash = 0;
    this.time = 0;
    this.scatter = null;
    this.parts = null;
  }

  /** Move the limbs on by `dt` of what the player is doing. */
  update(p, dt, won) {
    this.time += dt;
    this.face = lerp(this.face, p.face, blend(26, dt));
    const f = this.face;
    const speed = p.grounded ? Math.abs(p.gs) : 0;
    const s = Math.min(1, speed / TUNING.RUN);

    // A run cycle by distance: one radian per `stride` pixels.
    const stride = 5 + 14 * s;
    if (p.grounded) this.phase += (speed / stride) * dt;

    // The hard landing bends the knees, then recovers.
    this.squash = lerp(this.squash, 0, blend(11, dt));

    const slope = p.grounded ? p.nx / Math.max(0.3, -p.ny) : 0;
    const targets = [0, 1].map((i) => {
      const ph = this.phase + (i ? Math.PI : 0);
      if (won) return [(i ? 7 : -7), 0];
      if (p.inWater && !p.grounded) return [Math.sin(this.time * 7 + i * Math.PI) * 9, -6 - Math.max(0, Math.cos(this.time * 7 + i * Math.PI)) * 5];
      if (!p.grounded) {
        if (p.vy < -120) return i ? [-f * 8, -2] : [f * 12, -13];
        return i ? [-f * 12, -8] : [f * 10, -3];
      }
      const idle = i ? 7 : -7;
      const x = lerp(idle * 1, Math.sin(ph) * stride * f, Math.min(1, s * 5));
      const lift = Math.max(0, Math.cos(ph)) * (2 + 13 * s) * Math.min(1, s * 5);
      return [x, x * slope - lift];
    });
    const footRate = p.grounded ? 60 : 16;
    this.feet = this.feet.map((foot, i) => [lerp(foot[0], targets[i][0], blend(footRate, dt)), lerp(foot[1], targets[i][1], blend(footRate, dt))]);

    const handTargets = [0, 1].map((i) => {
      const ph = this.phase + (i ? 0 : Math.PI);
      if (won) return [(i ? 8 : -8), -24];
      if (p.inWater && !p.grounded) return [(i ? 1 : -1) * (12 + Math.sin(this.time * 5) * 8), -6 + Math.cos(this.time * 5) * 6];
      if (!p.grounded) return p.vy < -120 ? (i ? [-f * 9, -13] : [f * 14, -11]) : (i ? [-f * 17, -9] : [f * 17, -6]);
      const x = lerp(i ? 3 : -3, Math.sin(ph) * (3 + 13 * s) * f, Math.min(1, s * 5));
      return [x, 21 - 4 * s];
    });
    this.hands = this.hands.map((hand, i) => [lerp(hand[0], handTargets[i][0], blend(30, dt)), lerp(hand[1], handTargets[i][1], blend(30, dt))]);
    this.parts = this._pose(p, s, slope);
  }

  /** Bend the knees by landing this hard. */
  land(speed) {
    this.squash = Math.min(14, Math.max(0, speed - 250) * 0.022);
  }

  _pose(p, s, slope) {
    const f = this.face;
    const baseX = p.x, baseY = p.y + R;
    const lean = f * s * 5 + (p.grounded ? 0 : f * Math.min(1, Math.abs(p.vx) / TUNING.RUN) * 3);
    const bob = p.grounded ? Math.abs(Math.cos(this.phase)) * 3 * s : 0;
    const hip = [baseX, baseY - HIP - bob + this.squash];
    const shoulder = [hip[0] + lean, hip[1] - NECK];
    const head = [shoulder[0] + lean * 0.4, shoulder[1] - HEAD_UP];
    const legs = this.feet.map((foot, i) => {
      const fy = baseY + foot[1];
      return reach(hip[0], hip[1], baseX + foot[0], fy, THIGH, SHIN, -Math.sign(f || 1));
    });
    const arms = this.hands.map((hand) => reach(shoulder[0], shoulder[1], shoulder[0] + hand[0], shoulder[1] + hand[1], UPPER, FORE, Math.sign(f || 1)));
    return { hip, shoulder, head, legs, arms, face: f };
  }

  /** The figure as Excalidraw elements, back to front. */
  elements() {
    const { hip, shoulder, head, legs, arms, face } = this.parts;
    const scattered = (id, points) => {
      const hit = this.scatter?.[id];
      if (!hit) return points;
      const cos = Math.cos(hit.rot), sin = Math.sin(hit.rot);
      const [ox, oy] = points[0];
      return points.map(([x, y]) => [ox + (x - ox) * cos - (y - oy) * sin + hit.x, oy + (x - ox) * sin + (y - oy) * cos + hit.y]);
    };
    const limb = (id, points) => line(id, scattered(id, points), { ...STROKE });
    const headAt = scattered('p-head', [head])[0];
    const eyeAt = [headAt[0] + face * 5, headAt[1] - 1];
    return [
      limb('p-arm-b', arms[1]),
      limb('p-leg-b', legs[1]),
      limb('p-torso', [hip, shoulder]),
      ellipse('p-head', headAt[0] - HEAD_R, headAt[1] - HEAD_R, HEAD_R * 2, HEAD_R * 2, { ...STROKE, backgroundColor: '#ffffff', strokeWidth: 2.5 }),
      ellipse('p-eye', eyeAt[0] - 2, eyeAt[1] - 2, 4, 4, { ...STROKE, strokeWidth: 1.5, backgroundColor: color.ink, roughness: 0 }),
      limb('p-leg-f', legs[0]),
      limb('p-arm-f', arms[0]),
    ];
  }

  /** Come apart. Each part flies off from where it was. */
  breakApart(vx, vy, seed = 1) {
    this.scatter = {};
    PARTS.forEach((id, i) => {
      const a = ((i + 1) * 2.399 + seed) % (Math.PI * 2);
      this.scatter[id] = { x: 0, y: 0, vx: Math.cos(a) * 260 + vx * 0.3, vy: Math.sin(a) * 260 - 340 + vy * 0.15, rot: 0, spin: (i % 2 ? 1 : -1) * (5 + i) };
    });
  }

  updateScatter(dt) {
    for (const part of Object.values(this.scatter ?? {})) {
      part.vy += 1900 * dt;
      part.x += part.vx * dt;
      part.y += part.vy * dt;
      part.rot += part.spin * dt;
    }
  }
}
