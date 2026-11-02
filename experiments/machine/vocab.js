// Every word a drawing can use, in one table. The label parser, the inspector, the
// hints while typing, the palette and the in-page reference all read this table, so
// none of them can disagree about what is allowed. This file has no DOM.
//
// A word's `forms` are the ways to write it. `{type:param}` reads a value into
// `params[param]`. A word with `into` keeps its values in `params[into]`, and one with
// `many` keeps a list of them. Forms of a word are tried in order.

import { parseActions, parseExpr } from './expr.js';

const timeUnit = (n, unit = 's') => {
  const u = unit.toLowerCase();
  if (u.startsWith('ms') || u.startsWith('milli')) return n / 1000;
  if (u.startsWith('m')) return n * 60;
  return n;
};
const perSecond = (n, unit = 's') => {
  const u = unit.toLowerCase();
  if (u.startsWith('h')) return n / 3600;
  if (u.startsWith('m')) return n / 60;
  return n;
};
const NUMBER = '\\d+(?:\\.\\d+)?';

const TYPES = {
  count: { re: '(\\d+)(?!\\.\\d)', read: (a) => Number(a), whole: true },
  number: { re: `(${NUMBER})`, read: (a) => Number(a) },
  time: { re: `(${NUMBER})\\s*(ms|msecs?|milliseconds?|secs?|seconds?|s|mins?|minutes?|m)?`, groups: 2, read: (a, b) => timeUnit(Number(a), b) },
  persec: { re: `(${NUMBER})\\s*(?:(?:/|per\\s+)\\s*(s|sec|second|m|min|minute|h|hr|hour)s?)?`, groups: 2, read: (a, b) => perSecond(Number(a), b) },
  persecUnit: { re: `(${NUMBER})\\s*(?:/|per\\s+)\\s*(s|sec|second|m|min|minute|h|hr|hour)s?`, groups: 2, read: (a, b) => perSecond(Number(a), b) },
  percent: { re: `(${NUMBER})\\s*%`, read: (a) => Number(a) },
  name: { re: '([A-Za-z_][\\w-]*)', read: (a) => a.toLowerCase() },
  expr: { re: '(.+)', read: (a) => parseExpr(a), keep: true },
  guard: { re: '\\[([^\\]]*)\\]', read: (a) => parseExpr(a), keep: true },
  actions: { re: '(.+)', read: (a) => parseActions(a), keep: true },
};

// The program a drawing runs as. Each mode has a sentence for "why".
export const MODES = {
  flow: { name: 'a flow of work', why: 'a shape uses a work word such as rate or workers', short: 'work' },
  states: { name: 'a state machine', why: 'it has arrows and no shape uses a work or logic word', short: 'states' },
  chain: { name: 'a chance walk', why: 'its arrows carry % labels', short: 'chance' },
  logic: { name: 'a logic circuit', why: 'a shape is a switch, clock, lamp or gate', short: 'logic' },
  none: { name: 'nothing yet', why: 'no arrow touches a shape', short: 'nothing' },
};

