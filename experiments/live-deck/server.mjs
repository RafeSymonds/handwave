// Rooms over WebSockets. The server holds the one real copy of a room. A new or
// returning connection gets a full copy, then every change in order.
//
// A page numbers what it sends and keeps it until acknowledged. A full copy says
// how far this page's changes have been `seen`, so after a reconnect the page
// re-applies and resends only the ones that never arrived, and a change that
// crossed a dying connection counts exactly once on both sides.

import os from 'os';
import { SLIDES, slideById, voteOpen } from './meta.js';
import { apply, cleanPresenterOp, newState } from './room.js';

const MAX_MESSAGE = 64 * 1024;
const MAX_ROOMS = 50, MAX_CLIENTS = 1000, MAX_QUESTIONS = 200, MAX_QUESTION_LENGTH = 140;
const ASK_GAP_MS = 3000;
const SILENT_MS = 90000;   // A hidden tab's timers can slow to once a minute.

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

export default ({ route, sockets }) => {
  const rooms = new Map();

  const roomFor = (name) => {
    if (!rooms.has(name)) {
      if (rooms.size >= MAX_ROOMS) return null;
      rooms.set(name, { state: newState(), clients: new Set(), ballots: {}, seen: new Map(), lastAsk: new Map(), nextQuestion: 1 });
    }
    return rooms.get(name);
  };

  const send = (client, msg) => { if (client.ws.readyState === 1) client.ws.send(JSON.stringify(msg)); };
  const toAll = (room, msg, except) => { for (const c of room.clients) if (c !== except) send(c, msg); };
  const toRole = (room, role, msg) => { for (const c of room.clients) if (c.role === role) send(c, msg); };

  const publishCounts = (room, joining) => {
    const counts = { phones: 0, screens: 0 };
    for (const c of room.clients) { if (c.role === 'phone') counts.phones++; else counts.screens++; }
    if (counts.phones === room.state.counts.phones && counts.screens === room.state.counts.screens) return;
    room.state.counts = counts;
    toAll(room, { t: 'counts', counts }, joining);
  };

  const fullCopy = (room, client) => {
    const votes = {};
    for (const [slide, ballots] of Object.entries(room.ballots)) if (ballots.has(client.id)) votes[slide] = ballots.get(client.id);
    return { t: 'state', state: { ...room.state, questions: client.role === 'presenter' ? room.state.questions : [] }, you: { role: client.role, votes, seen: room.seen.get(client.session) ?? 0 } };
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
    toAll(room, tally);
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

  const receive = (room, client, raw) => {
    client.lastSeen = Date.now();
    if (raw.length > MAX_MESSAGE) return;
    let op;
    try { op = JSON.parse(raw); } catch { return; }
    if (!op || typeof op !== 'object') return;
    if (op.t === 'ping') { send(client, { t: 'pong' }); return; }
    if (!Number.isInteger(op.n)) return;
    if (op.n <= (room.seen.get(client.session) ?? 0)) { send(client, { t: 'ack', n: op.n, duplicate: true }); return; }
    room.seen.set(client.session, op.n);

    const ack = { t: 'ack', n: op.n };
    if (client.role === 'presenter') {
      const clean = cleanPresenterOp(op, room.state);
      if (clean) {
        apply(room.state, clean);
        toAll(room, clean, client);
      } else ack.rejected = true;
    } else if (client.role === 'phone' && op.t === 'vote') {
      if (!castVote(room, client, op)) ack.rejected = true;
      const ballots = room.ballots[op.slide];
      ack.vote = { slide: op.slide, option: ballots?.get(client.id) ?? null };
    } else if (client.role === 'phone' && op.t === 'ask') {
      ack.result = askQuestion(room, client, op);
    } else ack.rejected = true;
    send(client, ack);
  };

  route('GET', '/live-deck/info', (req, res, url) => {
    const name = roomName(url.searchParams.get('room')) ?? 'main';
    const port = req.socket.localPort;
    const lan = lanAddress();
    const query = name === 'main' ? '' : `?room=${name}`;
    // Bound to loopback, the server cannot be reached from a phone at any address.
    const bound = req.socket.server?.address()?.address;
    const reachable = Boolean(lan) && bound !== '127.0.0.1' && bound !== '::1';
    const body = { lan, port, reachable, joinUrl: `http://${lan ?? 'localhost'}:${port}/join${query}`, canPresent: isThisMachine(req.socket.remoteAddress) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });

  // The short address on the title slide.
  route('GET', '/join', (req, res, url) => {
    const name = roomName(url.searchParams.get('room')) ?? 'main';
    res.writeHead(302, { Location: `/experiments/live-deck/?role=phone&room=${name}` });
    res.end();
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

    const client = { ws, role, id, session, lastSeen: Date.now() };
    room.clients.add(client);
    ws.on('error', () => {});
    ws.on('close', () => { room.clients.delete(client); publishCounts(room); });
    ws.on('message', (raw) => {
      try { receive(room, client, raw.toString()); } catch (err) { console.error('live-deck:', err); }
    });
    // The newcomer's full copy already holds the new counts.
    publishCounts(room, client);
    send(client, fullCopy(room, client));
  });

  // Drop connections that have gone silent, so the counts stay true.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) for (const c of room.clients) if (now - c.lastSeen > SILENT_MS) c.ws.terminate();
  }, 15000);
  sweep.unref();
};
