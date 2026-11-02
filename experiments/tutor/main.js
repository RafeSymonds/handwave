// O11. Ask a question and an agent draws and explains the answer. Ops arrive while
// the model is still writing, and a sentence with the drawing that follows it forms
// one beat: a beat waits for the sentence before it to finish, so the picture
// stays with the voice however far ahead the model has written.
//
// URL parameters, mostly for tests: ?model=replay:<name>, ?speed=4 for replay timing,
// ?mute=1 for captions on a clock with no audio, ?volume=0 for real speech at no
// volume, ?pace=0.1 to scale the clock and draw pacing.

import { createStage } from '/lib/stage.js';
import { rect, text, color } from '/lib/draw.js';
import { BoardView, STAGE, audit } from './board.js';

const params = new URLSearchParams(location.search);
const PACE = Number(params.get('pace') ?? 1);
const MUTE = params.get('mute') === '1';
const VOLUME = params.has('volume') ? Number(params.get('volume')) : 1;
const DRAW_GAP_MS = 230;

const $ = (id) => document.getElementById(id);
const stage = await createStage($('stage'), STAGE);
const board = new BoardView();
const session = crypto.randomUUID();

const modelSelect = $('model');
const fixedModel = params.get('model');
if (fixedModel) {
  if (![...modelSelect.options].some((o) => o.value === fixedModel)) modelSelect.add(new Option(fixedModel, fixedModel));
  modelSelect.value = fixedModel;
}

const SUGGESTIONS = ['How does a website get its address?', 'Why is the sky blue?', 'What does a hash table do?'];
const metrics = { history: [], current: null };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------- the scene

function introElements() {
  const out = [
    text('intro-title', 800, 180, 'Ask me anything, and I will draw it.', { size: 60, font: 6, align: 'center', customData: { handwave: { ghost: true } } }),
    text('intro-note', 800, 268, 'Type below, or try one of these:', { size: 30, align: 'center', color: color.muted, customData: { handwave: { ghost: true } } }),
  ];
  SUGGESTIONS.forEach((q, i) => {
    const y = 350 + i * 118;
    out.push(rect(`suggest-${i}`, 400, y, 800, 92, { tone: color.blue, customData: { handwave: { cursor: 'pointer' } } }));
    out.push(text(`suggest-${i}-t`, 800, y + 46, q, { size: 34, align: 'center', valign: 'middle', color: color.blue.stroke, customData: { handwave: { ghost: true } } }));
  });
  return out;
}

let started = false;
function repaint() {
  stage.show(started ? board.elements() : introElements(), { stagger: 0.02 });
}

function showPointing() {
  const names = board.selected.map((id) => board.describe(id).label || id);
  $('pointing').textContent = names.length ? `pointing at: ${names.join(', ')}` : '';
}

// ------------------------------------------------------------------- the voice

const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
let voice = null;
function pickVoice() {
  const voices = synth?.getVoices() ?? [];
  voice = voices.find((v) => v.lang.startsWith('en') && v.localService && /samantha|daniel|karen|natural|premium|enhanced/i.test(v.name))
    ?? voices.find((v) => v.lang.startsWith('en') && v.localService)
    ?? voices.find((v) => v.lang.startsWith('en')) ?? null;
}
pickVoice();
synth?.addEventListener?.('voiceschanged', pickVoice);

const estimateMs = (words) => (450 + words.split(/\s+/).length * 370) * PACE;

// Speak one sentence. Resolves when it ends. Chrome can stall without firing
// events, so a sentence on a clock takes over if the voice does not start.
function speak(words, onStart) {
  return new Promise((resolve) => {
    let startedSpeaking = false, done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(startGuard); clearTimeout(endGuard); resolve(); } };
    let startGuard, endGuard;
    const onClock = () => {
      if (!startedSpeaking) { startedSpeaking = true; onStart('clock'); }
      endGuard = setTimeout(finish, estimateMs(words));
    };
    if (MUTE || !synth) { onClock(); return; }
    const u = new SpeechSynthesisUtterance(words);
    if (voice) u.voice = voice;
    u.rate = 1.03;
    u.volume = VOLUME;
    u.onstart = () => {
      if (startedSpeaking) return;
      clearTimeout(startGuard);
      startedSpeaking = true;
      onStart('voice');
      // A hung voice must not hold the lesson forever.
      endGuard = setTimeout(finish, estimateMs(words) * 2.5 + 2000);
    };
    u.onend = finish;
    u.onerror = () => { if (startedSpeaking) finish(); else { clearTimeout(startGuard); onClock(); } };
    startGuard = setTimeout(() => { synth.cancel(); onClock(); }, 1500);
    synth.speak(u);
  });
}

