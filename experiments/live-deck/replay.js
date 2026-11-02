// The replay page: the same slides drawn from the log, with a timeline to scrub.

import { createStage } from '/lib/stage.js';
import { scene } from './deck.js';
import { SLIDES } from './meta.js';
import { ReplayPlayer } from './replay-player.js';
import { viewOf } from './views.js';

const clock = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export async function startReplay({ role, room, info }) {
  const canvas = document.getElementById('stage');
  const scrub = document.getElementById('scrub');
  scrub.hidden = false;
  const stage = await createStage(canvas, { width: 1600, height: 900 });
  stage.resize();

  const time = document.getElementById('r-time');
  const label = document.getElementById('r-label');
  const play = document.getElementById('r-play');
  const save = document.getElementById('r-save');
  save.href = `/live-deck/replay?room=${encodeURIComponent(room)}&save=1`;

  let player = null;
  let at = 0;
  let playing = false;
  let running = null, runningSlide = null;
  let sceneInfo = { ...info, qr: null, reachable: true };

  function syncActivity() {
    const slide = SLIDES[player.state.index];
    const view = viewOf(slide);
    const next = view?.startScreen ? slide : null;
    if (next === runningSlide) return;
    running?.stop();
    runningSlide = next;
    running = next ? view.startScreen(stage, { driven: true }) : null;
  }

  function moveFigures(dt) {
    if (!running) return;
    const around = player.framesAround(at, runningSlide.id);
    if (!around) { running.clear(); return; }
    const { a, b } = around;
    const [aMs, aOp] = a;
    if (!b) {
      running.show([aOp.frame]);
      running.position(aOp.frame.at, dt);
      return;
    }
    const [bMs, bOp] = b;
    running.show([aOp.frame, bOp.frame]);
    const t = bMs > aMs ? Math.min(1, (at - aMs) / (bMs - aMs)) : 1;
    running.position(aOp.frame.at + (bOp.frame.at - aOp.frame.at) * t, dt);
  }

  function showAt(ms, { jump = false, dt = 1 / 60 } = {}) {
    at = Math.max(0, Math.min(player.duration, ms));
    const changed = player.seek(at);
    if (changed || jump) {
      syncActivity();
      if (jump) running?.clear();
      const view = viewOf(SLIDES[player.state.index]);
      stage.show(scene(player.state, { info: sceneInfo }), { instant: jump, ...(view?.stagger !== undefined ? { stagger: view.stagger } : {}), ...(view?.morphSeconds ? { morphSeconds: view.morphSeconds } : {}) });
    }
    moveFigures(dt);
    time.value = String(Math.round((at / (player.duration || 1)) * 1000));
    const slide = SLIDES[player.state.index];
    label.textContent = `${clock(at)} of ${clock(player.duration)}${player.cut ? ' with long pauses cut' : ''}. Slide ${player.state.index + 1}: ${slide.title}`;
  }

  function setPlaying(on) {
    playing = on;
    play.textContent = on ? 'Pause' : 'Play';
  }

  stage.onFrame((dt) => {
    if (!player || !playing) return;
    if (at >= player.duration) { setPlaying(false); return; }
    showAt(at + dt * 1000, { dt });
  });

  play.addEventListener('click', () => {
    if (!player) return;
    if (at >= player.duration) showAt(0, { jump: true });
    setPlaying(!playing);
    play.blur();
  });
  time.addEventListener('input', () => {
    if (!player) return;
    setPlaying(false);
    showAt((Number(time.value) / 1000) * player.duration, { jump: true });
  });
  addEventListener('keydown', (e) => {
    if (e.key === ' ' && e.target !== play) { e.preventDefault(); play.click(); }
  });

  function load(doc) {
    player = new ReplayPlayer(doc);
    // The slides show the address the talk had, not this page's.
    sceneInfo = { ...info, ...doc.info, qr: null, reachable: true };
    setPlaying(false);
    const marks = document.getElementById('r-marks');
    // Slides passed through quickly would print on top of each other, so those go unlabeled.
    let lastShare = -1;
    const roomy = player.marks().filter(({ at: when }) => {
      const share = when / (player.duration || 1);
      if (share - lastShare < 0.02) return false;
      lastShare = share;
      return true;
    });
    marks.replaceChildren(...roomy.map(({ at: when, index }) => {
      const mark = document.createElement('span');
      mark.textContent = String(index + 1);
      mark.title = SLIDES[index].title;
      mark.className = SLIDES[index].activity ? 'live' : '';
      mark.style.left = `${(when / (player.duration || 1)) * 100}%`;
      return mark;
    }));
    showAt(0, { jump: true });
  }

  document.getElementById('r-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try { load(JSON.parse(await file.text())); } catch (err) { label.textContent = err.message; }
  });

  try {
    const res = await fetch(`/live-deck/replay?room=${encodeURIComponent(room)}`);
    if (res.status === 403) throw new Error('Only the machine running the talk can open it here. Open a saved one.');
    if (!res.ok) throw new Error('No talk has run in this room since the server started. Open a saved one.');
    load(await res.json());
  } catch (err) {
    label.textContent = err.message;
    save.hidden = true;
  }

  return { stage, role, info, get player() { return player; }, get state() { return player?.state; }, get at() { return at; }, seek: (ms) => { setPlaying(false); showAt(ms, { jump: true }); }, play: () => setPlaying(true), load, get running() { return running; } };
}
