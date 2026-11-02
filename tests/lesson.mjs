// O9. Plays the branching lesson in a real browser with real input: holding for
// the voice at real speed, a right-answer path, a wrong-answer path, the keyboard,
// a clip that fails to load, and a small window.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { open, page, shots } from './browser.mjs';

const OUT = process.argv[2] ?? shots('lesson');
const FAST = 8;
const { base, context, browser, close } = await open();
const results = [];
const pass = (name, detail = '') => { results.push(name); console.log(`ok   ${name}${detail ? `: ${detail}` : ''}`); };

const load = async (p, query = '') => {
  await p.goto(`${base}/experiments/lesson/${query}`);
  await p.waitForFunction('window.app');
  await p.waitForFunction(() => window.app.ready.size >= 30, undefined, { timeout: 15000 });
  await p.evaluate(() => { window.app.audio.muted = true; });
};
const state = (p) => p.evaluate(() => {
  const { player, audio, stage } = window.app;
  return {
    mode: player.mode, index: player.index, beat: player.beat?.id ?? null, waiting: player.waiting, paused: player.paused, sentence: player.sentence,
    time: audio.currentTime, duration: audio.duration, audioPaused: audio.paused, stageTime: stage.time,
    caption: stage.get('caption')?.text ?? '', title: stage.get('lesson-title')?.text ?? null,
    log: player.log.map((e) => `${e.type}:${e.id ?? ''}`),
  };
});
const beatLog = (log) => log.filter((e) => e.startsWith('beat:')).map((e) => e.slice(5));
// Where an element is on screen, through the stage's own transform.
const center = (p, id) => p.evaluate((id) => {
  const { stage } = window.app;
  const el = stage.get(id);
  if (!el) return null;
  const r = stage.canvas.getBoundingClientRect();
  const { view } = stage;
  return { x: r.left + (el.x + el.width / 2) * view.scale / view.css + view.ox / view.css, y: r.top + (el.y + el.height / 2) * view.scale / view.css + view.oy / view.css };
}, id);
const clickEl = async (p, id) => {
  const c = await center(p, id);
  assert.ok(c, `${id} is on screen`);
  await p.mouse.move(c.x, c.y);
  await p.mouse.down();
  await p.mouse.up();
};
const until = (p, fn, arg, timeout = 60000) => p.waitForFunction(fn, arg, { timeout, polling: 30 });
const untilBeat = (p, id, timeout) => until(p, (id) => window.app.player.beat?.id === id, id, timeout);
const untilWaiting = (p, q, timeout) => until(p, (q) => window.app.player.waiting && window.app.player.question?.id === q, q, timeout);
const untilDone = (p, timeout) => until(p, () => window.app.player.mode === 'done', undefined, timeout);

