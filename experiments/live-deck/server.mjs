// Rooms over WebSockets. The server holds the one real copy of a room. A new or
// returning connection gets a full copy, then every change in order.
//
// A page numbers what it sends and keeps it until acknowledged. A full copy says
// how far this page's changes have been `seen`, so after a reconnect the page
// re-applies and resends only the ones that never arrived, and a change that
// crossed a dying connection counts exactly once on both sides.
//
// A slide's activity (see activity.js) runs here while its slide is current. Fast
// phone input has no number: it may be lost, and is limited per connection before
// it is even parsed. Screens get every frame unless they fall behind, in which case
// frames are skipped for them. Phones get a small status only when theirs changes.

import os from 'os';
import qrcode from 'qrcode-generator';
import { createActivity } from './activity.js';
import { SLIDES, slideById, voteOpen } from './meta.js';
import { apply, cleanPresenterOp, newState } from './room.js';
import { ReplayLog } from './talk-log.js';

const MAX_MESSAGE = 64 * 1024;

// A QR code as rows of '0' and '1'. Level Q leaves room for the hand-drawn edges.
function qrRows(text) {
  const code = qrcode(0, 'Q');
  code.addData(text);
  code.make();
  const n = code.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => (code.isDark(r, c) ? '1' : '0')).join(''));
}
const MAX_ROOMS = 50, MAX_CLIENTS = 1000, MAX_QUESTIONS = 200, MAX_QUESTION_LENGTH = 140;
const ASK_GAP_MS = 3000;
const SILENT_MS = 90000;   // A hidden tab's timers can slow to once a minute.
const MAX_BUFFERED = 512 * 1024;   // A screen this far behind skips frames until it catches up.
const TALLY_EVERY_MS = 100;

// Messages a connection may send: a steady rate per second and a burst above it.
const LIMIT = {
  fast: { rate: 30, burst: 60 },       // Phone input with no number.
  phone: { rate: 20, burst: 100 },     // A phone's numbered changes and pings.
  screen: { rate: 500, burst: 1000 },  // A presenter's ink and drags.
};

/** The address phones on this network can reach, skipping tunnels and link-local ones. */
export function lanAddress(interfaces = os.networkInterfaces()) {
  const skip = /^(utun|tun|tap|bridge|docker|vmnet|veth|llw|awdl|lo)/;
  const found = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (skip.test(name)) continue;
    for (const a of addresses ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) found.push({ name, address: a.address });
    }
  }
  found.sort((a, b) => (a.name.startsWith('en') ? 0 : 1) - (b.name.startsWith('en') ? 0 : 1) || a.name.localeCompare(b.name));
  return found[0]?.address ?? null;
}

/** Only this machine may present. Anyone else who asks gets the audience view. */
export function isThisMachine(address, interfaces = os.networkInterfaces()) {
  const bare = String(address ?? '').replace(/^::ffff:/, '');
  if (bare === '127.0.0.1' || bare === '::1') return true;
  return Object.values(interfaces).flat().some((a) => a?.address === bare);
}

const roomName = (value) => (value == null || value === '' ? 'main' : /^[a-z0-9-]{1,32}$/.test(value) ? value : null);
const okToken = (value) => typeof value === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(value);

const bucket = (limit) => ({ tokens: limit.burst, at: Date.now() });
function allow(store, limit, now) {
  store.tokens = Math.min(limit.burst, store.tokens + ((now - store.at) / 1000) * limit.rate);
  store.at = now;
  if (store.tokens < 1) return false;
  store.tokens--;
  return true;
}

const newStats = () => ({ ticks: 0, tickMs: 0, tickMsWorst: 0, inputs: 0, dropped: 0, frames: 0, messagesOut: 0, bytesOut: 0, skipped: 0, messagesIn: 0 });

