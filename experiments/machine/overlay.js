// What the running program looks like, drawn over the drawing. Nothing here changes
// the document: tokens, counts, charts and messages are all painted on top of it.

import { drawElement, passesFor } from '/lib/render.js';
import { ellipse, rect, color } from '/lib/draw.js';
import { absPoints, isText, ownerOf, pathOf, pointAlong } from './graph.js';
import { evaluate } from './expr.js';

const KIND_TONES = { gold: { fill: '#ffd43b', stroke: color.amber.stroke }, red: { fill: '#ffa8a8', stroke: color.rose.stroke }, green: { fill: '#8ce99a', stroke: color.green.stroke }, blue: { fill: '#74c0fc', stroke: color.blue.stroke } };
const EXTRA_TONES = [{ fill: '#8ce99a', stroke: color.green.stroke }, { fill: '#ffa8a8', stroke: color.rose.stroke }, { fill: '#b197fc', stroke: '#5f3dc4' }];

const tokenTones = {
  plain: { fill: '#74c0fc', stroke: color.blue.stroke },
  retry: { fill: '#ffd43b', stroke: color.amber.stroke },
  stale: { fill: '#dee2e6', stroke: '#868e96' },
};

// A token is drawn hundreds of times a frame, so each look is compiled once and stamped.
const stamps = new Map();
function stamp(tone, size, variant) {
  const key = `${tone.fill}|${size}|${variant}`;
  let s = stamps.get(key);
  if (!s) {
    const el = ellipse(`token-${tone.fill}-${size}-${variant}`, 0, 0, size, size, { tone, roughness: 0.8 });
    s = { passes: passesFor(el), fill: tone.fill, stroke: tone.stroke, size };
    stamps.set(key, s);
  }
  return s;
}

function drawStamp(ctx, s, x, y) {
  ctx.translate(x - s.size / 2, y - s.size / 2);
  for (const pass of s.passes) {
    if (pass.kind === 'fill') { ctx.fillStyle = s.fill; ctx.fill(pass.path, pass.rule); }
    else if (pass.hatch) { ctx.strokeStyle = s.fill; ctx.lineWidth = pass.width; ctx.stroke(pass.path); }
    else { ctx.strokeStyle = s.stroke; ctx.lineWidth = pass.width; ctx.stroke(pass.path); }
  }
  ctx.translate(s.size / 2 - x, s.size / 2 - y);
}

export const say = (ctx, words, x, y, { size = 24, ink = color.ink, align = 'left', font = 'Excalifont' } = {}) => {
  ctx.font = `${size}px ${font}`;
  ctx.fillStyle = ink;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(words, x, y);
};

// A waiting token eases towards its place, so a line shuffles forward and a new
// token drops into it rather than jumping.
function ease(token, tx, ty, dt) {
  if (token.px === undefined) { token.px = tx; token.py = ty; }
  const k = Math.min(1, dt * 12);
  token.px += (tx - token.px) * k;
  token.py += (ty - token.py) * k;
  return [token.px, token.py];
}

const PILE_GAP = 26;
const MAX_BOXES = 120;

/** Where each worker's box is on a workers shape. Clicks use this too. */
export function slotLayout(node, st) {
  const el = node.el;
  const count = node.params.workers ?? 1;
  // Boxes past what can be seen aren't drawn, whatever the label asks for.
  const slots = Math.min(MAX_BOXES, Math.max(count, ...st.busy.map((b) => b.slot + 1), 0));
  const gap = 12;
  const perRow = Math.max(1, Math.floor((el.width - 20) / (30 + gap)));
  const rows = Math.ceil(slots / perRow) || 1;
  const label = node.texts?.[0];
  const room = el.y + el.height - 10 - (label ? label.y + label.height : el.y + 10);
  const size = Math.max(16, Math.min(46, room / rows - gap, (el.width - 20) / Math.min(slots || 1, perRow) - gap));
  const step = size + gap;
  const top = el.y + el.height - rows * step - 8;
  const out = [];
  for (let i = 0; i < slots; i++) {
    const row = Math.floor(i / perRow), col = i % perRow;
    const inRow = Math.min(perRow, slots - row * perRow);
    out.push({ i, x: el.x + (el.width - inRow * step + gap) / 2 + col * step, y: top + row * step + gap / 2, size, gone: i >= count });
  }
  return out;
}

