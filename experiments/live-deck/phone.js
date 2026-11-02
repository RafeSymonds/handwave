// The phone. A hand-drawn vote above and an ordinary text box below, because a
// phone's own keyboard is the only good way to type. A slide with an activity hands
// the whole page to that activity's controller, from views.js.

import { createStage, hits } from '/lib/stage.js';
import { box, color, rect, text } from '/lib/draw.js';
import { Link } from './link.js';
import { SLIDES, voteOpen } from './meta.js';
import { apply } from './room.js';
import { viewOf } from './views.js';
import { wrap } from './words.js';

const WIDTH = 440;

export async function startPhone({ role, room, info }) {
  const form = document.getElementById('ask');
  form.hidden = false;
  const canvas = document.getElementById('stage');
  const stage = await createStage(canvas, { width: WIDTH, height: 760 });

  let state = null;
  let you = { votes: {} };
  let drawn = false;
  let control = null;      // The running activity's controller, if this slide has one.
  let controlSlide = null;

  const fitHeight = () => {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    stage.height = Math.round((WIDTH * r.height) / r.width);
    stage.resize();
  };
  fitHeight();

  // An activity takes the whole phone, so the question box steps aside.
  function syncControl() {
    const slide = SLIDES[state.index];
    const next = viewOf(slide)?.startPhone ? slide : null;
    if (next === controlSlide) return;
    control?.stop();
    controlSlide = next;
    control = next ? viewOf(next).startPhone({ stage, canvas, link, width: WIDTH, slide: next, redraw: () => draw() }) : null;
    form.hidden = Boolean(control?.hideAsk);
    fitHeight();
  }

  function view() {
    syncControl();
    const slide = SLIDES[state.index];
    const out = [];
    if (control) {
      if (link.status !== 'live') out.push(text('offline', 24, 2, 'Reconnecting…', { size: 24, color: color.rose.stroke, customData: { handwave: { ghost: true, enter: 'fade' } } }));
      return [...control.elements(), ...out];
    }
    let y = 20;
    if (link.status !== 'live') {
      out.push(text('offline', 24, y, 'Reconnecting…', { size: 26, color: color.rose.stroke, customData: { handwave: { ghost: true, enter: 'fade' } } }));
    }
    y += 38;
    const heading = wrap(slide.title, WIDTH - 48, 34, 6);
    out.push(text(`heading-${slide.id}`, 24, y, heading, { size: 34, font: 6 }));
    y += heading.split('\n').length * 43 + 22;

    if (!slide.vote) {
      out.push(text(`idle-${slide.id}`, 24, y, wrap('No vote on this slide. You can raise a question below.', WIDTH - 48, 28), { size: 28, color: color.muted }));
      return out;
    }

    const open = voteOpen(slide, state.step);
    const mine = you.votes[slide.id];
    const voted = mine !== undefined && mine !== null;
    const counts = state.tallies[slide.id] ?? slide.vote.options.map(() => 0);
    const total = counts.reduce((a, b) => a + b, 0);
    const W = WIDTH - 48;
    const rows = slide.vote.options.length;
    const below = 56;
    const H = Math.min(112, (stage.height - y - below) / rows - 12);
    const showResults = voted || !open;

    slide.vote.options.forEach((option, i) => {
      const id = `opt-${slide.id}-${i}`;
      const top = y + i * (H + 12);
      const isMine = mine === i;
      const isAnswer = !open && slide.vote.answer === i;
      const tone = isAnswer ? color.green : isMine ? color.blue : { fill: '#ffffff', stroke: color.ink };
      // The share sits behind the outline. A zero has no bar at all.
      if (showResults && counts[i] > 0) {
        const fill = Math.max(H * 0.3, (counts[i] / total) * (W - 6));
        out.push(rect(`${id}-bar`, 27, top + 3, fill, H - 6, { strokeColor: 'transparent', backgroundColor: isAnswer ? color.green.fill : isMine ? color.blue.fill : color.gray.fill, customData: { handwave: { ghost: true, enter: 'fade' } } }));
      }
      out.push(rect(id, 24, top, W, H, { strokeColor: tone.stroke, backgroundColor: 'transparent', strokeWidth: isMine ? 3 : 2 }));
      if (showResults) out.push(text(`${id}-n`, 24 + W - 18, top + H / 2, String(counts[i]), { size: 30, align: 'right', valign: 'middle', color: tone.stroke, customData: { handwave: { ghost: true, enter: 'fade' } } }));
      const room = showResults ? W - 90 : W - 40;
      out.push(text(`${id}-t`, 42, top + H / 2, wrap(option, room, 30), { size: 30, valign: 'middle', color: tone.stroke, customData: { handwave: { ghost: true } } }));
    });

    const line = !open ? 'Voting is closed.' : voted ? 'Counted. Tap to change it.' : 'Tap your answer.';
    out.push(text(`vote-status-${slide.id}`, 24, y + rows * (H + 12) + 2, line, { size: 26, color: color.muted, customData: { handwave: { ghost: true, enter: 'fade' } } }));
    return out;
  }

  const draw = () => {
    if (!state) return;
    stage.show(view(), { instant: !drawn, stagger: 0.015 });
    drawn = true;
  };

  addEventListener('resize', () => { fitHeight(); draw(); });

  const link = new Link({
    room,
    role,
    onState(msg, unacknowledged) {
      state = msg.state;
      you = msg.you;
      // A vote still on its way stays shown until the server answers it.
      for (const op of unacknowledged) if (op.t === 'vote') you.votes[op.slide] = op.option;
      syncControl();
      if (msg.you.activity) control?.you?.(msg.you.activity);
      control?.connected?.();
      draw();
    },
    onOp(op) {
      if (!state) return;
      if (op.t === 'act-you') {
        syncControl();
        if (op.slide === controlSlide?.id) control?.you?.(op.you);
        return;
      }
      apply(state, op);
      draw();
    },
    onAck(op, ack) {
      control?.ack?.(op, ack);
      if (op.t === 'vote') {
        if (ack.vote?.option === null || ack.vote?.option === undefined) delete you.votes[op.slide];
        else if (ack.vote) you.votes[op.slide] = ack.vote.option;
        draw();
      } else if (op.t === 'ask') {
        const said = { ok: 'Sent to the presenter.', 'too soon': 'Wait a moment before sending another.', rejected: 'That could not be sent.' };
        statusLine.textContent = ack.duplicate ? said.ok : said[ack.result] ?? said.rejected;
        if (ack.result === 'too soon') input.value = op.text;
      }
    },
    onStatus() {
      draw();
      if (link.status === 'live' && statusLine.textContent === waitingWords) statusLine.textContent = 'Reconnected. Sending…';
    },
  });

  // A finger drifts a few pixels during a tap, which the stage reads as a drag.
  // So a tap here is a press and a release on the same option.
  stage.on('up', '*', ({ el, x, y }) => {
    if (control || !el || !state || !hits(el, x, y)) return;
    const match = /^opt-(.+)-(\d+)$/.exec(el.id);
    if (!match) return;
    const slide = SLIDES[state.index];
    if (slide.id !== match[1] || !voteOpen(slide, state.step)) return;
    const option = +match[2];
    if (you.votes[slide.id] === option) return;
    you.votes[slide.id] = option;
    link.send({ t: 'vote', slide: slide.id, option });
    draw();
  });

  const input = document.getElementById('ask-text');
  const statusLine = document.getElementById('ask-status');
  const waitingWords = 'Saved. It will send when the connection returns.';
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const words = input.value.trim();
    if (!words) return;
    link.send({ t: 'ask', text: words });
    input.value = '';
    input.blur();
    statusLine.textContent = link.status === 'live' ? 'Sending…' : waitingWords;
  });

  return { stage, link, info, role, get state() { return state; }, get you() { return you; }, get control() { return control; } };
}