export const WORDS = [
  // ------------------------------------------------------------ work: shapes
  { id: 'rate', mode: 'flow', on: 'shape', makes: 'source', triggers: true, forms: ['rate {persec:rate}', '{persecUnit:rate}'], example: 'rate 3/s', means: 'Makes work at this average rate, at random moments.', also: ['qps', 'rps', 'arrivals', 'traffic', 'load', 'throughput', 'requests'] },
  { id: 'steady', mode: 'flow', on: 'shape', for: ['source'], forms: ['steady'], flag: true, example: 'steady', means: 'Spaces the work evenly instead of at random.' },
  { id: 'burst', mode: 'flow', on: 'shape', makes: 'source', triggers: true, into: 'burst', many: true, forms: ['burst {count:count} at {time:at}', 'burst {count:count} every {time:every}'], example: 'burst 40 at 10s', means: 'Adds that much work at once, at that time or on that schedule.', also: ['spike'] },
  { id: 'mix', mode: 'flow', on: 'shape', for: ['source'], into: 'mix', many: true, forms: ['mix {name:kind} {percent:share}'], example: 'mix gold 20%', means: 'Names that share of the work. An arrow can then say if gold.' },
  { id: 'keys', mode: 'flow', on: 'shape', for: ['source'], forms: ['keys {count:keys}'], example: 'keys 1000', means: 'Each job asks for one of this many items, and a few items are popular. A cache uses this.' },
  { id: 'workers', mode: 'flow', on: 'shape', makes: 'workers', triggers: true, forms: ['workers|worker {count:workers}', '{count:workers} workers|worker'], example: 'workers 3', means: 'Does work, this many jobs at a time. Click a worker to kill it.', also: ['threads', 'servers', 'server', 'cores', 'concurrency', 'capacity', 'replicas', 'instances', 'machines'] },
  { id: 'takes', mode: 'flow', on: 'shape', makes: 'workers', triggers: true, for: ['workers'], forms: ['takes|take {time:takes}'], example: 'takes 0.75s', means: 'How long one job takes, give or take 30%.', also: ['latency', 'duration', 'service', 'time', 'speed'] },
  { id: 'slow', mode: 'flow', on: 'shape', for: ['workers'], into: 'slow', forms: ['slow {percent:share} x{number:factor}'], example: 'slow 5% x10', means: 'That share of jobs take that many times as long.' },
  { id: 'limit', mode: 'flow', on: 'shape', for: ['queue', 'workers'], forms: ['limit {count:limit}'], example: 'limit 20', means: 'Turns work away once this many are waiting.', also: ['max', 'size', 'buffer', 'capacity'] },
  { id: 'priority', mode: 'flow', on: 'shape', for: ['queue', 'workers'], forms: ['priority {name:priority}'], example: 'priority gold', means: 'Work with this name goes first.' },
  { id: 'delay', mode: 'flow', on: 'shape', makes: 'delay', triggers: true, forms: ['delay {time:delay}'], example: 'delay 2s', means: 'Holds every job for this long, with no limit on how many.', also: ['sleep', 'wait', 'network', 'lag', 'pause'] },
  { id: 'batch', mode: 'flow', on: 'shape', makes: 'batch', triggers: true, forms: ['batch {count:batch} or {time:batchWait}', 'batch {count:batch}'], example: 'batch 5 or 2s', means: 'Groups this many jobs into one, or sends what it has after that time.', also: ['group'] },
  { id: 'split', mode: 'flow', on: 'shape', makes: 'split', forms: ['split {count:split}', 'split'], whole: true, example: 'split 3', means: 'Turns one job into this many parts. With no number, one part per arrow.', also: ['fork', 'fanout'] },
  { id: 'merge', mode: 'flow', on: 'shape', makes: 'merge', forms: ['merge'], whole: true, example: 'merge', means: 'Waits for every part of a split, then sends one job on.', also: ['join', 'gather'] },
  { id: 'first', mode: 'flow', on: 'shape', for: ['merge'], makes: 'merge', forms: ['first {count:first}'], example: 'first 1', means: 'Goes on as soon as this many parts have arrived, and ignores the rest.' },
  { id: 'cache', mode: 'flow', on: 'shape', makes: 'cache', triggers: true, forms: ['cache {percent:hitRate}', 'cache {count:cache}'], example: 'cache 80%', means: 'A % hits that often. A number remembers that many items, so its hit rate is earned. Arrows hit and miss say where work goes.', also: ['memo', 'memcached', 'redis'] },
  { id: 'ratelimit', mode: 'flow', on: 'shape', makes: 'limiter', triggers: true, forms: ['rate limit {persec:allow}', 'limit {persecUnit:allow}', 'allow {persec:allow}'], example: 'rate limit 5/s', means: 'Lets this much through. The rest go along an arrow labelled over, or are turned away.', also: ['throttle'] },
  { id: 'roundrobin', mode: 'flow', on: 'shape', makes: 'router', policy: 'round robin', for: ['router'], forms: ['round robin'], example: 'round robin', means: 'Sends work along each arrow in turn. This is the default.' },
  { id: 'random', mode: 'flow', on: 'shape', makes: 'router', policy: 'random', for: ['router'], forms: ['random'], example: 'random', means: 'Picks an arrow at random.' },
  { id: 'leastbusy', mode: 'flow', on: 'shape', makes: 'router', policy: 'least busy', for: ['router'], forms: ['least busy'], example: 'least busy', means: 'Sends work to whichever next shape has the least to do.', also: ['leastconn'] },
  { id: 'twochoices', mode: 'flow', on: 'shape', makes: 'router', policy: 'two choices', for: ['router'], forms: ['two choices'], example: 'two choices', means: 'Picks two arrows at random and uses the less busy one.' },
  { id: 'chart', mode: 'any', on: 'shape', makes: 'chart', forms: ['chart {expr:chartOf}', 'chart'], example: 'chart', means: 'Charts whatever it is joined to by an arrow. In a state machine, chart tries charts that variable.', also: ['graph', 'plot', 'probe'] },

  // ------------------------------------------------------------ work: arrows
  { id: 'share', modes: ['flow', 'chain'], on: 'arrow', forms: ['{percent:percent}'], example: '90%', means: 'This share of the work, or of the walkers, takes this arrow.', also: ['chance', 'probability'] },
  { id: 'if', mode: 'flow', on: 'arrow', forms: ['if {expr:when}'], example: 'if retries < 3', means: 'Only work this is true for takes this arrow. Work knows retries, age and its mix name.', also: ['when', 'only'] },
  { id: 'else', mode: 'flow', on: 'arrow', forms: ['else'], whole: true, flag: true, param: 'otherwise', example: 'else', means: 'Work no if arrow took goes this way.', also: ['otherwise'] },
  { id: 'after', modes: ['flow', 'states'], on: 'arrow', forms: ['after {time:after}', 'after {expr:afterExpr}'], example: 'after 5s', means: 'In a flow, work that has waited this long leaves this way. In a state machine, moves by itself after this long.', also: ['timeout', 'ttl', 'expires'] },
  { id: 'copy', mode: 'flow', on: 'arrow', forms: ['copy after {time:after}'], flag: false, example: 'copy after 5s', means: 'After this long, a retry leaves this way but the original keeps waiting. Nobody wants its result any more, so it is drawn gray.' },
  { id: 'hit', mode: 'flow', on: 'arrow', exit: 'hit', forms: ['hit'], whole: true, example: 'hit', means: 'Work the cache found takes this arrow.', also: ['hits'] },
  { id: 'miss', mode: 'flow', on: 'arrow', exit: 'miss', forms: ['miss'], whole: true, example: 'miss', means: 'Work the cache did not find takes this arrow.', also: ['misses'] },
  { id: 'over', mode: 'flow', on: 'arrow', exit: 'over', forms: ['over'], whole: true, example: 'over', means: 'Work past a rate limit takes this arrow instead of being turned away.', also: ['rejected', 'reject', 'excess'] },

  // ------------------------------------------------------------ state machines
  { id: 'event', mode: 'states', on: 'arrow', forms: [], free: true, example: 'fail', means: 'Any other words are an event. Each event gets a button and a number key. No label means an event called next.' },
  { id: 'times', mode: 'states', on: 'arrow', forms: ['x{count:times}', '×{count:times}'], example: 'fail x3', head: 'x', means: 'Moves on the third fail in a row. Any other event starts the count again.' },
  { id: 'guard', mode: 'states', on: 'arrow', forms: ['{guard:guard}'], example: 'buy [money >= 75]', head: '[', means: 'The arrow only works while this is true. On its own, it moves as soon as it is true.' },
  { id: 'action', mode: 'states', on: 'arrow', forms: ['/ {actions:action}'], example: 'coin / money = money + 25', head: '/', means: 'Runs when the arrow fires. A name you have not set is 0.' },
  { id: 'enter', mode: 'states', on: 'shape', forms: ['enter {actions:enter}'], example: 'enter tries = 0', means: 'Runs each time this state is entered.', also: ['entry', 'onenter'] },

  // ------------------------------------------------------------ chance
  { id: 'start', mode: 'chain', on: 'arrow', forms: ['start {count:walkers}'], example: 'start 200', means: 'On an arrow from nothing: this many walkers begin at the shape it points to.' },
  { id: 'every', mode: 'chain', on: 'arrow', forms: ['every {time:every}'], example: 'every 1s', means: 'On an arrow from nothing: walkers take a step this often.' },

  // ------------------------------------------------------------ logic
  { id: 'switch', mode: 'logic', on: 'shape', makes: 'switch', triggers: true, forms: ['switch on', 'switch off', 'switch'], whole: true, example: 'switch', means: 'A 1 or a 0 you click. Write switch on to start it on.', also: ['input', 'toggle-switch'] },
  { id: 'button', mode: 'logic', on: 'shape', makes: 'button', triggers: true, forms: ['button'], whole: true, example: 'button', means: 'A 1 only while you hold it down.', also: ['pushbutton'] },
  { id: 'clock', mode: 'logic', on: 'shape', makes: 'clock', triggers: true, forms: ['clock {time:clock}'], example: 'clock 1s', means: 'Flips between 0 and 1 this often.', also: ['oscillator', 'tick'] },
  { id: 'and', mode: 'logic', on: 'shape', makes: 'and', triggers: true, forms: ['and'], whole: true, example: 'and', means: '1 when every arrow in is 1.' },
  { id: 'or', mode: 'logic', on: 'shape', makes: 'or', triggers: true, forms: ['or'], whole: true, example: 'or', means: '1 when any arrow in is 1.' },
  { id: 'not', mode: 'logic', on: 'shape', makes: 'not', triggers: true, forms: ['not'], whole: true, example: 'not', means: '1 when its arrow in is 0.', also: ['inverter'] },
  { id: 'xor', mode: 'logic', on: 'shape', makes: 'xor', triggers: true, forms: ['xor'], whole: true, example: 'xor', means: '1 when an odd number of arrows in are 1.' },
  { id: 'nand', mode: 'logic', on: 'shape', makes: 'nand', triggers: true, forms: ['nand'], whole: true, example: 'nand', means: '0 only when every arrow in is 1.' },
  { id: 'nor', mode: 'logic', on: 'shape', makes: 'nor', triggers: true, forms: ['nor'], whole: true, example: 'nor', means: '1 only when every arrow in is 0.' },
  { id: 'flip', mode: 'logic', on: 'shape', makes: 'flip', triggers: true, forms: ['flip'], whole: true, example: 'flip', means: 'Changes between 0 and 1 each time its arrow in goes to 1. Chain these to count.', also: ['flipflop', 'toggle', 'tff'] },
  { id: 'lamp', mode: 'logic', on: 'shape', makes: 'lamp', triggers: true, forms: ['lamp'], whole: true, example: 'lamp', means: 'Lights up when its arrow in is 1.', also: ['led', 'light', 'output', 'bulb'] },
];

