// The game's physics, with no DOM, so tests and level design can run it in Node.
// Expects Matter on globalThis.
//
// A level has two states. In `plan` nothing moves: you draw, and each finished
// stroke is placed. `go()` starts the clock. A run ends in `won` or `failed`, and
// `retry()` rebuilds the same plan from scratch, so every attempt of a plan plays
// out identically. Strokes drawn during a run stop the clock while the pen is
// down, and are forgotten by the next retry.

import { convexPieces, dist, isSimple, pathLength, polylineDistance, signedArea, simplify, thickQuads } from './geometry.js';

export const THICKNESS = 8;
export const BALL_RADIUS = 26;
export const STEP_MS = 1000 / 120;
export const STEPS_PER_SECOND = 120;

const PEN_SPACING = 10;       // Pointer samples closer than this add nothing.
const CLOSE_REACH = 40;       // A pen this near its start closes the loop.
const MIN_LOOP_LENGTH = 90;
const MIN_LOOP_AREA = 300;
const PIN_REACH = 22;         // A stroke this near a pin is nailed to it.
const LINE_DENSITY = 0.002;
const SOLID_DENSITY = 0.005;  // A closed loop is about four times as heavy per area.
const TOP_LIMIT = 122;        // The HUD lives above this.
const REST_SPEED = 0.1;       // Slower than one step of free fall, so a lost support shows.
const REST_SPIN = 0.003;

// Matter caps friction per contact whatever the weight, so a heavy block on a
// slope creeps unless static friction is far above the usual range.
const surface = { friction: 0.9, frictionStatic: 12, restitution: 0.05 };

export function closesLoop(points) {
  return points.length > 3 && pathLength(points) >= MIN_LOOP_LENGTH && dist(points[0], points[points.length - 1]) <= CLOSE_REACH;
}

const toVerts = (points) => points.map(([x, y]) => ({ x, y }));

function convexBody(points, options) {
  const { Bodies, Vertices } = globalThis.Matter;
  let verts = Vertices.clockwiseSort(toVerts(points));
  if (!Vertices.isConvex(verts)) verts = Vertices.hull(verts); // Nearly straight pieces can test as bent.
  const c = Vertices.centre(verts);
  return Bodies.fromVertices(c.x, c.y, [verts], options);
}

/** The collision shape of a stroke, built only from its points, so a rebuild is identical. */
function strokeBody(stroke) {
  const { Body } = globalThis.Matter;
  let parts;
  if (stroke.closed) {
    let tolerance = 4;
    let outline = simplify(stroke.points, tolerance).slice(0, -1);
    while (outline.length > 32) outline = simplify(stroke.points, (tolerance *= 1.5)).slice(0, -1);
    parts = convexPieces(outline).filter((piece) => Math.abs(signedArea(piece)) > 4).map((piece) => convexBody(piece, { density: SOLID_DENSITY }));
  } else {
    let tolerance = 2.5;
    let path = simplify(stroke.points, tolerance);
    while (path.length > 40) path = simplify(stroke.points, (tolerance *= 1.5));
    parts = thickQuads(path, THICKNESS).map((quad) => convexBody(quad, { density: LINE_DENSITY }));
  }
  const body = parts.length === 1 ? parts[0] : Body.create({ parts });
  Object.assign(body, surface, { frictionAir: 0.004, label: stroke.id });
  return body;
}

export class World {
  constructor(level) {
    this.level = level;
    this.plan = [];       // Strokes kept between attempts.
    this.extra = [];      // Strokes drawn during this run.
    this.nextStroke = 0;
    this.pen = null;
    this.onEvent = () => {};
    this.reset();
  }

  // ------------------------------------------------------------------ building

