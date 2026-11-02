// O9. A narrated lesson that stops and asks. You answer by clicking the drawing,
// and a wrong choice gets its own voiced explanation before the lesson asks again.
//
// lesson.md is the source and voice.py compiles it to lesson.json with its audio.
// Everything on screen comes from `view()`, which reads the player's state, and
// stage.show moves the picture to match. Each beat holds until its audio ends.

import { createStage, measure } from '/lib/stage.js';
import { rect, diamond, text, box, color, parseScene } from '/lib/draw.js';

const params = new URLSearchParams(location.search);
const RATE = Number(params.get('rate') ?? 1);   // tests run the voice faster
const GAP = 0.35 / RATE;                        // seconds of quiet between beats
const LEFT = 120, WIDTH = 1360;
const DIAGRAM = { dx: 120, dy: 70 };            // where a diagram's own (0, 0) sits on the page
const CAPTION_Y = 682, CAPTION_SIZE = 30, CONTROLS_Y = 826;
const PACE = 1.5;                               // entrances run slower than in a drag: a voice sets the pace

const stage = await createStage(document.getElementById('stage'), { width: 1600, height: 900 });
const lesson = await (await fetch('./lesson.json')).json();

// ------------------------------------------------------------------ scenes

const merged = (el, handwave) => ({ ...el, customData: { ...el.customData, handwave: { ...el.customData?.handwave, ...handwave } } });

