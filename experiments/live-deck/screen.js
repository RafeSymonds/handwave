// The presenter and the audience screen. They draw the same scene from the same
// state. Only the presenter has input and a panel.

import { QR_FILE, qrDataUrl } from './qr.js';
import { createStage } from '/lib/stage.js';
import { randomToken, Link } from './link.js';
import { scene, ownerOf } from './deck.js';
import { SLIDES } from './meta.js';
import { apply, stepFrom } from './room.js';

const SEND_EVERY_MS = 33;
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export async function startScreen({ role, room, info }) {
  const presenting = role === 'presenter';
  const panel = document.getElementById('panel');
  panel.hidden = !presenting;
  const canvas = document.getElementById('stage');
  const stage = await createStage(canvas, { width: 1600, height: 900 });
  if (info.qr) stage.files[QR_FILE] = { dataURL: qrDataUrl(info.qr) };

  let state = null;
  let drawn = false;

  const draw = (options = {}) => {
    if (!state) return;
    stage.show(scene(state, { info }), { instant: !drawn, ...options });
    drawn = true;
    if (presenting) showPanel();
  };

  const link = new Link({
    room,
    role,
    onState(msg, unacknowledged) {
      state = msg.state;
      for (const op of unacknowledged) apply(state, op);
      draw();
    },
    onOp(op) {
      if (!state) return;
      apply(state, op);
      // A drag should be followed closely, and a return home should be seen.
      draw(op.t === 'offset' ? { morphSeconds: 0.09 } : op.t === 'home' ? homeMotion : {});
    },
    onStatus: showStatus,
  });

  function showStatus(status) {
    const words = { connecting: 'Connecting…', live: 'Live', down: 'Connection lost. Reconnecting…', refused: 'The server refused this connection.' }[status];
    const pill = document.getElementById('pill');
    pill.hidden = presenting || status === 'live' || status === 'connecting';
    pill.textContent = words;
    if (presenting) {
      const el = document.getElementById('p-status');
      if (status === 'live' && !info.reachable) {
        el.dataset.status = 'down';
        el.textContent = 'Phones cannot reach this server. Restart it with HOST=0.0.0.0 npm start';
        return;
      }
      el.dataset.status = status;
      el.textContent = status === 'live' && state ? `Live: ${count(state.counts.phones, 'phone')}, ${count(state.counts.screens, 'screen')}` : status === 'down' ? 'Connection lost. Keep going: your changes will send when it returns.' : words;
    }
  }

  // ------------------------------------------------------------------ the panel

  let listed = '';

  function showPanel() {
    const slide = SLIDES[state.index];
    showStatus(link.status);
    document.getElementById('p-position').textContent = `Slide ${state.index + 1} of ${SLIDES.length}, step ${state.step + 1} of ${slide.steps}`;
    document.getElementById('p-notes').textContent = slide.notes[state.step] ?? '';
    const moved = Object.keys(state.offsets[slide.id] ?? {}).length;
    const strokes = state.ink[slide.id]?.length ?? 0;
    const offScript = document.getElementById('p-offscript');
    offScript.hidden = !moved && !strokes;
    offScript.textContent = `Off script: ${moved} moved, ${strokes} drawn. Esc returns.`;
    const summary = JSON.stringify([state.questions, state.shown?.id]);
    if (summary !== listed) {
      listed = summary;
      showQuestions();
    }
  }

  // Questions come from strangers, so they only ever reach the page as text.
  function showQuestions() {
    const list = document.getElementById('p-questions');
    document.getElementById('p-empty').hidden = state.questions.length > 0;
    list.replaceChildren(...state.questions.map((q) => {
      const item = document.createElement('li');
      const shown = state.shown?.id === q.id;
      item.classList.toggle('shown', shown);
      const words = document.createElement('div');
      words.textContent = q.text;
      const actions = document.createElement('div');
      actions.className = 'actions';
      const button = (label, name, act) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.dataset.action = name;
        b.addEventListener('click', () => { act(); b.blur(); });
        actions.append(b);
      };
      if (shown) button('Hide', 'hide', () => commit({ t: 'q-hide' }));
      else button('Show', 'show', () => commit({ t: 'q-show', id: q.id, q: { id: q.id, text: q.text } }));
      button('Remove', 'remove', () => commit({ t: 'q-drop', id: q.id }));
      item.append(words, actions);
      return item;
    }));
  }

  document.getElementById('p-audience').href = `?role=audience&room=${encodeURIComponent(room)}`;

  // ------------------------------------------------------------------ input

  const homeMotion = { morphSeconds: 0.55, exit: 0.3 };

  // A change the presenter makes applies here at once, then goes to the room.
  function commit(op, options) {
    apply(state, op);
    link.send(op);
    draw(options);
  }

  if (presenting) {
    const go = (delta) => {
      if (!state) return;
      flushDrag();
      const to = stepFrom(state.index, state.step, delta);
      if (to.index !== state.index || to.step !== state.step) commit({ t: 'goto', ...to });
    };
    const home = () => {
      if (!state) return;
      flushDrag();
      commit({ t: 'home', slide: SLIDES[state.index].id }, homeMotion);
    };
    addEventListener('keydown', (e) => {
      if (e.target.closest?.('button, a') && (e.key === ' ' || e.key === 'Enter')) return;
      if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); go(1); }
      else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); go(-1); }
      else if (e.key === 'Escape') { e.preventDefault(); home(); }
    });

    // What the pointer is doing: moving a thing, or drawing.
    let gesture = null;
    let unsent = null;
    let sendTimer = null;

    function flushDrag() {
      clearTimeout(sendTimer);
      sendTimer = null;
      if (!unsent) return;
      const op = unsent();
      unsent = null;
      if (op) link.send(op);
    }

    const sendSoon = (prepare) => {
      unsent = prepare;
      if (!sendTimer) sendTimer = setTimeout(flushDrag, SEND_EVERY_MS);
    };

    stage.on('down', '*', ({ el, event }) => {
      if (!state) return;
      const slide = SLIDES[state.index].id;
      if (el && !event.shiftKey) {
        const owner = ownerOf(el);
        gesture = { kind: 'move', slide, owner, from: state.offsets[slide]?.[owner] ?? [0, 0] };
      } else gesture = { kind: 'ink', slide, stroke: null, buffer: [] };
    });

    stage.on('drag', '*', ({ x, y, start }) => {
      if (!gesture) return;
      if (gesture.kind === 'move') {
        const op = { t: 'offset', slide: gesture.slide, id: gesture.owner, dx: gesture.from[0] + x - start.x, dy: gesture.from[1] + y - start.y };
        apply(state, op);
        sendSoon(() => op);
        draw({ morphSeconds: 0.001 });
        return;
      }
      const point = [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
      if (!gesture.stroke) {
        flushDrag();
        gesture.stroke = `${randomToken()}`;
        commit({ t: 'ink-start', slide: gesture.slide, id: gesture.stroke, pts: [[start.x, start.y], point] });
        return;
      }
      apply(state, { t: 'ink-add', slide: gesture.slide, id: gesture.stroke, pts: [point] });
      gesture.buffer.push(point);
      const current = gesture;
      sendSoon(() => {
        const pts = current.buffer;
        current.buffer = [];
        return pts.length ? { t: 'ink-add', slide: current.slide, id: current.stroke, pts } : null;
      });
      draw();
    });

    stage.on('up', '*', () => {
      flushDrag();
      gesture = null;
      if (state) draw();
    });

    stage.on('move', '*', ({ x, y }) => {
      canvas.style.cursor = gesture?.kind === 'move' ? 'grabbing' : gesture ? 'crosshair' : stage.hit(x, y) ? 'grab' : 'crosshair';
    });
  }

  return { stage, link, info, role, get state() { return state; } };
}