  reset() {
    const { Engine, Bodies, Composite, Events } = globalThis.Matter;
    // No sleeping: Matter treats a sleeping body as a wall for the step that wakes
    // it, which eats most of a hit. The renderer hides resting jitter instead.
    const engine = Engine.create({ positionIterations: 10, velocityIterations: 8, constraintIterations: 4 });
    engine.gravity.y = 1;
    this.engine = engine;
    this.state = 'plan';
    this.steps = 0;
    this.extra = [];
    this.bodies = new Map();
    this.solids = [];     // Everything the pen and the ball can touch.
    this.hazards = [];
    this.gateOpen = 0;
    this.plateLoad = 0;
    this.endStep = null;
    this.failReason = null;
    this.stuck = false;
    this.stillSteps = 0;

    const add = (body) => { Composite.add(engine.world, body); this.solids.push(body); return body; };
    const fixed = { isStatic: true, ...surface };

    for (const ground of this.level.ground ?? []) {
      for (let i = 1; i < ground.length; i++) {
        const [ax, ay] = ground[i - 1], [bx, by] = ground[i];
        add(convexBody([[ax, ay], [bx, by], [bx, 1000], [ax, 1000]], fixed));
      }
    }
    for (const block of this.level.blocks ?? []) add(convexBody(block, fixed));
    for (const hazard of this.level.hazards ?? []) this.hazards.push(add(convexBody(hazard, { ...fixed, label: 'hazard' })));

    if (this.level.gate) {
      const g = this.level.gate;
      this.gateBody = add(Bodies.rectangle(g.x + g.w / 2, g.y + g.h / 2, g.w, g.h, { ...fixed, label: 'gate' }));
    }
    if (this.level.plate) {
      const p = this.level.plate;
      add(Bodies.rectangle(p.x + p.w / 2, p.y + 5, p.w, 10, { ...fixed, label: 'plate' }));
      this.plateSensor = Bodies.rectangle(p.x + p.w / 2, p.y - 4, p.w - 4, 8, { isStatic: true, isSensor: true });
    }

    const { x, y } = this.level.ball;
    // A polygon with many sides: Matter's own circle stops at about one side per
    // pixel of radius, and a ball that clunks over 26 corners stops rolling.
    this.ball = add(Bodies.polygon(x, y, 64, BALL_RADIUS, { density: 0.0008, friction: 0, frictionStatic: 0, restitution: 0.2, frictionAir: 0.0006, label: 'ball' }));

    for (const stroke of this.plan) this._place(stroke);

    Events.on(engine, 'collisionStart', (e) => {
      for (const pair of e.pairs) {
        const a = pair.bodyA.parent, b = pair.bodyB.parent;
        if (a === b) continue;
        const speed = Math.hypot(a.velocity.x - b.velocity.x, a.velocity.y - b.velocity.y); // Pixels per 60th of a second.
        if ((a === this.ball && b.label === 'hazard') || (b === this.ball && a.label === 'hazard')) this._fail('hazard');
        if (speed < 2.2) continue;
        const support = pair.collision.supports?.[0] ?? pair.collision.bodyA.position;
        const moving = a === this.ball || b === this.ball;
        this.onEvent({ type: 'impact', x: support.x, y: support.y, speed, ball: moving });
      }
    });
  }

  _place(stroke) {
    const { Body, Composite, Constraint } = globalThis.Matter;
    const body = strokeBody(stroke);
    stroke.origin = [body.position.x, body.position.y];
    const nailed = (this.level.pins ?? []).filter((pin) => polylineDistance([pin.x, pin.y], stroke.points) <= PIN_REACH);
    stroke.nails = nailed;
    Composite.add(this.engine.world, body);
    this.solids.push(body);
    if (nailed.length >= 2) Body.setStatic(body, true);
    else if (nailed.length === 1) {
      const pin = nailed[0];
      Composite.add(this.engine.world, Constraint.create({ bodyA: body, pointA: { x: pin.x - body.position.x, y: pin.y - body.position.y }, pointB: { x: pin.x, y: pin.y }, length: 0, stiffness: 1, damping: 0.02 }));
    }
    this.bodies.set(stroke.id, body);
    return body;
  }

  // ------------------------------------------------------------------ the pen

  get inkUsed() {
    let used = 0;
    for (const s of this.plan) used += s.length;
    for (const s of this.extra) used += s.length;
    if (this.pen) used += pathLength(this.pen.points);
    return used;
  }

  get inkLeft() { return Math.max(0, this.level.ink - this.inkUsed); }

  /** Whether a thick pen can sit on this spot, or travel between two spots. */
  _penFree(from, to) {
    const { Query } = globalThis.Matter;
    if (to[1] < TOP_LIMIT) return false;
    const a = { x: from[0], y: from[1] }, b = { x: to[0], y: to[1] };
    if (Math.hypot(a.x - b.x, a.y - b.y) < 0.5) b.x += 0.5;
    return Query.ray(this.solids, a, b, THICKNESS + 2).length === 0;
  }

  penDown(x, y) {
    if (this.state === 'won') return;
    this.pen = { points: [], tip: [x, y], blocked: false, dry: false };
    this.penMove(x, y);
  }

  penMove(x, y) {
    const pen = this.pen;
    if (!pen) return;
    pen.tip = [x, y];
    const point = [Math.round(x), Math.round(y)];
    if (!pen.points.length) {
      pen.blocked = !this._penFree(point, point);
      if (!pen.blocked && this.inkLeft > 0) pen.points.push(point);
      return;
    }
    const last = pen.points[pen.points.length - 1];
    const step = dist(last, point);
    if (step < PEN_SPACING) return;
    const left = this.inkLeft;
    pen.dry = left <= 0;
    if (pen.dry) return;
    let next = point;
    if (step > left) {
      const t = left / step;
      next = [Math.round(last[0] + (point[0] - last[0]) * t), Math.round(last[1] + (point[1] - last[1]) * t)];
    }
    pen.blocked = !this._penFree(last, next);
    if (!pen.blocked) pen.points.push(next);
  }

