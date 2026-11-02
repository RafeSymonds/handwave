// A page's connection to its room. Reconnects by itself, notices a connection that
// has silently died, and resends anything the server has not acknowledged.

const CHECK_MS = 4000;      // How often to ping.
const PATIENCE_MS = 8000;   // How long a ping may go unanswered before giving up on the socket.
const MAX_WAITING = 5000;

// crypto.randomUUID needs https, and phones reach this over plain http on a LAN.
export function randomToken() {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function deviceId() {
  try {
    let id = localStorage.getItem('handwave.live-deck.client');
    if (!id) { id = randomToken(); localStorage.setItem('handwave.live-deck.client', id); }
    return id;
  } catch {
    return randomToken();
  }
}

export class Link {
  /**
   * onState(message, unacknowledged)  a full copy arrived. Re-apply what is still unacknowledged.
   * onOp(op)                          a change from elsewhere
   * onAck(op, ack)                    the server answered something this page sent
   * onStatus(status)                  connecting, live, down or refused
   */
  constructor({ room, role, onState, onOp, onAck, onStatus }) {
    Object.assign(this, { room, role, onState, onOp, onAck, onStatus });
    this.client = deviceId();
    this.session = randomToken();
    this.n = 0;
    this.waiting = [];
    this.status = 'connecting';
    this.ready = false;
    this.attempts = 0;
    this.pingedAt = null;
    this.connect();
    this.timer = setInterval(() => this.check(), CHECK_MS);
    const wake = () => { if (document.visibilityState !== 'hidden') this.wake(); };
    document.addEventListener('visibilitychange', wake);
    addEventListener('online', wake);
  }

  connect() {
    clearTimeout(this.retry);
    this.retry = null;
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const query = new URLSearchParams({ room: this.room, role: this.role, client: this.client, session: this.session });
    const ws = new WebSocket(`${scheme}://${location.host}/live-deck/ws?${query}`);
    this.ws = ws;
    ws.onmessage = (e) => {
      if (ws !== this.ws) return;
      this.pingedAt = null;
      this.receive(JSON.parse(e.data));
    };
    ws.onclose = (e) => {
      if (ws !== this.ws) return;
      if (e.code === 4003 || e.code === 4004) { this.ws = null; this.setStatus('refused'); return; }
      this.lost();
    };
  }

  lost() {
    const dead = this.ws;
    this.ws = null;
    this.ready = false;
    this.pingedAt = null;
    if (dead) { dead.onclose = dead.onmessage = null; dead.close(); }
    this.setStatus('down');
    if (this.retry) return;
    const wait = Math.min(5000, 250 * 2 ** this.attempts++) * (0.7 + Math.random() * 0.6);
    this.retry = setTimeout(() => this.connect(), wait);
  }

  check() {
    if (!this.ws || this.ws.readyState !== 1) return;
    if (this.pingedAt !== null) {
      if (Date.now() - this.pingedAt > PATIENCE_MS) this.lost();
      return;
    }
    this.pingedAt = Date.now();
    this.ws.send('{"t":"ping"}');
  }

  // A phone waking up should not wait out a backoff or a ping.
  wake() {
    if (this.status === 'refused') return;
    if (this.retry) { this.attempts = 0; this.connect(); } else this.check();
  }

  receive(msg) {
    if (msg.t === 'state') {
      this.ready = true;
      this.attempts = 0;
      this.setStatus('live');
      // The full copy already includes whatever arrived before the connection died.
      const seen = msg.you?.seen ?? 0;
      for (const op of this.waiting.filter((k) => k.n <= seen)) this.onAck?.(op, { t: 'ack', n: op.n, duplicate: true });
      this.waiting = this.waiting.filter((k) => k.n > seen);
      this.onState(msg, this.waiting.slice());
      for (const op of this.waiting) this.ws.send(JSON.stringify(op));
    } else if (msg.t === 'ack') {
      const at = this.waiting.findIndex((op) => op.n === msg.n);
      if (at >= 0) {
        const [op] = this.waiting.splice(at, 1);
        this.onAck?.(op, msg);
      }
    } else if (msg.t !== 'pong') {
      this.onOp(msg);
    }
  }

  send(op) {
    const numbered = { ...op, n: ++this.n };
    this.waiting.push(numbered);
    if (this.waiting.length > MAX_WAITING) this.waiting.shift();
    if (this.ready && this.ws?.readyState === 1) this.ws.send(JSON.stringify(numbered));
  }

  /** Input that goes now or not at all, with no number and no resend. */
  sendNow(op) {
    if (this.ready && this.ws?.readyState === 1) this.ws.send(JSON.stringify(op));
  }

  setStatus(status) {
    if (status === this.status) return;
    this.status = status;
    this.onStatus?.(status);
  }
}