// What a shape turns out to be. `says` is what it does, and `why` is how the program
// knows. Order matters in a flow: the first kind whose word is present wins.
export const KINDS = {
  source: { name: 'source', mode: 'flow', says: 'Makes work and sends it along its arrows.', why: 'it has a rate or burst word', poke: { label: 'send 20 now', id: 'burst' } },
  cache: { name: 'cache', mode: 'flow', says: 'Answers some work itself and passes the rest on.', why: 'it has the word cache', poke: { label: 'empty the cache', id: 'flush' } },
  limiter: { name: 'rate limit', mode: 'flow', says: 'Lets only so much work through each second.', why: 'it has the words rate limit' },
  batch: { name: 'batch', mode: 'flow', says: 'Groups jobs together. A worker does a whole group in the time of one job.', why: 'it has the word batch' },
  split: { name: 'split', mode: 'flow', says: 'Turns one job into several parts.', why: 'its label is split' },
  merge: { name: 'merge', mode: 'flow', says: 'Waits for the parts of a split, then sends one job on.', why: 'its label is merge' },
  delay: { name: 'delay', mode: 'flow', says: 'Holds every job for a fixed time, with no limit on how many.', why: 'it has the word delay' },
  workers: { name: 'workers', mode: 'flow', says: 'Does work a few jobs at a time. Others wait in a line above it.', why: 'it has the word workers or takes' },
  router: { name: 'splitter', mode: 'flow', says: 'Chooses an arrow out for each job and holds nothing.', why: 'it is a diamond or names a way to choose' },
  sink: { name: 'end', mode: 'flow', says: 'Ends work and counts it.', why: 'arrows come in and none go out' },
  queue: { name: 'queue', mode: 'flow', says: 'Holds work until a shape further along has room.', why: 'it has an arrow out and no other word' },
  idle: { name: 'not connected', mode: 'flow', says: 'Does nothing until an arrow touches it.', why: 'no arrow touches it' },
  chart: { name: 'chart', mode: 'any', says: 'Charts what it is joined to by an arrow. Nothing flows along that arrow.', why: 'it has the word chart' },
  state: { name: 'state', mode: 'states', says: 'The machine is in one state at a time. Arrows out say how it can leave.', why: 'this drawing runs as a state machine' },
  place: { name: 'place', mode: 'chain', says: 'Walkers stand here, then take an arrow out by its % each step.', why: 'this drawing runs as a chance walk' },
  switch: { name: 'switch', mode: 'logic', says: 'A 1 or a 0. Click it to change it.', why: 'its label is switch' },
  button: { name: 'button', mode: 'logic', says: 'A 1 only while you hold it down.', why: 'its label is button' },
  clock: { name: 'clock', mode: 'logic', says: 'Flips between 0 and 1 on a schedule.', why: 'it has the word clock' },
  and: { name: 'and gate', mode: 'logic', says: '1 when every arrow in is 1.', why: 'its label is and' },
  or: { name: 'or gate', mode: 'logic', says: '1 when any arrow in is 1.', why: 'its label is or' },
  not: { name: 'not gate', mode: 'logic', says: '1 when its arrow in is 0.', why: 'its label is not' },
  xor: { name: 'xor gate', mode: 'logic', says: '1 when an odd number of arrows in are 1.', why: 'its label is xor' },
  nand: { name: 'nand gate', mode: 'logic', says: '0 only when every arrow in is 1.', why: 'its label is nand' },
  nor: { name: 'nor gate', mode: 'logic', says: '1 only when every arrow in is 0.', why: 'its label is nor' },
  flip: { name: 'flip-flop', mode: 'logic', says: 'Changes each time its arrow in goes to 1, so it runs at half the speed of what feeds it.', why: 'its label is flip' },
  lamp: { name: 'lamp', mode: 'logic', says: 'Lights up when its arrow in is 1.', why: 'its label is lamp' },
  wire: { name: 'junction', mode: 'logic', says: 'Passes on a 1 if any arrow in is 1.', why: 'it has no logic word' },
};

