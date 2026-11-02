// Phones that are only a WebSocket, for measuring a room at scale. They send what a
// real phone's controller sends and keep what the server tells them.

import WebSocket from 'ws';

export function connectPhone(port, room, i, { role = 'phone' } = {}) {
  const tag = String(i).padStart(5, '0');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/live-deck/ws?room=${room}&role=${role}&client=bot-${tag}&session=bot-s-${tag}`);
    const phone = { ws, you: null, n: 0, send: (op) => { if (ws.readyState === 1) ws.send(JSON.stringify(op)); }, numbered: (op) => { if (ws.readyState === 1) ws.send(JSON.stringify({ ...op, n: ++phone.n })); }, close: () => ws.terminate() };
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.t === 'state') { phone.you = msg.you.activity; phone.index = msg.state.index; resolve(phone); }
      if (msg.t === 'act-you') phone.you = msg.you;
      if (msg.t === 'goto') phone.index = msg.index;
    });
  });
}

export const connectPhones = (port, room, count, from = 0) => Promise.all(Array.from({ length: count }, (_, i) => connectPhone(port, room, from + i)));

/** Each phone holds right and presses jump about twice a second. Returns a stop function. */
export function raceBots(phones) {
  const timers = phones.map((phone, i) => {
    let jumping = false;
    phone.send({ t: 'act', i: 2 });
    return setInterval(() => { jumping = !jumping; phone.send({ t: 'act', i: jumping ? 6 : 2 }); }, 240 + (i % 7) * 10);
  });
  return () => { timers.forEach(clearInterval); for (const phone of phones) phone.send({ t: 'act', i: 0 }); };
}

/** Each phone taps its job after a human's pause. Returns a stop function. */
export function queueBots(phones, { pauseMs = 250 } = {}) {
  const timers = phones.map((phone, i) => {
    let last = 0;
    return setInterval(() => {
      // A person who has stopped taps once to start again.
      if (phone.you?.stalled) { phone.send({ t: 'act', job: 0 }); return; }
      const job = phone.you?.job;
      if (job && job !== last) {
        last = job;
        setTimeout(() => phone.send({ t: 'act', job }), pauseMs + (i % 5) * 40);
      }
    }, 50);
  });
  return () => timers.forEach(clearInterval);
}

/** A small drawing that differs per phone. */
export const someStrokes = (i) => [Array.from({ length: 20 }, (_, k) => [40 + k * 25, 200 + Math.round(Math.sin(k + i) * 120)]), [[100 + i * 3, 60], [300, 60 + (i % 40)]]];