  /** Lift the pen. The stroke becomes a body, or nothing if it is too short. */
  penUp() {
    const pen = this.pen;
    this.pen = null;
    if (!pen || pen.points.length < 2 || pathLength(pen.points) < 24) return null;
    const stroke = { id: `s${this.nextStroke++}`, points: pen.points, closed: false, length: pathLength(pen.points) };
    if (closesLoop(pen.points)) this._tryClose(stroke);
    this._place(stroke);
    (this.state === 'plan' ? this.plan : this.extra).push(stroke);
    this.onEvent({ type: 'stroke', stroke });
    return stroke;
  }

  // A loop becomes a solid only if the solid would have room. Anything else stays a line.
  _tryClose(stroke) {
    const { Query } = globalThis.Matter;
    const closed = stroke.points.concat([stroke.points[0]]);
    const outline = simplify(closed, 4).slice(0, -1);
    if (outline.length < 3 || !isSimple(outline) || Math.abs(signedArea(outline)) < MIN_LOOP_AREA) return;
    const candidate = strokeBody({ ...stroke, points: closed, closed: true });
    if (Query.collides(candidate, this.solids).length) return;
    stroke.points = closed;
    stroke.closed = true;
    stroke.length = pathLength(closed);
  }

  undo() {
    if (this.state !== 'plan' || !this.plan.length) return false;
    this.plan.pop();
    this.reset();
    return true;
  }

  restart() {
    this.plan = [];
    this.reset();
  }

  // ------------------------------------------------------------------ the clock

  go() {
    if (this.state === 'plan') this.state = 'run';
  }

  /** Back to the plan as drawn. Strokes from the run are forgotten and refunded. */
  retry() {
    this.reset();
  }

  _fail(reason) {
    if (this.state !== 'run') return;
    this.state = 'failed';
    this.failReason = reason;
    this.endStep = this.steps;
    this.onEvent({ type: 'fail', reason, x: this.ball.position.x, y: Math.min(880, this.ball.position.y) });
  }

  /** One fixed step. Does nothing while the pen is down or outside a run. */
  step() {
    if (this.pen || (this.state !== 'run' && this.state !== 'won')) return;
    const { Engine, Query, Body } = globalThis.Matter;
    Engine.update(this.engine, STEP_MS);
    this.steps++;
    this._holdResting();
    if (this.state !== 'run') return;

    const ball = this.ball.position;
    const f = this.level.flag;
    if (ball.x > f.x - 46 && ball.x < f.x + 46 && ball.y > f.y - 130 && ball.y < f.y + 20) {
      this.state = 'won';
      this.endStep = this.steps;
      this.winInk = this.inkUsed;
      this.onEvent({ type: 'won', ink: this.winInk, stars: this.starsFor(this.winInk) });
      return;
    }
    if (ball.y > 980 || ball.x < -120 || ball.x > 1720) this._fail('fell');

    if (this.plateSensor) {
      const parents = new Set();
      const movable = this.solids.filter((b) => !b.isStatic);
      for (const hit of Query.collides(this.plateSensor, movable)) {
        const part = hit.bodyA === this.plateSensor ? hit.bodyB : hit.bodyA;
        parents.add(part.parent);
      }
      this.plateLoad = [...parents].reduce((sum, b) => sum + b.mass, 0);
      const open = this.plateLoad >= this.level.plate.load;
      const before = this.gateOpen;
      this.gateOpen = Math.max(0, Math.min(1, this.gateOpen + (open ? 1 : -1) * (1 / 90)));
      if (this.gateOpen !== before) {
        const g = this.level.gate;
        Body.setPosition(this.gateBody, { x: g.x + g.w / 2, y: g.y + g.h / 2 - this.gateOpen * g.h });
      }
    }

    if (Body.getSpeed(this.ball) < 0.12) {
      this.stillSteps++;
      if (this.stillSteps > 240) this.stuck = true;
    } else {
      this.stillSteps = 0;
      this.stuck = false;
    }
  }

  // Matter pushes bodies out of contacts along the contact normal, so anything on
  // a slope creeps downhill for ever, whatever its friction. A body that has been
  // still for a second is held where it is until a hit or a lost support moves it.
  _holdResting() {
    const { Body } = globalThis.Matter;
    for (const body of this.bodies.values()) {
      if (body.isStatic) continue;
      const rest = (body.plugin.rest ??= { still: 0, held: false, x: 0, y: 0, a: 0 });
      const moving = body.speed > REST_SPEED || Math.abs(body.angularSpeed) > REST_SPIN;
      if (rest.held) {
        if (moving) {
          rest.held = false;
          rest.still = 0;
        } else {
          Body.setPosition(body, { x: rest.x, y: rest.y });
          Body.setAngle(body, rest.a);
          Body.setVelocity(body, { x: 0, y: 0 });
          Body.setAngularVelocity(body, 0);
        }
      } else if (moving) {
        rest.still = 0;
      } else if (++rest.still >= STEPS_PER_SECOND) {
        Object.assign(rest, { held: true, x: body.position.x, y: body.position.y, a: body.angle });
      }
    }
  }

  starsFor(ink) {
    const [three, two] = this.level.stars;
    return ink <= three ? 3 : ink <= two ? 2 : 1;
  }
}