// ---------------------------------------------------------- 1. start and real-speed hold
{
  const p = await page(context);
  await load(p);
  let s = await state(p);
  assert.equal(s.mode, 'start');
  assert.ok(s.audioPaused, 'nothing plays before the start click');
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${OUT}/1-start.png` });

  const clicked = Date.now();
  await clickEl(p, 'start');
  await p.waitForFunction(() => window.app.audio.currentTime > 0, undefined, { timeout: 5000, polling: 10 });
  console.log(`     voice audible ${Date.now() - clicked} ms after the click`);
  s = await state(p);
  assert.equal(s.beat, 'title-card-0');
  assert.equal(s.audioPaused, false, 'the start click starts the voice');
  const lesson = await p.evaluate(() => window.app.lesson.beats[0]);
  assert.ok(Math.abs(s.duration - lesson.duration) < 0.05, `clip length ${s.duration} matches ${lesson.duration}`);

  // Real speed: the first beat holds until its audio ends, and captions follow the voice.
  const started = Date.now();
  const seenCaptions = new Set();
  const samples = [];
  while (true) {
    const now = await state(p);
    if (now.beat !== 'title-card-0') break;
    if (now.caption) seenCaptions.add(now.caption);
    samples.push(now);
    if (now.time < lesson.duration - 0.2) assert.equal(now.beat, 'title-card-0');
    const expected = lesson.sentences.findLast((x) => x.start <= now.time + 0.03)?.text;
    if (expected && now.time > 0.1 && !now.audioPaused) assert.ok(now.caption.replace(/\n/g, ' ') === expected || samples.length < 2 || Math.abs(lesson.sentences.find((x) => x.text === expected).start - now.time) < 0.25, `caption follows voice at ${now.time}: "${now.caption}" vs "${expected}"`);
    if (Date.now() - started > 30000) throw new Error(`first beat never ended: ${JSON.stringify(now)}`);
    await p.waitForTimeout(100);
  }
  const held = (Date.now() - started + 200) / 1000;
  s = await state(p);
  const ended = s.log.indexOf('ended:title-card-0');
  const next = s.log.indexOf('beat:lookup-0');
  assert.ok(ended >= 0 && next > ended, 'the next beat follows the end of the clip');
  assert.ok(held >= lesson.duration && held < lesson.duration + 1.2, `held ${held}s for a ${lesson.duration}s clip`);
  assert.equal(seenCaptions.size, lesson.sentences.length, 'every sentence was captioned');
  pass('holds for real audio', `clip ${lesson.duration}s, held ${held.toFixed(2)}s, ${seenCaptions.size} captions`);
  assert.deepEqual(p.problems, []);
  await p.close();
}

// ---------------------------------------------------------- 2. every right answer, first try
{
  const p = await page(context);
  await load(p, `?rate=${FAST}`);
  await clickEl(p, 'start');
  await untilBeat(p, 'q1-ask');
  await p.waitForTimeout(700);
  await p.screenshot({ path: `${OUT}/2-q1-asking-while-voiced.png` });
  await untilWaiting(p, 'q1');
  await p.waitForTimeout(700);
  await p.screenshot({ path: `${OUT}/3-q1-waiting.png` });
  const firsts = await p.evaluate(() => window.app.lesson.beats.filter((b) => b.question).map((b) => b.question.choices.findIndex((c) => c.right)));
  assert.ok(new Set(firsts).size > 1, `the right answer's number varies: ${firsts}`);
  // Hovering shows which one you are about to pick.
  const ring = await center(p, 'ring/root');
  await p.mouse.move(ring.x, ring.y);
  await p.waitForTimeout(300);
  assert.equal(await p.evaluate(() => window.app.stage.get('ring/root').strokeStyle), 'solid');
  await p.screenshot({ path: `${OUT}/4-q1-hover.png` });
  // Clicking something that is not a choice does nothing.
  const resolver = await center(p, 'lookup/resolver');
  await p.mouse.click(resolver.x, resolver.y);
  await p.waitForTimeout(150);
  assert.equal((await state(p)).waiting, true, 'a click off the rings is ignored');

  await clickEl(p, 'ring/root');
  await untilBeat(p, 'q1-right-root');
  await p.waitForTimeout(200);
  await p.screenshot({ path: `${OUT}/5-q1-right.png` });
  await untilBeat(p, 'lookup-2');
  await untilWaiting(p, 'q2');
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${OUT}/6-q2-waiting.png` });
  await clickEl(p, 'ring/auth');
  await untilBeat(p, 'lookup-6');
  await untilWaiting(p, 'q3');
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${OUT}/7-q3-waiting.png` });
  await clickEl(p, 'ring/cache');
  await untilBeat(p, 'q3-right-cache');
  await p.waitForTimeout(900);
  assert.ok(await p.evaluate(() => window.app.stage.get('lookup/a-browser')), 'the right answer draws its own arrow');
  await p.screenshot({ path: `${OUT}/8-q3-right.png` });
  await untilBeat(p, 'caching-3');
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${OUT}/9-caching.png` });
  await untilDone(p);
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${OUT}/10-end-right.png` });
  const s = await state(p);
  const lesson = await p.evaluate(() => window.app.lesson);
  const expected = [];
  for (const b of lesson.beats) {
    expected.push(b.id);
    if (b.question) expected.push(...b.question.choices.find((c) => c.right).beats.map((x) => x.id));
  }
  assert.deepEqual(beatLog(s.log), expected, 'the right path says the main beats in order and no wrong branch');
  assert.match(s.caption, /3 of 3/);
  // Replay at the end says the last card again and comes back to the end.
  await p.keyboard.press('r');
  await untilBeat(p, 'end-0');
  await untilDone(p);
  pass('right-answer path to the end', `${expected.length} beats in order, "${s.caption}"`);
  assert.deepEqual(p.problems, []);
  await p.close();
}