// In a flow, a shape with several kinds' words is the first of these.
export const KIND_ORDER = ['chart', 'source', 'cache', 'limiter', 'batch', 'split', 'merge', 'delay', 'workers', 'router'];

// Parts to drag onto the board. `short` names it in the tray, and `label` is what the
// shape starts with, which the tests check reads as the kind it claims to be.
export const PARTS = {
  work: [
    { id: 'source', short: 'source', type: 'ellipse', label: 'requests\nrate 3/s', tone: 'blue', w: 190, h: 110, kind: 'source' },
    { id: 'queue', short: 'queue', type: 'rectangle', label: 'queue', tone: 'amber', w: 230, h: 150, valign: 'top', kind: 'queue' },
    { id: 'workers', short: 'workers', type: 'rectangle', label: 'workers 2\ntakes 1s', tone: 'gray', w: 240, h: 150, valign: 'top', kind: 'workers' },
    { id: 'end', short: 'end', type: 'ellipse', label: 'done', tone: 'green', w: 170, h: 90, kind: 'sink' },
    { id: 'decide', short: 'decide', type: 'diamond', label: 'ok?', tone: 'gray', w: 160, h: 120, kind: 'router' },
    { id: 'balance', short: 'balance', type: 'diamond', label: 'least busy', tone: 'gray', w: 190, h: 130, kind: 'router' },
    { id: 'delay', short: 'delay', type: 'rectangle', label: 'delay 2s', tone: 'gray', w: 180, h: 90, kind: 'delay' },
    { id: 'batch', short: 'batch', type: 'rectangle', label: 'batch 5 or 2s', tone: 'gray', w: 210, h: 100, valign: 'top', kind: 'batch' },
    { id: 'split', short: 'split', type: 'rectangle', label: 'split', tone: 'gray', w: 120, h: 80, kind: 'split' },
    { id: 'merge', short: 'merge', type: 'rectangle', label: 'merge', tone: 'gray', w: 150, h: 100, valign: 'top', kind: 'merge' },
    { id: 'cache', short: 'cache', type: 'rectangle', label: 'cache 80%', tone: 'blue', w: 180, h: 90, kind: 'cache' },
    { id: 'limiter', short: 'rate limit', type: 'rectangle', label: 'rate limit 5/s', tone: 'gray', w: 210, h: 90, kind: 'limiter' },
    { id: 'chart', short: 'chart', type: 'rectangle', label: 'chart', tone: 'none', w: 320, h: 160, valign: 'top', kind: 'chart' },
  ],
  states: [
    { id: 'state', short: 'state', type: 'rectangle', label: 'state', tone: 'gray', w: 220, h: 110, kind: 'state' },
    { id: 'start', short: 'start arrow', type: 'arrow', label: '', tone: 'none', w: 90, h: 0, kind: 'state', says: 'An arrow from nothing marks the state to begin in. Drop it on a state.' },
    { id: 'chart', short: 'chart', type: 'rectangle', label: 'chart tries', tone: 'none', w: 320, h: 160, valign: 'top', kind: 'chart' },
  ],
  logic: [
    { id: 'switch', short: 'switch', type: 'rectangle', label: 'switch', tone: 'gray', w: 120, h: 70, kind: 'switch' },
    { id: 'button', short: 'button', type: 'rectangle', label: 'button', tone: 'gray', w: 120, h: 70, kind: 'button' },
    { id: 'clock', short: 'clock', type: 'rectangle', label: 'clock 1s', tone: 'gray', w: 140, h: 70, kind: 'clock' },
    { id: 'lamp', short: 'lamp', type: 'ellipse', label: 'lamp', tone: 'gray', w: 110, h: 90, kind: 'lamp' },
    { id: 'and', short: 'and', type: 'rectangle', label: 'and', tone: 'gray', w: 110, h: 80, kind: 'and' },
    { id: 'or', short: 'or', type: 'rectangle', label: 'or', tone: 'gray', w: 110, h: 80, kind: 'or' },
    { id: 'not', short: 'not', type: 'rectangle', label: 'not', tone: 'gray', w: 110, h: 80, kind: 'not' },
    { id: 'xor', short: 'xor', type: 'rectangle', label: 'xor', tone: 'gray', w: 110, h: 80, kind: 'xor' },
    { id: 'nand', short: 'nand', type: 'rectangle', label: 'nand', tone: 'gray', w: 110, h: 80, kind: 'nand' },
    { id: 'nor', short: 'nor', type: 'rectangle', label: 'nor', tone: 'gray', w: 110, h: 80, kind: 'nor' },
    { id: 'flip', short: 'flip-flop', type: 'rectangle', label: 'flip', tone: 'gray', w: 110, h: 80, kind: 'flip' },
  ],
};