// ------------------------------------------------------------------- the beats

let turn = 0;              // bumped by every new question or stop, which orphans older work
let queue = [];
let pumping = false;
let speaking = null;       // the promise of the sentence in progress
let streamOpen = false;
let controller = null;
let lastSaid = '';
let interruptedAfter = '';
let appliedSeq = 0;

function markFirst(name) {
  const m = metrics.current;
  if (m && m[name] === undefined) {
    m[name] = Math.round(performance.now() - m.t0);
    showMeter();
  }
}

function showMeter() {
  const m = metrics.current;
  if (!m) return;
  const bits = [];
  if (m.firstSpoken !== undefined) bits.push(`words ${(m.firstSpoken / 1000).toFixed(1)} s`);
  if (m.firstDrawn !== undefined) bits.push(`drawing ${(m.firstDrawn / 1000).toFixed(1)} s`);
  $('meter').textContent = bits.join(', ');
}

async function pump() {
  if (pumping) return;
  pumping = true;
  const mine = turn;
  while (queue.length && mine === turn) {
    const op = queue.shift();
    if (op.op === 'say') {
      if (speaking) await speaking;
      if (mine !== turn) break;
      lastSaid = op.text;
      speaking = speak(op.text, (how) => {
        if (mine !== turn) return;
        $('caption').textContent = op.text;
        if (metrics.current) metrics.current.speech = how;
        markFirst('firstSpoken');
      }).then(() => { if (mine === turn) speaking = null; });
      continue;
    }
    board.apply(op);
    appliedSeq = op.seq ?? appliedSeq;
    repaint();
    if (op.op === 'draw') markFirst('firstDrawn');
    if (op.op === 'draw' || op.op === 'update') await sleep(DRAW_GAP_MS * PACE);
  }
  // A stopped turn's loop only wakes to find it is out of date. It must not touch
  // the state of the turn that replaced it.
  if (mine !== turn) return;
  pumping = false;
  settleWhenQuiet(mine);
}

async function settleWhenQuiet(mine) {
  if (streamOpen || queue.length) return;
  if (speaking) await speaking;
  if (mine !== turn || streamOpen || queue.length) return;
  if (metrics.current && metrics.current.finished === undefined) {
    metrics.current.finished = Math.round(performance.now() - metrics.current.t0);
    window.dispatchEvent(new Event('tutor-idle'));
  }
  // The turn is over, so the whole board is readable and clickable again.
  if (board.focus.size) { board.apply({ op: 'focus', ids: [] }); repaint(); }
  letGo();
  // An error stays on screen, since it is the last thing the tutor has to say.
  if (!metrics.current?.error) $('caption').textContent = '';
}

// What was pointed at stays ringed during its answer, then lets go, so the next
// question does not silently point at it too.
let answering = [];
function letGo() {
  if (!answering.length) return;
  board.selected = board.selected.filter((id) => !answering.includes(id));
  answering = [];
  repaint();
  showPointing();
}

/** Drop everything not yet said or drawn. */
function stopTalking() {
  const wasTalking = !!speaking || queue.length > 0 || streamOpen;
  turn++;
  queue = [];
  speaking = null;
  synth?.cancel();
  if (streamOpen) controller?.abort();
  controller = null;
  streamOpen = false;
  pumping = false;
  $('caption').textContent = '';
  if (wasTalking && lastSaid) interruptedAfter = lastSaid;
  letGo();
}

let nextReset = false;

