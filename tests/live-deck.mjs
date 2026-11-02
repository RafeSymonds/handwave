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
import { cleanPresenterOp, newState } from '../experiments/live-deck/room.js';
import { SLIDES } from '../experiments/live-deck/meta.js';

const SHOTS = process.argv[2] ?? shots('live-deck');
const PATH = '/experiments/live-deck/';
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

async function sameScreen(a, b, name) {
  await settle(a);
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
await goTo(pres, 5, 0);
await until(aud, () => window.app.state.index === 5 && !window.app.stage.elements().some((e) => e.type === 'freedraw'), undefined, 'the next slide leaves the layer behind');
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
await goTo(pres, 5, 0);
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
await goTo(pres, 5, 0);
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
await goTo(pres, 5, 0);
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

// Every page, for errors. A browser logs each failed reconnect, which is expected here.
const problems = everyPage.flatMap((p) => p.problems).filter((m) => !/WebSocket connection to/.test(m));
ok('no page had an error', problems.length === 0, problems.slice(0, 5));

console.log(`\n${passes} passed, ${failures} failed`);
await browser.close();
await close();
process.exit(failures ? 1 : 0);