// What each kind shows you it could also say, derived from the table.
export function wordsFor(kind, place, mode) {
  return WORDS.filter((w) => {
    if (w.on !== place || w.free || !w.forms.length) return false;
    if (!inMode(w, mode)) return false;
    if (place === 'shape' && w.for) return w.for.includes(kind);
    if (place === 'shape') return w.makes === kind && kind !== 'chart' ? true : w.makes === kind;
    return true;
  });
}

const inMode = (w, mode) => {
  const modes = w.modes ?? [w.mode];
  return modes.includes('any') || modes.includes(mode);
};

// ---------------------------------------------------------------------------
// Compile the forms.

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function compile(form) {
  const groups = [];
  const pieces = form.split(' ');
  let re = '';
  pieces.forEach((piece, i) => {
    let endsInWord = false;
    re += piece.replace(/\{(\w+):(\w+)\}|([^{]+)/g, (m, type, param, literal) => {
      if (type) {
        groups.push({ type, param });
        endsInWord = false;
        return TYPES[type].re;
      }
      endsInWord = /[A-Za-z]$/.test(literal);
      return `(?:${literal.split('|').map(escape).join('|')})`;
    });
    if (i < pieces.length - 1) re += endsInWord ? '(?![A-Za-z_])\\s*[:=]?\\s*' : '\\s*';
    else if (endsInWord) re += '(?![\\w-])';
    else if (groups.at(-1)?.type !== 'expr' && groups.at(-1)?.type !== 'actions') re += '(?![\\w%])';
  });
  return { regex: new RegExp(re, 'dyi'), groups };
}

for (const word of WORDS) {
  word.compiled = word.forms.map(compile);
  // The first literal of a word is what you would start typing.
  word.head ??= /^[A-Za-z]+/.exec(word.forms[0] ?? '')?.[0].toLowerCase() ?? word.id;
}

function scope(place, mode) {
  return WORDS.filter((w) => w.on === place && w.compiled.length && inMode(w, mode));
}

// Edit distance, for "did you mean".
export function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const hold = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = hold;
    }
  }
  return row[b.length];
}