async function ask(question) {
  question = question.trim();
  if (!question) return;
  stopTalking();
  const reset = nextReset;
  nextReset = false;
  const mine = turn;
  if (!started) { started = true; repaint(); }
  const pointing = board.selected.map((id) => board.describe(id));
  answering = [...board.selected];
  const m = { t0: performance.now(), question, model: modelSelect.value, pointing: pointing.length };
  metrics.current = m;
  metrics.history.push(m);
  $('meter').textContent = '';
  $('caption').textContent = '…';

  streamOpen = true;
  controller = new AbortController();
  const body = { session, question, pointing, model: modelSelect.value, applied: appliedSeq, reset, interruptedAfter, speed: Number(params.get('speed') ?? 1), record: params.get('record') ?? undefined };
  interruptedAfter = '';
  try {
    const response = await fetch('/tutor/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    if (!response.ok) throw new Error(await response.text());
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) if (line.trim()) receive(JSON.parse(line), mine);
    }
  } catch (err) {
    if (err.name !== 'AbortError' && mine === turn) $('caption').textContent = `The tutor could not answer: ${err.message}`;
  }
  if (mine !== turn) return;
  streamOpen = false;
  pump();
}

function receive(message, mine) {
  if (mine !== turn) return;
  const m = metrics.current;
  if (message.meta) {
    if (message.meta === 'first-delta') m.serverFirstDelta = message.ms;
    else if (message.meta === 'process') { m.spawned = message.started; m.spawnMs = message.ms; } else if (message.meta === 'prompt') m.prompt = message.text;
    else if (message.meta === 'error') { m.error = message.message; $('caption').textContent = `The tutor stopped: ${message.message}`; } else if (message.meta === 'done') {
      Object.assign(m, { serverDone: message.ms, serverFirstSay: message.firstSay, serverFirstDraw: message.firstDraw, notes: message.notes, trace: message.trace, cost: message.cost, apiMs: message.apiMs, usage: message.usage, cancelled: message.cancelled });
      m.streamEnded = Math.round(performance.now() - m.t0);
    }
    return;
  }
  if (m.firstOpAt === undefined) m.firstOpAt = Math.round(performance.now() - m.t0);
  queue.push(message);
  pump();
}

// ------------------------------------------------------------------- input

$('bar').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('question').value;
  $('question').value = '';
  ask(q).then(showPointing);
});

let warmed = false;
function warm() {
  // Starting the process before the question is ready takes its start out of the wait.
  if (warmed || modelSelect.value.startsWith('replay:')) return;
  warmed = true;
  fetch('/tutor/warm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session, model: modelSelect.value }) }).catch(() => {});
}
$('question').addEventListener('input', warm);
modelSelect.addEventListener('change', () => { warmed = false; });

$('stop').addEventListener('click', stopTalking);
$('new-board').addEventListener('click', () => {
  stopTalking();
  interruptedAfter = '';
  lastSaid = '';
  board.apply({ op: 'clear' });
  appliedSeq = 0;
  started = false;
  nextReset = true;
  repaint();
  showPointing();
});

addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (board.selected.length) { board.selected = []; repaint(); showPointing(); } else stopTalking();
});

stage.on('click', '*', ({ id }) => {
  if (!id) return;
  const suggestion = /^suggest-(\d)$/.exec(id);
  if (suggestion) { ask(SUGGESTIONS[+suggestion[1]]); return; }
  const owner = board.ownerOf(id);
  if (!owner) return;
  board.toggle(owner);
  repaint();
  showPointing();
  $('question').focus();
});

// ------------------------------------------------------------------- the microphone

const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
if (Recognition) {
  const mic = $('mic');
  mic.hidden = false;
  let listening = null;
  mic.addEventListener('click', () => {
    if (listening) { listening.stop(); return; }
    // Talking over the tutor stops it, as it would stop a person.
    stopTalking();
    warm();
    const r = new Recognition();
    r.lang = 'en-US';
    r.interimResults = true;
    r.continuous = false;
    listening = r;
    mic.setAttribute('aria-pressed', 'true');
    r.onresult = (e) => {
      let words = '';
      let final = false;
      for (const result of e.results) { words += result[0].transcript; final = final || result.isFinal; }
      $('question').value = words;
      if (final) {
        $('question').value = '';
        ask(words).then(showPointing);
      }
    };
    r.onerror = (e) => { $('caption').textContent = `The microphone did not work: ${e.error}`; };
    r.onend = () => { listening = null; mic.setAttribute('aria-pressed', 'false'); };
    r.start();
  });
}

repaint();
window.app = { stage, board, metrics, audit: () => audit(board), get queue() { return queue; }, get appliedSeq() { return appliedSeq; }, ask };
