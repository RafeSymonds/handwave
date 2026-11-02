// Sound made on the spot with WebAudio: a pen scratch while drawing, a thud that
// scales with a hit, and a few notes for finishing. No files.

let ctx = null;
let muted = false;
let scratchGain = null;

function noiseBuffer(seconds) {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** Call from a pointer or key event: browsers only start audio after one. */
export function unlock() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  const Context = window.AudioContext ?? window.webkitAudioContext;
  if (!Context) return;
  ctx = new Context();
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer(1.5);
  source.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 3200;
  band.Q.value = 0.8;
  scratchGain = ctx.createGain();
  scratchGain.gain.value = 0;
  source.connect(band).connect(scratchGain).connect(ctx.destination);
  source.start();
}

export function setMuted(value) { muted = value; if (value) scratch(0); }
export const isMuted = () => muted;

/** Scratch volume follows pen speed, 0 to 1. */
export function scratch(amount) {
  if (!ctx || !scratchGain) return;
  scratchGain.gain.setTargetAtTime(muted ? 0 : Math.min(1, amount) * 0.05, ctx.currentTime, 0.02);
}

export function thud(speed) {
  if (!ctx || muted) return;
  const t = ctx.currentTime;
  const hit = Math.min(1, speed / 14);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.setValueAtTime(70 + hit * 90, t);
  osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
  gain.gain.setValueAtTime(0.05 + hit * 0.2, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.15);
}

function note(frequency, at, length, volume = 0.12) {
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, t + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + length + 0.02);
}

export function won(stars) {
  if (!ctx || muted) return;
  [523, 659, 784].slice(0, Math.max(1, stars)).forEach((f, i) => note(f, 0.28 * i + 0.1, 0.5));
}

export function failed() {
  if (!ctx || muted) return;
  note(196, 0, 0.22, 0.1);
  note(147, 0.12, 0.3, 0.1);
}

export function letGo() {
  if (!ctx || muted) return;
  note(392, 0, 0.08, 0.05);
}