const closeEnough = (a, b) => {
  const d = distance(a, b);
  return d > 0 && d <= (Math.max(a.length, b.length) >= 5 ? 2 : 1) && a[0] === b[0] || (d === 1 && a.length >= 4);
};

// ---------------------------------------------------------------------------
// Read one label.

const startsWithNumber = (s) => /^\s*[:=]?\s*\d/.test(s);

function matchAt(line, at, words, wholeLine) {
  let best = null, failure = null;
  for (const word of words) {
    for (const { regex, groups } of word.compiled) {
      regex.lastIndex = at;
      const m = regex.exec(line);
      if (!m || !m[0].length) continue;
      if (word.whole && m[0].trim().toLowerCase() !== wholeLine) continue;
      const values = {};
      const numbers = [];
      let g = 1, bad = null;
      for (const { type, param } of groups) {
        const t = TYPES[type];
        const count = t.groups ?? 1;
        try {
          values[param] = t.read(...m.slice(g, g + count));
          if (t.keep) values[`${param}Text`] = m[g];
        } catch (err) {
          bad = err;
        }
        if (type !== 'name' && !t.keep) numbers.push({ param, start: m.indices[g][0], end: m.indices[g][1], value: Number(m[g]), whole: !!t.whole, percent: type === 'percent' });
        g += count;
      }
      if (bad) {
        if (!failure) failure = { word, text: m[0], error: bad };
        continue;
      }
      if (!best || m[0].length > best.text.length) best = { word, text: m[0], start: at, end: at + m[0].length, values, numbers };
    }
  }
  return { best, failure };
}

