// The tutor's backend. POST /tutor/ask streams validated ops as NDJSON while the
// model is still writing. With no API key the model runs through the `claude` CLI,
// kept alive per session: a follow-up needs no process start, and the process holds
// the conversation.
//
// A model of "replay:<name>" plays experiments/tutor/recordings/<name>.jsonl through
// the same validator with its original timing, so tests use no model calls.
// `record: "<name>"` on a live ask writes such a file.

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Board, Lines, parseLine } from './ops.mjs';
import { SYSTEM_PROMPT, buildPrompt } from './prompt.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const recordings = path.join(here, 'recordings');
const MODELS = new Set(['claude-haiku-5-5', 'claude-sonnet-5-5']);
const DEFAULT_MODEL = 'claude-haiku-5-5';
const IDLE_MS = 10 * 60 * 1000;
const TURN_TIMEOUT_MS = 90 * 1000;

const sessions = new Map();

// One long-lived `claude -p` process. The temp cwd and --safe-mode keep the user's
// CLAUDE.md, hooks and plugins out of the tutor. (--bare would too, but it refuses
// OAuth, and there is no API key here.)
class ClaudeProcess {
  constructor(model) {
    this.model = model;
    this.startedAt = performance.now();
    this.alive = true;
    this.turn = null;
    this.buffer = '';
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'handwave-tutor-'));
    this.cwd = cwd;
    this.child = spawn('claude', [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
      '--model', model, '--system-prompt', SYSTEM_PROMPT, '--tools', '', '--no-session-persistence', '--safe-mode', '--strict-mcp-config',
      // A tutor mid-conversation cannot go silent. Haiku spent 10 s on 2,173 tokens of
      // thinking before its first word on a question like this one.
    ], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MAX_THINKING_TOKENS: '0' } });
    this.stderr = '';
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-500); });
    this.child.stdout.on('data', (d) => this._read(d));
    this.child.stdin.on('error', () => {});
    this.child.on('error', (err) => this._died(err.message));
    this.child.on('exit', (code) => this._died(`claude exited with code ${code}. ${this.stderr}`.trim()));
  }

  _read(chunk) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const turn = this.turn;
      if (!turn) continue;
      // Where a turn's wait went, for the latency report.
      if (event.type !== 'stream_event' || event.event?.type !== 'content_block_delta') {
        turn.trace?.push([turn.ms(), event.type === 'stream_event' ? event.event?.type : `${event.type}${event.subtype ? `:${event.subtype}` : ''}`]);
      }
      if (event.type === 'stream_event' && event.event?.type === 'content_block_delta') {
        if (event.event.delta?.type === 'text_delta') turn.onDelta(event.event.delta.text);
        else if (event.event.delta?.type === 'thinking_delta') turn.onThinking?.();
      } else if (event.type === 'result') {
        this.turn = null;
        if (event.is_error) turn.onError(String(event.result ?? event.subtype ?? 'model error'));
        else turn.onDone({ apiMs: event.duration_api_ms, usage: event.usage, cost: event.total_cost_usd });
      }
    }
  }

  _died(reason) {
    if (!this.alive) return;
    this.alive = false;
    const turn = this.turn;
    this.turn = null;
    fs.rm(this.cwd, { recursive: true, force: true }, () => {});
    turn?.onError(reason);
  }

  send(text, turn) {
    this.turn = turn;
    this.child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`);
  }

  kill() {
    this.turn = null;
    if (this.alive) this.child.kill();
  }
}

function sessionFor(id) {
  let s = sessions.get(id);
  if (!s) {
    s = { id, board: new Board(), transcript: [], proc: null, active: null, idle: null };
    sessions.set(id, s);
  }
  return s;
}

function touch(s) {
  clearTimeout(s.idle);
  s.idle = setTimeout(() => { s.proc?.kill(); s.proc = null; sessions.delete(s.id); }, IDLE_MS);
  s.idle.unref?.();
}

/** Keep a process running for this session and model. Returns whether it had to start one. */
function ensureProcess(s, model) {
  if (s.proc?.alive && s.proc.model === model) return false;
  s.proc?.kill();
  s.proc = new ClaudeProcess(model);
  s.freshProcess = true;
  return true;
}

// A process that has been replaced knows nothing of the lesson, so its first message carries it.
const earlierFor = (s) => {
  if (!s.freshProcess) return [];
  s.freshProcess = false;
  return s.transcript;
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 200000) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (err) { reject(err); } });
    req.on('error', reject);
  });
}

const LOOPBACK_ADDRESS = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
const LOOPBACK_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i;

/**
 * Why a request may not reach the model, or null if it may. These routes spend the
 * user's subscription, and the root server can listen on every interface of a
 * machine with a public address. So a request must come from this machine, and from
 * a page this server served. Every browser sends Origin on a POST, so a missing one
 * is refused too. The Host must also name this machine: otherwise a site could point
 * its own domain at 127.0.0.1, and its Origin and Host would match (DNS rebinding).
 */
export function refusal(req) {
  if (!LOOPBACK_ADDRESS.test(req.socket?.remoteAddress ?? '')) return 'the tutor only answers this machine';
  const host = String(req.headers.host ?? '');
  if (!LOOPBACK_HOST.test(host)) return 'the tutor only answers this machine';
  let origin;
  try { origin = new URL(String(req.headers.origin ?? '')).host; } catch { return 'the tutor only answers its own page'; }
  if (origin.toLowerCase() !== host.toLowerCase()) return 'the tutor only answers its own page';
  return null;
}

function allowed(req, res) {
  const why = refusal(req);
  if (why) { res.writeHead(403); res.end(why); return false; }
  if (!String(req.headers['content-type'] ?? '').includes('application/json')) { res.writeHead(415); res.end('send JSON'); return false; }
  return true;
}

function replay(name, speed, turn) {
  if (!/^[\w-]+$/.test(name)) { turn.onError('bad recording name'); return () => {}; }
  let lines;
  try {
    lines = fs.readFileSync(path.join(recordings, `${name}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (err) { turn.onError(`no recording ${name}: ${err.message}`); return () => {}; }
  const timers = lines.map((entry) => setTimeout(() => {
    if (entry.delta !== undefined) turn.onDelta(entry.delta);
    else if (entry.done) turn.onDone({ replay: name });
  }, entry.t / speed));
  return () => timers.forEach(clearTimeout);
}