export default ({ route, sockets }) => {
  const rooms = new Map();

  const roomFor = (name) => {
    if (!rooms.has(name)) {
      if (rooms.size >= MAX_ROOMS) return null;
      const room = { name, state: newState(), clients: new Set(), ballots: {}, seen: new Map(), lastAsk: new Map(), nextQuestion: 1, activities: new Map(), current: null, currentSlide: null, ticker: null, log: new ReplayLog(), stats: newStats(), unsentTallies: {}, tallyTimer: null };
      room.host = {
        state: room.state,
        log: room.log,
        // Everything emitted is public: it reaches every screen and the replay.
        emit(op) {
          apply(room.state, op);
          toScreens(room, op);
          record(room, op);
        },
        // What only the presenter may see. It stays out of full copies and the replay.
        toPresenter(op) {
          apply(room.state, op);
          toRole(room, 'presenter', op);
        },
      };
      rooms.set(name, room);
      record(room, { t: 'goto', index: 0, step: 0 });
    }
    return rooms.get(name);
  };

  function sendRaw(room, client, json) {
    if (client.ws.readyState !== 1) return;
    client.ws.send(json);
    room.stats.messagesOut++;
    room.stats.bytesOut += json.length;
  }

  const send = (room, client, msg) => sendRaw(room, client, JSON.stringify(msg));
  const toAll = (room, msg, except) => { const json = JSON.stringify(msg); for (const c of room.clients) if (c !== except) sendRaw(room, c, json); };
  const toRole = (room, role, msg) => { const json = JSON.stringify(msg); for (const c of room.clients) if (c.role === role) sendRaw(room, c, json); };
  const toScreens = (room, msg, except) => { const json = JSON.stringify(msg); for (const c of room.clients) if (c.role !== 'phone' && c !== except) sendRaw(room, c, json); };

  // The replay holds only what the shared screen showed.
  function record(room, op, json) {
    room.log.add(op, json);
    if (op.t === 'gal-pull' && op.retract) room.log.retract(op.slide, op.id);
  }

  const publishCounts = (room, joining) => {
    const counts = { phones: 0, screens: 0 };
    for (const c of room.clients) { if (c.role === 'phone') counts.phones++; else counts.screens++; }
    if (counts.phones === room.state.counts.phones && counts.screens === room.state.counts.screens) return;
    const op = { t: 'counts', counts };
    apply(room.state, op);
    toAll(room, op, joining);
    record(room, op);
  };

  const fullCopy = (room, client) => {
    const votes = {};
    for (const [slide, ballots] of Object.entries(room.ballots)) if (ballots.has(client.id)) votes[slide] = ballots.get(client.id);
    const state = {
      ...room.state,
      questions: client.role === 'presenter' ? room.state.questions : [],
      review: client.role === 'presenter' ? room.state.review : {},
      live: client.role === 'phone' ? {} : room.state.live,
    };
    const activity = client.role === 'phone' && room.current ? room.current.you?.(client.id) ?? null : null;
    return { t: 'state', state, you: { role: client.role, votes, seen: room.seen.get(client.session) ?? 0, activity } };
  };

  const castVote = (room, client, op) => {
    const slide = slideById(op.slide);
    if (!slide || SLIDES[room.state.index] !== slide || !voteOpen(slide, room.state.step)) return false;
    if (!Number.isInteger(op.option) || op.option < 0 || op.option >= slide.vote.options.length) return false;
    const ballots = (room.ballots[slide.id] ??= new Map());
    ballots.set(client.id, op.option);
    const counts = slide.vote.options.map(() => 0);
    for (const option of ballots.values()) counts[option]++;
    const tally = { t: 'tally', slide: slide.id, counts };
    apply(room.state, tally);
    // A vote changes the room's copy at once. The bars go out at most ten times a
    // second, because telling every phone about every vote grows with the square of the room.
    room.unsentTallies[slide.id] = tally;
    room.tallyTimer ??= setTimeout(() => {
      room.tallyTimer = null;
      for (const unsent of Object.values(room.unsentTallies)) {
        toAll(room, unsent);
        record(room, unsent);
      }
      room.unsentTallies = {};
    }, TALLY_EVERY_MS);
    return true;
  };

  const askQuestion = (room, client, op) => {
    const words = typeof op.text === 'string' ? op.text.replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION_LENGTH) : '';
    if (!words || room.state.questions.length >= MAX_QUESTIONS) return 'rejected';
    const now = Date.now();
    if (now - (room.lastAsk.get(client.id) ?? 0) < ASK_GAP_MS) return 'too soon';
    room.lastAsk.set(client.id, now);
    const asked = { t: 'asked', q: { id: `q${room.nextQuestion++}`, text: words } };
    apply(room.state, asked);
    toRole(room, 'presenter', asked);
    return 'ok';
  };

  // ------------------------------------------------------------------ the running activity

  const phonesIn = (room) => [...room.clients].filter((c) => c.role === 'phone');

  function pushYou(room) {
    if (!room.current?.you) return;
    for (const c of phonesIn(room)) {
      const json = JSON.stringify(room.current.you(c.id));
      if (json === c.lastYou) continue;
      c.lastYou = json;
      sendRaw(room, c, `{"t":"act-you","slide":"${room.currentSlide.id}","you":${json}}`);
    }
  }

  function pushFrame(room, now) {
    const frame = room.current?.frame?.();
    if (!frame) return;
    const op = { t: 'act-frame', slide: room.currentSlide.id, frame };
    apply(room.state, op);
    const json = JSON.stringify(op);
    room.stats.frames++;
    for (const c of room.clients) {
      if (c.role === 'phone') continue;
      if (c.ws.bufferedAmount > MAX_BUFFERED) { room.stats.skipped++; continue; }
      sendRaw(room, c, json);
    }
    const every = room.current.constructor.logEverySeconds;
    if (every !== null && now - (room.loggedAt ?? -Infinity) >= (every ?? 0) * 1000) {
      room.loggedAt = now;
      record(room, op, json);
    }
  }

  function stopTicker(room) {
    clearInterval(room.ticker);
    room.ticker = null;
  }

  function startTicker(room) {
    stopTicker(room);
    const activity = room.current;
    if (!activity || !room.clients.size) return;
    const { tickHz = 4, frameHz = 2, youHz = 2 } = activity.constructor;
    let last = performance.now(), untilFrame = 0, untilYou = 0;
    room.ticker = setInterval(() => {
      const started = performance.now();
      // A stalled server should catch up on time, within reason. The race caps its own physics.
      const dt = Math.min(1, (started - last) / 1000);
      last = started;
      activity.tick?.(dt);
      untilFrame -= dt;
      if (untilFrame <= 0) { untilFrame = Math.max(untilFrame + 1 / frameHz, 0); pushFrame(room, started); }
      untilYou -= dt;
      if (untilYou <= 0) { untilYou = Math.max(untilYou + 1 / youHz, 0); pushYou(room); }
      const spent = performance.now() - started;
      room.stats.ticks++;
      room.stats.tickMs += spent;
      room.stats.tickMsWorst = Math.max(room.stats.tickMsWorst, spent);
    }, 1000 / tickHz);
    room.ticker.unref?.();
  }

  // The current slide decides which activity runs. Going back to a slide finds its
  // activity as it was, with whoever is connected now.
  function syncActivity(room) {
    const slide = SLIDES[room.state.index];
    const next = slide.activity ? (room.activities.get(slide.id) ?? room.activities.set(slide.id, createActivity(slide, room.host)).get(slide.id)) : null;
    if (next !== room.current) {
      const phones = phonesIn(room);
      if (room.current) for (const c of phones) room.current.leave?.(c.id);
      room.current = next;
      room.currentSlide = next ? slide : null;
      room.loggedAt = null;
      for (const c of phones) { c.lastYou = null; next?.join?.(c.id); }
      next?.layout?.();
      startTicker(room);
    }
    next?.setStep?.(room.state.step);
    pushYou(room);
  }

  // ------------------------------------------------------------------ input

  const receive = (room, client, raw) => {
    const now = Date.now();
    client.lastSeen = now;
    room.stats.messagesIn++;
    if (raw.length > MAX_MESSAGE) return;
    // Checked before parsing, so a flood costs as little as possible.
    const fast = raw.startsWith('{"t":"act"');
    const allowed = fast ? allow(client.fast, LIMIT.fast, now) : allow(client.slow, client.role === 'phone' ? LIMIT.phone : LIMIT.screen, now);
    if (!allowed) { room.stats.dropped++; return; }
    let op;
    try { op = JSON.parse(raw); } catch { return; }
    if (!op || typeof op !== 'object') return;
    if (op.t === 'ping') { send(room, client, { t: 'pong' }); return; }
    if (op.t === 'act') {
      if (client.role === 'phone') { room.current?.input?.(client.id, op); room.stats.inputs++; }
      return;
    }
    if (!Number.isInteger(op.n)) return;
    if (op.n <= (room.seen.get(client.session) ?? 0)) { send(room, client, { t: 'ack', n: op.n, duplicate: true }); return; }
    room.seen.set(client.session, op.n);

    const ack = { t: 'ack', n: op.n };
    if (client.role === 'presenter') {
      if (typeof op.t === 'string' && op.t.startsWith('gal-')) {
        if (!room.current?.review?.(op)) ack.rejected = true;
        pushYou(room);
      } else {
        const clean = cleanPresenterOp(op, room.state);
        if (clean) {
          const wasShown = room.state.shown?.id === clean.id;
          apply(room.state, clean);
          toAll(room, clean, client);
          // A question only reaches the replay once it was on screen. Removing a
          // shown one takes it back out of the file too.
          if (clean.t !== 'q-drop') record(room, clean);
          else if (wasShown) { room.log.retractQuestion(clean.id); record(room, { t: 'q-hide' }); }
          if (clean.t === 'goto') syncActivity(room);
          else if (['ink-start', 'ink-add', 'offset', 'home'].includes(clean.t) && clean.slide === room.currentSlide?.id) room.current?.layout?.();
        } else ack.rejected = true;
      }
    } else if (client.role === 'phone' && op.t === 'vote') {
      if (!castVote(room, client, op)) ack.rejected = true;
      const ballots = room.ballots[op.slide];
      ack.vote = { slide: op.slide, option: ballots?.get(client.id) ?? null };
    } else if (client.role === 'phone' && op.t === 'ask') {
      ack.result = askQuestion(room, client, op);
    } else if (client.role === 'phone' && op.t === 'act-submit') {
      ack.result = op.slide === room.currentSlide?.id ? room.current.submit?.(client.id, op) ?? 'rejected' : 'closed';
      pushYou(room);
    } else ack.rejected = true;
    send(room, client, ack);
  };

  const infoFor = (req, name) => {
    const port = req.socket.localPort;
    const lan = lanAddress();
    const query = name === 'main' ? '' : `?room=${name}`;
    // Bound to loopback, the server cannot be reached from a phone at any address.
    const bound = req.socket.server?.address()?.address;
    const reachable = Boolean(lan) && bound !== '127.0.0.1' && bound !== '::1';
    const joinUrl = `http://${lan ?? 'localhost'}:${port}/join${query}`;
    return { lan, port, reachable, joinUrl };
  };

  route('GET', '/live-deck/info', (req, res, url) => {
    const name = roomName(url.searchParams.get('room')) ?? 'main';
    const info = infoFor(req, name);
    // No code on a server phones cannot reach, because scanning it could only fail.
    const body = { ...info, qr: info.reachable ? qrRows(info.joinUrl) : null, canPresent: isThisMachine(req.socket.remoteAddress) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });

  // The short address on the title slide.
  route('GET', '/join', (req, res, url) => {
    const name = roomName(url.searchParams.get('room')) ?? 'main';
    res.writeHead(302, { Location: `/experiments/live-deck/?role=phone&room=${name}` });
    res.end();
  });

  // The log of a talk. It can be tens of megabytes, so only this machine may ask for it.
  route('GET', '/live-deck/replay', (req, res, url) => {
    const name = roomName(url.searchParams.get('room')) ?? 'main';
    const room = rooms.get(name);
    if (!isThisMachine(req.socket.remoteAddress) || !room) { res.writeHead(room ? 403 : 404); res.end(); return; }
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (url.searchParams.has('save')) headers['Content-Disposition'] = `attachment; filename="talk-${name}.json"`;
    res.writeHead(200, headers);
    res.end(JSON.stringify(room.log.document(infoFor(req, name))));
  });

  // What the server is spending, for measuring. Only this machine may ask.
  route('GET', '/live-deck/stats', (req, res, url) => {
    const room = rooms.get(roomName(url.searchParams.get('room')) ?? 'main');
    if (!isThisMachine(req.socket.remoteAddress) || !room) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ...room.stats, log: { entries: room.log.entries.length, bytes: room.log.bytes }, clients: room.clients.size }));
  });

  sockets('/live-deck/ws', (ws, req) => {
    // Another website must not be able to drive a talk through the presenter's browser.
    try {
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) { ws.close(4003, 'wrong origin'); return; }
    } catch { ws.close(4003, 'wrong origin'); return; }

    const url = new URL(req.url, 'http://localhost');
    const name = roomName(url.searchParams.get('room'));
    const room = name && roomFor(name);
    const id = url.searchParams.get('client');
    const session = url.searchParams.get('session');
    if (!room || !okToken(id) || !okToken(session) || room.clients.size >= MAX_CLIENTS) { ws.close(4004, 'refused'); return; }

    let role = url.searchParams.get('role');
    if (role !== 'presenter' && role !== 'phone') role = 'audience';
    if (role === 'presenter' && !isThisMachine(req.socket.remoteAddress)) role = 'audience';

    const client = { ws, role, id, session, lastSeen: Date.now(), lastYou: null, fast: bucket(LIMIT.fast), slow: bucket(role === 'phone' ? LIMIT.phone : LIMIT.screen) };
    room.clients.add(client);
    ws.on('error', () => {});
    ws.on('close', () => {
      room.clients.delete(client);
      publishCounts(room);
      // A device can hold two connections while it reconnects. Only the last one leaves.
      if (role === 'phone' && ![...room.clients].some((c) => c.id === id && c.role === 'phone')) room.current?.leave?.(id);
      if (!room.clients.size) stopTicker(room);
    });
    ws.on('message', (raw) => {
      try { receive(room, client, raw.toString()); } catch (err) { console.error('live-deck:', err); }
    });
    // The newcomer's full copy already holds the new counts.
    publishCounts(room, client);
    if (role === 'phone') room.current?.join?.(id);
    if (room.current && !room.ticker) startTicker(room);
    const copy = fullCopy(room, client);
    if (role === 'phone') client.lastYou = JSON.stringify(copy.you.activity);
    send(room, client, copy);
  });

  // Drop connections that have gone silent, so the counts stay true.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) for (const c of room.clients) if (now - c.lastSeen > SILENT_MS) c.ws.terminate();
  }, 15000);
  sweep.unref();
};