/**
 * Read one label for a place and mode. Returns what it understood (`hits`), the words
 * it took as a name (`rest`), and what looks wrong (`problems`).
 */
export function readLabel(label = '', place = 'shape', mode = 'flow') {
  const params = {};
  const hits = [];
  const rest = [];
  const problems = [];
  const words = scope(place, mode);
  const lines = String(label).split('\n');

  lines.forEach((line, lineNo) => {
    const wholeLine = line.trim().toLowerCase();
    let at = 0;
    while (at < line.length) {
      while (at < line.length && /[\s,]/.test(line[at])) at++;
      if (at >= line.length) break;
      const { best, failure } = matchAt(line, at, words, wholeLine);
      if (best) {
        hits.push({ ...best, line: lineNo });
        at = best.end;
        continue;
      }
      if (failure) {
        problems.push({ line: lineNo, start: at, end: at + failure.text.length, text: failure.text.trim(), message: `I can't read "${failure.text.trim()}": ${failure.error.message}.`, level: 'error' });
        at += failure.text.length;
        continue;
      }
      const m = /[^\s,[]+|\[/y;
      m.lastIndex = at;
      const piece = m.exec(line)[0];
      rest.push({ word: piece, line: lineNo, start: at, end: at + piece.length });
      at += piece.length;
    }
  });

  for (const hit of hits) store(params, hit);
  checkRest(rest, lines, place, mode, problems, words);
  const name = nameFrom(lines, rest, hits);
  return { params, hits, rest, problems, name };
}

function store(params, hit) {
  const { word, values } = hit;
  if (word.policy) params.policy = word.policy;
  if (word.exit) params.exit = word.exit;
  if (word.id === 'copy') params.copy = true;
  if (word.flag) params[word.param ?? word.id] = true;
  if (word.into) {
    if (word.many) (params[word.into] ??= []).push(values);
    else params[word.into] = values;
  } else {
    Object.assign(params, values);
    if (word.id === 'split' && values.split === undefined) params.split = 0;
    if (word.id === 'switch') params.startsOn = /\bon\b/i.test(hit.text);
  }
}

function nameFrom(lines, rest, hits) {
  const first = rest.filter((r) => r.line === rest[0]?.line);
  if (first.length) return lines[first[0].line].slice(first[0].start, first.at(-1).end).trim();
  return hits[0] ? (hits[0].word.head ?? '') : '';
}

// A leftover word might be a name, which is fine, or a mistake worth saying out loud.
function checkRest(rest, lines, place, mode, problems, words) {
  const argTakers = words.filter((w) => w.forms.every((f) => f.includes('{')));
  rest.forEach((piece, i) => {
    const lower = piece.word.toLowerCase();
    if (!/^[a-z]/.test(lower)) return;
    const line = lines[piece.line];
    const after = line.slice(piece.end);
    const hasNumber = startsWithNumber(after);
    const trailing = /^\s*[:=]?\s*\S*/.exec(after)[0].trim();
    const shownWith = hasNumber ? `${piece.word} ${trailing.replace(/^[:=]\s*/, '')}` : piece.word;

    // The right word with the wrong thing after it, or nothing after it.
    const exact = argTakers.find((w) => w.head === lower || w.forms.some((f) => f.split(' ')[0].split('|').includes(lower)));
    if (exact && !(place === 'arrow' && mode === 'states')) {
      problems.push({ line: piece.line, start: piece.start, end: piece.end + after.length, text: line.slice(piece.start).trim(), word: exact, message: `I can't read "${line.slice(piece.start).trim()}". Try something like "${exact.example}".`, level: 'error' });
      return;
    }

    // Goes somewhere else.
    if (hasNumber || mode !== 'states') {
      const other = WORDS.find((w) => w.compiled.length && w.on !== place && w.head === lower && (inMode(w, mode) || !w.triggers));
      if (other) {
        problems.push({ line: piece.line, start: piece.start, end: piece.end, text: shownWith, word: other, message: `"${shownWith}" goes on ${other.on === 'shape' ? 'a shape' : 'an arrow'}, not ${place === 'shape' ? 'a shape' : 'an arrow'}.`, level: 'error' });
        return;
      }
    }

    // Spelled a little differently, or called something else.
    const pool = words.filter((w) => !w.free);
    const named = pool.find((w) => (w.also ?? []).includes(lower));
    const near = pool.find((w) => closeEnough(lower, w.head));
    const takesArg = (w) => w.forms.every((f) => f.includes('{'));
    const match = (named && (hasNumber || !takesArg(named)) ? named : null)
      ?? (near && (hasNumber ? takesArg(near) : !takesArg(near) && lines[piece.line].trim().toLowerCase() === lower) ? near : null);
    if (match) {
      problems.push({ line: piece.line, start: piece.start, end: piece.end, text: shownWith, word: match, suggest: match.head, message: `"${shownWith}"? Did you mean "${hasNumber ? `${match.head} ${trailing.replace(/^[:=]\s*/, '')}` : match.head}"?`, level: 'error' });
      return;
    }

    // An unknown word with a number on a shape looks like it means something.
    if (hasNumber && place === 'shape' && mode !== 'states' && mode !== 'chain' && i === rest.length - 1 && !rest.slice(0, i).some((r) => r.line === piece.line)) {
      const numbered = pool.filter((w) => takesArg(w) && w.head).slice(0, 5).map((w) => w.head).join(', ');
      problems.push({ line: piece.line, start: piece.start, end: piece.end, text: shownWith, message: `I don't know "${piece.word}", so "${shownWith}" is just a name. Words that use a number: ${numbered}.`, level: 'note' });
    }
  });
}

/** Whether a label uses a word that makes the whole drawing a flow or a circuit. */
export function triggerOf(label, mode) {
  return readLabel(label, 'shape', mode).hits.find((h) => h.word.triggers) ?? null;
}

/** Hints while typing: what starts with these letters, or goes by another name. */
export function suggest(prefix, place, mode, kind) {
  const lower = prefix.toLowerCase();
  const pool = scope(place, mode).filter((w) => !w.free);
  const allowedHere = (w) => place !== 'shape' || !w.for || !kind || w.for.includes(kind);
  const match = (w) => !lower || w.head.startsWith(lower) || w.forms.some((f) => f.toLowerCase().startsWith(lower)) || (w.also ?? []).some((a) => a.startsWith(lower));
  const found = pool.filter(match);
  return [...found.filter(allowedHere), ...found.filter((w) => !allowedHere(w))];
}
