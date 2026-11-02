// The presenter and the audience screen. They draw the same scene from the same
// state. Only the presenter has input and a panel.

import { QR_FILE, qrDataUrl } from './qr.js';
import { createStage } from '/lib/stage.js';
import { randomToken, Link } from './link.js';
import { scene, ownerOf } from './deck.js';
import { SLIDES, branchTarget, slideById } from './meta.js';
import { apply, stepFrom } from './room.js';
import { viewOf } from './views.js';

const SEND_EVERY_MS = 33;
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// The panel redraws with every frame of an activity, so text is only touched when it changes.
const setText = (el, words) => { if (el.textContent !== words) el.textContent = words; };

export async function startScreen({ role, room, info }) {
  const presenting = role === 'presenter';
  const panel = document.getElementById('panel');
  panel.hidden = !presenting;
  const canvas = document.getElementById('stage');
  const stage = await createStage(canvas, { width: 1600, height: 900 });
  if (info.qr) stage.files[QR_FILE] = { dataURL: qrDataUrl(info.qr) };

  let state = null;
  let drawn = false;
  let running = null;       // The activity view drawing on this stage right now.
  let runningSlide = null;
  let sceneKey = '';

  // The current slide decides which activity view runs, as it does on the server.
  function syncActivity() {
    const slide = SLIDES[state.index];
    const view = viewOf(slide);
    const next = view?.startScreen ? slide : null;
    if (next === runningSlide) return;
    running?.stop();
    runningSlide = next;
    running = next ? view.startScreen(stage) : null;
    if (running && state.live[slide.id]) running.frame(state.live[slide.id]);
  }

  const draw = (options = {}) => {
    if (!state) return;
    syncActivity();
    const view = viewOf(SLIDES[state.index]);
    stage.show(scene(state, { info }), { instant: !drawn, ...(view?.stagger !== undefined ? { stagger: view.stagger } : {}), ...options });
    drawn = true;
    if (presenting) showPanel();
  };

  // Frames arrive many times a second. Only some of them change what the slide says.
  function onFrame(op) {
    if (op.slide !== SLIDES[state.index].id) return;
    running?.frame(op.frame);
    const view = viewOf(SLIDES[state.index]);
    if (view?.drawEveryFrame) { draw({ morphSeconds: view.morphSeconds }); return; }
    const key = view?.sceneKey?.(op.frame) ?? JSON.stringify(op.frame);
    if (key !== sceneKey) { sceneKey = key; draw(); }
  }

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
      if (op.t === 'act-frame') { onFrame(op); return; }
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
        setText(el, 'Phones cannot reach this server. Restart it with HOST=0.0.0.0 npm start');
        return;
      }
      el.dataset.status = status;
      setText(el, status === 'live' && state ? `Live: ${count(state.counts.phones, 'phone')}, ${count(state.counts.screens, 'screen')}` : status === 'down' ? 'Connection lost. Keep going: your changes will send when it returns.' : words);
    }
  }

  // ------------------------------------------------------------------ the panel

  let listed = '';

  function showPanel() {
    const slide = SLIDES[state.index];
    showStatus(link.status);
    setText(document.getElementById('p-position'), `Slide ${state.index + 1} of ${SLIDES.length}, step ${state.step + 1} of ${slide.steps}`);
    setText(document.getElementById('p-notes'), slide.notes[state.step] ?? '');
    // A presenter should never have to guess where a branching talk goes.
    const nextEl = document.getElementById('p-next');
    nextEl.hidden = !slide.branch || state.step < slide.steps - 1;
    if (slide.branch) setText(nextEl, `Next goes to: ${slideById(branchTarget(slide, state.tallies[slide.id])).title}`);
    document.getElementById('p-pointer').hidden = slide.pointer !== 'ink';
    const moved = Object.keys(state.offsets[slide.id] ?? {}).length;
    const strokes = state.ink[slide.id]?.length ?? 0;
    const offScript = document.getElementById('p-offscript');
    offScript.hidden = !moved && !strokes;
    setText(offScript, `Off script: ${moved} moved, ${strokes} drawn. Esc returns.`);
    const summary = JSON.stringify([state.questions, state.shown?.id]);
    if (summary !== listed) {
      listed = summary;
      showQuestions();
    }
    showActivityPanel(slide);
  }

  // What the current activity asks of the presenter, such as drawings to review.
  let panelShown = null;
  function showActivityPanel(slide) {
    const view = viewOf(slide);
    const root = document.getElementById('p-activity');
    root.hidden = !view?.panel;
    if (!view?.panel) { panelShown = null; return; }
    const key = `${slide.id}:${view.panelKey(state, slide)}`;
    if (key === panelShown) return;
    panelShown = key;
    view.panel(root, { slide, state, commit: reviewCommit });
  }

  // What is decided leaves the list at once, so the next key press acts on the next drawing.
  // What reaches the room still only happens when the server says so.
  const reviewCommit = (op) => {
    const slide = SLIDES[state.index].id;
    link.send({ ...op, slide });
    if (op.t === 'gal-ok' || op.t === 'gal-no') {
      apply(state, { t: 'gal-out', slide, id: op.id });
      showPanel();
    }
  };

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
  document.getElementById('p-replay').href = `?role=replay&room=${encodeURIComponent(room)}`;

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
      const to = stepFrom(state, delta);
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
      else if (state) {
        const slide = SLIDES[state.index];
        if (viewOf(slide)?.key?.(e, { slide, state, commit: reviewCommit })) e.preventDefault();
      }
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
      // A slide that is drawn on by default moves things with Shift instead.
      const inkFirst = SLIDES[state.index].pointer === 'ink';
      if (el && (inkFirst ? event.shiftKey : !event.shiftKey)) {
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

    stage.on('move', '*', ({ x, y, event }) => {
      const inkFirst = state && SLIDES[state.index].pointer === 'ink';
      const grabs = stage.hit(x, y) && (inkFirst ? event.shiftKey : true);
      canvas.style.cursor = gesture?.kind === 'move' ? 'grabbing' : gesture ? 'crosshair' : grabs ? 'grab' : 'crosshair';
    });
  }

  return { stage, link, info, role, get state() { return state; }, get running() { return running; } };
}
