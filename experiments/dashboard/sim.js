// The simulated service behind the `demo` source: a checkout system with six parts and
// the traffic between them. A value is a pure function of the metric, the time, a seed and
// the list of incidents, so any moment can be asked for at any time, and a test can
// compute what the page should be showing. This file has no DOM.

export const SIM_METRICS = {
  'web.rate': { name: 'requests', unit: 'req/s' },
  'web.errors': { name: 'errors', unit: '%' },
  'web.latency': { name: 'latency', unit: 'ms' },
  'api.rate': { name: 'requests', unit: 'req/s' },
  'api.errors': { name: 'errors', unit: '%' },
  'api.latency': { name: 'latency', unit: 'ms' },
  'cache.hitrate': { name: 'hit rate', unit: '%', axis: [0, 100] },
  'db.rate': { name: 'queries', unit: 'query/s' },
  'db.latency': { name: 'latency', unit: 'ms' },
  'db.connections': { name: 'connections', unit: 'conns', axis: [0, 100] },
  'queue.depth': { name: 'waiting', unit: 'jobs' },
  'worker.rate': { name: 'finished', unit: 'jobs/s' },
  'worker.busy': { name: 'busy', unit: '%', axis: [0, 100] },
  'edge.web-api': { name: 'web to api', unit: 'req/s' },
  'edge.api-cache': { name: 'api to cache', unit: 'req/s' },
  'edge.api-db': { name: 'api to db', unit: 'query/s' },
  'edge.api-queue': { name: 'api to queue', unit: 'jobs/s' },
  'edge.queue-worker': { name: 'queue to worker', unit: 'jobs/s' },
};

export const INCIDENTS = {
  'db-slow': { label: 'the database slows down', says: 'Database latency climbs, connections fill up, and the API starts to fail.' },
  'bad-deploy': { label: 'a bad deploy', says: 'The API starts answering errors. Traffic carries on.' },
  'queue-stuck': { label: 'the worker stops', says: 'Nothing finishes, so the queue grows until it recovers.' },
  'exporter-down': { label: 'the database stops reporting', says: 'Its numbers stop arriving. Nothing says it is healthy or broken, so the shape must say no data.' },
};

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// A repeatable number from -1 to 1 for one metric at one second.
function noise(id, t, seed) {
  let h = (hash(id) ^ Math.imul(Math.floor(t), 2654435761) ^ Math.imul(seed, 40503)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), h | 1);
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  return (((h ^ (h >>> 14)) >>> 0) / 2147483648) - 1;
}

// The same, drifting: straight lines between a new number every `period` seconds.
function drift(id, t, seed, period = 30) {
  const k = Math.floor(t / period);
  const a = noise(id, k * period, seed), b = noise(id, (k + 1) * period, seed);
  return a + (b - a) * ((t - k * period) / period);
}

const RAMP = 25;

// How far into an incident of this kind time `t` is, from 0 to 1.
function level(kind, t, incidents) {
  let most = 0;
  for (const inc of incidents) {
    if (inc.kind !== kind || t < inc.start) continue;
    const up = Math.min(1, (t - inc.start) / RAMP);
    const down = inc.end === null || inc.end === undefined || t < inc.end ? 1 : Math.max(0, 1 - (t - inc.end) / RAMP);
    most = Math.max(most, up * down);
  }
  return most;
}

// Jobs left behind by stopped workers, which drain after they recover.
function backlog(t, incidents) {
  let total = 0;
  for (const inc of incidents) {
    if (inc.kind !== 'queue-stuck' || t < inc.start) continue;
    const stop = inc.end ?? Infinity;
    const grown = (Math.min(t, stop) - inc.start) * 45;
    const drained = t > stop ? (t - stop) * 30 : 0;
    total += Math.max(0, grown - drained);
  }
  return total;
}

const round3 = (v) => Math.round(v * 1000) / 1000;

/** The value of a metric at a time, or null if it is not reporting then. */
export function simValue(id, t, { seed = 7, incidents = [] } = {}) {
  const sec = Math.floor(t);
  // Mostly drift, with a little jitter, as real services do.
  const n = (key) => 0.8 * drift(key, sec, seed) + 0.2 * noise(key, sec, seed);
  const slow = level('db-slow', sec, incidents);
  const bad = level('bad-deploy', sec, incidents);
  const stuck = level('queue-stuck', sec, incidents);
  const silent = incidents.some((inc) => inc.kind === 'exporter-down' && sec >= inc.start && (inc.end === null || inc.end === undefined || sec < inc.end));
  if (silent && (id.startsWith('db.') || id === 'edge.api-db')) return null;

  const traffic = 420 + 90 * Math.sin((2 * Math.PI * sec) / 3600) + 30 * Math.sin((2 * Math.PI * sec) / 620) + 12 * n('traffic');
  const apiErrors = 0.3 + 0.15 * Math.abs(n('api.errors')) + 11 * bad + 6 * slow;
  const webErrors = apiErrors * 0.8 + 0.05 * Math.abs(n('web.errors'));
  const webApi = traffic * (1 - webErrors / 100);
  const dbLatency = 8 + 2 * Math.abs(n('db.latency')) + 180 * slow;
  const apiLatency = 42 + 6 * Math.abs(n('api.latency')) + dbLatency * 0.9 + 30 * bad;
  const hit = 91 + 1.5 * n('cache.hitrate');
  const toCache = webApi * 0.85;
  const toDb = webApi * 0.15 + toCache * (1 - hit / 100);
  const toQueue = webApi * 0.12;
  const finished = stuck >= 1 ? 0 : (toQueue + 1.5 * n('worker.rate')) * (1 - stuck);

  let value;
  switch (id) {
    case 'web.rate': value = traffic; break;
    case 'web.errors': value = webErrors; break;
    case 'web.latency': value = apiLatency + 12 + 3 * Math.abs(n('web.latency')); break;
    case 'api.rate': case 'edge.web-api': value = webApi; break;
    case 'api.errors': value = apiErrors; break;
    case 'api.latency': value = apiLatency; break;
    case 'cache.hitrate': value = hit; break;
    case 'edge.api-cache': value = toCache; break;
    case 'db.rate': case 'edge.api-db': value = toDb; break;
    case 'db.latency': value = dbLatency; break;
    case 'db.connections': value = Math.round(Math.min(100, 22 + 3 * n('db.connections') + 74 * slow)); break;
    case 'queue.depth': value = Math.round(6 + 3 * Math.abs(n('queue.depth')) + backlog(sec, incidents)); break;
    case 'worker.rate': case 'edge.queue-worker': value = Math.max(0, finished); break;
    case 'worker.busy': value = Math.min(100, 55 + 5 * n('worker.busy') + 40 * slow - 50 * stuck); break;
    case 'edge.api-queue': value = toQueue; break;
    default: return undefined;
  }
  return round3(value);
}