// excalive's hand-written arrows carry only points, and the renderer reads size
// to decide how rough a line is. Proposed for parseScene in lib/draw.js.
function withSize(e) {
  if (!e.points?.length || e.width) return e;
  const xs = e.points.map((p) => p[0]), ys = e.points.map((p) => p[1]);
  return { ...e, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

// Only rings and buttons take input, so every drawn element lets it through. Ids
// carry the scene name, so a new scene fades the old one out instead of morphing.
const scenes = {};
for (const [name, file] of Object.entries(lesson.scenes)) {
  const { elements } = parseScene(await (await fetch(`./${file}`)).json());
  const isCard = elements.find((e) => e.id === 'frame').width >= stage.width;
  const placed = elements.map((e) => merged({ ...withSize(e), id: `${name}/${e.id}`, x: e.x + (isCard ? 0 : DIAGRAM.dx), y: e.y + (isCard ? 0 : DIAGRAM.dy) }, { ghost: true }));
  scenes[name] = new Map(placed.map((e, i) => [elements[i].id, e]));
}

// Numbered from the top of the drawing down. lesson.md lists the right answer
// first, and numbering in that order would give it away.
for (const beat of lesson.beats) {
  if (!beat.question) continue;
  const scene = scenes[beat.scene];
  beat.question.choices.sort((a, b) => scene.get(a.id).y - scene.get(b.id).y);
}

/** Greedy line breaks. Proposed for lib/draw.js. */
function wrap(words, size, font, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of words.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next, size, font).width > maxWidth) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

// ------------------------------------------------------------------ the player

const player = {
  mode: 'start',          // start, play, done
  index: -1,              // which main beat
  beat: null,             // the beat being said
  picture: { scene: 'title-card', ids: lesson.beats[0].ids },
  before: null,           // the picture before this beat, for replay
  question: null,
  queue: [],              // answer beats still to say
  waiting: false,         // a question has been said and waits for a click
  answers: {},            // question id -> {tried, answered, chosen, firstTry}
  sentence: -1,
  hover: null,
  paused: false,
  held: false,            // the gap ended while paused
  token: 0,
  fallback: null,         // set when a clip will not play: hold for its length anyway
  problem: null,
  log: [],
};

const note = (type, id) => player.log.push({ type, id, at: performance.now() });
const answersFor = (q) => (player.answers[q.id] ??= { tried: new Set(), answered: false, chosen: null, firstTry: null });

const audio = new Audio();
audio.preload = 'auto';

// Clips load ahead of time, so a beat's voice starts with its picture and the
// browser knows each clip's length. A clip not ready yet streams from its URL.
const ready = new Map();
function loadClips() {
  const urls = [];
  for (const beat of lesson.beats) {
    urls.push(beat.audio);
    if (beat.question) {
      urls.push(beat.question.again.audio);
      for (const choice of beat.question.choices) urls.push(...choice.beats.map((b) => b.audio));
    }
  }
  urls.forEach(async (url) => {
    try {
      const response = await fetch(url);
      if (response.ok) ready.set(url, URL.createObjectURL(await response.blob()));
    } catch { /* it will stream, or hold without sound */ }
  });
}

// The browser or the system can pause the voice too: a media key, or another app
// taking the sound. That has to show as paused, or the lesson looks hung, so our
// own pauses are counted to tell them apart.
let ownPauses = 0;
function pauseAudio() {
  if (audio.paused) return;
  ownPauses++;
  audio.pause();
}

audio.addEventListener('pause', () => {
  if (ownPauses > 0) { ownPauses--; return; }
  // A clip reaching its end also fires pause, just before ended.
  if (audio.ended || player.mode !== 'play' || player.waiting || player.paused) return;
  note('paused-from-outside', player.beat?.id);
  setPaused(true);
});
audio.addEventListener('play', () => { if (player.paused) setPaused(false); });

function stopAudio() {
  player.token++;
  player.fallback = null;
  pauseAudio();
}

function playClip(beat) {
  const token = ++player.token;
  player.fallback = null;
  // Changing the source drops any pause event still queued.
  ownPauses = 0;
  audio.defaultPlaybackRate = RATE;
  audio.src = ready.get(beat.audio) ?? beat.audio;
  audio.playbackRate = RATE;
  audio.play().catch((err) => {
    if (token !== player.token || err.name === 'AbortError') return;
    holdWithoutSound(beat, err.message);
  });
}

function holdWithoutSound(beat, why) {
  console.warn(`lesson: ${beat.audio} did not play (${why}), holding for its length`);
  player.problem = 'The sound did not play. Captions continue.';
  player.fallback = { t0: stage.time, duration: beat.duration / RATE };
  paint();
}

audio.addEventListener('error', () => { if (player.beat && !player.fallback && audio.src) holdWithoutSound(player.beat, 'load error'); });
audio.addEventListener('ended', () => clipEnded());

function clipEnded() {
  const token = player.token;
  note('ended', player.beat.id);
  setTimeout(() => {
    if (token !== player.token) return;
    if (player.paused) player.held = true; else nextAfterBeat();
  }, GAP * 1000);
}

/** Say a beat: move the picture to it and start its clip. */
function startBeat(beat) {
  player.before = player.picture;
  player.beat = beat;
  player.mode = 'play';
  player.waiting = false;
  player.sentence = -1;
  player.picture = { scene: beat.scene, ids: beat.ids };
  note('beat', beat.id);
  playClip(beat);
  paint();
}

function startMain(index) {
  player.index = index;
  player.queue = [];
  const beat = lesson.beats[index];
  if (!beat) {
    player.mode = 'done';
    player.beat = null;
    player.question = null;
    player.sentence = -1;
    note('done');
    paint();
    return;
  }
  player.question = beat.question ?? null;
  startBeat(beat);
}

/** Decide what follows a finished beat. */
function nextAfterBeat() {
  if (player.queue.length) { startBeat(player.queue.shift()); return; }
  const q = player.question;
  if (q && !answersFor(q).answered) {
    if (player.beat.kind === 'wrong') { startBeat(q.again); return; }
    player.token++;
    player.waiting = true;
    player.sentence = -1;
    note('waiting', q.id);
    paint();
    return;
  }
  startMain(player.index + 1);
}

function answer(id, { skipped = false } = {}) {
  const q = player.question;
  if (!q) return;
  const state = answersFor(q);
  const choice = q.choices.find((c) => c.id === id);
  if (state.answered || !choice || state.tried.has(id)) return;
  note(choice.right ? 'right' : 'wrong', `${q.id}/${id}`);
  state.firstTry ??= choice.right && !skipped;
  if (choice.right) { state.answered = true; state.chosen = id; } else state.tried.add(id);
  player.hover = null;
  player.queue = choice.beats.slice();
  takeOver();
  startBeat(player.queue.shift());
}

function skip() {
  if (player.mode === 'start') { begin(); return; }
  if (player.mode === 'done') return;
  note('skip', player.beat?.id);
  const q = player.question;
  // A question that is waiting gives up its answer.
  if (q && !answersFor(q).answered && player.waiting) {
    answer(q.choices.find((c) => c.right).id, { skipped: true });
    return;
  }
  takeOver();
  nextAfterBeat();
}

function replay() {
  if (player.mode === 'start') return;
  // A waiting question replays the last thing said. At the end, the last card.
  const beat = player.beat ?? lesson.beats.at(-1);
  if (player.mode === 'done') player.index = lesson.beats.length - 1;
  note('replay', beat.id);
  takeOver();
  player.picture = player.before ?? player.picture;
  paint({ instant: true });
  startBeat(beat);
}

// Input replaces whatever is playing, even while paused or between beats.
function takeOver() {
  player.held = false;
  setPaused(false);
  stopAudio();
}

function setPaused(paused) {
  if (paused === player.paused) return;
  player.paused = paused;
  note(paused ? 'pause' : 'resume', player.beat?.id);
  if (paused) {
    pauseAudio();
    stage.pause();
    paint();
    stage.render();
    return;
  }
  stage.play();
  if (player.held) { player.held = false; nextAfterBeat(); return; }
  if (player.beat && !player.waiting && !player.fallback && !audio.ended) audio.play().catch(() => {});
  paint();
}

const togglePause = () => {
  // Nothing plays while a question waits or before the lesson starts.
  if (player.mode !== 'play' || player.waiting) return;
  setPaused(!player.paused);
};

function begin() {
  note('start');
  startMain(0);
}

// How far through the clip the voice is.
function clipTime() {
  if (player.fallback) return (stage.time - player.fallback.t0) * RATE;
  return audio.currentTime;
}

stage.onFrame(() => {
  if (player.fallback && stage.time - player.fallback.t0 >= player.fallback.duration) {
    player.fallback = null;
    clipEnded();
  }
  if (player.mode !== 'play' || player.waiting || !player.beat) return;
  const t = clipTime();
  let current = -1;
  player.beat.sentences.forEach((s, i) => { if (s.start <= t + 0.03) current = i; });
  if (current !== player.sentence) { player.sentence = current; paint(); }
});

// ------------------------------------------------------------------ the view

const ui = (el, extra = {}) => merged(el, { enter: 'none', exit: 'none', change: 'none', ghost: true, ...extra });
const live = { ghost: false, cursor: 'pointer' };
const asking = () => player.question && !answersFor(player.question).answered;

function sceneElements() {
  const scene = scenes[player.picture.scene];
  const tried = player.question ? answersFor(player.question).tried : new Set();
  const dimmed = (id) => tried.has(id) || tried.has(id.replace(/-t$/, ''));
  return player.picture.ids.map((id) => {
    const el = scene.get(id);
    return dimmed(id) ? { ...el, opacity: 45 } : el;
  });
}

function rings() {
  const q = player.question;
  if (!q) return [];
  const scene = scenes[q.again.scene];
  const state = answersFor(q);
  const out = [];
  q.choices.forEach((choice, i) => {
    const target = scene.get(choice.id);
    const pad = 10;
    const ring = (o) => rect(`ring/${choice.id}`, target.x - pad, target.y - pad, target.width + pad * 2, target.height + pad * 2, { backgroundColor: 'transparent', ...o });
    if (state.answered) {
      if (choice.id === state.chosen) out.push(merged(ring({ strokeColor: color.green.stroke, strokeWidth: 4 }), { ghost: true }));
    } else if (state.tried.has(choice.id)) {
      out.push(merged(ring({ strokeColor: color.rose.stroke, strokeWidth: 2 }), { ghost: true }));
    } else {
      const over = player.hover === `ring/${choice.id}`;
      out.push(merged(ring({ strokeColor: color.amber.stroke, strokeStyle: over ? 'solid' : 'dashed', strokeWidth: over ? 4 : 2.5 }), live));
      out.push(text(`ring/${choice.id}-n`, target.x - pad - 10, target.y + target.height / 2, String(i + 1), { size: 28, align: 'right', valign: 'middle', color: color.amber.stroke, customData: { handwave: { ghost: true, enter: 'fade' } } }));
    }
  });
  return out;
}

function title() {
  const q = player.question;
  const beat = player.beat;
  if (q && beat) return text('lesson-title', LEFT, 24, q.prompt, { size: 46, font: 6, color: color.blue.stroke, customData: { handwave: { ghost: true, enter: 'fade', exit: 'none' } } });
  if (beat?.title) return text('lesson-title', LEFT, 24, beat.title, { size: 46, font: 6, customData: { handwave: { ghost: true, enter: 'fade', exit: 'none' } } });
  return null;
}

function captionWords() {
  if (player.mode === 'start') return { words: '' };
  if (player.mode === 'done') {
    const results = Object.values(player.answers);
    const first = results.filter((r) => r.firstTry).length;
    return { words: `You answered ${first} of ${results.length} on the first try.`, tone: color.muted };
  }
  if (player.waiting) return { words: 'Click one of the dashed boxes, or press its number.', tone: color.muted };
  const sentence = player.beat?.sentences[player.sentence];
  return { words: sentence?.text ?? '' };
}

function caption() {
  const { words, tone } = captionWords();
  if (!words) return [];
  return [ui(text('caption', LEFT, CAPTION_Y, wrap(words, CAPTION_SIZE, 6, WIDTH), { size: CAPTION_SIZE, font: 6, color: tone ?? color.ink }))];
}

function buttons() {
  const out = [];
  let x = LEFT;
  const add = (id, label, width, enabled = true) => {
    const over = player.hover === id && enabled;
    const tone = over ? color.blue : id === 'btn-pause' && player.paused ? color.amber : color.gray;
    const [shape, words] = box(id, x, CONTROLS_Y, width, 46, label, { size: 22, tone, opacity: enabled ? 100 : 40 });
    out.push(merged(ui(shape), enabled ? live : {}), ui(words));
    x += width + 12;
  };
  const q = player.question;
  add('btn-replay', 'replay  (R)', 150);
  add('btn-pause', player.paused ? 'resume  (space)' : 'pause  (space)', 190, player.mode === 'play' && !player.waiting);
  add('btn-skip', q && player.waiting ? 'show answer  (→)' : 'skip  (→)', q && player.waiting ? 210 : 130, player.mode !== 'done');
  return out;
}

// One mark per beat of the main path: how far along, and how each question went.
function progress() {
  const out = [];
  const count = lesson.beats.length;
  const right = LEFT + WIDTH, span = 620, left = right - span, cell = span / count;
  lesson.beats.forEach((beat, i) => {
    const x = left + i * cell;
    const passed = i < player.index || player.mode === 'done';
    const here = i === player.index && player.mode !== 'done';
    if (beat.question) {
      const state = player.answers[beat.question.id];
      const done = state && (state.answered || state.tried.size);
      const tone = !done ? (here ? color.amber : { fill: '#ffffff', stroke: color.amber.stroke }) : state.firstTry ? color.green : color.rose;
      out.push(ui(diamond(`mark-${i}`, x + cell / 2 - 12, CONTROLS_Y + 11, 24, 24, { tone })));
    } else {
      const tone = here ? color.blue : passed ? { fill: '#adb5bd', stroke: '#868e96' } : { fill: '#ffffff', stroke: '#ced4da' };
      out.push(ui(rect(`mark-${i}`, x + 3, CONTROLS_Y + 18, cell - 6, 10, { tone, roughness: 0.6, roundness: null, strokeWidth: 1 })));
    }
  });
  return out;
}

function startButton() {
  const [shape, words] = box('start', 124, 650, 220, 84, 'Start', { size: 44, tone: player.hover === 'start' ? color.blue : color.amber });
  return [
    merged(ui(shape, { exit: undefined }), live),
    ui(words, { exit: undefined }),
    ui(text('sound', 370, 692, 'with the sound on', { size: 30, valign: 'middle', color: color.muted }), { exit: undefined }),
  ];
}

function view() {
  const out = [...sceneElements()];
  const heading = title();
  if (heading) out.push(heading);
  out.push(...rings(), ...caption());
  if (player.mode === 'start') out.push(...startButton());
  else out.push(...buttons(), ...progress());
  if (player.problem) out.push(ui(text('problem', LEFT + WIDTH, 40, player.problem, { size: 22, font: 6, align: 'right', color: color.rose.stroke })));
  return out;
}

function paint({ instant = false } = {}) {
  const next = view();
  // A few new things come one at a time: an arrow, then its label. Many come together.
  const fresh = next.filter((el) => !stage.get(el.id) && el.customData?.handwave?.enter !== 'none').length;
  const oneAtATime = fresh <= 4 && player.mode !== 'start';
  stage.show(next, { instant, speed: PACE, stagger: oneAtATime ? 0.28 : 0.05 });
}

// ------------------------------------------------------------------ input

stage.on('click', '*', ({ id }) => {
  if (!id) return;
  if (id === 'start') begin();
  else if (id === 'btn-replay') replay();
  else if (id === 'btn-pause') togglePause();
  else if (id === 'btn-skip') skip();
  else if (id.startsWith('ring/')) answer(id.slice(5));
});
stage.on('enter', '*', ({ id }) => { player.hover = id; paint(); });
stage.on('leave', '*', () => { player.hover = null; paint(); });

addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.key === ' ') { e.preventDefault(); if (player.mode === 'start') begin(); else togglePause(); }
  else if (e.key === 'Enter' && player.mode === 'start') begin();
  else if (e.key === 'r' || e.key === 'R') replay();
  else if (e.key === 'ArrowRight') skip();
  else if (/^[1-9]$/.test(e.key) && asking()) {
    const open = player.question.choices[Number(e.key) - 1];
    if (open) answer(open.id);
  }
});

loadClips();
paint();
window.app = { stage, player, lesson, audio, scenes, wrap, ready };
