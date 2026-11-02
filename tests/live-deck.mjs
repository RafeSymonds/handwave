// The live deck, end to end: one presenter, audience screens and phones in real
// browser pages, with real keyboard, mouse and touch. Connections are cut with a
// real TCP proxy, so a drop here is a drop the browser cannot tell from wifi.
//   node tests/live-deck.mjs [screenshot dir]

import net from 'net';
import os from 'os';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { open, page, shots } from './browser.mjs';
import { startServer } from '../server.mjs';
import { isThisMachine, lanAddress } from '../experiments/live-deck/server.mjs';
import { apply as applyOp, cleanPresenterOp, newState, stepFrom } from '../experiments/live-deck/room.js';
import { SLIDES, slideById, winningOption } from '../experiments/live-deck/meta.js';
import { connectPhone, connectPhones, queueBots, raceBots, someStrokes } from '../experiments/live-deck/simulated-phones.mjs';
import { Race, raceLevel } from '../experiments/live-deck/race.js';
import { QueueModel } from '../experiments/live-deck/queue.js';
import { cleanStrokes, LIMITS } from '../experiments/live-deck/gallery.js';
import { ReplayLog } from '../experiments/live-deck/talk-log.js';
import { ReplayPlayer } from '../experiments/live-deck/replay-player.js';

const SHOTS = process.argv[2] ?? shots('live-deck');
const PATH = '/experiments/live-deck/';
const END = SLIDES.findIndex((s) => s.id === 'end');
// ONLY=race,queue runs just those parts. The parts: core, race, queue, gallery, branch, replay.
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const want = (part) => !only || only.has(part);
let failures = 0, passes = 0;

function ok(name, condition, detail) {
  if (condition) passes++; else failures++;
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
  return condition;
}

async function until(p, fn, arg, name, timeout = 6000) {
  try {
    await p.waitForFunction(fn, arg, { timeout, polling: 20 });
    return ok(name, true);
  } catch {
    return ok(name, false);
  }
}

function tcpProxy(target) {
  const pairs = new Set();
  let server, port;
  const api = {
    get port() { return port; },
    start: () => new Promise((resolve) => {
      server = net.createServer((client) => {
        const upstream = net.connect(target, '127.0.0.1');
        const pair = { client, upstream };
        pairs.add(pair);
        client.pipe(upstream);
        upstream.pipe(client);
        const gone = () => pairs.delete(pair);
        for (const s of [client, upstream]) { s.on('error', () => {}); s.on('close', gone); }
      });
      server.listen(port ?? 0, '127.0.0.1', () => { port = server.address().port; resolve(port); });
    }),
    // Both directions die at once, like a network going away.
    cut: () => new Promise((resolve) => {
      server.close(() => resolve());
      for (const { client, upstream } of pairs) { client.destroy(); upstream.destroy(); }
    }),
    // What the page sends still arrives, but nothing comes back and no close is seen.
    stallReplies: () => { for (const { client, upstream } of pairs) upstream.unpipe(client); },
  };
  return api;
}

const pos = (p) => p.evaluate(() => [window.app.state.index, window.app.state.step]);

async function goTo(p, index, step) {
  for (let i = 0; i < 40; i++) {
    const [a, b] = await pos(p);
    if (a === index && b === step) return;
    await p.keyboard.press(a < index || (a === index && b < step) ? 'ArrowRight' : 'ArrowLeft');
  }
  throw new Error(`never reached ${index}:${step}`);
}

const point = (p, stageX, stageY) => p.evaluate(([x, y]) => {
  const { stage } = window.app;
  const r = stage.canvas.getBoundingClientRect();
  const v = stage.view;
  return { x: r.left + (x * v.scale + v.ox) / v.css, y: r.top + (y * v.scale + v.oy) / v.css };
}, [stageX, stageY]);

const center = async (p, id) => {
  const el = await p.evaluate((id) => { const e = window.app.stage.get(id); return e && { x: e.x, y: e.y, w: e.width, h: e.height }; }, id);
  if (!el) throw new Error(`no element ${id}`);
  return point(p, el.x + el.w / 2, el.y + el.h / 2);
};

async function drag(p, from, to, steps = 14) {
  await p.mouse.move(from.x, from.y);
  await p.mouse.down();
  for (let i = 1; i <= steps; i++) await p.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  await p.mouse.up();
}

const tap = async (p, id) => { const c = await center(p, id); await p.touchscreen.tap(c.x, c.y); };

// What a screen is showing, once settled.
const shown = (p) => p.evaluate(() => window.app.stage.elements().map((e) => [e.id, Math.round(e.x), Math.round(e.y), Math.round(e.width ?? 0), e.text ?? '', e.points?.length ?? 0]));
const tally = (p, slide) => p.evaluate((slide) => window.app.state.tallies[slide] ?? null, slide);
const settle = (p, ms = 450) => p.waitForTimeout(ms);

async function sameScreen(a, b, name, wait = 450) {
  await settle(a, wait);
  const [x, y] = [await shown(a), await shown(b)];
  return ok(name, JSON.stringify(x) === JSON.stringify(y), JSON.stringify(x) === JSON.stringify(y) ? undefined : { a: x.length, b: y.length, first: x.find((e, i) => JSON.stringify(e) !== JSON.stringify(y[i])), other: y.find((e, i) => JSON.stringify(e) !== JSON.stringify(x[i])) });
}

const offStage = (p) => p.evaluate(() => {
  const { stage } = window.app;
  return stage.elements().filter((e) => e.type !== 'freedraw' && (e.x < -1 || e.y < -1 || e.x + (e.width ?? 0) > stage.width + 1 || e.y + (e.height ?? 0) > stage.height + 1)).map((e) => e.id);
});

// ---------------------------------------------------------------------------

const { base, browser, context, close } = await open({ viewport: { width: 1940, height: 900 } });
const port = Number(new URL(base).port);
const everyPage = [];
const track = (p) => { everyPage.push(p); return p; };

const openScreen = async (ctx, url) => {
  const p = track(await page(ctx));
  await p.goto(url);
  await p.waitForFunction(() => window.app && window.app.state);
  return p;
};
const phoneContext = () => browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