export default function tutor({ route }) {
  route('POST', '/tutor/warm', async (req, res) => {
    if (!allowed(req, res)) return;
    const body = await readJson(req);
    const s = sessionFor(String(body.session ?? 'default'));
    touch(s);
    const model = MODELS.has(body.model) ? body.model : null;
    const started = model ? ensureProcess(s, model) : false;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ started }));
  });

  route('POST', '/tutor/ask', async (req, res) => {
    if (!allowed(req, res)) return;
    const received = performance.now();
    const ms = () => Math.round(performance.now() - received);
    const body = await readJson(req);
    const question = String(body.question ?? '').slice(0, 2000).trim();
    if (!question) { res.writeHead(400); res.end('no question'); return; }

    const s = sessionFor(String(body.session ?? 'default'));
    touch(s);

    // A new question ends whatever the model was still writing.
    if (s.active) { s.active.cancel(); s.active = null; }
    if (body.reset) {
      s.board = new Board();
      s.transcript = [];
      s.proc?.kill();
      s.proc = null;
    }
    if (Number.isInteger(body.applied)) s.board.rewind(body.applied);

    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.socket?.setNoDelay?.(true);
    const send = (obj) => { if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`); };

    const said = [];
    const notes = [];
    const lines = new Lines();
    const rec = [];
    let finished = false;
    let firstDelta = null;
    let firstSay = null;
    let firstDraw = null;

    const handleLine = (line) => {
      const parsed = parseLine(line);
      if (parsed.note) notes.push(parsed.note);
      for (const raw of parsed.ops) {
        const { ops, notes: why } = s.board.apply(raw);
        notes.push(...why);
        for (const op of ops) {
          if (op.op === 'say') { said.push(op.text); firstSay ??= ms(); } else if (op.op === 'draw') firstDraw ??= ms();
          send(op);
        }
      }
    };

    const finish = (meta) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      for (const line of lines.flush()) handleLine(line);
      notes.push(...s.board.endTurn());
      s.transcript.push({ question, said });
      if (s.active === active) s.active = null;
      if (body.record && /^[\w-]+$/.test(body.record)) {
        rec.push({ t: ms(), done: true });
        fs.mkdirSync(recordings, { recursive: true });
        fs.writeFileSync(path.join(recordings, `${body.record}.jsonl`), `${rec.map((r) => JSON.stringify(r)).join('\n')}\n`);
      }
      send({ meta: 'done', ms: ms(), firstDelta, firstSay, firstDraw, notes, trace, sentences: said.length, seq: s.board.log.length, ...meta });
      res.end();
    };

    const trace = [];
    const turn = {
      ms,
      trace,
      onDelta(text) {
        if (firstDelta === null) { firstDelta = ms(); send({ meta: 'first-delta', ms: firstDelta }); }
        rec.push({ t: ms(), delta: text });
        for (const line of lines.push(text)) handleLine(line);
      },
      onDone: (meta) => finish(meta),
      onError: (message) => { send({ meta: 'error', message }); finish({ failed: true }); },
    };

    const timeout = setTimeout(() => { active.cancel(); turn.onError('the model took too long'); }, TURN_TIMEOUT_MS);
    timeout.unref?.();

    let stopReplay = null;
    const active = {
      cancel() {
        if (finished) return;
        stopReplay?.();
        // The model cannot be stopped mid-turn over stdin, so end the process. The
        // next question starts one and tells it the lesson so far.
        if (s.proc && !stopReplay) { s.proc.kill(); s.proc = null; }
        finish({ cancelled: true });
      },
    };
    s.active = active;
    res.on('close', () => { if (!finished) active.cancel(); });

    const pointing = (Array.isArray(body.pointing) ? body.pointing : []).slice(0, 12).map((p) => ({ id: String(p.id ?? '').slice(0, 44), label: String(p.label ?? '').slice(0, 60), kind: String(p.kind ?? '').slice(0, 12) }));
    const interruptedAfter = body.interruptedAfter ? String(body.interruptedAfter).slice(0, 300) : '';

    const model = String(body.model ?? DEFAULT_MODEL);
    if (model.startsWith('replay:')) {
      const text = buildPrompt({ question, board: s.board, pointing, interruptedAfter });
      send({ meta: 'prompt', text });
      stopReplay = replay(model.slice(7), Number(body.speed) || 1, turn);
      return;
    }
    if (!MODELS.has(model)) { turn.onError(`unknown model ${model}`); return; }
    const started = ensureProcess(s, model);
    send({ meta: 'process', started, ms: ms() });
    const text = buildPrompt({ question, board: s.board, pointing, interruptedAfter, earlier: earlierFor(s) });
    trace.push([ms(), `sent, process age ${Math.round(performance.now() - s.proc.startedAt)} ms`]);
    s.proc.send(text, turn);
  });
}
