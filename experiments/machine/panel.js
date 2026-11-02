// The panel under the board: what the program is doing, in words and numbers. It is
// a stage like the board, redrawn a few times a second. Its layout is in stage units,
// 1600 wide.

import { rect, line, text, box, color } from '/lib/draw.js';

const quiet = { customData: { handwave: { enter: 'fade', ghost: true } } };
const round = (n) => (n >= 10 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, ''));

const CHART = { x: 660, y: 100, w: 560, h: 90 };

export function createPanel(m) {
  const { panel } = m;
  let chartMax = 10;

  function verdictOf(s, started) {
    const b = s.bottleneck;
    const finishing = b ? `${b.count} ${b.count === 1 ? 'worker finishes' : 'workers finish'} ${round(b.capacity)}/s` : '';
    const arriving = b ? `${round(b.demand)}/s arrive` : '';
    if (!started) return { words: 'Watching how fast work arrives...', tone: color.gray };
    if (b && b.count === 0) return { words: `Every worker in ${b.name || 'this shape'} is dead, so its line can only grow.`, tone: color.rose };
    if (s.verdict === 'wasting') return { words: `Working hard for nobody: ${round(s.wasteRate)}/s finished after the client gave up, ${round(s.goodRate)}/s in time.`, tone: color.rose };
    if (s.verdict === 'turning away') return { words: b ? `Turning work away: ${arriving}, and ${finishing}.` : 'Turning work away.', tone: color.rose };
    if (s.verdict === 'backing up') {
      if (b && b.demand > b.capacity) return { words: `Backing up: ${arriving}, but ${finishing}.`, tone: color.rose };
      return { words: `Backing up: the line is growing by ${round(Math.max(0, s.slope))} a second.`, tone: color.rose };
    }
    if (s.verdict === 'draining') return { words: b ? `Draining the line: ${arriving}, and ${finishing}.` : 'Draining the line.', tone: color.amber };
    return { words: b ? `Keeping up: ${arriving}, and ${finishing}.` : `Keeping up: ${s.finished} finished.`, tone: color.green };
  }

  function flowPanel(out) {
    const s = m.sim.stats();
    m.stats = s;
    const b = s.bottleneck;
    const started = s.time > 8;
    const { words, tone } = verdictOf(s, started);
    out.push(text('verdict', 40, 12, words, { size: 34, color: tone.stroke, ...quiet }));

    // Two bars on one scale, so the comparison is the picture.
    if (b) {
      const scale = 340 / Math.max(0.1, b.demand, b.capacity);
      const bar = (id, y, value, label, barTone) => {
        const width = Math.max(4, value * scale);
        out.push(rect(`${id}-bar`, 40, y, width, 36, { tone: barTone, roundness: null, ...quiet }));
        out.push(text(`${id}-t`, 40 + width + 22, y + 18, label, { size: 26, valign: 'middle', color: barTone.stroke, ...quiet }));
      };
      bar('arriving', 70, b.demand, `arriving ${round(b.demand)}/s`, color.blue);
      bar('capacity', 116, b.capacity, `can finish ${round(b.capacity)}/s`, b.capacity < b.demand ? color.rose : color.green);
    }

    // The waiting line over the last minute. The line itself is drawn on the layer below.
    out.push(line('chart-y', [[CHART.x, CHART.y], [CHART.x, CHART.y + CHART.h]], { strokeColor: color.muted, ...quiet }));
    out.push(line('chart-x', [[CHART.x, CHART.y + CHART.h], [CHART.x + CHART.w, CHART.y + CHART.h]], { strokeColor: color.muted, ...quiet }));
    out.push(text('chart-t', CHART.x, CHART.y - 36, `waiting, last minute: ${s.waiting} now`, { size: 24, color: color.muted, ...quiet }));
    chartMax = Math.max(10, ...m.sim.history.filter((p) => p.t > m.sim.time - 60).map((p) => p.waiting));
    out.push(text('chart-max', CHART.x - 8, CHART.y + 12, String(chartMax), { size: 20, align: 'right', valign: 'middle', color: color.muted, ...quiet }));

    const x = 1270;
    out.push(text('finished', x, 64, `${s.finished} finished`, { size: 30, ...quiet }));
    out.push(text('average', x, 102, `${s.average ? round(s.average) : '0'}s each on average`, { size: 24, color: color.muted, ...quiet }));
    out.push(text('slowest', x, 132, `slowest 5%: ${s.slowest ? round(s.slowest) : '0'}s`, { size: 24, color: color.muted, ...quiet }));
    if (s.wasted) out.push(text('wasted', x, 162, `${s.wasted} wasted`, { size: 26, color: color.rose.stroke, ...quiet }));
    else if (s.dropped) out.push(text('dropped', x, 162, `${s.dropped} turned away`, { size: 26, color: color.rose.stroke, ...quiet }));
  }

  function statePanel(out) {
    const sim = m.sim;
    const name = sim.nameOf(sim.current);
    out.push(text('verdict', 40, 12, sim.moving ? 'Moving...' : `Now: ${name}`, { size: 34, color: color.amber.stroke, ...quiet }));
    let x = 40;
    sim.events().forEach((event, i) => {
      const on = sim.enabled(event);
      const width = Math.max(110, event.length * 16 + 54);
      out.push(...box(`event-${event}`, x, 70, width, 56, `${i + 1}  ${event}`, { size: 26, tone: on ? color.blue : color.gray, opacity: on ? 100 : 55, customData: { handwave: { enter: 'fade' } } }));
      x += width + 12;
    });
    const timed = sim.outgoing().find((e) => sim.waitOf(e) !== undefined && e.to);
    if (timed && !sim.moving) out.push(text('timer', x + 16, 98, `${sim.nameOf(timed.to)} in ${Math.max(0, sim.waitOf(timed) - (sim.time - sim.entered)).toFixed(1)}s`, { size: 28, valign: 'middle', color: color.amber.stroke, ...quiet }));
    else if (sim.note) out.push(text('ignored', x + 16, 98, sim.note, { size: 28, valign: 'middle', color: color.muted, ...quiet }));
    out.push(text('trail', 40, 142, sim.trail.join('  >  '), { size: 26, color: color.muted, ...quiet }));
    const vars = Object.keys(sim.vars);
    if (vars.length) out.push(text('vars', 1560, 24, vars.map((k) => `${k} = ${+Number(sim.vars[k]).toFixed(2)}`).join('    '), { size: 28, align: 'right', color: color.blue.stroke, ...quiet }));
  }

  function chainPanel(out) {
    const sim = m.sim;
    const places = [...m.graph.nodes.values()].filter((n) => n.kind === 'place');
    const words = places.map((n) => `${n.name || 'place'} ${Math.round(sim.share(n.id) * 100)}%`).join(', ');
    out.push(text('verdict', 40, 12, `After ${sim.steps} steps: ${words}`, { size: 34, color: color.blue.stroke, ...quiet }));
    const long = places.map((n) => `${n.name || 'place'} ${Math.round((sim.longRun.get(n.id) ?? 0) * 100)}%`).join(', ');
    out.push(text('long-run', 40, 66, `In the long run: ${long}`, { size: 28, color: color.muted, ...quiet }));
    out.push(text('walkers', 40, 104, `${sim.total} walkers take a step every ${round(sim.every)}s. Unlabelled arrows split what is left of 100%.`, { size: 24, color: color.muted, ...quiet }));
  }

  function logicPanel(out) {
    const sim = m.sim;
    const lamps = [...m.graph.nodes.values()].filter((n) => n.kind === 'lamp');
    const words = lamps.length ? lamps.map((n) => `${labelName(n)} is ${sim.value(n.id) ? 'on' : 'off'}`).join(', ') : 'Add a lamp to see the result.';
    out.push(text('verdict', 40, 12, words, { size: 34, color: lamps.some((n) => sim.value(n.id)) ? color.amber.stroke : color.gray.stroke, ...quiet }));
    timingRows().forEach((n, i) => out.push(text(`row-${n.id}`, 132, timingY(i) + 15, labelName(n), { size: 22, align: 'right', valign: 'middle', color: color.muted, ...quiet })));
  }

  const labelName = (n) => (n.name && n.name !== n.kind ? n.name : n.kind);
  const timingRows = () => [...m.graph.nodes.values()].filter((n) => ['switch', 'button', 'clock', 'lamp'].includes(n.kind)).slice(0, 5);
  const timingY = (i) => 62 + i * 34;

  panel.layer('under', (ctx) => {
    const sim = m.sim;
    if (sim?.mode === 'flow') {
      const points = sim.history.filter((p) => p.t > sim.time - 60);
      if (points.length < 2) return;
      ctx.strokeStyle = color.rose.stroke;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      points.forEach((p, i) => {
        const x = CHART.x + ((p.t - (sim.time - 60)) / 60) * CHART.w;
        const y = CHART.y + CHART.h - (p.waiting / chartMax) * CHART.h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    // What the token colors mean, once there is more than one on screen.
    if (sim?.mode === 'flow' && m.tokensSeen.size > 1) {
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.font = '22px Excalifont';
      let x = 1570;
      const y = panel.height - 24;
      for (const [words, tone] of [...m.tokensSeen].reverse()) {
        x -= ctx.measureText(words).width;
        ctx.fillStyle = color.muted;
        ctx.fillText(words, x, y);
        x -= 18;
        ctx.fillStyle = tone.fill;
        ctx.strokeStyle = tone.stroke;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y - 7, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        x -= 34;
      }
    }
    if (sim?.mode === 'logic') {
      // A timing diagram: inputs and lamps over the last 20 seconds.
      const left = 145, right = 1570, span = 20;
      const samples = sim.series();
      ctx.lineWidth = 3;
      ctx.lineJoin = 'miter';
      timingRows().forEach((n, i) => {
        const y = timingY(i);
        ctx.strokeStyle = n.kind === 'lamp' ? color.amber.stroke : color.green.stroke;
        ctx.beginPath();
        let last = null;
        for (const s of samples) {
          if (s.t < sim.time - span) continue;
          const x = right - ((sim.time - s.t) / span) * (right - left);
          const v = y + (s[n.id] ? 2 : 26);
          if (last === null) ctx.moveTo(x, v);
          else ctx.lineTo(x, last);
          ctx.lineTo(x, v);
          last = v;
        }
        ctx.stroke();
      });
    }
  });

  function refresh() {
    const out = [];
    const sim = m.sim;
    if (sim?.mode === 'flow') flowPanel(out);
    if (sim?.mode === 'states') statePanel(out);
    if (sim?.mode === 'chain') chainPanel(out);
    if (sim?.mode === 'logic') logicPanel(out);
    const bottom = panel.height - 40;
    const general = m.graph.issues.find((i) => !i.id);
    const problem = m.message ?? (general ? { words: general.message, tone: general.level === 'error' ? color.rose : color.amber } : null);
    if (problem) out.push(text('message', 40, bottom - (m.graph.mode === 'logic' ? 0 : 0), problem.words, { size: 26, color: problem.tone.stroke, ...quiet }));
    else out.push(text('hint', 40, bottom, m.nextStep(), { size: 24, color: color.muted, ...quiet }));
    panel.show(out, { stagger: 0, morphSeconds: 0.25 });
  }

  return { refresh };
}