const slotShapes = new Map();
function slotShape(node, i, size) {
  const key = `${node}-${i}-${Math.round(size)}`;
  if (!slotShapes.has(key)) slotShapes.set(key, rect(`slot-${key}`, 0, 0, Math.round(size), Math.round(size), { backgroundColor: '#ffffff', strokeColor: color.gray.stroke, roughness: 0.8 }));
  return slotShapes.get(key);
}

const handleShape = ellipse('handle', 0, 0, 20, 20, { tone: color.amber, roughness: 0.5 });
const connectShape = ellipse('connect', 0, 0, 22, 22, { tone: color.blue, roughness: 0.5 });

/** Where the corner to resize a selected shape is. */
export const resizeAt = (el) => [el.x + el.width + 3, el.y + el.height + 3];

/** Where the "drag to draw an arrow" circle sits on a shape. */
export function connectAt(el) {
  const w = el.width, h = el.height;
  if (el.type === 'rectangle') return [el.x + w + 13, el.y - 13];
  // Just outside the shape's top-right edge.
  const k = el.type === 'ellipse' ? Math.SQRT1_2 : 0.5;
  return [el.x + w / 2 + (w / 2) * k + 13, el.y + h / 2 - (h / 2) * k - 13];
}

export function createOverlay(m) {
  const { board } = m;
  const kindTones = new Map();

  function toneOf(token) {
    if (token.stale) return seen('nobody wants this', tokenTones.stale);
    if (token.kind) {
      if (!kindTones.has(token.kind)) kindTones.set(token.kind, KIND_TONES[token.kind] ?? EXTRA_TONES[kindTones.size % EXTRA_TONES.length]);
      return seen(token.kind, kindTones.get(token.kind));
    }
    return token.retries > 0 ? seen('retried', tokenTones.retry) : seen('work', tokenTones.plain);
  }

  // What has been on screen this run, so the panel can say what each color means.
  function seen(words, tone) {
    if (!m.tokensSeen.has(words)) m.tokensSeen.set(words, tone);
    return tone;
  }

  function drawToken(ctx, token, x, y) {
    const size = token.count > 1 ? 34 : 22;
    drawStamp(ctx, stamp(toneOf(token), size, token.id % 6), x, y);
    if (token.count > 1) say(ctx, String(token.count), x, y + 7, { size: 20, align: 'center' });
  }

  // A waiting line winds through the shape from its bottom, with the next token out at
  // the bottom right. Winding back and forth means each token moves one place when the
  // line moves, instead of the end of each row crossing the whole shape. It skips the
  // label and keeps going past the top, so a line that outgrows its box looks like it.
  function drawPile(ctx, node, st, dt, { above = false, caption = true } = {}) {
    const el = node.el;
    const cols = Math.max(1, Math.floor((el.width - 24) / PILE_GAP));
    const left = el.x + (el.width - cols * PILE_GAP) / 2 + PILE_GAP / 2;
    const floor = above ? el.y - 18 : el.y + el.height - 22;
    // Stop under the title. The count below the shape keeps saying how long the line is.
    const ceiling = board.camera.y + 112;
    const label = above ? null : node.texts[0];
    const rows = [];
    for (let y = floor; y >= ceiling; y -= PILE_GAP) {
      if (label && y + 11 > label.y - 2 && y - 11 < label.y + label.height + 2) continue;
      rows.push(y);
    }
    const shown = Math.min(st.queue.length, Math.max(1, rows.length) * cols);
    for (let i = 0; i < shown; i++) {
      const row = Math.floor(i / cols), col = i % cols;
      const across = row % 2 === 0 ? cols - 1 - col : col;
      const [x, y] = ease(st.queue[i], left + across * PILE_GAP, rows[row] ?? floor, dt);
      drawToken(ctx, st.queue[i], x, y);
    }
    if (caption && (st.queue.length || st.dropped)) say(ctx, [st.queue.length ? `${st.queue.length} waiting` : '', st.dropped ? `${st.dropped} turned away` : ''].filter(Boolean).join(', '), el.x + 6, el.y + el.height + 28, { size: 26, ink: color.rose.stroke });
  }

  function drawSlots(ctx, node, st, dt) {
    const el = node.el;
    // When work is backing up, the shape holding it back is marked.
    const s = m.stats;
    if (s?.bottleneck?.id === node.id && s.time > 8 && (s.verdict === 'backing up' || s.verdict === 'turning away' || s.verdict === 'wasting')) {
      drawElement(ctx, { ...el, backgroundColor: 'transparent', strokeColor: color.rose.stroke, strokeWidth: 4 });
    }
    const busyAt = new Map(st.busy.map((b) => [b.slot, b]));
    for (const slot of slotLayout(node, st)) {
      const dead = st.dead.has(slot.i);
      const shape = slotShape(node.id, slot.i, slot.size);
      drawElement(ctx, { ...shape, x: slot.x, y: slot.y, strokeStyle: slot.gone ? 'dashed' : 'solid', backgroundColor: dead ? color.rose.fill : '#ffffff', strokeColor: dead ? color.rose.stroke : color.gray.stroke });
      if (dead) {
        // A killed worker stays on the drawing, crossed out, until you click it again.
        ctx.strokeStyle = color.rose.stroke;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(slot.x + 7, slot.y + 7); ctx.lineTo(slot.x + slot.size - 7, slot.y + slot.size - 7);
        ctx.moveTo(slot.x + slot.size - 7, slot.y + 7); ctx.lineTo(slot.x + 7, slot.y + slot.size - 7);
        ctx.stroke();
      }
      const job = busyAt.get(slot.i);
      if (job) {
        const [tx, ty] = ease(job.token, slot.x + slot.size / 2, slot.y + slot.size / 2, dt);
        drawToken(ctx, job.token, tx, ty);
        // The bar under a job is the time it has left.
        ctx.strokeStyle = color.ink;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(slot.x + 4, slot.y + slot.size + 3);
        ctx.lineTo(slot.x + 4 + (slot.size - 8) * Math.max(0, job.left / job.total), slot.y + slot.size + 3);
        ctx.stroke();
      }
    }
    if (st.queue.length) drawPile(ctx, node, st, dt, { above: true, caption: false });
    // A small shape's boxes and line already say this, and its neighbours need the room.
    if (el.height < 100 || el.width < 200) return;
    const alive = m.sim._alive(node, st);
    const inUse = st.busy.filter((b) => b.slot < (node.params.workers ?? 1)).length;
    const words = [`${inUse} of ${alive} busy`, st.queue.length ? `${st.queue.length} waiting` : '', st.dropped ? `${st.dropped} turned away` : ''].filter(Boolean).join(', ');
    say(ctx, words, el.x + el.width / 2, el.y + el.height + 28, { size: 24, ink: st.queue.length || st.dropped ? color.rose.stroke : color.muted, align: 'center' });
  }

  function drawInside(ctx, node, st, dt) {
    // Jobs in a delay cross the shape as their time runs out.
    const el = node.el;
    const lane = el.y + el.height - 20;
    for (const job of st.busy) {
      const k = 1 - Math.max(0, job.left / job.total);
      const [x, y] = ease(job.token, el.x + 18 + (el.width - 36) * k, lane, dt * 4);
      drawToken(ctx, job.token, x, y);
    }
  }

  function drawChart(ctx, node) {
    const el = node.el;
    const label = node.texts[0];
    const top = (label ? label.y + label.height : el.y) + 8;
    const box = { x: el.x + 56, y: top, w: el.width - 74, h: el.y + el.height - top - 34 };
    if (box.w < 30 || box.h < 20) return;
    const sim = m.sim;
    const lines = [];
    let caption = '';
    const expr = node.params.chartOf;
    if (sim.mode === 'states') {
      if (expr) lines.push({ samples: sim.series(), read: (s) => evaluate(expr, s), ink: color.amber.stroke, name: node.params.chartOfText });
      caption = node.params.chartOfText ?? '';
    } else {
      for (const id of node.watching) {
        const target = m.graph.nodes.get(id);
        if (!target) continue;
        const metric = sim.defaultMetric?.(target);
        const samples = sim.series(id);
        lines.push({ samples, read: expr ? (s) => evaluate(expr, s) : (s) => s[metric.key] ?? 0, ink: target.el.strokeColor === 'transparent' ? color.ink : target.el.strokeColor, name: target.name });
        caption = expr ? node.params.chartOfText : metric.label;
        if (node.watching.length === 1) caption = `${target.name}: ${caption}`;
      }
    }
    ctx.strokeStyle = color.muted;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(box.x, box.y); ctx.lineTo(box.x, box.y + box.h); ctx.lineTo(box.x + box.w, box.y + box.h);
    ctx.stroke();
    const now = sim.time;
    const span = sim.mode === 'logic' ? 20 : 60;
    let max = sim.mode === 'chain' ? 1 : 1e-9;
    for (const line of lines) for (const s of line.samples) if (s.t > now - span) max = Math.max(max, line.read(s));
    if (max < 1 && sim.mode !== 'chain') max = 1;
    const shown = sim.mode === 'chain' ? '100%' : max >= 10 ? String(Math.round(max)) : String(+max.toFixed(1));
    say(ctx, shown, box.x - 6, box.y + 14, { size: 18, ink: color.muted, align: 'right' });
    say(ctx, '0', box.x - 6, box.y + box.h, { size: 18, ink: color.muted, align: 'right' });
    lines.forEach((line, n) => {
      const pts = line.samples.filter((s) => s.t > now - span);
      if (pts.length < 2) return;
      ctx.strokeStyle = line.ink;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach((p, i) => {
        const x = box.x + ((p.t - (now - span)) / span) * box.w;
        const y = box.y + box.h - (line.read(p) / max) * box.h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
    lines.forEach((line, n) => {
      if (lines.length < 2 || !line.name) return;
      // Names sit on the lines, so each gets a white edge to stay readable.
      ctx.font = '18px Excalifont';
      ctx.textAlign = 'right';
      ctx.lineWidth = 4;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#ffffff';
      ctx.strokeText(line.name, box.x + box.w - 4, box.y + 16 + n * 20);
      say(ctx, line.name, box.x + box.w - 4, box.y + 16 + n * 20, { size: 18, ink: line.ink, align: 'right' });
    });
    if (caption) say(ctx, caption, box.x + box.w / 2, box.y + box.h + 22, { size: 19, ink: color.muted, align: 'center' });
    if (!lines.length && sim.mode !== 'states') say(ctx, 'nothing joined yet', box.x + box.w / 2, box.y + box.h / 2, { size: 20, ink: color.muted, align: 'center' });
  }

  function drawFlow(ctx, dt) {
    const sim = m.sim;
    for (const token of sim.moving) {
      const edge = m.graph.edges.get(token.edge);
      if (!edge) continue;
      const [x, y] = pointAlong(pathOf(edge.el), edge.reversed ? 1 - token.t : token.t);
      token.px = x; token.py = y;
      drawToken(ctx, token, x, y);
    }
    for (const node of m.graph.nodes.values()) {
      const st = sim.state(node.id);
      if (!st) continue;
      const el = node.el;
      const middle = el.x + el.width / 2;
      const below = el.y + el.height + 28;
      switch (node.kind) {
        case 'queue': drawPile(ctx, node, st, dt); break;
        case 'workers': drawSlots(ctx, node, st, dt); break;
        case 'delay':
          drawInside(ctx, node, st, dt);
          if (st.busy.length) say(ctx, `${st.busy.length} inside`, middle, below, { size: 24, ink: color.muted, align: 'center' });
          break;
        case 'batch':
          drawPile(ctx, node, st, dt, { caption: false });
          say(ctx, `${st.queue.length} of ${node.params.batch ?? 1}`, middle, below, { size: 24, ink: color.muted, align: 'center' });
          break;
        case 'merge':
          drawPile(ctx, node, st, dt, { caption: false });
          if (st.queue.length) say(ctx, `${st.queue.length} parts waiting`, middle, below, { size: 24, ink: color.muted, align: 'center' });
          break;
        case 'cache':
          if (st.recent.length) say(ctx, `${Math.round(sim.metrics(node).hitrate)}% hit`, middle, below, { size: 26, ink: color.blue.stroke, align: 'center' });
          break;
        case 'limiter':
          if (st.dropped) say(ctx, `${st.dropped} turned away`, middle, below, { size: 24, ink: color.rose.stroke, align: 'center' });
          break;
        case 'sink':
          if (st.done) say(ctx, st.wasted ? `${st.done - st.wasted}, and ${st.wasted} wasted` : String(st.done), middle, below + 2, { size: st.wasted ? 26 : 30, ink: st.wasted ? color.rose.stroke : el.strokeColor, align: 'center' });
          break;
        case 'chart': drawChart(ctx, node); break;
        default:
      }
    }
    // A cross where work was just turned away, since a dropped token is otherwise invisible.
    for (const drop of sim.drops) {
      const node = m.graph.nodes.get(drop.node);
      if (!node) continue;
      const age = (sim.time - drop.time) / 0.6;
      if (age >= 1) continue;
      ctx.globalAlpha = 1 - age;
      ctx.strokeStyle = color.rose.stroke;
      ctx.lineWidth = 3;
      const x = node.el.x - 18, y = node.el.y + 20;
      ctx.beginPath(); ctx.moveTo(x - 9, y - 9); ctx.lineTo(x + 9, y + 9); ctx.moveTo(x + 9, y - 9); ctx.lineTo(x - 9, y + 9); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  function drawStates(ctx) {
    const sim = m.sim;
    for (const node of m.graph.nodes.values()) if (node.kind === 'chart') drawChart(ctx, node);
    if (sim.moving) {
      const edge = m.graph.edges.get(sim.moving.edge);
      if (edge) {
        const [x, y] = pointAlong(pathOf(edge.el), edge.reversed ? 1 - sim.moving.t : sim.moving.t);
        drawStamp(ctx, stamp(tokenTones.retry, 22, 0), x, y);
      }
      return;
    }
    for (const edge of sim.outgoing()) {
      // A timed arrow fills in as its time runs out.
      if (sim.waitOf(edge) !== undefined && edge.to) {
        const path = pathOf(edge.el);
        const reach = sim.progress(edge) * path.total;
        ctx.strokeStyle = color.amber.stroke;
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(path.pts[0][0], path.pts[0][1]);
        for (let i = 1; i < path.pts.length && path.lens[i - 1] < reach; i++) {
          const [x, y] = pointAlong(path, Math.min(reach, path.lens[i]) / path.total);
          ctx.lineTo(x, y);
        }
        ctx.stroke();
        // The label stays readable over the line.
        for (const el of edge.texts) {
          const patch = board.get(`${el.id}-patch`);
          if (patch) drawElement(ctx, patch);
          drawElement(ctx, el);
        }
      }
      // `fail x3` shows how many it has seen.
      const seen = sim.counts.get(edge.id);
      if (seen) {
        const [x, y] = pointAlong(pathOf(edge.el), 0.5);
        say(ctx, `${seen} of ${edge.times}`, x, y - 26, { size: 28, ink: color.rose.stroke, align: 'center' });
      }
    }
  }

  function drawChain(ctx) {
    const sim = m.sim;
    for (const token of sim.moving) {
      if (token.t < 0) continue;
      const edge = m.graph.edges.get(token.edge);
      if (!edge) continue;
      const [x, y] = pointAlong(pathOf(edge.el), edge.reversed ? 1 - token.t : token.t);
      drawStamp(ctx, stamp(tokenTones.plain, 16, token.id % 6), x, y);
    }
    for (const node of m.graph.nodes.values()) {
      if (node.kind === 'chart') { drawChart(ctx, node); continue; }
      if (node.kind !== 'place') continue;
      const el = node.el;
      const share = sim.share(node.id);
      const long = sim.longRun?.get(node.id) ?? 0;
      const w = el.width * 0.56, x = el.x + (el.width - w) / 2, y = el.y + el.height * 0.66;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x, y, w, 12);
      ctx.fillStyle = el.strokeColor;
      ctx.fillRect(x, y, w * share, 12);
      ctx.strokeStyle = el.strokeColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, 12);
      // The tick is where this shape settles in the long run.
      ctx.fillStyle = color.ink;
      ctx.fillRect(x + w * long - 1.5, y - 5, 3, 22);
      say(ctx, `${Math.round(share * 100)}%`, x + w / 2, y + 38, { size: 26, ink: el.strokeColor, align: 'center' });
    }
  }

  function drawLogic(ctx) {
    const sim = m.sim;
    for (const node of m.graph.nodes.values()) if (node.kind === 'chart') drawChart(ctx, node);
    // A 1 on a wire is thick and green. A change travels from the shape it left.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const [id, wire] of sim.wires) {
      const edge = m.graph.edges.get(id);
      if (!edge) continue;
      const path = pathOf(edge.el);
      const part = (a, b) => {
        if (b <= a) return;
        ctx.beginPath();
        const steps = Math.max(2, Math.ceil((b - a) * 24));
        for (let i = 0; i <= steps; i++) {
          const k = a + (b - a) * (i / steps);
          const [x, y] = pointAlong(path, edge.reversed ? 1 - k : k);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      };
      ctx.strokeStyle = color.green.stroke;
      ctx.lineWidth = 6;
      let from = 0;
      const pulses = [...wire.pulses].reverse();
      for (const p of pulses) {
        if (p.value) part(from, Math.min(1, p.t));
        from = Math.min(1, p.t);
      }
      if (wire.value) part(from, 1);
    }
  }

  // ------------------------------------------------------------------ editing marks

  const outline = (ctx, el, ink, width = 4) => drawElement(ctx, { ...el, backgroundColor: 'transparent', strokeColor: ink, strokeWidth: width, opacity: 100, strokeStyle: 'solid' });

  function drawEditing(ctx) {
    const g = m.gesture;
    if (g?.type === 'rewire' && g.target) outline(ctx, m.byId(g.target), color.amber.stroke);
    if (g?.type === 'connect' && g.target) outline(ctx, m.byId(g.target), color.blue.stroke);
    if (g?.type === 'part' && g.onShape) outline(ctx, m.byId(g.onShape), color.blue.stroke);
    if (g?.type === 'part' && g.onArrow) outline(ctx, m.byId(g.onArrow), color.blue.stroke);

    const picked = m.selected && m.byId(m.selected);
    if (picked) outline(ctx, picked, color.blue.stroke, 3);
    if (picked && m.isShape(picked) && !g) {
      const [x, y] = resizeAt(picked);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = color.blue.stroke;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.rect(x - 7, y - 7, 14, 14);
      ctx.fill();
      ctx.stroke();
    }

    // The ends you can grab, on the arrow under the pointer.
    const held = g?.type === 'rewire' ? g.arrow : m.hoverArrow ?? (picked?.type === 'arrow' ? picked.id : null);
    const arrow = held && m.byId(held);
    if (arrow) {
      const abs = absPoints(arrow);
      if (arrow.startBinding) drawElement(ctx, { ...handleShape, x: abs[0][0] - 10, y: abs[0][1] - 10 });
      if (arrow.endBinding) drawElement(ctx, { ...handleShape, x: abs[abs.length - 1][0] - 10, y: abs[abs.length - 1][1] - 10 });
    }

    // The circle to draw a new arrow from, on the shape in focus.
    const focus = m.connectShape();
    if (focus && (!g || g.type === 'connect')) {
      const [x, y] = connectAt(focus);
      drawElement(ctx, { ...connectShape, x: x - 11, y: y - 11 });
      ctx.strokeStyle = color.blue.stroke;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x - 5, y + 4); ctx.lineTo(x + 5, y - 4); ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y - 4); ctx.lineTo(x + 4, y + 2);
      ctx.stroke();
    }
    if (g?.type === 'connect' && g.point) {
      const [sx, sy] = connectAt(m.byId(g.from));
      const [ex, ey] = g.point;
      const angle = Math.atan2(ey - sy, ex - sx);
      ctx.strokeStyle = color.blue.stroke;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.setLineDash([8, 8]);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(ex - 18 * Math.cos(angle - 0.4), ey - 18 * Math.sin(angle - 0.4));
      ctx.lineTo(ex, ey);
      ctx.lineTo(ex - 18 * Math.cos(angle + 0.4), ey - 18 * Math.sin(angle + 0.4));
      ctx.stroke();
    }
    if (g?.type === 'part' && g.point) drawGhost(ctx, g);
    if (m.running === false || m.empty()) drawNotice(ctx);
  }

  function drawGhost(ctx, g) {
    const { part } = g;
    const [x, y] = g.point;
    ctx.save();
    ctx.globalAlpha = 0.65;
    if (part.type === 'arrow') {
      ctx.strokeStyle = color.ink;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x - part.w, y); ctx.lineTo(x, y); ctx.lineTo(x - 16, y - 8); ctx.moveTo(x, y); ctx.lineTo(x - 16, y + 8); ctx.stroke();
    } else {
      if (part.type === 'text') {
        say(ctx, part.label, x, y, { size: 26, ink: color.muted, align: 'center' });
        ctx.restore();
        return;
      }
      const el = m.ghostShape(part, x, y);
      drawElement(ctx, el);
      const lines = part.label.split('\n');
      lines.forEach((line, i) => say(ctx, line, x, y + 8 + (i - (lines.length - 1) / 2) * 30, { size: 26, align: 'center', ink: el.strokeColor }));
    }
    ctx.restore();
  }

  function drawNotice(ctx) {
    const c = board.camera;
    const mid = c.x + board.width / (2 * c.zoom);
    if (m.empty()) {
      const y = c.y + board.height / (2 * c.zoom);
      say(ctx, 'An empty board', mid, y - 50, { size: 44, ink: color.muted, align: 'center' });
      say(ctx, 'Drag a part here from the left, or double-click to add a shape.', mid, y, { size: 30, ink: color.muted, align: 'center' });
      say(ctx, 'You can also drop an .excalidraw file anywhere.', mid, y + 44, { size: 30, ink: color.muted, align: 'center' });
      return;
    }
    if (m.running === false) say(ctx, 'paused', c.x + board.width / c.zoom - 30, c.y + 40 / c.zoom, { size: 28 / c.zoom, ink: color.amber.stroke, align: 'right' });
  }

  // ------------------------------------------------------------------ what's wrong, said on the drawing

  const wrapCache = new Map();
  function wrap(ctx, words, width, size) {
    const key = `${size}|${width}|${words}`;
    if (wrapCache.has(key)) return wrapCache.get(key);
    ctx.font = `${size}px Excalifont`;
    const lines = [];
    let line = '';
    for (const word of words.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > width) { lines.push(line); line = word; } else line = next;
    }
    if (line) lines.push(line);
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const out = { lines, widest };
    if (wrapCache.size > 300) wrapCache.clear();
    wrapCache.set(key, out);
    return out;
  }

  function anchorOf(id) {
    const el = m.byId(id);
    if (!el) return null;
    if (el.type === 'arrow') {
      const [x, y] = pointAlong(pathOf(el), 0.5);
      return { x, top: y - 20, bottom: y + 24 };
    }
    return { x: el.x + el.width / 2, top: el.y, bottom: el.y + el.height + 40 };
  }

  function squiggle(ctx, issue) {
    const t = issue.textId ? m.byId(issue.textId) : null;
    if (!t || issue.start === undefined) return;
    const lines = t.text.split('\n');
    const row = issue.lineInText ?? 0;
    const line = lines[row];
    if (line === undefined) return;
    ctx.font = `${t.fontSize}px Excalifont`;
    const whole = ctx.measureText(line).width;
    const before = ctx.measureText(line.slice(0, issue.start)).width;
    const part = ctx.measureText(line.slice(issue.start, issue.end)).width;
    const align = t.textAlign ?? 'left';
    const left = t.x + (align === 'center' ? (t.width - whole) / 2 : align === 'right' ? t.width - whole : 0) + before;
    const y = t.y + (row + 1) * t.fontSize * (t.lineHeight ?? 1.25) + 1;
    ctx.strokeStyle = color.rose.stroke;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i <= part; i += 6) {
      const px = left + i, py = y + (Math.round(i / 6) % 2 ? 3 : 0);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  function drawIssues(ctx) {
    m.bubbles = [];
    if (m.gesture) return;
    const c = board.camera;
    const viewLeft = c.x + 8, viewRight = c.x + board.width / c.zoom - 8, viewBottom = c.y + board.height / c.zoom - 8;
    const seen = new Map();
    for (const issue of m.graph.issues) {
      if (!issue.id) continue;
      const anchor = anchorOf(issue.id);
      if (!anchor) continue;
      if (issue.level === 'error') squiggle(ctx, issue);
      const stacked = seen.get(issue.id) ?? 0;
      if (stacked >= 2) continue;
      const size = 22;
      const { lines, widest } = wrap(ctx, issue.message, 380, size);
      const w = widest + 20, h = lines.length * 26 + 10;
      let x = Math.max(viewLeft, Math.min(viewRight - w, anchor.x - w / 2));
      let y = anchor.bottom + stacked * 4 + (seen.get(`${issue.id}:y`) ?? 0);
      if (y + h > viewBottom) y = anchor.top - h - 8;
      seen.set(issue.id, stacked + 1);
      seen.set(`${issue.id}:y`, (seen.get(`${issue.id}:y`) ?? 0) + h + 4);
      const error = issue.level === 'error';
      ctx.fillStyle = error ? '#fff5f5' : '#fffdf5';
      ctx.strokeStyle = error ? color.rose.stroke : color.amber.stroke;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 8);
      ctx.fill();
      ctx.stroke();
      lines.forEach((l, i) => say(ctx, l, x + 10, y + 26 + i * 26, { size, ink: error ? color.rose.stroke : color.amber.stroke }));
      m.bubbles.push({ x, y, w, h, issue });
    }
  }

  return function drawOverlay(ctx, dt) {
    const sim = m.sim;
    if (sim?.mode === 'flow') drawFlow(ctx, dt);
    if (sim?.mode === 'states') drawStates(ctx);
    if (sim?.mode === 'chain') drawChain(ctx);
    if (sim?.mode === 'logic') drawLogic(ctx);
    drawIssues(ctx);
    drawEditing(ctx);
  };
}

/** Which text and owner a stage point is on, for tests and input. */
export const textOf = (doc, id) => doc.find((el) => isText(el) && ownerOf(el) === id);
