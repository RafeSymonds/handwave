#!/usr/bin/env node
// Serves the repository as static files. An experiment that needs a backend adds
// experiments/<name>/server.mjs, which exports
//   default ({ route, sockets, root, log }) => {}
// `route(method, path, handler)` adds an HTTP route and `sockets(path, onConnection)`
// a WebSocket endpoint. Run with PORT=0 to take any free port.
//
// It listens on this machine only. HOST=0.0.0.0 opens it to the local network,
// which phones need for the live deck. Do that only on a network you trust,
// because backends such as the tutor act on your behalf.

import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { WebSocketServer } from 'ws';

const root = path.dirname(fileURLToPath(import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.excalidraw': 'application/json', '.md': 'text/markdown; charset=utf-8',
  '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4',
};

export async function startServer(port = Number(process.env.PORT ?? 4173), { host = process.env.HOST ?? '127.0.0.1', quiet = false } = {}) {
  const routes = [];
  const socketPaths = new Map();
  const log = (...args) => { if (!quiet) console.log(...args); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = routes.find((r) => r.method === req.method && r.path === url.pathname);
    if (route) {
      try { await route.handler(req, res, url); } catch (err) {
        console.error(err);
        if (!res.headersSent) res.writeHead(500);
        res.end(String(err?.message ?? err));
      }
      return;
    }
    let file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    const hidden = path.relative(root, file).split(path.sep).some((part) => part.startsWith('.'));
    if (!file.startsWith(root) || hidden) { res.writeHead(403); res.end(); return; }
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      const stream = fs.createReadStream(file);
      stream.on('error', () => { res.writeHead(404); res.end('not found'); });
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      stream.pipe(res);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const entry = socketPaths.get(pathname);
    if (!entry) { socket.destroy(); return; }
    entry.wss.handleUpgrade(req, socket, head, (ws) => entry.onConnection(ws, req));
  });

  const api = {
    root, log,
    route: (method, p, handler) => routes.push({ method, path: p, handler }),
    sockets: (p, onConnection) => socketPaths.set(p, { wss: new WebSocketServer({ noServer: true }), onConnection }),
  };

  const experiments = path.join(root, 'experiments');
  // The front page asks this which experiments exist.
  api.route('GET', '/experiments.json', (req, res) => {
    const built = fs.readdirSync(experiments).filter((name) => fs.existsSync(path.join(experiments, name, 'index.html')));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(built));
  });
  if (fs.existsSync(experiments)) {
    for (const name of fs.readdirSync(experiments)) {
      const backend = path.join(experiments, name, 'server.mjs');
      if (!fs.existsSync(backend)) continue;
      // One experiment's broken backend must not take down the others.
      try {
        (await import(pathToFileURL(backend).href)).default(api);
      } catch (err) {
        console.error(`handwave: experiments/${name}/server.mjs failed to load: ${err.message}`);
      }
    }
  }

  await new Promise((resolve) => server.listen(port, host, resolve));
  const actual = server.address().port;
  log(`handwave on http://localhost:${actual}`);
  return { server, port: actual, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await startServer();