if (want('core')) {
console.log('--- joining');
const pres = await openScreen(context, `${base}${PATH}`);
ok('a bare link on this machine opens the presenter', (await pres.evaluate(() => window.app.role)) === 'presenter');
const audienceContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const aud = await openScreen(audienceContext, `${base}${PATH}?role=audience`);
ok('the audience page has no panel', await aud.evaluate(() => document.getElementById('panel').hidden));

const info = await pres.evaluate(() => window.app.info);
const addresses = Object.values(os.networkInterfaces()).flat().map((a) => a.address);
ok('the join address uses a real address of this machine', info.lan === null || addresses.includes(info.lan), info.joinUrl);
ok('the title slide shows the join address', (await pres.evaluate(() => window.app.stage.get('join-url').text)) === info.joinUrl);
ok('on a loopback server the slide says phones cannot reach it and how to fix it', (await pres.evaluate(() => window.app.stage.get('join-note').text)).includes('HOST=0.0.0.0'));
ok('so does the presenter panel', (await pres.textContent('#p-status')).includes('HOST=0.0.0.0'));
ok('a server phones cannot reach shows no code to scan', (await pres.evaluate(() => window.app.stage.get('join-qr'))) === undefined);

const phones = [];
for (let i = 0; i < 5; i++) {
  const c = await phoneContext();
  const p = track(await page(c));
  await p.goto(`${base}/join`);
  await p.waitForFunction(() => window.app && window.app.state);
  phones.push(p);
}
ok('/join redirects to the phone page', (await phones[0].evaluate(() => window.app.role)) === 'phone');
await until(pres, () => window.app.state.counts.phones === 5, undefined, 'the presenter counts 5 phones');
await until(aud, () => window.app.stage.get('join-count')?.text === '5 phones connected', undefined, 'the audience slide says 5 phones connected');
await settle(pres, 900);
await pres.screenshot({ path: `${SHOTS}/presenter-title.png` });
await aud.screenshot({ path: `${SHOTS}/audience-title.png` });
await phones[0].screenshot({ path: `${SHOTS}/phone-no-vote.png` });
ok('nothing on an idle phone runs off the page', (await offStage(phones[0])).length === 0, await offStage(phones[0]));
await sameScreen(pres, aud, 'audience matches presenter on the title slide');

console.log('--- stepping');
await pres.keyboard.press('ArrowRight');
await until(aud, () => window.app.state.index === 1, undefined, 'ArrowRight reaches the audience');
await pres.keyboard.press(' ');
await pres.keyboard.press('ArrowRight');
await until(aud, () => window.app.state.index === 1 && window.app.state.step === 2, undefined, 'Space and ArrowRight step on');
await settle(aud, 700);
const demoBefore = await aud.evaluate(() => window.app.stage.get('demo').x);
await pres.keyboard.press('ArrowRight');
await until(aud, () => window.app.state.step === 3, undefined, 'the last step arrives');
ok('a shared id morphs on the audience screen', await aud.evaluate(() => { const i = window.app.stage.items.get('demo'); return i.anim?.kind === 'change' || i.el.x !== undefined; }));
await settle(aud, 700);
ok('the shared element ends at its new place', (await aud.evaluate(() => window.app.stage.get('demo').x)) !== demoBefore);
await until(aud, () => !window.app.stage.get('old'), undefined, 'a missing id leaves');
ok('the state box shows the real position', (await aud.evaluate(() => window.app.stage.get('state-t').text)).includes('slide 2, step 4'));
await pres.keyboard.press('ArrowLeft');
await until(aud, () => window.app.state.step === 2 && window.app.stage.get('old'), undefined, 'ArrowLeft goes back');
await sameScreen(pres, aud, 'audience matches presenter after stepping');

console.log('--- voting');
await goTo(pres, 2, 0);
await until(phones[0], () => window.app.stage.get('opt-survive-0'), undefined, 'the vote reaches the phone');
await settle(phones[0], 700);
await phones[0].screenshot({ path: `${SHOTS}/phone-vote-before.png` });
const choices = [3, 3, 0, 3, 1];
const expected = [0, 0, 0, 0];
let previousWidth = await aud.evaluate(() => window.app.stage.get('survive-row3-bar').width);
for (let i = 0; i < choices.length; i++) {
  // Watch the bar on the audience screen while the vote arrives.
  const watching = choices[i] === 3 ? aud.evaluate(async () => {
    const { stage } = window.app, widths = [], start = performance.now();
    while (performance.now() - start < 700) { widths.push(stage._look(stage.items.get('survive-row3-bar')).width); await new Promise(requestAnimationFrame); }
    return widths;
  }) : null;
  await tap(phones[i], `opt-survive-${choices[i]}`);
  expected[choices[i]]++;
  await until(pres, (want) => JSON.stringify(window.app.state.tallies.survive) === want, JSON.stringify(expected), `phone ${i + 1}'s touch counts on the presenter`);
  await until(aud, (want) => JSON.stringify(window.app.state.tallies.survive) === want, JSON.stringify(expected), `phone ${i + 1}'s touch counts on the audience screen`);
  if (watching) {
    const widths = await watching;
    const between = new Set(widths.map((w) => Math.round(w))).size;
    const rising = widths.every((w, k) => k === 0 || w >= widths[k - 1] - 0.5);
    ok('the bar grows through in-between widths', rising && between >= 3 && widths.at(-1) > previousWidth, { from: Math.round(widths[0]), to: Math.round(widths.at(-1)), widths: between });
    previousWidth = widths.at(-1);
  }
}
ok('bar lengths follow the counts', await aud.evaluate(() => { const w = (i) => window.app.stage.get(`survive-row${i}-bar`).width; return w(3) === 3 * w(1) && w(0) === w(1) && w(2) === 4 ? true : [w(0), w(1), w(2), w(3)]; }) === true);
ok('the count beside a bar is right', (await aud.evaluate(() => window.app.stage.get('survive-row3-count').text)) === '3');
ok('the total is right', (await pres.evaluate(() => window.app.stage.get('survive-total').text)) === '5 votes');
await settle(pres, 500);
await pres.screenshot({ path: `${SHOTS}/presenter-vote.png` });
await aud.screenshot({ path: `${SHOTS}/audience-vote.png` });
await phones[0].screenshot({ path: `${SHOTS}/phone-vote-after.png` });
ok('nothing on a voted phone runs off the page', (await offStage(phones[0])).length === 0, await offStage(phones[0]));
const smallContext = await browser.newContext({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const small = track(await page(smallContext));
await small.goto(`${base}/join`);
await small.waitForFunction(() => window.app && window.app.state);
ok('a small phone fits every option', (await offStage(small)).length === 0, await offStage(small));
await small.screenshot({ path: `${SHOTS}/phone-small.png` });
await smallContext.close();
await sameScreen(pres, aud, 'audience matches presenter on the bars');

await tap(phones[2], 'opt-survive-3');
await until(pres, () => JSON.stringify(window.app.state.tallies.survive) === '[0,1,0,4]', undefined, 'a phone can change its vote, and the total stays 5');
await phones[2].reload();
await phones[2].waitForFunction(() => window.app && window.app.state);
ok('a reloaded phone remembers its vote', (await phones[2].evaluate(() => window.app.you.votes.survive)) === 3);
ok('reloading does not count it twice', JSON.stringify(await tally(pres, 'survive')) === '[0,1,0,4]');

await pres.keyboard.press('ArrowRight');
await until(phones[0], () => window.app.state.step === 1 && [...window.app.stage.items.keys()].includes('vote-status-survive'), undefined, 'the phone sees the vote close');
const stayed = await tally(pres, 'survive');
await tap(phones[1], 'opt-survive-0');
await settle(phones[1], 300);
ok('a tap after closing does nothing', JSON.stringify(await tally(pres, 'survive')) === JSON.stringify(stayed));
await phones[1].evaluate(() => window.app.link.send({ t: 'vote', slide: 'survive', option: 0 }));
await settle(phones[1], 300);
ok('the server refuses a late vote too', JSON.stringify(await tally(pres, 'survive')) === JSON.stringify(stayed));
ok('the refused vote is taken back on the phone', (await phones[1].evaluate(() => window.app.you.votes.survive)) === 3);
await settle(pres, 900);
await pres.screenshot({ path: `${SHOTS}/presenter-reveal.png` });
await phones[0].screenshot({ path: `${SHOTS}/phone-vote-closed.png` });

console.log('--- questions');
const evil = '<img src=x onerror="window.pwned=1"> how does ink survive a reconnect?';
const box = await phones[0].locator('#ask-text').boundingBox();
await phones[0].touchscreen.tap(box.x + 20, box.y + 10);
await phones[0].keyboard.type(evil);
const send = await phones[0].locator('#ask-send').boundingBox();
await phones[0].touchscreen.tap(send.x + send.width / 2, send.y + send.height / 2);
await until(pres, () => document.querySelectorAll('#p-questions li').length === 1, undefined, 'the question reaches the presenter');
await until(phones[0], () => document.getElementById('ask-status').textContent === 'Sent to the presenter.', undefined, 'the phone is told it was sent');
await phones[0].screenshot({ path: `${SHOTS}/phone-question-sent.png` });
ok('the question stays text', (await pres.evaluate(() => document.querySelector('#p-questions img') === null && !window.pwned)) && (await pres.textContent('#p-questions li')).includes('<img'));
ok('other screens do not get the queue', (await aud.evaluate(() => window.app.state.questions.length)) === 0 && (await phones[1].evaluate(() => window.app.state.questions.length)) === 0);
await phones[0].locator('#ask-text').fill('a second one straight away');
await phones[0].locator('#ask-send').tap();
await until(phones[0], () => document.getElementById('ask-status').textContent.includes('Wait a moment'), undefined, 'a second question too soon is held back');
ok('and its words are kept', (await phones[0].inputValue('#ask-text')) === 'a second one straight away');
await phones[0].locator('#ask-text').fill('');

await pres.click('#p-questions button[data-action=show]');
await until(aud, () => window.app.stage.get('note-q1-t'), undefined, 'Show puts the question on the audience screen');
ok('its words arrive intact', (await aud.evaluate(() => window.app.stage.get('note-q1-t').text.replace(/\n/g, ' '))) === evil);
await settle(aud, 1600);
await aud.screenshot({ path: `${SHOTS}/audience-question.png` });
await pres.screenshot({ path: `${SHOTS}/presenter-question.png` });
await pres.click('#p-questions button[data-action=hide]');
await until(aud, () => !window.app.stage.get('note-q1-t'), undefined, 'Hide takes it off');
await pres.click('#p-questions button[data-action=remove]');
await until(pres, () => document.querySelectorAll('#p-questions li').length === 0, undefined, 'Remove clears it from the queue');
const longest = 'Whatifsomeonesendsonelongwordwithnospacesatallthatrunsrightacrossthenote and then a good deal more ordinary text to reach the limit of the box.'.slice(0, 140);
await phones[1].locator('#ask-text').fill(longest);
await phones[1].locator('#ask-send').tap();
await until(pres, () => document.querySelectorAll('#p-questions li').length === 1, undefined, 'the longest question arrives');
await pres.click('#p-questions button[data-action=show]');
await until(aud, () => [...window.app.stage.items.keys()].some((id) => id.startsWith('note-')), undefined, 'and goes on screen');
await settle(aud, 1800);
ok('it stays on the page', (await offStage(aud)).length === 0, await offStage(aud));
await aud.screenshot({ path: `${SHOTS}/audience-long-question.png` });
await pres.click('#p-questions button[data-action=remove]');
await until(aud, () => ![...window.app.stage.items.keys()].some((id) => id.startsWith('note-') && !window.app.stage.items.get(id).leaving), undefined, 'removing a shown question takes it off the screen');
const keyAfterClick = await pos(pres);
await pres.keyboard.press('ArrowLeft');
await until(pres, (k) => window.app.state.step === k - 1, keyAfterClick[1], 'keys still work after using the panel');
await pres.keyboard.press('ArrowRight');

console.log('--- off script');
await goTo(pres, 4, 0);
await until(aud, () => window.app.state.index === 4, undefined, 'the audience reaches the layer slide');
await settle(pres, 500);
const start = await center(pres, 'drag-me');
const homeX = await pres.evaluate(() => window.app.stage.get('drag-me').x);
await pres.mouse.move(start.x, start.y);
await pres.mouse.down();
for (let i = 1; i <= 10; i++) await pres.mouse.move(start.x + i * 30, start.y + i * 25);
await aud.waitForFunction((home) => window.app.stage.get('drag-me').x > home + 100, homeX, { timeout: 3000 }).then(() => ok('the audience sees the drag before the mouse lets go', true), () => ok('the audience sees the drag before the mouse lets go', false));
await pres.mouse.up();
await until(aud, () => { const o = window.app.state.offsets.layer?.['drag-me']; return o && Math.abs(o[0] - 300) < 3 && Math.abs(o[1] - 250) < 3; }, undefined, 'the final offset arrives');
ok('the readout shows the live offset', /^\d+, \d+$/.test(await aud.evaluate(() => window.app.stage.get('calc-1-v').text)) && (await aud.evaluate(() => window.app.stage.get('calc-1-v').text)) !== '0, 0');
ok('the label moves with its box', await pres.evaluate(() => { const s = window.app.stage; return s.get('drag-me-t').x > s.get('drag-me').x && s.get('drag-me-t').x < s.get('drag-me').x + 340; }));

const a = await point(pres, 220, 620), b = await point(pres, 720, 760);
await drag(pres, a, b, 30);
await until(aud, () => window.app.stage.elements().filter((e) => e.type === 'freedraw').length === 1, undefined, 'ink on blank space reaches the audience');
const inkCounts = await Promise.all([pres, aud].map((p) => p.evaluate(() => window.app.stage.elements().find((e) => e.type === 'freedraw').points.length)));
ok('with every point', inkCounts[0] === inkCounts[1] && inkCounts[0] > 25, inkCounts);
const over = await center(pres, 'drag-me');
const offsetBefore = await pres.evaluate(() => JSON.stringify(window.app.state.offsets.layer));
await pres.keyboard.down('Shift');
await drag(pres, over, { x: over.x + 240, y: over.y - 140 }, 12);
await pres.keyboard.up('Shift');
ok('Shift-drag on a thing draws instead of moving it', (await pres.evaluate(() => JSON.stringify(window.app.state.offsets.layer))) === offsetBefore && (await pres.evaluate(() => window.app.state.ink.layer.length)) === 2);
await until(aud, () => window.app.state.ink.layer?.length === 2, undefined, 'the second stroke reaches the audience');
ok('a click on blank space leaves no dot', await (async () => { const c = await point(pres, 1400, 760); await pres.mouse.click(c.x, c.y); return (await pres.evaluate(() => window.app.state.ink.layer.length)) === 2; })());
ok('the panel says it is off script', (await pres.textContent('#p-offscript')).startsWith('Off script: 1 moved, 2 drawn'));
await settle(pres, 300);
await pres.screenshot({ path: `${SHOTS}/presenter-offscript.png` });
await aud.screenshot({ path: `${SHOTS}/audience-offscript.png` });
await sameScreen(pres, aud, 'audience matches presenter off script');

const title = await center(pres, 'layer-title');
await drag(pres, title, { x: title.x + 120, y: title.y + 60 });
await until(aud, () => window.app.state.offsets.layer?.['layer-title'], undefined, 'any element can be dragged, even a title');

await pres.keyboard.press('ArrowRight');
ok('a step within the slide keeps the layer', (await pres.evaluate(() => window.app.state.ink.layer.length)) === 2);
await goTo(pres, END, 0);
await until(aud, (end) => window.app.state.index === end && !window.app.stage.elements().some((e) => e.type === 'freedraw'), END, 'the next slide leaves the layer behind');
await goTo(pres, 4, 0);
await until(aud, () => window.app.state.index === 4 && window.app.stage.elements().filter((e) => e.type === 'freedraw').length === 2, undefined, 'coming back finds it still there');
await settle(pres, 400);

// Esc: watch the box travel home on both screens.
const watchHome = (p) => p.evaluate(async () => {
  const { stage } = window.app, xs = [], begin = performance.now();
  while (performance.now() - begin < 900) { const i = stage.items.get('drag-me'); xs.push(stage._look(i).x); await new Promise(requestAnimationFrame); }
  return xs;
});
const travels = [watchHome(pres), watchHome(aud)];
await settle(pres, 60);
await pres.keyboard.press('Escape');
for (const [label, xs] of [['presenter', await travels[0]], ['audience', await travels[1]]]) {
  const distinct = new Set(xs.map((x) => Math.round(x))).size;
  ok(`Esc morphs the box home on the ${label} screen`, xs.at(-1) === homeX && xs[0] > homeX + 200 && distinct >= 5, { from: Math.round(xs[0]), to: Math.round(xs.at(-1)), positions: distinct });
}
await until(aud, () => !window.app.stage.elements().some((e) => e.type === 'freedraw'), undefined, 'Esc removes the ink');
ok('Esc clears the layer in the state', await pres.evaluate(() => !window.app.state.offsets.layer && !window.app.state.ink.layer));
ok('the panel is back on script', await pres.evaluate(() => document.getElementById('p-offscript').hidden));
await sameScreen(pres, aud, 'audience matches presenter back on script');

await goTo(pres, 3, 3);
await settle(pres, 900);
const speaker = await center(pres, 'speaker');
const arrowBefore = await aud.evaluate(() => { const s = window.app.stage; return [s.get('speaker-hall').x, s.get('speaker-hall-t').y]; });
await drag(pres, speaker, { x: speaker.x, y: speaker.y + 160 });
await until(aud, (x) => window.app.state.offsets.room?.speaker && window.app.stage.get('speaker-hall').points.at(-1)[1] < -100, arrowBefore, 'an arrow keeps joining the box it starts from');
ok('its far end stays on the other box', await aud.evaluate(() => { const a = window.app.stage.get('speaker-hall'); return Math.abs(a.x + a.points.at(-1)[0] - 608) < 2 && Math.abs(a.y + a.points.at(-1)[1] - 410) < 2; }));
await settle(pres, 300);
await pres.screenshot({ path: `${SHOTS}/presenter-arrow.png` });
await pres.keyboard.press('Escape');

console.log('--- joining late');
await goTo(pres, 2, 0);
const row = await center(pres, 'survive-row3-bar');
await drag(pres, row, { x: row.x + 40, y: row.y + 20 });
const blank = await point(pres, 1100, 640);
await drag(pres, blank, { x: blank.x + 200, y: blank.y + 60 }, 16);
await settle(pres, 500);
const lateContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const late = track(await page(lateContext));
await late.goto(`${base}${PATH}?role=audience`);
await late.waitForFunction(() => window.app && window.app.state);
ok('a late screen has the slide', JSON.stringify(await pos(late)) === JSON.stringify(await pos(pres)));
ok('it arrives finished, with nothing replaying', await late.evaluate(() => [...window.app.stage.items.values()].every((i) => !i.anim)));
await sameScreen(pres, late, 'it matches the presenter: bars, offsets and ink');
const latePhoneContext = await phoneContext();
const latePhone = track(await page(latePhoneContext));
await latePhone.goto(`${base}/join`);
await latePhone.waitForFunction(() => window.app && window.app.state);
ok('a late phone can vote straight away', await latePhone.evaluate(() => Boolean(window.app.stage.get('opt-survive-0'))));
await tap(latePhone, 'opt-survive-0');
await until(aud, () => JSON.stringify(window.app.state.tallies.survive) === '[1,1,0,4]', undefined, "a late phone's vote counts");
await until(late, () => window.app.state.counts.phones === 6, undefined, 'and it is in the count');
await lateContext.close();
await until(pres, () => window.app.state.counts.screens === 2, undefined, 'a screen that leaves comes off the count');
await pres.reload();
await pres.waitForFunction(() => window.app && window.app.state);
ok('a presenter who reloads finds the talk where it was', JSON.stringify(await pos(pres)) === '[2,0]' && (await pres.evaluate(() => window.app.state.ink.survive?.length)) === 1);
await pres.keyboard.press('Escape');

console.log('--- dropped connections');
await goTo(pres, END, 0);
const proxyA = tcpProxy(port);
await proxyA.start();
const netPhoneContext = await phoneContext();
const netPhone = track(await page(netPhoneContext));
await netPhone.goto(`http://127.0.0.1:${proxyA.port}/join`);
await netPhone.waitForFunction(() => window.app && window.app.state && window.app.link.status === 'live');
await settle(netPhone, 500);
const beforeDrop = await tally(pres, 'end') ?? [0, 0, 0];
await proxyA.cut();
await until(netPhone, () => window.app.link.status === 'down', undefined, 'the phone notices the drop');
await until(netPhone, () => window.app.stage.get('offline'), undefined, 'and says it is reconnecting');
await settle(netPhone, 400);
await netPhone.screenshot({ path: `${SHOTS}/phone-reconnecting.png` });
await until(pres, (n) => window.app.state.counts.phones === n, 6, 'the room stops counting it');
await tap(netPhone, 'opt-end-0');
ok('a vote during the drop shows on the phone', (await netPhone.evaluate(() => window.app.you.votes.end)) === 0);
await settle(pres, 300);
ok('but has not reached the room', JSON.stringify(await tally(pres, 'end') ?? [0, 0, 0]) === JSON.stringify(beforeDrop));
await netPhone.locator('#ask-text').fill('asked while offline');
await netPhone.locator('#ask-send').tap();
ok('a question during the drop waits', (await netPhone.textContent('#ask-status')).includes('when the connection returns'));
await proxyA.start();
await until(netPhone, () => window.app.link.status === 'live', undefined, 'the phone reconnects by itself', 8000);
const wanted = [beforeDrop[0] + 1, beforeDrop[1], beforeDrop[2]];
await until(pres, (w) => JSON.stringify(window.app.state.tallies.end) === w, JSON.stringify(wanted), 'its vote then counts, once');
await until(pres, () => document.querySelectorAll('#p-questions li').length === 1, undefined, 'its question arrives');
await until(netPhone, () => window.app.link.waiting.length === 0, undefined, 'nothing is left waiting');
await pres.click('#p-questions button[data-action=remove]');

// The presenter and an audience screen lose the connection together.
const proxyB = tcpProxy(port);
await proxyB.start();
const netPres = await openScreen(context, `http://127.0.0.1:${proxyB.port}${PATH}?role=presenter`);
const netAudContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const netAud = await openScreen(netAudContext, `http://127.0.0.1:${proxyB.port}${PATH}?role=audience`);
await goTo(pres, 4, 0);
await until(netAud, () => window.app.state.index === 4, undefined, 'the connections are in sync before the drop');
await settle(netPres, 300);
await proxyB.cut();
await until(netPres, () => window.app.link.status === 'down', undefined, 'the presenter notices the drop');
ok('the panel tells the presenter to keep going', (await netPres.textContent('#p-status')).includes('Keep going'));
await until(netAud, () => !document.getElementById('pill').hidden, undefined, 'the audience screen shows it is reconnecting');
await netAud.screenshot({ path: `${SHOTS}/audience-reconnecting.png` });
await netPres.bringToFront();
await netPres.keyboard.press('ArrowRight');
const moveFrom = await center(netPres, 'drag-me');
await drag(netPres, moveFrom, { x: moveFrom.x + 150, y: moveFrom.y + 90 });
const inkAt = await point(netPres, 900, 780);
await drag(netPres, inkAt, { x: inkAt.x + 300, y: inkAt.y - 40 }, 20);
ok('the presenter can work through the drop', await netPres.evaluate(() => window.app.state.step === 1 && window.app.state.ink.layer.length === 1));
await settle(aud, 200);
ok('the room has not seen it yet', JSON.stringify(await pos(aud)) === '[4,0]');
await proxyB.start();
await until(netPres, () => window.app.link.status === 'live', undefined, 'the presenter reconnects', 8000);
await until(netAud, () => window.app.link.status === 'live', undefined, 'the audience screen reconnects', 8000);
await until(aud, () => window.app.state.step === 1 && window.app.state.ink.layer?.length === 1, undefined, 'what the presenter did offline reaches everyone');
await until(netAud, () => window.app.state.step === 1 && window.app.state.ink.layer?.length === 1, undefined, 'including the screen that dropped');
await until(netPres, () => window.app.link.waiting.length === 0, undefined, 'nothing is left waiting on the presenter');
await sameScreen(netPres, aud, 'after the drop the direct screen matches the presenter');
await sameScreen(netPres, netAud, 'after the drop the reconnected screen matches too');
const pointsOnline = (p) => p.evaluate(() => window.app.state.ink.layer[0].pts.length);
ok('no ink point arrives twice', (await pointsOnline(netPres)) === (await pointsOnline(aud)), [await pointsOnline(netPres), await pointsOnline(aud)]);

// The worst case: replies stop with no close, so the page only knows from silence,
// and what it sent did reach the room, so sending it again must not double it.
console.log('--- a connection that dies silently');
const startedSilence = Date.now();
proxyB.stallReplies();
const silentAt = await point(netPres, 300, 760);
await drag(netPres, silentAt, { x: silentAt.x + 240, y: silentAt.y + 30 }, 20);
await until(aud, () => window.app.state.ink.layer?.length === 2, undefined, 'what the page sends still reaches the room');
await settle(aud, 300);
const roomPoints = await aud.evaluate(() => window.app.state.ink.layer[1].pts.length);
ok('the page has had no answer', await netPres.evaluate(() => window.app.link.waiting.length > 0));
await until(netPres, () => window.app.link.status === 'down' || window.app.link.attempts > 0 , undefined, 'silence is noticed', 16000);
console.log(`     noticed after ${((Date.now() - startedSilence) / 1000).toFixed(1)}s`);
await until(netPres, () => window.app.link.status === 'live' && window.app.link.waiting.length === 0, undefined, 'the page reconnects and resends', 10000);
await settle(aud, 300);
ok('what was sent twice counts once', (await aud.evaluate(() => window.app.state.ink.layer[1].pts.length)) === roomPoints, roomPoints);
ok('the server copy still matches', (await netPres.evaluate(() => window.app.state.ink.layer[1].pts.length)) === roomPoints);
await netPres.keyboard.press('Escape');
await netPres.close();
await netAudContext.close();
await netPhoneContext.close();
await pres.bringToFront();

console.log('--- what the server refuses');
const stateBefore = await pos(pres);
await phones[1].evaluate(() => window.app.link.send({ t: 'goto', index: 0, step: 0 }));
await phones[1].evaluate(() => window.app.link.send({ t: 'home', slide: 'layer' }));
await aud.evaluate(() => window.app.link.send({ t: 'vote', slide: 'layer', option: 0 }));
await settle(pres, 300);
ok('a phone cannot move the deck', JSON.stringify(await pos(pres)) === JSON.stringify(stateBefore));
await goTo(pres, END, 0);
const endBefore = JSON.stringify(await tally(pres, 'end'));
await phones[3].evaluate(() => { const { ws } = window.app.link; ws.send('not json at all'); ws.send('x'.repeat(100000)); ws.send('{"t":"vote"}'); ws.send('null'); ws.send('[]'); });
await aud.evaluate(() => window.app.link.send({ t: 'vote', slide: 'end', option: 0 }));
await phones[3].evaluate(() => window.app.link.send({ t: 'vote', slide: 'end', option: 99 }));
await settle(pres, 300);
ok('rubbish, an audience vote and a bad option change nothing', JSON.stringify(await tally(pres, 'end')) === endBefore);
await tap(phones[3], 'opt-end-1');
await until(pres, () => window.app.state.tallies.end[1] >= 1, undefined, 'the server is fine afterwards');
const refused = (headers, query = 'client=aaaaaaaa&session=bbbbbbbb') => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live-deck/ws?${query}`, { headers });
  ws.on('close', (code) => resolve(code));
  ws.on('error', () => resolve('error'));
  ws.on('message', () => { ws.close(); resolve('accepted'); });
});
ok('another website cannot connect', (await refused({ Origin: 'http://evil.example' })) === 4003);
ok('a connection without an identity is refused', (await refused({}, 'role=phone')) === 4004);
ok('a room with a bad name is refused', (await refused({}, 'room=../../etc&client=aaaaaaaa&session=bbbbbbbb')) === 4004);
ok('presenting is limited to this machine', isThisMachine('127.0.0.1') && isThisMachine('::ffff:127.0.0.1') && !isThisMachine('8.8.8.8'));
ok('a strange element id is refused', cleanPresenterOp({ t: 'offset', slide: 'layer', id: '__proto__', dx: 1, dy: 1 }, newState()) === null);
ok('tunnels are skipped when picking an address', lanAddress({ utun3: [{ family: 'IPv4', address: '100.64.0.1', internal: false }], en0: [{ family: 'IPv4', address: '192.168.1.5', internal: false }], lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] }) === '192.168.1.5');

console.log('--- a real network address');
const open0 = await startServer(0, { host: '0.0.0.0', quiet: true });
const lan = lanAddress();
if (lan) {
  const lanBase = `http://${lan}:${open0.port}`;
  const lanInfo = await (await fetch(`${lanBase}/live-deck/info`)).json();
  ok('opened to the network, the server says phones can reach it', lanInfo.reachable === true && lanInfo.joinUrl === `${lanBase}/join`, lanInfo.joinUrl);
  const lanPresContext = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const lanPres = await openScreen(lanPresContext, lanBase + PATH);
  ok('the laptop presents over its own address', (await lanPres.evaluate(() => window.app.role)) === 'presenter');
  ok('and the slide drops the warning', (await lanPres.evaluate(() => window.app.stage.get('join-note').text)) === 'Same wifi as this laptop.');

  // Read the code from the pixels on the slide, as a camera would.
  await lanPres.addScriptTag({ path: fileURLToPath(new URL('../node_modules/jsqr/dist/jsQR.js', import.meta.url)) });
  const scan = (options = {}) => lanPres.evaluate(({ scale = 1, blur = 0, angle = 0 }) => {
    const src = document.getElementById('stage');
    const w = Math.round(src.width * scale), h = Math.round(src.height * scale);
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.filter = blur ? `blur(${blur}px)` : 'none';
    ctx.translate(w / 2, h / 2);
    ctx.rotate(angle);
    ctx.translate(-w / 2, -h / 2);
    ctx.drawImage(src, 0, 0, w, h);
    return window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h)?.data ?? null;
  }, options);
  await lanPres.waitForTimeout(500);
  await lanPres.screenshot({ path: `${SHOTS}/qr-title.png` });
  const scanned = await scan();
  ok('the code on the title slide scans to the join address', scanned === lanInfo.joinUrl, scanned);
  ok('it still scans small, blurred and tilted', (await scan({ scale: 0.5, blur: 1, angle: 0.12 })) === lanInfo.joinUrl);
  const voteAt = SLIDES.findIndex((slide) => slide.vote);
  await goTo(lanPres, voteAt, 0);
  await lanPres.waitForTimeout(500);
  await lanPres.screenshot({ path: `${SHOTS}/qr-vote.png` });
  ok('the code on a vote slide scans too', (await scan()) === lanInfo.joinUrl);
  await goTo(lanPres, SLIDES.findIndex((slide) => slide.id === 'race'), 0);
  await lanPres.waitForTimeout(500);
  await lanPres.screenshot({ path: `${SHOTS}/qr-race.png` });
  ok('the code on the race slide scans too, for whoever arrives late', (await scan()) === lanInfo.joinUrl);
  await goTo(lanPres, 0, 0);
  await lanPres.waitForTimeout(300);

  const lanPhoneContext = await phoneContext();
  const lanPhone = track(await page(lanPhoneContext));
  await lanPhone.goto(scanned);
  await lanPhone.waitForFunction(() => window.app && window.app.state);
  await until(lanPres, () => window.app.stage.get('join-count')?.text === '1 phone connected', undefined, 'a phone joins through the scanned code');
  ok('the token works without https', (await lanPhone.evaluate(() => window.isSecureContext)) === false && (await lanPhone.evaluate(() => window.app.link.client.length)) > 8);
  await lanPresContext.close();
  await lanPhoneContext.close();
} else console.log('     skipped: this machine has no network address');
await open0.close();

console.log('--- 200 phones at once');
await goTo(pres, END, 0);
const crowdStart = await tally(pres, 'end');
const crowdBase = crowdStart.reduce((s, v) => s + v, 0);
const crowd = await Promise.all(Array.from({ length: 200 }, (_, i) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live-deck/ws?role=phone&client=crowd-${String(i).padStart(4, '0')}&session=crowd-s-${String(i).padStart(4, '0')}`);
  ws.once('message', () => resolve(ws));
  ws.on('error', reject);
})));
await until(pres, () => window.app.state.counts.phones >= 200, undefined, 'the room counts them');
const worst = pres.evaluate(async () => { const { stage } = window.app; let most = 0; const begin = performance.now(); while (performance.now() - begin < 1500) { most = Math.max(most, stage.frameMs); await new Promise(requestAnimationFrame); } return most; });
const voted = Date.now();
crowd.forEach((ws, i) => ws.send(JSON.stringify({ t: 'vote', slide: 'end', option: i % 3, n: 1 })));
await until(pres, (want) => window.app.state.tallies.end.reduce((a, b) => a + b, 0) === want, crowdBase + 200, 'all 200 votes count');
const landed = Date.now() - voted;
ok('and reach the audience screen', await aud.waitForFunction((want) => window.app.state.tallies.end.reduce((a, b) => a + b, 0) === want, crowdBase + 200, { timeout: 3000 }).then(() => true, () => false));
console.log(`     200 votes reached the presenter in ${landed} ms. Worst presenter frame ${(await worst).toFixed(1)} ms`);
await settle(pres, 500);
await pres.screenshot({ path: `${SHOTS}/presenter-crowd.png` });
for (const ws of crowd) ws.terminate();
await until(pres, () => window.app.state.counts.phones < 50, undefined, 'they leave the count');
for (const c of browser.contexts()) {
  if (c === context) for (const p of c.pages()) await p.close();
  else await c.close();
}
}

// ---------------------------------------------------------------------------
// Activities. Each part has its own room, so it starts from a clean state.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const statsOf = async (room) => (await fetch(`${base}/live-deck/stats?room=${room}`)).json();
const quantile = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0; };

/** Close each part's pages, so one part's rendering does not slow the next part's measurements. */
async function closeEverything() {
  for (const c of browser.contexts()) {
    if (c === context) for (const p of c.pages()) await p.close();
    else await c.close();
  }
}

/** A 320 by 568 phone, the smallest in common use, must fit a controller. */
async function fitsSmallPhone(room, name) {
  const c = await browser.newContext({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const p = track(await page(c));
  await p.goto(`${base}/join?room=${room}`);
  await p.waitForFunction(() => window.app?.control);
  await settle(p, 500);
  ok(`the ${name} controller fits a small phone`, (await offStage(p)).length === 0, await offStage(p));
  await p.screenshot({ path: `${SHOTS}/${name}-phone-small.png` });
  await c.close();
}

/** Phones are built upright. A phone held sideways is told so rather than shown a broken layout. */
async function sideways(room) {
  const c = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const p = track(await page(c));
  await p.goto(`${base}/join?room=${room}`);
  await p.waitForFunction(() => window.app?.control);
  ok('a phone held sideways is asked to turn upright', await p.evaluate(() => getComputedStyle(document.getElementById('turn')).display === 'flex'));
  await p.setViewportSize({ width: 390, height: 844 });
  ok('and the message goes when it does', await p.evaluate(() => getComputedStyle(document.getElementById('turn')).display === 'none'));
  await c.close();
}

/** Open a presenter, an audience screen and some real phones in one room. */
async function openRoom(room, phoneCount) {
  const presenter = await openScreen(context, `${base}${PATH}?room=${room}`);
  const audienceCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const audience = await openScreen(audienceCtx, `${base}${PATH}?role=audience&room=${room}`);
  const real = [];
  for (let i = 0; i < phoneCount; i++) {
    const c = await phoneContext();
    const p = track(await page(c));
    await p.goto(`${base}/join?room=${room}`);
    await p.waitForFunction(() => window.app && window.app.state);
    real.push(p);
  }
  return { presenter, audience, audienceCtx, real };
}

async function goToSlide(p, id, step = 0) {
  const index = SLIDES.findIndex((s) => s.id === id);
  for (let i = 0; i < 80; i++) {
    const [a, b] = await pos(p);
    if (a === index && b === step) return;
    await p.keyboard.press(a < index || (a === index && b < step) ? 'ArrowRight' : 'ArrowLeft');
  }
  throw new Error(`never reached ${id}:${step}`);
}

// Real multi-touch through the browser's input pipeline, which pointer events come from.
async function fingersOn(p) {
  const cdp = await p.context().newCDPSession(p);
  let down = false;
  return {
    async set(points) {
      const touchPoints = points.map((pt, id) => ({ x: pt.x, y: pt.y, id }));
      if (!points.length) { if (down) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); down = false; return; }
      await cdp.send('Input.dispatchTouchEvent', { type: down ? 'touchMove' : 'touchStart', touchPoints });
      down = true;
    },
  };
}

/** What a room costs while it runs: the server per tick and per second, the presenter's frames. */
async function measureRoom(room, screen, ms, label) {
  const before = await statsOf(room);
  const started = Date.now();
  const frames = await screen.evaluate(async (ms) => {
    const { stage } = window.app;
    const gaps = [], renders = [];
    let last = performance.now();
    const begin = last;
    while (last - begin < ms) {
      await new Promise(requestAnimationFrame);
      const now = performance.now();
      gaps.push(now - last);
      renders.push(stage.frameMs);
      last = now;
    }
    return { gaps, renders };
  }, ms);
  const after = await statsOf(room);
  const seconds = (Date.now() - started) / 1000;
  const report = {
    tickAvgMs: +((after.tickMs - before.tickMs) / Math.max(1, after.ticks - before.ticks)).toFixed(3),
    tickWorstMs: +after.tickMsWorst.toFixed(1),
    inPerSec: Math.round((after.messagesIn - before.messagesIn) / seconds),
    outPerSec: Math.round((after.messagesOut - before.messagesOut) / seconds),
    outKBPerSec: Math.round((after.bytesOut - before.bytesOut) / seconds / 1024),
    frameP50: +quantile(frames.gaps, 0.5).toFixed(1),
    frameP95: +quantile(frames.gaps, 0.95).toFixed(1),
    renderP95: +quantile(frames.renders, 0.95).toFixed(1),
  };
  console.log(`     ${label}: ${JSON.stringify(report)}`);
  return report;
}

if (want('race')) {
  console.log('--- race: the model');
  const fakeHost = (state = newState()) => ({ state, emit() {}, toPresenter() {} });
  const raceSlide = slideById('race');
  const runRace = (race, seconds, each) => { for (let i = 0; i < seconds * 60; i++) { each?.(i); race.tick(1 / 60); } };

  // The best run a person could make: run flat out and jump at the last moment at each edge.
  const expert = (race, id, seen) => () => {
    const { player: p } = race.racers.get(id).sim;
    seen.furthest = Math.max(seen.furthest, p.x);
    const atEdge = [360, 820].some((edge) => p.x > edge - 26 && p.x < edge + 5);
    // Press at the edge, and keep holding on the way up for the full height.
    // Past the flag, it turns back, as anyone would.
    race.input(id, { i: (p.x > 1500 ? 1 : 2) | ((atEdge && p.grounded) || (!p.grounded && p.vy < 0) ? 4 : 0) });
  };
  const host = fakeHost();
  const race = new Race(raceSlide, host);
  race.join('solo-phone');
  race.setStep(1);
  const seen = { furthest: 0 };
  runRace(race, 30, expert(race, 'solo-phone', seen));
  ok('the best possible run clears the first gap and reaches the second', seen.furthest > 815, Math.round(seen.furthest));
  ok('but cannot cross the second', race.done.length === 0 && seen.furthest < 1290, { furthest: Math.round(seen.furthest), deaths: race.racers.get('solo-phone').sim.deaths });
  host.state.ink.race = [{ id: 'bridge', pts: Array.from({ length: 48 }, (_, k) => [820 + k * 10, 580 - k * (100 / 47)]) }];
  race.layout();
  runRace(race, 30, expert(race, 'solo-phone', seen));
  ok('with a line drawn across it, the same run reaches the flag', race.done.length === 1, race.done);

  // Many figures in one level must not interfere: Sim marks shared segments with a counter.
  const crowdHost = fakeHost();
  const crowdRace = new Race(raceSlide, crowdHost);
  for (let i = 0; i < 40; i++) crowdRace.join(`phone-${i}`);
  runRace(crowdRace, 2);
  ok('forty figures in one level all stand on the first box', [...crowdRace.racers.values()].every((r) => r.sim.player.grounded && !r.sim.player.dead && Math.abs(r.sim.player.y - (640 - 14)) < 2));
  const xs = [...crowdRace.racers.values()].map((r) => Math.round(r.sim.player.x));
  ok('and start spread out along it', Math.max(...xs) - Math.min(...xs) > 150 && new Set(xs).size > 30);

  // A box dragged over a figure must not trap it inside the outline.
  const liftHost = fakeHost();
  const lift = new Race(raceSlide, liftHost);
  lift.join('standing');
  runRace(lift, 1);
  liftHost.state.offsets.race = { 'race-view': [-350, 0] };
  lift.layout();
  runRace(lift, 1);
  const lifted = lift.racers.get('standing').sim.player;
  ok('a box dragged onto a figure leaves it standing on top', lifted.grounded && lifted.y < 580 - 14 + 2 && !lifted.dead, { y: Math.round(lifted.y) });
  ok('the level moves with an offset', raceLevel(raceSlide.activity, { 'race-view': [0, 100] }, []).bodies.find((b) => b.id === 'race-view').minY === 680);
  ok('ink is ground, not a hazard, whatever its color on screen', raceLevel(raceSlide.activity, {}, [{ id: 'a', pts: [[0, 0], [100, 0]] }]).bodies.find((b) => b.id === 'ink-a').role === 'solid');

  const fullRace = new Race(raceSlide, fakeHost());
  for (let i = 0; i < 205; i++) fullRace.join(`phone-${i}`);
  ok('the race holds at most 200 figures, and tells the rest', fullRace.racers.size === 200 && fullRace.you('phone-204').full === true);
  const inputRace = new Race(raceSlide, fakeHost());
  inputRace.join('p');
  for (const bad of [{ i: 8 }, { i: -1 }, { i: 'x' }, { i: 1.5 }, {}]) inputRace.input('p', bad);
  ok('bad input is ignored', inputRace.racers.get('p').bits === 0);

  console.log('--- race: on real pages');
  const room = 't-race';
  const { presenter, audience, real } = await openRoom(room, 3);
  await goToSlide(presenter, 'race');
  const figures = (p) => p.evaluate(() => [...window.app.running.crowd.figures.values()].map((f) => ({ n: f.number, x: f.x, y: f.y, dead: f.dead, gone: f.gone, won: f.won })));
  const figure = async (p, n) => (await figures(p)).find((f) => f.n === n);
  await until(audience, () => window.app.running?.crowd.figures.size === 3, undefined, 'three figures appear on the audience screen');
  await until(real[0], () => window.app.control?.state?.number, undefined, 'each phone learns its number');
  const numbers = await Promise.all(real.map((p) => p.evaluate(() => window.app.control.state.number)));
  ok('the numbers are all different', new Set(numbers).size === 3, numbers);
  ok('the question box steps aside on the phone', await real[0].evaluate(() => document.getElementById('ask').hidden));
  await settle(real[0], 300);
  await real[0].screenshot({ path: `${SHOTS}/race-phone.png` });
  ok('nothing on the controller runs off the page', (await offStage(real[0])).length === 0, await offStage(real[0]));
  await fitsSmallPhone(room, 'race');
  await sideways(room);
  const n0 = numbers[0], n1 = numbers[1];

  const finger = await fingersOn(real[0]);
  const rightAt = await center(real[0], 'race-right');
  const jumpAt = await center(real[0], 'race-jump');
  const leftAt = await center(real[0], 'race-left');
  await settle(audience, 1200);
  const start0 = await figure(audience, n0);
  // To a tenth of a pixel, far finer than anyone could see.
  const still = await audience.evaluate(async (n) => {
    const fig = window.app.running.crowd.figures.get(n);
    const seen = new Set();
    const rounded = (v) => (Array.isArray(v) ? v.map(rounded) : Math.round(v * 10));
    for (let i = 0; i < 40; i++) { seen.add(JSON.stringify(fig.rig.elements().map((e) => [rounded(e.x), rounded(e.y), rounded(e.points ?? [])]))); await new Promise(requestAnimationFrame); }
    return seen.size;
  }, n0);
  ok('a figure standing still has perfectly still limbs', still === 1, still);
  // From the finger landing to the figure moving on another page, on this machine.
  const delays = [];
  for (let i = 0; i < 6; i++) {
    const watching = audience.evaluate(async (n) => {
      const fig = window.app.running.crowd.figures.get(n);
      const from = fig.x;
      while (Math.abs(fig.x - from) < 0.5) await new Promise(requestAnimationFrame);
      return Date.now();
    }, n0);
    const pressed = Date.now();
    await finger.set([i % 2 ? rightAt : leftAt]);
    delays.push((await watching) - pressed);
    await sleep(120);
    await finger.set([]);
    await sleep(350);
  }
  console.log(`     a press moves the figure after ${quantile(delays, 0.5)} ms (worst ${Math.max(...delays)} ms), with no network between them`);
  ok('a press shows quickly on the big screen', quantile(delays, 0.5) < 250, delays);
  await finger.set([leftAt]);
  await until(real[0], () => window.app.control.bits === 1, undefined, 'a finger on Left presses Left');
  await until(audience, ([n, x]) => window.app.running.crowd.figures.get(n).x < x - 8, [n0, start0.x], 'the figure walks left on the audience screen');
  await finger.set([rightAt]);
  await until(real[0], () => window.app.control.bits === 2, undefined, 'sliding the finger to Right changes direction');
  await until(audience, ([n, x]) => window.app.running.crowd.figures.get(n).x > x + 40, [n0, start0.x], 'and the figure runs right');
  const stride = await audience.evaluate(async (n) => {
    const fig = window.app.running.crowd.figures.get(n);
    const seen = new Set();
    for (let i = 0; i < 20; i++) { seen.add(JSON.stringify(fig.rig.parts.legs[0][2].map(Math.round))); await new Promise(requestAnimationFrame); }
    return seen.size;
  }, n0);
  ok('its legs move because it moves', stride > 5, stride);
  await finger.set([leftAt, jumpAt]);
  await until(real[0], () => window.app.control.bits === 5, undefined, 'two thumbs at once: Left and Jump');
  await until(audience, ([n, y]) => window.app.running.crowd.figures.get(n).y < y - 80, [n0, start0.y], 'and the figure jumps while moving');
  await settle(audience, 150);
  await audience.screenshot({ path: `${SHOTS}/race-jump.png` });
  await finger.set([]);
  await until(real[0], () => window.app.control.bits === 0, undefined, 'lifting both thumbs lets go');

  // The race itself, with a real finger making the run.
  await presenter.keyboard.press('ArrowRight');
  await until(audience, () => window.app.state.step === 1 && window.app.state.live.race?.clock !== null, undefined, 'Next starts the race and the clock');
  await until(audience, ([n, x]) => Math.abs(window.app.running.crowd.figures.get(n).x - x) < 200, [n0, 190], 'everyone goes back to the start');
  await settle(audience, 300);

  // Run right and jump at the first gap. The screen shows the figure slightly behind where it is.
  async function runToSecondGap() {
    for (let attempt = 0; attempt < 4; attempt++) {
      await finger.set([rightAt]);
      for (let i = 0; i < 200; i++) {
        const fig = await figure(audience, n0);
        if (fig && fig.x > 262) break;
        await sleep(10);
      }
      await finger.set([rightAt, jumpAt]);
      await sleep(380);
      await finger.set([rightAt]);
      await sleep(350);
      const fig = await figure(audience, n0);
      if (fig.x > 500 && fig.y < 620) return;
      await finger.set([]);
      await audience.waitForFunction((n) => { const f = window.app.running.crowd.figures.get(n); return !f.dead && f.y < 640 && f.x < 360; }, n0, { timeout: 5000 });
      await settle(audience, 300);
    }
  }
  await runToSecondGap();
  await until(audience, ([n]) => window.app.running.crowd.figures.get(n).x > 530, [n0], 'a real finger gets across the first gap');
  await until(real[0], () => window.app.control.state.out === true, undefined, 'the second gap is too wide: the phone says it fell', 8000);
  ok('nobody is at the flag', (await audience.evaluate(() => window.app.state.live.race.done.length)) === 0);
  await finger.set([]);
  await settle(audience, 1200);
  await audience.screenshot({ path: `${SHOTS}/race-no-bridge.png` });
  await real[0].screenshot({ path: `${SHOTS}/race-phone-fell.png` });

  // The presenter draws across the gap, starting on a box, with the plain mouse.
  const bridgeA = await point(presenter, 805, 578), bridgeB = await point(presenter, 1300, 476);
  await drag(presenter, bridgeA, bridgeB, 40);
  await until(audience, () => window.app.state.ink.race?.length === 1, undefined, 'on this slide a drag that starts on a box draws');
  ok('it does not move the box', await presenter.evaluate(() => !window.app.state.offsets.race?.['race-view']));
  await runToSecondGap();
  await until(audience, ([n]) => window.app.running.crowd.figures.get(n).x > 1000 && window.app.running.crowd.figures.get(n).y < 620, [n0], 'the figure runs across the ink', 8000);
  await presenter.screenshot({ path: `${SHOTS}/race-bridge.png` });
  await until(audience, (n) => window.app.state.live.race.done[0]?.[0] === n, n0, 'and reaches the flag', 6000);
  await until(real[0], () => window.app.control.state.place === 1, undefined, 'the phone is told it came first');
  await finger.set([]);
  await settle(real[0], 300);
  await real[0].screenshot({ path: `${SHOTS}/race-phone-won.png` });

  // A phone drops in the middle of the race, with its finger still down.
  const proxy = tcpProxy(port);
  await proxy.start();
  const dropContext = await phoneContext();
  const dropPhone = track(await page(dropContext));
  await dropPhone.goto(`http://127.0.0.1:${proxy.port}/join?room=${room}`);
  await dropPhone.waitForFunction(() => window.app?.control?.state?.number);
  const dropNumber = await dropPhone.evaluate(() => window.app.control.state.number);
  await until(audience, (n) => window.app.running.crowd.figures.has(n), dropNumber, 'a late phone joins the race');
  const dropFinger = await fingersOn(dropPhone);
  await settle(dropPhone, 300);
  await dropFinger.set([await center(dropPhone, 'race-left')]);
  await until(audience, (n) => Math.abs(window.app.running.crowd.figures.get(n).x) > 0 && window.app.state.live.race.racers.find((r) => r[0] === n)?.[5] < -100, dropNumber, 'its figure runs');
  await proxy.cut();
  await until(audience, (n) => window.app.running.crowd.figures.get(n)?.gone === true, dropNumber, 'when it drops, its figure dims', 3000);
  await settle(audience, 500);
  const stoppedAt = await figure(audience, dropNumber);
  await settle(audience, 600);
  ok('and stops where it is', Math.abs((await figure(audience, dropNumber)).x - stoppedAt.x) < 2);
  await audience.screenshot({ path: `${SHOTS}/race-dropped.png` });
  const others = await fingersOn(real[1]);
  const before1 = await figure(audience, n1);
  await others.set([await center(real[1], 'race-right')]);
  await until(audience, ([n, x]) => window.app.running.crowd.figures.get(n).x > x + 30, [n1, before1.x], 'everyone else plays on');
  await others.set([]);
  await proxy.start();
  await until(dropPhone, () => window.app.link.status === 'live', undefined, 'the phone reconnects', 8000);
  ok('with the same number', (await dropPhone.evaluate(() => window.app.control.state.number)) === dropNumber);
  await until(audience, (n) => window.app.running.crowd.figures.get(n)?.gone === false, dropNumber, 'its figure comes back');
  const backAt = await figure(audience, dropNumber);
  await until(audience, ([n, x]) => Math.abs(window.app.running.crowd.figures.get(n).x - x) > 10 || window.app.running.crowd.figures.get(n).dead, [dropNumber, backAt.x], 'and the finger still down keeps it running');
  await dropFinger.set([]);
  await dropContext.close();

  // A line under a crowd in the air.
  await presenter.keyboard.press('Escape');
  await until(audience, () => !window.app.state.ink.race?.length, undefined, 'Esc takes the ink away');
  const bots = await connectPhones(port, room, 30);
  await until(audience, () => window.app.running.crowd.figures.size >= 33, undefined, '30 simulated phones join');
  await presenter.keyboard.press('ArrowRight');
  await presenter.keyboard.press('ArrowLeft');
  await until(audience, () => window.app.state.live.race?.clock < 800, undefined, 'going back to the race starts it again');
  const netA = await point(presenter, 362, 770), netB = await point(presenter, 508, 770);
  await drag(presenter, netA, netB, 12);
  await until(presenter, () => window.app.state.ink.race?.length === 1, undefined, 'the presenter draws under the first gap');
  await sleep(250);
  bots.forEach((b) => b.send({ t: 'act', i: 2 }));
  await sleep(1800);
  const caught = await audience.evaluate(() => window.app.state.live.race.racers.filter((r) => r[1] > 350 && r[1] < 520 && Math.abs(r[2] - 756) < 8 && (r[7] & 1)).length);
  ok('the line catches the crowd that walks off the box', caught >= 25, caught);
  await presenter.screenshot({ path: `${SHOTS}/race-crowd-caught.png` });
  await audience.screenshot({ path: `${SHOTS}/race-crowd-caught-audience.png` });
  await presenter.keyboard.press('Escape');
  await sleep(1000);
  const fell = await audience.evaluate(() => window.app.state.live.race.racers.filter((r) => r[1] > 350 && r[1] < 520 && Math.abs(r[2] - 756) < 8).length);
  ok('and Esc drops them', fell < 3, fell);

  console.log('--- race: limits');
  const flood = await connectPhone(port, room, 900);
  const before = await statsOf(room);
  for (let i = 0; i < 5000; i++) flood.ws.send('{"t":"act","i":2}');
  flood.ws.send('x'.repeat(100000));
  flood.ws.send('{"t":"act","i":999}');
  await sleep(600);
  const after = await statsOf(room);
  ok('a flood from one phone is dropped, not processed', after.dropped - before.dropped > 4500, { dropped: after.dropped - before.dropped, applied: after.inputs - before.inputs });
  ok('it stays connected and the server stays up', flood.ws.readyState === 1);
  flood.close();
  const lateScreenContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const lateScreen = await openScreen(lateScreenContext, `${base}${PATH}?role=audience&room=${room}`);
  await until(lateScreen, () => window.app.running?.crowd.figures.size >= 30, undefined, 'a late screen sees the crowd at once');
  await lateScreenContext.close();

  console.log('--- race: at scale');
  const stopBots = raceBots(bots);
  await sleep(1500);
  const raceReport = await measureRoom(room, presenter, 6000, '33 phones racing, on the presenter');
  ok('the server stays well under its tick', raceReport.tickAvgMs < 8, raceReport.tickAvgMs);
  ok('the presenter stays smooth', raceReport.frameP95 < 40, raceReport.frameP95);
  await presenter.screenshot({ path: `${SHOTS}/race-30-phones.png` });
  await audience.screenshot({ path: `${SHOTS}/race-30-phones-audience.png` });
  const more = await connectPhones(port, room, 167, 100);
  const stopMore = raceBots(more);
  await sleep(1500);
  const bigReport = await measureRoom(room, presenter, 5000, '200 phones racing, on the presenter');
  ok('200 figures still fit in a tick', bigReport.tickAvgMs < 10, bigReport.tickAvgMs);
  await presenter.screenshot({ path: `${SHOTS}/race-200-phones.png` });
  stopBots();
  stopMore();
  for (const b of [...bots, ...more]) b.close();
  await presenter.keyboard.press('ArrowRight');
  await until(audience, () => window.app.state.step === 2, undefined, 'Next ends the race');
  const logged = await statsOf(room);
  console.log(`     this race's room logged ${logged.log.entries} changes, ${Math.round(logged.log.bytes / 1024)} KB`);
  await settle(presenter, 1000);
  await presenter.screenshot({ path: `${SHOTS}/race-result.png` });
  await sameScreen(presenter, audience, 'audience matches presenter at the result');
  await closeEverything();
}

if (want('queue')) {
  console.log('--- queue: the model');
  // Workers who tap a job after a person's pause, unless told to stop.
  function runQueue(model, seconds, { tapping = true, reaction = 0.4, onTick } = {}) {
    const dt = 0.05;
    for (let t = 0; t < seconds; t += dt) {
      model.advance(dt);
      if (tapping) {
        for (const w of model.workers.values()) {
          if (w.gone) continue;
          if (w.stalled) model.wake(w.id);
          if (w.job && model.now - w.heldSince >= reaction) model.tap(w.id, w.job.id);
        }
      }
      onTick?.();
    }
  }
  const model = new QueueModel({ seed: 7 });
  for (let i = 0; i < 30; i++) model.join(`worker-${i}`);
  let lost = 0;
  const balance = () => { if (model.arrived !== model.finished + model.line.length + model.held() + model.turnedAway) lost++; };
  model.setLoad(0.5, '50%');
  let peak = 0;
  runQueue(model, 60, { onTick: () => { balance(); peak = Math.max(peak, model.line.length); } });
  ok('at 50% with people tapping, the line stays short', peak < 12, peak);
  model.setLoad(0.9, '90%');
  const at90 = [];
  runQueue(model, 60, { onTick: () => { balance(); at90.push(model.line.length); } });
  ok('at 90% the line is longer but still clears', Math.max(...at90) > peak && Math.min(...at90) === 0, { peak: Math.max(...at90) });
  model.setLoad(0.9, 'stop');
  const stoppedFrom = model.line.length;
  runQueue(model, 10, { tapping: false, onTick: balance });
  const backedUp = model.line.length;
  ok('when people stop tapping, the line backs up', backedUp - stoppedFrom > 100, { from: stoppedFrom, to: backedUp });
  ok('and everyone holding a job has lost it', [...model.workers.values()].every((w) => w.stalled && !w.job));
  model.setLoad(0.5, '50%');
  let clearSeconds = 0;
  runQueue(model, 120, { onTick: () => { balance(); if (model.line.length > 0) clearSeconds += 0.05; } });
  ok('the backlog takes longer to clear than it took to build', clearSeconds > 10 && model.line.length < 20, { build: 10, clear: Math.round(clearSeconds) });
  ok('every job is accounted for at every moment', lost === 0, lost);

  const small = new QueueModel({ seed: 3 });
  small.join('a'); small.join('b');
  small.setLoad(3, 'x');
  runQueue(small, 3, { tapping: false });
  const heldJob = small.workers.get('a').job.id;
  ok('a stale job id finishes nothing', !small.tap('a', heldJob + 999) && small.finished === 0);
  ok('a real one finishes', small.tap('a', heldJob) && small.finished === 1);
  ok('a second tap on the same job counts once', !small.tap('a', heldJob) && small.finished === 1);
  small.advance(0.1);
  ok('a worker rests before the next job', small.workers.get('a').job === null);
  const heldByB = small.workers.get('b').job;
  small.leave('b');
  ok('a dropped phone returns its job to the front of the line', small.line[0] === heldByB && small.workers.get('b').job === null);
  ok('the rate follows who is connected', Math.abs(small.rate() - 3 * 0.6) < 1e-9, small.rate());
  small.join('b');
  ok('it returns as the same worker', small.workers.get('b').number === 2 && !small.workers.get('b').gone);
  const crowded = new QueueModel();
  for (let i = 0; i < 205; i++) crowded.join(`w${i}`);
  ok('at most 200 desks', crowded.workers.size === 200);
  const tooLong = new QueueModel({ seed: 1 });
  tooLong.join('x');
  tooLong.setLoad(500, 'x');
  for (let i = 0; i < 60; i++) tooLong.advance(1);
  ok('the line has a limit, and jobs past it are counted', tooLong.line.length <= 401 && tooLong.turnedAway > 0 && tooLong.arrived === tooLong.finished + tooLong.line.length + tooLong.held() + tooLong.turnedAway);

  console.log('--- queue: on real pages');
  const room = 't-queue';
  const { presenter, audience, real } = await openRoom(room, 3);
  await goToSlide(presenter, 'queue');
  await until(audience, () => (window.app.state.live.queue?.workers.length ?? 0) === 3, undefined, 'three workers appear on the audience screen');
  await until(real[0], () => window.app.control?.state?.number, undefined, 'each phone learns its worker number');
  ok('the question box steps aside', await real[0].evaluate(() => document.getElementById('ask').hidden));
  await until(real[0], () => window.app.control.state.job > 0, undefined, 'a phone gets a job', 8000);
  await settle(real[0], 200);
  await real[0].screenshot({ path: `${SHOTS}/queue-phone-job.png` });
  ok('nothing on the card runs off the page', (await offStage(real[0])).length === 0, await offStage(real[0]));
  await fitsSmallPhone(room, 'queue');
  const job0 = await real[0].evaluate(() => window.app.control.state.job);
  await until(audience, (id) => window.app.stage.get(`job-${id}`) && window.app.stage.get(`job-${id}`).x > 1100, job0, 'that job sits on its worker on the big screen');
  const finishedBefore = await audience.evaluate(() => window.app.state.live.queue.finished);
  const card = await center(real[0], 'q-tap');
  await real[0].touchscreen.tap(card.x, card.y);
  await until(audience, (n) => window.app.state.live.queue.finished === n + 1, finishedBefore, 'a real tap finishes it');
  await until(audience, (id) => !window.app.state.live.queue.workers.some((w) => w[1] === id), job0, 'and it leaves the desk');
  ok('the phone counts it', (await real[0].evaluate(() => window.app.control.state.finished)) >= 1);

  // Stop tapping: the line backs up on the screen and workers go red.
  const bots = await connectPhones(port, room, 27);
  await until(audience, () => window.app.state.live.queue.workers.length >= 30, undefined, '27 simulated phones join');
  const stopTapping = queueBots(bots);
  const tapReal = setInterval(() => { for (const p of real) p.evaluate(() => { const { control, link } = window.app; if (control?.state?.job) { link.sendNow({ t: 'act', job: control.state.job }); } }).catch(() => {}); }, 400);
  await sleep(6000);
  const steady = await measureRoom(room, presenter, 5000, '30 phones tapping at 50%, on the presenter');
  ok('the server stays well under its tick', steady.tickAvgMs < 8, steady.tickAvgMs);
  ok('the presenter stays smooth', steady.frameP95 < 40, steady.frameP95);
  const short = await audience.evaluate(() => window.app.state.live.queue.waiting);
  ok('with everyone tapping at 50% the line is short', short < 20, short);
  await presenter.screenshot({ path: `${SHOTS}/queue-50.png` });
  await real[1].screenshot({ path: `${SHOTS}/queue-phone-idle.png` });
  await presenter.keyboard.press('ArrowRight');
  await until(audience, () => window.app.state.live.queue.step === 1 && window.app.state.live.queue.load === 0.9, undefined, 'Next raises the load to 90%');
  await sleep(8000);
  await presenter.screenshot({ path: `${SHOTS}/queue-90.png` });
  stopTapping();
  clearInterval(tapReal);
  const before = await audience.evaluate(() => window.app.state.live.queue.waiting);
  await presenter.keyboard.press('ArrowRight');
  await until(audience, () => window.app.state.step === 2, undefined, 'Next asks everyone to stop');
  await until(real[0], () => window.app.stage.get('q-order').text === 'Stop tapping now.', undefined, 'the phone says to stop');
  await real[0].screenshot({ path: `${SHOTS}/queue-phone-stop.png` });
  await sleep(7000);
  const backed = await audience.evaluate(() => window.app.state.live.queue);
  ok('the line backs up on the big screen', backed.waiting > before + 40, { before, now: backed.waiting });
  const redCount = await audience.evaluate(() => window.app.state.live.queue.workers.filter((w) => w[2] === 2).length);
  ok('workers who stopped turn red', redCount >= 25, redCount);
  ok('and the worker box is red on screen', await audience.evaluate(() => window.app.stage.get('w-1').strokeColor === '#c92a2a'));
  const shownJobs = await audience.evaluate(() => window.app.stage.elements().filter((e) => e.id.startsWith('job-')).length);
  ok('the waiting jobs are drawn', shownJobs >= Math.min(240, backed.waiting), { shownJobs, waiting: backed.waiting });
  await settle(presenter, 300);
  await presenter.screenshot({ path: `${SHOTS}/queue-stopped.png` });
  await audience.screenshot({ path: `${SHOTS}/queue-stopped-audience.png` });
  ok('the line stays on the slide', (await offStage(presenter)).filter((id) => id.startsWith('job-')).length === 0, await offStage(presenter));
  const redCard = await real[1].evaluate(() => window.app.control.state.stalled);
  ok('a stopped phone says so', redCard === true);
  await settle(real[1], 200);
  await real[1].screenshot({ path: `${SHOTS}/queue-phone-stalled.png` });
  const wake = await center(real[1], 'q-tap');
  await real[1].touchscreen.tap(wake.x, wake.y);
  await until(audience, () => window.app.state.live.queue.workers[1][2] !== 2, undefined, 'a tap brings a worker back');
  await until(real[1], () => window.app.control.state.job > 0, undefined, 'and hands it a job');

  // A phone drops while holding a job.
  const proxy = tcpProxy(port);
  await proxy.start();
  const dropContext = await phoneContext();
  const dropPhone = track(await page(dropContext));
  await dropPhone.goto(`http://127.0.0.1:${proxy.port}/join?room=${room}`);
  await dropPhone.waitForFunction(() => window.app?.control?.state?.job > 0);
  const dropState = await dropPhone.evaluate(() => window.app.control.state);
  await proxy.cut();
  await until(audience, (job) => window.app.state.live.queue.line.includes(job), dropState.job, 'when a phone drops, its job goes back in the line');
  await until(audience, (n) => window.app.state.live.queue.workers.find((w) => w[0] === n)?.[2] === 3, dropState.number, 'and its desk shows it is gone');
  await settle(audience, 200);
  await audience.screenshot({ path: `${SHOTS}/queue-dropped.png` });
  await until(dropPhone, () => window.app.stage.get('offline'), undefined, 'the phone says it is reconnecting');
  await proxy.start();
  await until(dropPhone, () => window.app.link.status === 'live', undefined, 'it reconnects', 8000);
  ok('as the same worker', (await dropPhone.evaluate(() => window.app.control.state.number)) === dropState.number);
  await dropContext.close();

  await presenter.keyboard.press('ArrowRight');
  await until(audience, () => window.app.state.live.queue.step === 3 && window.app.state.live.queue.load === 0.5, undefined, 'Next asks everyone to start again');
  const stopAgain = queueBots(bots);
  const peakBefore = await audience.evaluate(() => window.app.state.live.queue.waiting);
  await sleep(8000);
  const falling = await audience.evaluate(() => window.app.state.live.queue.waiting);
  ok('the line falls once people tap', falling < peakBefore, { peakBefore, falling });
  await settle(presenter, 200);
  await presenter.screenshot({ path: `${SHOTS}/queue-recovering.png` });
  ok('the chart marks each step', (await audience.evaluate(() => window.app.state.live.queue.marks.map((m) => m[1]).join(','))) === '50%,90%,stop,50%', await audience.evaluate(() => window.app.state.live.queue.marks.map((m) => m[1]).join(',')));
  stopAgain();
  for (const b of bots) b.close();
  await sameScreen(presenter, audience, 'audience matches presenter, once settled', 800);
  await closeEverything();
}

if (want('gallery')) {
  console.log('--- gallery: the rules');
  ok('a drawing must be numbers', cleanStrokes([[['a', 1]]]) === null && cleanStrokes('x') === null && cleanStrokes([]) === null && cleanStrokes([[]]) === null);
  ok('points are kept inside the box and rounded', JSON.stringify(cleanStrokes([[[-5, 9000.7], [10.4, 20.6]]])) === '[[[0,400],[10,21]]]');
  ok('a drawing has a limit on strokes', cleanStrokes(Array.from({ length: LIMITS.strokes + 1 }, () => [[1, 1]])) === null);
  ok('and on points', cleanStrokes([Array.from({ length: LIMITS.points + 1 }, () => [1, 1])]) === null);

  console.log('--- gallery: on real pages');
  const room = 't-gallery';
  // Every byte the audience screen and another phone receive, to prove nothing leaks.
  const received = { audience: [], phone: [] };
  const listen = (p, into) => p.on('websocket', (ws) => ws.on('framereceived', (f) => into.push(String(f.payload))));
  const presenter = await openScreen(context, `${base}${PATH}?room=${room}`);
  const audienceCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const audience = track(await page(audienceCtx));
  listen(audience, received.audience);
  await audience.goto(`${base}${PATH}?role=audience&room=${room}`);
  await audience.waitForFunction(() => window.app && window.app.state);
  const real = [];
  for (let i = 0; i < 3; i++) {
    const c = await phoneContext();
    const p = track(await page(c));
    if (i === 2) listen(p, received.phone);
    await p.goto(`${base}/join?room=${room}`);
    await p.waitForFunction(() => window.app && window.app.state);
    real.push(p);
  }
  await goToSlide(presenter, 'draw');
  await until(real[0], () => window.app.stage.get('gal-pad'), undefined, 'each phone shows a drawing pad');
  ok('the question box steps aside', await real[0].evaluate(() => document.getElementById('ask').hidden));
  await settle(real[0], 400);
  ok('nothing on the pad runs off the page', (await offStage(real[0])).length === 0, await offStage(real[0]));
  await fitsSmallPhone(room, 'gallery');

  async function drawOn(p, shape) {
    const finger = await fingersOn(p);
    const box = await p.evaluate(() => { const e = window.app.stage.get('gal-pad'); return { x: e.x, y: e.y, w: e.width, h: e.height }; });
    for (const stroke of shape) {
      const pts = [];
      for (const [u, v] of stroke) pts.push(await point(p, box.x + u * box.w, box.y + v * box.h));
      await finger.set([pts[0]]);
      for (const pt of pts.slice(1)) await finger.set([pt]);
      await finger.set([]);
    }
  }
  const zigzag = [Array.from({ length: 16 }, (_, k) => [0.1 + k * 0.05, k % 2 ? 0.2 : 0.8])];
  const house = [[[0.2, 0.8], [0.2, 0.4], [0.5, 0.15], [0.8, 0.4], [0.8, 0.8], [0.2, 0.8]], [[0.45, 0.8], [0.45, 0.55], [0.55, 0.55], [0.55, 0.8]]];
  await drawOn(real[0], house);
  ok('a finger draws strokes', (await real[0].evaluate(() => window.app.control.strokes.length)) === 2);
  await until(real[0], () => window.app.stage.elements().filter((e) => e.type === 'freedraw').length === 2, undefined, 'and they show on the phone as it draws');
  await settle(real[0], 150);
  await real[0].screenshot({ path: `${SHOTS}/gallery-phone-drawn.png` });
  await tap(real[0], 'gal-send');
  await until(presenter, () => window.app.state.review.draw?.length === 1, undefined, 'the drawing reaches the presenter');
  await until(presenter, () => document.querySelector('#p-activity h2')?.textContent === 'Drawings waiting: 1', undefined, 'the panel counts it');
  ok('but shows nothing until the presenter says the room cannot see this window', await presenter.evaluate(() => document.querySelectorAll('#p-activity canvas').length === 0));
  await presenter.screenshot({ path: `${SHOTS}/gallery-guarded.png` });
  await presenter.keyboard.press('a');
  await settle(presenter, 200);
  ok('and A does nothing while it is hidden', await audience.evaluate(() => !(window.app.state.live.draw?.shown?.length)));
  await presenter.click('#p-activity button[data-action=reveal]');
  await until(presenter, () => document.querySelector('#p-activity .review-card'), undefined, 'one click shows it');
  await until(real[0], () => window.app.control.strokes.length === 0 && window.app.control.state.waiting, undefined, 'the phone clears and says it is waiting');
  await settle(real[0], 150);
  await real[0].screenshot({ path: `${SHOTS}/gallery-phone-sent.png` });
  ok('the presenter sees real ink in the card', await presenter.evaluate(() => { const c = document.querySelector('#p-activity .review-card canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 100) dark++; return dark > 100; }));
  await until(audience, () => window.app.state.live.draw?.waiting === 1, undefined, 'the audience screen gets a count');
  ok('and the slide shows only the count', await audience.evaluate(() => window.app.stage.get('draw-count').text.startsWith('1 waiting') && !window.app.stage.elements().some((e) => e.type === 'freedraw')));
  ok('the waiting drawing never reached the audience screen', received.audience.every((m) => !m.includes('strokes')));
  ok('or another phone', received.phone.every((m) => !m.includes('strokes')));
  ok('other screens hold no review list', await audience.evaluate(() => Object.keys(window.app.state.review).length === 0) && await real[1].evaluate(() => Object.keys(window.app.state.review).length === 0));
  await presenter.screenshot({ path: `${SHOTS}/gallery-review.png` });

  // Phones and audience screens cannot approve anything, even by asking directly.
  await real[1].evaluate(() => { window.app.link.send({ t: 'gal-ok', id: 'd1', slide: 'draw' }); window.app.link.send({ t: 'gal-show', slide: 'draw', item: { id: 'x', strokes: [[[1, 1]]] } }); });
  await audience.evaluate(() => window.app.link.send({ t: 'gal-ok', id: 'd1', slide: 'draw' }));
  await settle(presenter, 300);
  ok('a phone or an audience screen cannot approve a drawing', await audience.evaluate(() => !(window.app.state.live.draw?.shown?.length)));
  const lateCtx = await browser.newContext({ viewport: { width: 800, height: 450 } });
  const late = await openScreen(lateCtx, `${base}${PATH}?role=audience&room=${room}`);
  ok('a late screen gets no waiting drawings in its full copy', await late.evaluate(() => JSON.stringify(window.app.state).indexOf('strokes') === -1));
  await lateCtx.close();
  await presenter.reload();
  await presenter.waitForFunction(() => window.app && window.app.state);
  ok('a presenter who reloads still has the waiting drawing', await presenter.waitForFunction(() => window.app.state.review.draw?.length === 1).then(() => true, () => false));
  ok('and has to say again that the room cannot see', await presenter.evaluate(() => document.querySelector('#p-activity .review-card') === null));
  await presenter.click('#p-activity button[data-action=reveal]');

  await presenter.keyboard.press('Control+r');
  await presenter.keyboard.press('Alt+a');
  await settle(presenter, 200);
  ok('a key with a modifier decides nothing, so Cmd-R cannot reject a drawing', await presenter.evaluate(() => window.app.state.review.draw?.length === 1));
  await presenter.keyboard.press('a');
  await until(audience, () => window.app.state.live.draw?.shown?.length === 1, undefined, 'A approves it, and it reaches the audience screen');
  await until(audience, () => window.app.stage.elements().filter((e) => e.type === 'freedraw').length === 2, undefined, 'with every stroke drawn');
  await until(real[0], () => window.app.control.state.said === 'shown', undefined, 'the phone is told it is on the big screen');
  await settle(real[0], 150);
  await real[0].screenshot({ path: `${SHOTS}/gallery-phone-shown.png` });
  ok('the slide says nobody is waiting now', await audience.evaluate(() => window.app.state.live.draw.waiting === 0));

  await drawOn(real[1], zigzag);
  await tap(real[1], 'gal-send');
  await until(presenter, () => document.querySelector('#p-activity .review-card'), undefined, 'a second drawing arrives');
  await presenter.click('#p-activity button[data-action=reject]');
  await until(real[1], () => window.app.control.state.said === 'declined', undefined, 'Reject tells the phone');
  ok('and it never reaches the wall', await audience.evaluate(() => window.app.state.live.draw.shown.length === 1));
  ok('its strokes never reached the audience screen', !received.audience.some((m) => m.includes('"strokes"') && m.includes(JSON.stringify([50 + 0, 0]))));

  // A newer drawing replaces the one still waiting, so a phone cannot fill the list.
  await sleep(2100);
  await drawOn(real[2], zigzag);
  await tap(real[2], 'gal-send');
  await until(presenter, () => window.app.state.review.draw?.length === 1, undefined, 'a third phone sends one');
  await sleep(2100);
  await drawOn(real[2], house);
  await tap(real[2], 'gal-send');
  await until(presenter, () => window.app.state.review.draw?.length === 1 && window.app.state.review.draw[0].strokes.length === 2, undefined, 'its next one replaces it in the list');
  await presenter.keyboard.press('r');
  await until(presenter, () => !window.app.state.review.draw?.length, undefined, 'R rejects');

  // A drawing that was approved by mistake comes down.
  await presenter.click('#p-activity button[data-action=pull]');
  await until(audience, () => window.app.state.live.draw.shown.length === 0, undefined, 'clicking one on the wall list takes it down');
  await until(real[0], () => window.app.control.state.said === 'removed', undefined, 'and the phone is told');
  await until(audience, () => !window.app.stage.elements().some((e) => e.type === 'freedraw'), undefined, 'its strokes leave the screen');

  // Sending while the connection is down.
  const proxy = tcpProxy(port);
  await proxy.start();
  const dropContext = await phoneContext();
  const dropPhone = track(await page(dropContext));
  await dropPhone.goto(`http://127.0.0.1:${proxy.port}/join?room=${room}`);
  await dropPhone.waitForFunction(() => window.app?.control);
  await settle(dropPhone, 400);
  await drawOn(dropPhone, zigzag);
  await proxy.cut();
  await until(dropPhone, () => window.app.link.status === 'down', undefined, 'the phone loses its connection while drawing');
  ok('the drawing is still on the phone', (await dropPhone.evaluate(() => window.app.control.strokes.length)) === 1);
  await tap(dropPhone, 'gal-send');
  await until(dropPhone, () => window.app.control.note.includes('when the connection returns'), undefined, 'Send says it will go when the connection returns');
  await proxy.start();
  await until(presenter, () => window.app.state.review.draw?.length === 1, undefined, 'when it returns the drawing arrives', 9000);
  await until(dropPhone, () => window.app.control.strokes.length === 0, undefined, 'and the phone clears');
  await settle(presenter, 300);
  ok('it arrived once', (await presenter.evaluate(() => window.app.state.review.draw.length)) === 1);
  await presenter.keyboard.press('r');
  await dropContext.close();

  console.log('--- gallery: what the server refuses');
  const bad = await connectPhone(port, room, 950);
  const results = [];
  bad.ws.on('message', (raw) => { const msg = JSON.parse(raw.toString()); if (msg.t === 'ack') results.push(msg.result); });
  bad.numbered({ t: 'act-submit', slide: 'draw', strokes: 'nope' });
  bad.numbered({ t: 'act-submit', slide: 'draw', strokes: [Array.from({ length: 1300 }, () => [1, 1])] });
  bad.numbered({ t: 'act-submit', slide: 'race', strokes: someStrokes(1) });
  bad.numbered({ t: 'act-submit', slide: 'draw', strokes: someStrokes(1) });
  bad.numbered({ t: 'act-submit', slide: 'draw', strokes: someStrokes(2) });
  await sleep(300);
  ok('bad drawings, the wrong slide and sending too fast are all refused', JSON.stringify(results) === JSON.stringify(['rejected', 'rejected', 'closed', 'ok', 'too soon']), results);
  bad.close();

  console.log('--- gallery: at scale');
  const bots = await connectPhones(port, room, 30, 100);
  await until(presenter, () => window.app.state.counts.phones >= 33, undefined, '30 simulated phones join');
  bots.forEach((b, i) => b.numbered({ t: 'act-submit', slide: 'draw', strokes: someStrokes(i) }));
  await until(presenter, () => window.app.state.review.draw?.length >= 30, undefined, 'all 30 drawings reach the presenter');
  await settle(presenter, 200);
  await presenter.screenshot({ path: `${SHOTS}/gallery-review-30.png` });
  for (let i = 0; i < 28; i++) await presenter.keyboard.press('a');
  await until(audience, () => window.app.state.live.draw.shown.length === 24, undefined, 'the wall holds 24, and the oldest make way');
  await settle(presenter, 1200);
  await presenter.screenshot({ path: `${SHOTS}/gallery-wall-24.png` });
  await audience.screenshot({ path: `${SHOTS}/gallery-wall-24-audience.png` });
  ok('the whole wall stays on the slide', (await offStage(audience)).length === 0, await offStage(audience));
  const report = await measureRoom(room, presenter, 3000, '30 phones and a full wall, on the presenter');
  ok('the full wall stays smooth', report.frameP95 < 40, report.frameP95);
  await presenter.keyboard.press('a');
  await presenter.keyboard.press('a');
  for (let i = 0; i < 20; i++) await presenter.locator('#p-activity button[data-action=pull]').first().click();
  await until(audience, () => window.app.state.live.draw.shown.length <= 8, undefined, 'taking drawings down reflows the wall');
  await settle(audience, 1200);
  await audience.screenshot({ path: `${SHOTS}/gallery-wall-few.png` });
  await sameScreen(presenter, audience, 'audience matches presenter on the wall');
  for (const b of bots) b.close();
  await closeEverything();
}

if (want('branch')) {
  console.log('--- branch: the rules');
  ok('the option in the lead wins', winningOption([1, 5, 2]) === 1);
  ok('the first listed wins a tie', winningOption([3, 3]) === 0 && winningOption([]) === 0);
  const s = newState();
  const choose = SLIDES.findIndex((k) => k.id === 'choose');
  const backIn = SLIDES.findIndex((k) => k.id === 'back-in');
  const fast = SLIDES.findIndex((k) => k.id === 'fast');
  const after = SLIDES.findIndex((k) => k.id === 'replay');
  s.index = choose; s.step = 1;
  s.tallies.choose = [1, 2];
  ok('Next from the vote goes to the winner', stepFrom(s, 1).index === fast);
  s.tallies.choose = [2, 1];
  ok('and follows the count', stepFrom(s, 1).index === backIn);
  s.step = 0;
  ok('Next within a slide stays on it', stepFrom(s, 1).index === choose);
  s.index = backIn; s.step = 0;
  ok('a branch rejoins the talk, skipping the other branch', stepFrom(s, 1).index === after);
  applyOp(s, { t: 'goto', index: after, step: 0, from: fast });
  ok('Back returns the way the talk came', stepFrom(s, -1).index === fast);

  console.log('--- branch: on real pages');
  const room = 't-branch';
  const { presenter, audience, real } = await openRoom(room, 3);
  await goToSlide(presenter, 'choose');
  await until(real[0], () => window.app.stage.get('opt-choose-1'), undefined, 'the choice reaches the phones');
  ok('after the activities the phone is back to voting, with its question box', await real[0].evaluate(() => !document.getElementById('ask').hidden && !window.app.control));
  await settle(audience, 900);
  await audience.screenshot({ path: `${SHOTS}/branch-vote.png` });
  ok('long options stay on the slide', (await offStage(audience)).length === 0, await offStage(audience));
  await tap(real[0], 'opt-choose-1');
  await tap(real[1], 'opt-choose-1');
  await tap(real[2], 'opt-choose-0');
  await until(presenter, () => JSON.stringify(window.app.state.tallies.choose) === '[1,2]', undefined, 'real taps count');
  await presenter.keyboard.press('ArrowRight');
  await until(audience, () => window.app.state.index === window.app.state.index && window.app.state.step === 1, undefined, 'Next closes the vote');
  await until(presenter, () => !document.getElementById('p-next').hidden, undefined, 'the panel says where Next goes');
  ok('it names the winner', (await presenter.textContent('#p-next')).includes('How the server stays fast'), await presenter.textContent('#p-next'));
  ok('the slide says what the room picked', (await audience.evaluate(() => window.app.stage.get('choose-picked').text)).includes('How the server stays fast'));
  await settle(presenter, 1000);
  await presenter.screenshot({ path: `${SHOTS}/branch-closed.png` });
  await tap(real[2], 'opt-choose-1');
  await settle(presenter, 200);
  ok('a late vote cannot change the path', JSON.stringify(await tally(presenter, 'choose')) === '[1,2]');
  await presenter.keyboard.press('ArrowRight');
  await until(audience, (want) => window.app.state.index === want, fast, 'Next takes the whole room down the winning branch');
  await until(real[0], (want) => window.app.state.index === want, fast, 'phones too');
  await settle(presenter, 1400);
  await presenter.screenshot({ path: `${SHOTS}/branch-fast.png` });
  ok('the branch slide stays on the page', (await offStage(audience)).length === 0, await offStage(audience));
  ok('it says the room chose it', (await audience.evaluate(() => window.app.stage.get('fast-why').text)).includes('2 votes'));
  await presenter.keyboard.press('ArrowRight');
  await until(audience, (want) => window.app.state.index === want, after, 'the branch rejoins, skipping the other one');
  await presenter.keyboard.press('ArrowLeft');
  await until(audience, (want) => window.app.state.index === want, fast, 'Back retraces the branch');
  await presenter.keyboard.press('ArrowLeft');
  await until(audience, (want) => window.app.state.index === want && window.app.state.step === 1, choose, 'and back to the vote');
  await presenter.keyboard.press('ArrowLeft');
  await until(real[2], () => window.app.state.step === 0, undefined, 'one more reopens voting');
  await tap(real[0], 'opt-choose-0');
  await tap(real[1], 'opt-choose-0');
  await until(presenter, () => JSON.stringify(window.app.state.tallies.choose) === '[3,0]', undefined, 'the room changes its mind');
  await presenter.keyboard.press('ArrowRight');
  await presenter.keyboard.press('ArrowRight');
  await until(audience, (want) => window.app.state.index === want, backIn, 'and the talk takes the other branch');
  await settle(presenter, 1400);
  await presenter.screenshot({ path: `${SHOTS}/branch-back-in.png` });
  const lateCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const late = await openScreen(lateCtx, `${base}${PATH}?role=audience&room=${room}`);
  ok('a late screen lands on the branch', (await late.evaluate(() => window.app.state.index)) === backIn);
  await presenter.keyboard.press('ArrowLeft');
  await presenter.keyboard.press('ArrowLeft');
  await until(audience, (want) => window.app.state.index === want && window.app.state.step === 0, choose, 'back at the vote');
  const crowd = await connectPhones(port, room, 30, 300);
  const churn = setInterval(() => crowd.forEach((b, i) => b.numbered({ t: 'vote', slide: 'choose', option: (i + Date.now() / 1000 | 0) % 2 })), 500);
  await sleep(800);
  const report = await measureRoom(room, presenter, 4000, '30 phones changing their votes twice a second, on the presenter');
  clearInterval(churn);
  ok('the vote stays smooth with 30 phones changing their minds', report.frameP95 < 40, report.frameP95);
  ok('and bars go out at most ten times a second, not once per vote per phone', report.outPerSec < 600, report.outPerSec);
  for (const b of crowd) b.close();
  await closeEverything();
}

if (want('replay')) {
  console.log('--- replay: the log');
  const log = new ReplayLog();
  log.add({ t: 'goto', index: 0, step: 0 });
  const big = 'x'.repeat(1024 * 1024);
  for (let i = 0; i < 40; i++) log.add({ t: 'act-frame', slide: 'race', frame: { big } });
  ok('activity frames stop at a budget', log.framesCut && log.frameBytes <= 32 * 1024 * 1024, log.frameBytes);
  log.add({ t: 'goto', index: 1, step: 0 });
  ok('slides and votes keep logging after that', log.entries.at(-1)[1].t === 'goto' && log.entries.at(-1)[1].index === 1);
  const stranger = () => new ReplayPlayer({ kind: 'nope', entries: [] });
  ok('a file that is not a talk is refused', (() => { try { stranger(); return false; } catch (e) { return e.message.includes('not a saved talk'); } })());
  ok('a talk from another deck is refused', (() => { try { new ReplayPlayer({ kind: 'handwave-live-deck-replay', entries: [[0, { t: 'goto', index: 999, step: 0 }]] }); return false; } catch (e) { return e.message.includes('different deck'); } })());
  const quick = new ReplayPlayer({ kind: 'handwave-live-deck-replay', entries: [[0, { t: 'goto', index: 0, step: 0 }], [100, { t: 'goto', index: 1, step: 0 }], [200, { t: 'tally', slide: 'survive', counts: [1, 2, 3, 4] }], [300, { t: 'goto', index: 2, step: 0 }]] });
  quick.seek(150);
  ok('any moment is the changes up to it', quick.state.index === 1 && !quick.state.tallies.survive);
  quick.seek(250);
  ok('forward applies what is new', quick.state.tallies.survive[3] === 4);
  quick.seek(50);
  ok('and back forgets what came later', quick.state.index === 0 && !quick.state.tallies.survive);
  const paused = new ReplayPlayer({ kind: 'handwave-live-deck-replay', entries: [[0, { t: 'goto', index: 0, step: 0 }], [3600000, { t: 'goto', index: 1, step: 0 }], [3601000, { t: 'goto', index: 2, step: 0 }]] });
  ok('a long pause is cut to 30 s', paused.duration === 31000 && paused.cut === 3600000 - 30000, paused.duration);

  console.log('--- replay: a whole talk');
  const room = 't-replay';
  const { presenter, audience, real } = await openRoom(room, 2);
  const bots = await connectPhones(port, room, 30, 200);
  const moments = {};
  const snapshot = async (name) => { await settle(audience, 700); moments[name] = { at: Date.now(), screen: await shown(audience) }; };

  await goToSlide(presenter, 'survive');
  await until(real[0], () => window.app.stage.get('opt-survive-0'), undefined, 'a vote opens');
  await tap(real[0], 'opt-survive-3');
  await tap(real[1], 'opt-survive-1');
  bots.forEach((b, i) => b.numbered({ t: 'vote', slide: 'survive', option: i % 4 }));
  await until(audience, () => window.app.state.tallies.survive?.reduce((a, b) => a + b, 0) === 32, undefined, 'all the votes arrive');
  await snapshot('votes');
  await goToSlide(presenter, 'layer');
  const inkFrom = await point(presenter, 300, 650), inkTo = await point(presenter, 900, 780);
  await drag(presenter, inkFrom, inkTo, 30);
  await until(audience, () => window.app.state.ink.layer?.length === 1, undefined, 'ink arrives');
  await snapshot('ink');

  // Questions: one never shown, one shown and hidden, one shown and then removed.
  const ask = async (phone, words) => { await phone.locator('#ask-text').fill(words); await phone.locator('#ask-send').tap(); };
  await ask(real[0], 'QUESTION-NEVER-SHOWN');
  await until(presenter, () => document.querySelectorAll('#p-questions li').length === 1, undefined, 'a question waits');
  await ask(real[1], 'QUESTION-SHOWN-AND-HIDDEN');
  await until(presenter, () => document.querySelectorAll('#p-questions li').length === 2, undefined, 'another waits');
  await presenter.locator('#p-questions li').nth(1).locator('button[data-action=show]').click();
  await until(audience, () => window.app.state.shown?.text === 'QUESTION-SHOWN-AND-HIDDEN', undefined, 'one goes on screen');
  await snapshot('question');
  await presenter.locator('#p-questions li').nth(1).locator('button[data-action=hide]').click();
  await sleep(3100);
  await ask(real[1], 'QUESTION-THEN-REMOVED');
  await until(presenter, () => document.querySelectorAll('#p-questions li').length === 3, undefined, 'a third waits');
  await presenter.locator('#p-questions li').nth(2).locator('button[data-action=show]').click();
  await until(audience, () => window.app.state.shown?.text === 'QUESTION-THEN-REMOVED', undefined, 'it goes on screen');
  await presenter.locator('#p-questions li').nth(2).locator('button[data-action=remove]').click();
  await until(audience, () => !window.app.state.shown, undefined, 'and comes off when removed');

  await goToSlide(presenter, 'race');
  await until(audience, () => window.app.running?.crowd.figures.size >= 32, undefined, 'the race has its figures');
  await presenter.keyboard.press('ArrowRight');
  await sleep(600);
  const realNumber = await real[0].evaluate(() => window.app.control.state.number);
  const stopRace = raceBots(bots);
  await sleep(1500);
  moments.raceEarly = { at: Date.now() };
  const standing = await audience.evaluate((n) => window.app.state.live.race.racers.find((r) => r[0] === n), realNumber);
  await sleep(1500);
  moments.raceLate = { at: Date.now() };
  stopRace();
  await sleep(300);
  await presenter.screenshot({ path: `${SHOTS}/replay-race-live.png` });

  await goToSlide(presenter, 'queue');
  const stopQueue = queueBots(bots);
  await sleep(3000);
  moments.queue = { at: Date.now(), finished: await audience.evaluate(() => window.app.state.live.queue.finished) };
  stopQueue();
  await sleep(200);

  await goToSlide(presenter, 'draw');
  await until(real[0], () => window.app.stage.get('gal-pad'), undefined, 'the gallery opens');
  await presenter.click('#p-activity button[data-action=reveal]');
  const marked = (a) => [[[a, a + 100], [a + 1, a + 101], [a + 200, a + 150]]];
  const send = (b, a) => b.numbered({ t: 'act-submit', slide: 'draw', strokes: marked(a) });
  send(bots[0], 11);   // Approved and kept.
  await until(presenter, () => window.app.state.review.draw?.length === 1, undefined, 'a drawing waits');
  await presenter.keyboard.press('a');
  await until(audience, () => window.app.state.live.draw?.shown?.length === 1, undefined, 'it is approved');
  await snapshot('wall');
  send(bots[1], 22);   // Rejected.
  await until(presenter, () => window.app.state.review.draw?.length === 1, undefined, 'another waits');
  await presenter.keyboard.press('r');
  send(bots[2], 33);   // Approved, then taken down.
  await until(presenter, () => window.app.state.review.draw?.length === 1, undefined, 'a third waits');
  await presenter.keyboard.press('a');
  await until(audience, () => window.app.state.live.draw.shown.length === 2, undefined, 'it is approved too');
  await snapshot('takenDown');
  await presenter.locator('#p-activity button[data-action=pull]').nth(1).click();
  await until(audience, () => window.app.state.live.draw.shown.length === 1, undefined, 'and taken down');
  send(bots[3], 44);   // Never decided.
  await until(presenter, () => window.app.state.review.draw?.length === 1, undefined, 'a fourth is left waiting');

  await goToSlide(presenter, 'replay');
  await until(audience, () => window.app.state.live.replay?.changes > 50, undefined, 'the replay slide shows real numbers from the log');
  await settle(presenter, 800);
  await presenter.screenshot({ path: `${SHOTS}/replay-slide.png` });
  ok('the replay slide stays on the page', (await offStage(audience)).length === 0, await offStage(audience));

  const res = await fetch(`${base}/live-deck/replay?room=${room}`);
  const doc = await res.json();
  const file = JSON.stringify(doc);
  console.log(`     the log: ${doc.entries.length} entries, ${Math.round(file.length / 1024)} KB`);
  ok('an approved drawing is in the file', file.includes('[11,111]'));
  ok('a rejected drawing is not', !file.includes('[22,122]'));
  ok('a drawing taken down is not', !file.includes('[33,133]'));
  ok('one left waiting is not', !file.includes('[44,144]'));
  ok('a question never shown is not', !file.includes('QUESTION-NEVER-SHOWN'));
  ok('a question that was shown is', file.includes('QUESTION-SHOWN-AND-HIDDEN'));
  ok('a shown question that was then removed is not', !file.includes('QUESTION-THEN-REMOVED'));
  const saved = await fetch(`${base}/live-deck/replay?room=${room}&save=1`);
  ok('Save downloads it as a file', (saved.headers.get('content-disposition') ?? '').includes('attachment'));
  ok('an unknown room has no replay', (await fetch(`${base}/live-deck/replay?room=no-such-room`)).status === 404);

  const replayCtx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const replay = track(await page(replayCtx));
  await replay.goto(`${base}${PATH}?role=replay&room=${room}`);
  await replay.waitForFunction(() => window.app && window.app.player);
  ok('the replay page has no panel and no way to change the room', await replay.evaluate(() => document.getElementById('panel').hidden && !window.app.link));
  const when = (name) => moments[name].at - doc.startedAt;
  const seek = async (ms) => { await replay.evaluate((ms) => window.app.seek(ms), ms); await settle(replay, 150); };
  const sameAs = async (name, label) => {
    await seek(when(name));
    const a = JSON.stringify(moments[name].screen), b = JSON.stringify(await shown(replay));
    ok(label, a === b, a === b ? undefined : { first: moments[name].screen.find((e, i) => JSON.stringify(e) !== JSON.stringify(JSON.parse(b)[i])), other: JSON.parse(b).find((e, i) => JSON.stringify(e) !== JSON.stringify(moments[name].screen[i])) });
  };
  await sameAs('votes', 'at the vote, the replay matches what the audience saw');
  await replay.screenshot({ path: `${SHOTS}/replay-votes.png` });
  await sameAs('ink', 'with the ink, it matches too');
  await replay.screenshot({ path: `${SHOTS}/replay-ink.png` });
  await sameAs('question', 'with a question on screen, it matches too');
  await sameAs('wall', 'with the gallery wall, it matches too');
  await seek(when('takenDown'));
  ok('a drawing later taken down shows an empty frame, even at the time it was up', await replay.evaluate(() => window.app.stage.get('fr-d3') && !window.app.stage.elements().some((e) => e.id.startsWith('dr-d3'))));
  await replay.screenshot({ path: `${SHOTS}/replay-wall.png` });
  await sameAs('votes', 'scrubbing back to the vote gives the same picture');

  await seek(when('raceEarly'));
  ok('in the race, the figures are there', (await replay.evaluate(() => window.app.running?.crowd.figures.size)) >= 32);
  const figuresAt = () => replay.evaluate(() => [...window.app.running.crowd.figures.values()].map((f) => [f.number, Math.round(f.x), Math.round(f.y)]));
  const early = await figuresAt();
  await replay.screenshot({ path: `${SHOTS}/replay-race.png` });
  await seek(when('raceLate'));
  const lateFigures = await figuresAt();
  ok('later in the race, they are elsewhere', JSON.stringify(early) !== JSON.stringify(lateFigures));
  await seek(when('raceEarly'));
  ok('scrubbing back puts them where they were', JSON.stringify(await figuresAt()) === JSON.stringify(early));
  const standingNow = (await figuresAt()).find((f) => f[0] === realNumber);
  ok('a figure standing still is where it stood in the talk', Math.abs(standingNow[1] - standing[1]) < 3 && Math.abs(standingNow[2] - standing[2]) < 3, { replay: standingNow, live: standing });
  await seek(when('queue'));
  const replayed = await replay.evaluate(() => window.app.state.live.queue.finished);
  ok('in the queue, the finished count matches', Math.abs(replayed - moments.queue.finished) <= 20, { replay: replayed, live: moments.queue.finished });
  await settle(replay, 200);
  await replay.screenshot({ path: `${SHOTS}/replay-queue.png` });

  // The real timeline with the real mouse.
  const track0 = await replay.locator('#r-time').boundingBox();
  const duration = await replay.evaluate(() => window.app.player.duration);
  await replay.mouse.click(track0.x + track0.width * 0.5, track0.y + track0.height / 2);
  await settle(replay, 150);
  const halfway = await replay.evaluate(() => window.app.at);
  ok('clicking the timeline jumps there', Math.abs(halfway / duration - 0.5) < 0.05, +(halfway / duration).toFixed(3));
  ok('the label says where', (await replay.textContent('#r-label')).startsWith(`${Math.floor(halfway / 60000)}:`));
  ok('the timeline marks each slide that has room for a label', (await replay.locator('#r-marks span').count()) >= 4 && (await replay.evaluate(() => window.app.player.marks().length)) >= 8);
  await replay.evaluate(() => window.app.seek(0));
  await replay.click('#r-play');
  await replay.waitForFunction(() => window.app.at > 400, undefined, { timeout: 4000 });
  ok('Play runs the clock', (await replay.textContent('#r-play')) === 'Pause');
  const motion = await replay.evaluate(() => window.app.at);
  await sleep(300);
  ok('and time moves on', (await replay.evaluate(() => window.app.at)) > motion);
  await replay.click('#r-play');
  const pausedAt = await replay.evaluate(() => window.app.at);
  await sleep(200);
  ok('Pause stops it', (await replay.evaluate(() => window.app.at)) === pausedAt);
  // Time a stretch of the race playing back, with its 32 figures.
  await replay.evaluate((ms) => { window.app.seek(ms); window.app.play(); }, when('raceEarly') - 1000);
  const playback = await replay.evaluate(async () => {
    const gaps = [], renders = [];
    let last = performance.now();
    const begin = last;
    while (last - begin < 3000) { await new Promise(requestAnimationFrame); const now = performance.now(); gaps.push(now - last); renders.push(window.app.stage.frameMs); last = now; }
    return { gaps, renders };
  });
  console.log(`     replaying 32 figures: frame p95 ${quantile(playback.gaps, 0.95).toFixed(1)} ms, render p95 ${quantile(playback.renders, 0.95).toFixed(1)} ms`);
  ok('playing back the race stays smooth', quantile(playback.gaps, 0.95) < 40, +quantile(playback.gaps, 0.95).toFixed(1));
  await replay.click('#r-play');

  // From a saved file, with no server copy of the room.
  const savedPath = `${SHOTS}/talk.json`;
  (await import('node:fs')).writeFileSync(savedPath, file);
  const fileCtx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const fromFile = track(await page(fileCtx));
  await fromFile.goto(`${base}${PATH}?role=replay&room=never-used`);
  await fromFile.waitForFunction(() => window.app);
  ok('with no talk in the room, the page says to open one', (await fromFile.textContent('#r-label')).includes('Open a saved one'));
  // The browser logs that expected 404 as an error.
  fromFile.problems.length = 0;
  await fromFile.setInputFiles('#r-file', savedPath);
  await fromFile.waitForFunction(() => window.app.player);
  await fromFile.evaluate((ms) => window.app.seek(ms), when('wall'));
  await settle(fromFile, 150);
  ok('a saved file replays the same picture', JSON.stringify(await shown(fromFile)) === JSON.stringify(moments.wall.screen));
  (await import('node:fs')).writeFileSync(`${SHOTS}/not-a-talk.json`, '{"hello":1}');
  await fromFile.setInputFiles('#r-file', `${SHOTS}/not-a-talk.json`);
  await fromFile.waitForFunction(() => document.getElementById('r-label').textContent.includes('not a saved talk'));
  ok('a wrong file gets a plain message', true);
  for (const b of bots) b.close();
  await closeEverything();
}


// Every page, for errors. A browser logs each failed reconnect, which is expected here.
const problems = everyPage.flatMap((p) => p.problems).filter((m) => !/WebSocket connection to/.test(m));
ok('no page had an error', problems.length === 0, problems.slice(0, 5));

console.log(`\n${passes} passed, ${failures} failed`);
await browser.close();
await close();
process.exit(failures ? 1 : 0);