// ---------------------------------------------------------- 3. every wrong answer before the right one
{
  const p = await page(context);
  await load(p, `?rate=${FAST}`);
  await clickEl(p, 'start');
  await untilWaiting(p, 'q1');

  await clickEl(p, 'ring/tld');
  await untilBeat(p, 'q1-wrong-tld');
  await p.waitForTimeout(1000);
  let s = await state(p);
  assert.ok(await p.evaluate(() => window.app.stage.get('lookup/guess-tld')), 'the wrong choice plays out on the drawing');
  await p.screenshot({ path: `${OUT}/11-q1-wrong-tld.png` });
  await untilBeat(p, 'q1-again');
  await untilWaiting(p, 'q1');
  await p.waitForTimeout(500);
  assert.equal(await p.evaluate(() => window.app.stage.get('lookup/guess-tld')), undefined, 'that picture leaves when the lesson returns');
  await p.screenshot({ path: `${OUT}/12-q1-again.png` });
  // A ruled-out choice no longer answers.
  await clickEl(p, 'ring/tld');
  await p.waitForTimeout(150);
  assert.equal((await state(p)).waiting, true, 'a ruled-out choice is ignored');

  await clickEl(p, 'ring/auth');
  await untilBeat(p, 'q1-wrong-auth');
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${OUT}/13-q1-wrong-auth.png` });
  await untilWaiting(p, 'q1');
  await clickEl(p, 'ring/root');
  await untilBeat(p, 'q1-right-root');

  await untilWaiting(p, 'q2');
  await clickEl(p, 'ring/root');
  await untilBeat(p, 'q2-wrong-root');
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${OUT}/14-q2-wrong-root.png` });
  await untilWaiting(p, 'q2');
  await clickEl(p, 'ring/tld');
  await untilBeat(p, 'q2-wrong-tld');
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${OUT}/15-q2-wrong-tld.png` });
  await untilWaiting(p, 'q2');
  await clickEl(p, 'ring/auth');
  await untilBeat(p, 'q2-right-auth');

  await untilWaiting(p, 'q3');
  await clickEl(p, 'ring/root');
  await untilBeat(p, 'q3-wrong-root');
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${OUT}/16-q3-wrong-root.png` });
  await untilWaiting(p, 'q3');
  await clickEl(p, 'ring/auth');
  await untilBeat(p, 'q3-wrong-auth');
  await p.waitForTimeout(800);
  await untilWaiting(p, 'q3');
  await clickEl(p, 'ring/cache');
  await untilDone(p);
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${OUT}/17-end-wrong.png` });

  s = await state(p);
  const said = beatLog(s.log);
  const lesson = await p.evaluate(() => window.app.lesson);
  const every = (q, order) => [`${q}-ask`, ...order.flatMap((o) => (o.endsWith('!') ? [o.slice(0, -1)] : [o, `${q}-again`]))];
  const expected = [];
  for (const b of lesson.beats) {
    if (!b.question) { expected.push(b.id); continue; }
    const q = b.question.id;
    const wrong = b.question.choices.filter((c) => !c.right);
    const right = b.question.choices.find((c) => c.right);
    const order = { q1: ['tld', 'auth'], q2: ['root', 'tld'], q3: ['root', 'auth'] }[q];
    assert.deepEqual(order.slice().sort(), wrong.map((c) => c.id).sort());
    expected.push(...every(q, [...order.map((o) => `${q}-wrong-${o}`), `${q}-right-${right.id}!`]));
  }
  assert.deepEqual(said, expected, 'each wrong choice got its own section, then the question, then the main path');
  assert.match(s.caption, /0 of 3/);
  pass('wrong-answer path to the end', `${said.length} beats, "${s.caption}"`);
  assert.deepEqual(p.problems, []);
  await p.close();
}

// ---------------------------------------------------------- 4. the keyboard
{
  const p = await page(context);
  await load(p, `?rate=${FAST}`);
  await p.keyboard.press('Enter');
  await untilBeat(p, 'title-card-0');
  await p.keyboard.press('ArrowRight');
  await untilBeat(p, 'lookup-0');
  // Replay restarts the beat from its own start, picture included.
  await p.waitForTimeout(600);
  const earlier = (await state(p)).time;
  assert.ok(earlier > 0.5, `time advanced to ${earlier}`);
  await p.keyboard.press('r');
  await p.waitForTimeout(80);
  let s = await state(p);
  assert.equal(s.beat, 'lookup-0');
  assert.ok(s.time < earlier, `replay rewound from ${earlier} to ${s.time}`);
  assert.ok(s.log.includes('replay:lookup-0'));

  // Pause holds both the voice and the picture.
  await p.waitForTimeout(200);
  await p.keyboard.press(' ');
  await p.waitForTimeout(100);
  const a = await state(p);
  assert.equal(a.paused, true);
  assert.equal(a.audioPaused, true);
  await p.waitForTimeout(500);
  const b = await state(p);
  assert.equal(b.time, a.time, 'the voice holds while paused');
  assert.equal(b.stageTime, a.stageTime, 'the picture holds while paused');
  await p.screenshot({ path: `${OUT}/18-paused.png` });
  await p.keyboard.press(' ');
  await p.waitForTimeout(250);
  const c = await state(p);
  assert.equal(c.paused, false);
  assert.ok(c.time > b.time, 'the voice resumes');

  // A pause from outside the page, such as a media key, shows as paused instead of hanging.
  await p.evaluate(() => HTMLMediaElement.prototype.pause.call(window.app.audio));
  await p.waitForFunction(() => window.app.player.paused);
  assert.ok((await state(p)).log.some((e) => e.startsWith('paused-from-outside')));
  assert.match(await p.evaluate(() => window.app.stage.get('btn-pause-t').text), /resume/);
  await p.keyboard.press(' ');
  await p.waitForFunction(() => !window.app.player.paused && !window.app.audio.paused);

  // Skipping forward reaches the question, which then waits, and a number answers it.
  await p.keyboard.press('ArrowRight');
  await untilBeat(p, 'lookup-1');
  await p.keyboard.press('ArrowRight');
  await untilBeat(p, 'q1-ask');
  await p.keyboard.press('ArrowRight');
  await untilWaiting(p, 'q1');
  await p.keyboard.press('2');
  const choice2 = await p.evaluate(() => window.app.player.question.choices[1].id);
  await untilBeat(p, `q1-wrong-${choice2}`);
  await p.waitForTimeout(150);
  await p.keyboard.press('r');
  await p.waitForTimeout(80);
  s = await state(p);
  assert.equal(s.beat, `q1-wrong-${choice2}`, 'replay stays inside the wrong answer');
  assert.ok(s.log.includes(`replay:q1-wrong-${choice2}`));
  await p.keyboard.press('ArrowRight');
  await untilBeat(p, 'q1-again');
  await p.keyboard.press('ArrowRight');
  await untilWaiting(p, 'q1');
  // Replay while it waits repeats the last thing said, then waits again.
  await p.keyboard.press('r');
  await untilBeat(p, 'q1-again');
  await untilWaiting(p, 'q1');
  // A waiting question, skipped, gives its answer and counts as missed.
  await p.keyboard.press('ArrowRight');
  await untilBeat(p, 'q1-right-root');
  // Clicks during a question's own narration also answer it.
  await untilBeat(p, 'lookup-2');
  for (const id of ['lookup-3', 'lookup-4', 'lookup-5']) { await p.keyboard.press('ArrowRight'); await untilBeat(p, id); }
  await p.keyboard.press('ArrowRight');
  await untilBeat(p, 'q2-ask');
  await p.waitForTimeout(100);
  await clickEl(p, 'ring/auth');
  await untilBeat(p, 'q2-right-auth');
  // Hammer the controls mid-animation.
  for (let i = 0; i < 8; i++) { await p.keyboard.press('r'); await p.keyboard.press(' '); await p.keyboard.press(' '); await p.keyboard.press('ArrowRight'); }
  await p.waitForTimeout(400);
  s = await state(p);
  assert.ok(['play'].includes(s.mode) || s.mode === 'done', `still running after hammering: ${s.mode}`);
  pass('keyboard: replay, pause, skip, number keys', `${s.log.length} events, then ${s.beat}`);
  assert.deepEqual(p.problems, []);
  await p.close();
}

// ---------------------------------------------------------- 5. a clip that will not load
{
  const p = await page(context);
  const lessonJson = await (await context.request.get(`${base}/experiments/lesson/lesson.json`)).json();
  const broken = lessonJson.beats[1];
  await p.route(`**/${broken.audio}`, (route) => route.abort());
  await load(p, `?rate=${FAST}`);
  await clickEl(p, 'start');
  await untilBeat(p, broken.id);
  const started = Date.now();
  await until(p, (id) => window.app.player.beat?.id !== id, broken.id, 30000);
  const held = (Date.now() - started) / 1000;
  const expected = broken.duration / FAST;
  assert.ok(held >= expected * 0.8 && held < expected + 2, `held ${held}s without sound for ${expected}s`);
  const warned = await p.evaluate(() => window.app.stage.get('problem')?.text);
  assert.match(warned, /did not play/);
  pass('a failed clip holds for its length and says so', `held ${held.toFixed(2)}s of ${expected.toFixed(2)}s`);
  await p.close();
}

// ---------------------------------------------------------- 6. a small window, and captions that fit
{
  const small = await browser.newContext({ viewport: { width: 1000, height: 620 }, deviceScaleFactor: 2 });
  const p = await page(small);
  await load(p, `?rate=${FAST}`);
  await clickEl(p, 'start');
  await untilWaiting(p, 'q1');
  await clickEl(p, 'ring/root');
  await untilBeat(p, 'q1-right-root');
  pass('clicks land right in a small window');
  await p.screenshot({ path: `${OUT}/19-small-window.png` });

  const caps = await p.evaluate(() => {
    const { lesson, wrap } = window.app;
    const out = [];
    const each = (b) => { for (const s of b.sentences) out.push({ id: b.id, lines: wrap(s.text, 30, 6, 1360).split('\n').length }); };
    for (const b of lesson.beats) {
      each(b);
      if (b.question) { b.question.choices.forEach((c) => c.beats.forEach(each)); each(b.question.again); }
    }
    return out;
  });
  const most = Math.max(...caps.map((c) => c.lines));
  assert.ok(most <= 3, `captions fit the space: ${most} lines at most`);
  pass('captions fit', `${caps.length} sentences, ${most} lines at most`);

  // Anything in the scenes runs off the page or under the captions?
  const overflow = await p.evaluate(() => {
    const { lesson, scenes } = window.app;
    const out = [];
    const check = (b) => {
      for (const id of b.ids) {
        const el = scenes[b.scene].get(id);
        if (id === 'frame' || (el.strokeColor === 'transparent')) continue;
        // A line's extent comes from its points, which can run left of its origin.
        const xs = el.points ? el.points.map((pt) => el.x + pt[0]) : [el.x, el.x + (el.width ?? 0)];
        const ys = el.points ? el.points.map((pt) => el.y + pt[1]) : [el.y, el.y + (el.height ?? 0)];
        if (Math.min(...xs) < 0 || Math.max(...xs) > 1600 || Math.max(...ys) > 676) out.push(`${b.id}: ${id}`);
      }
    };
    for (const b of lesson.beats) {
      check(b);
      if (b.question) b.question.choices.forEach((c) => c.beats.forEach(check));
    }
    return out;
  });
  assert.deepEqual(overflow, [], 'nothing runs off the page or under the captions');
  pass('nothing overflows');
  await p.close();
  await small.close();
}

// ---------------------------------------------------------- 7. real speed through a wrong answer
{
  const p = await page(context);
  await load(p);
  await clickEl(p, 'start');
  await untilBeat(p, 'title-card-0');
  await p.keyboard.press('ArrowRight');
  await untilBeat(p, 'lookup-0');
  await p.keyboard.press('ArrowRight');
  await untilBeat(p, 'lookup-1');
  await p.keyboard.press('ArrowRight');
  await untilWaiting(p, 'q1', 40000);
  await clickEl(p, 'ring/tld');
  await untilWaiting(p, 'q1', 40000);
  const { log, wrong, again } = await p.evaluate(() => {
    const { player, lesson } = window.app;
    const q = lesson.beats.find((b) => b.question?.id === 'q1').question;
    return { log: player.log, wrong: q.choices.find((c) => c.id === 'tld').beats[0], again: q.again };
  });
  const at = (type, id) => log.find((e) => e.type === type && e.id === id).at;
  const heldWrong = (at('beat', 'q1-again') - at('beat', 'q1-wrong-tld')) / 1000;
  assert.ok(heldWrong >= wrong.duration && heldWrong < wrong.duration + 1, `wrong answer held ${heldWrong}s for a ${wrong.duration}s clip`);
  const lastWaiting = log.findLast((e) => e.type === 'waiting').at;
  const heldAgain = (lastWaiting - at('beat', 'q1-again')) / 1000;
  assert.ok(heldAgain >= again.duration && heldAgain < again.duration + 1, `again held ${heldAgain}s for a ${again.duration}s clip`);
  pass('real speed: a wrong answer and its return hold for their clips', `${heldWrong.toFixed(2)}s of ${wrong.duration}s, ${heldAgain.toFixed(2)}s of ${again.duration}s`);
  assert.deepEqual(p.problems, []);
  await p.close();
}

// ---------------------------------------------------------- 8. the browser's real autoplay rule
{
  // browser.mjs turns the rule off, and Playwright's evaluate counts as a user
  // gesture, so this browser turns the rule on and nothing is evaluated until the
  // page has recorded every play() itself. The voice is nearly silent, not muted,
  // since muted audio is exempt.
  const strict = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=document-user-activation-required'] });
  const ctx = await strict.newContext({ viewport: { width: 1600, height: 900 } });
  const p = await page(ctx);
  await p.addInitScript(() => {
    window.plays = [];
    const real = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function play() {
      this.volume = 0.001;
      const entry = { active: navigator.userActivation.hasBeenActive, result: 'pending' };
      window.plays.push(entry);
      const promise = real.call(this);
      promise.then(() => { entry.result = 'played'; }, (err) => { entry.result = err.name; });
      return promise;
    };
    addEventListener('load', () => new Audio('/nothing-yet').play().catch(() => {}));
  });
  await p.goto(`${base}/experiments/lesson/?rate=${FAST}`);
  await p.waitForTimeout(2000);
  // Where the Start button sits on a 1600 by 900 page: lib's stage maps it 1:1.
  await p.mouse.move(234, 692);
  await p.mouse.down();
  await p.mouse.up();
  await p.waitForTimeout(3500);
  const { plays, beats } = await p.evaluate(() => ({ plays: window.plays, beats: window.app.player.log.filter((e) => e.type === 'beat').map((e) => e.id) }));
  assert.equal(plays[0].active, false, 'nothing had activated the page before the click');
  assert.equal(plays[0].result, 'NotAllowedError', 'the rule is in force before the click');
  const lesson = plays.slice(1);
  assert.ok(lesson.length >= 2, `the lesson went past its first clip: ${beats}`);
  assert.ok(lesson.every((e) => e.active && e.result === 'played'), `every clip after the click played: ${JSON.stringify(lesson)}`);
  pass('the start click satisfies the autoplay rule for later clips', `refused before it, then ${lesson.length} clips played`);
  await strict.close();
}

// ---------------------------------------------------------- 9. the clips themselves
{
  const root = new URL('../experiments/lesson/', import.meta.url);
  const lesson = JSON.parse(readFileSync(new URL('lesson.json', root)));
  const sections = lesson.beats.flatMap((b) => [b, ...(b.question ? [b.question.again, ...b.question.choices.flatMap((c) => c.beats)] : [])]);
  let shortest = Infinity;
  for (const b of sections) {
    const wav = readFileSync(new URL(b.audio, root));
    const pcm = new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) >> 1);
    const seconds = pcm.length / 24000;
    assert.ok(Math.abs(seconds - b.duration) < 0.02, `${b.id}: file holds ${seconds}s, lesson says ${b.duration}s`);
    let sum = 0;
    for (const v of pcm) sum += v * v;
    const rms = Math.sqrt(sum / pcm.length);
    assert.ok(rms > 300, `${b.id} is nearly silent (rms ${rms})`);
    const words = b.text.split(/\s+/).length;
    const pace = words / (seconds / 60);
    // Low end allows for an address, one word on the page and many in the voice.
    assert.ok(pace > 50 && pace < 230, `${b.id}: ${pace.toFixed(0)} words a minute`);
    shortest = Math.min(shortest, seconds);
  }
  pass('every clip holds sound at a speaking pace', `${sections.length} clips, shortest ${shortest.toFixed(2)}s`);
}

console.log(`\n${results.length} checks passed`);
await close();
