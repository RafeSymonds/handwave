// The dashboard's backend. A page asks for data by source name and query, and only this
// file and sources.mjs ever open a connection. Every route answers only this machine, and
// only a page this server served, because the root server can be listening on every
// interface for the live deck.

import { createSources } from './sources.mjs';

const LOOPBACK_ADDRESS = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
const LOOPBACK_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i;

/**
 * Why a request may not be answered, or null if it may. The same rule as the tutor's: it
 * must come from this machine, from a page this server served, and name this machine as
 * its Host, which stops a site pointing its own domain at 127.0.0.1 (DNS rebinding).
 * Every browser sends Origin on a POST, so every route here is a POST and a missing
 * Origin is refused.
 */
export function refusal(req) {
  if (!LOOPBACK_ADDRESS.test(req.socket?.remoteAddress ?? '')) return 'the dashboard only answers this machine';
  const host = String(req.headers.host ?? '');
  if (!LOOPBACK_HOST.test(host)) return 'the dashboard only answers this machine';
  let origin;
  try { origin = new URL(String(req.headers.origin ?? '')).host; } catch { return 'the dashboard only answers its own page'; }
  if (origin.toLowerCase() !== host.toLowerCase()) return 'the dashboard only answers its own page';
  return null;
}

const MAX_BODY = 1_000_000;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
      if (body.length > MAX_BODY) { reject(new Error('that request is too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('that request is not JSON')); }
    });
    req.on('error', reject);
  });
}

export default function dashboard({ route }) {
  const sources = createSources();

  const answer = (path, fn) => route('POST', path, async (req, res) => {
    const why = refusal(req);
    if (why) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end(why); return; }
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) { res.writeHead(415, { 'Content-Type': 'text/plain' }); res.end('send JSON'); return; }
    let out;
    try {
      out = await fn(await readJson(req), req);
    } catch (err) {
      res.writeHead(err.status ?? 400, { 'Content-Type': 'text/plain' });
      res.end(String(err.message ?? err));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(out));
  });

  answer('/dashboard/sources', async () => ({ now: Date.now() / 1000, ...sources.list() }));
  answer('/dashboard/fetch', async (body) => ({ now: Date.now() / 1000, results: await sources.fetchAll(body.queries) }));
  answer('/dashboard/push', async (body, req) => sources.push(body, req.headers.authorization));
  answer('/dashboard/incident', async (body) => sources.incident(body));
}
