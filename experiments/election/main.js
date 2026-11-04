// The 2026 midterm results as a hand-drawn page. Every seat is a dot and every state
// a tile, so pointing at one reads that race, and the page saves as an .excalidraw
// file. The numbers are a snapshot in results.json, written by refresh.mjs.

import { createStage, measure } from '/lib/stage.js';
import { rect, ellipse, text, line, color, toExcalidraw } from '/lib/draw.js';

const canvas = document.getElementById('stage');
const stage = await createStage(canvas, { width: 1600, height: 900 });
const results = await (await fetch('./results.json')).json();

const TABS = [
  { id: 'senate', title: 'Senate', office: 'Senate', races: 'Senate races' },
  { id: 'house', title: 'House', office: 'House', races: 'House seats' },
  { id: 'governors', title: 'Governors', office: 'governor', races: 'governor races' },
];

// A seat's fill says its party and what happened to it: darkest flipped, middle kept,
// palest not up this year. A seat with no call has no party yet, so it stays hollow.
const TONES = {
  D: { flip: { fill: '#1971c2', stroke: '#1864ab' }, won: { fill: '#4dabf7', stroke: '#1971c2' }, notUp: { fill: '#e7f5ff', stroke: '#a5d8ff' } },
  R: { flip: { fill: '#e03131', stroke: '#c92a2a' }, won: { fill: '#ff6b6b', stroke: '#e03131' }, notUp: { fill: '#fff5f5', stroke: '#ffc9c9' } },
};
const OPEN = { fill: '#ffffff', stroke: color.ink };
const OTHER = { fill: '#dee2e6', stroke: '#868e96' };
const FAINT = '#adb5bd';
const toneOf = (party, kind) => (kind === 'open' ? OPEN : TONES[party][kind]);
const PARTY_NAME = { D: 'Democrats', R: 'Republicans' };

// A race's kind, in the same words as a seat's.
const kindOf = (race) => (!race.called ? 'open' : race.flip ? 'flip' : 'won');

// A common tile map of the states: [column, row].
const GRID = {
  AK: [0, 0], ME: [10, 0], WI: [5, 1], VT: [9, 1], NH: [10, 1],
  WA: [0, 2], ID: [1, 2], MT: [2, 2], ND: [3, 2], MN: [4, 2], IL: [5, 2], MI: [6, 2], NY: [8, 2], MA: [9, 2],
  OR: [0, 3], NV: [1, 3], WY: [2, 3], SD: [3, 3], IA: [4, 3], IN: [5, 3], OH: [6, 3], PA: [7, 3], NJ: [8, 3], CT: [9, 3], RI: [10, 3],
  CA: [0, 4], UT: [1, 4], CO: [2, 4], NE: [3, 4], MO: [4, 4], KY: [5, 4], WV: [6, 4], VA: [7, 4], MD: [8, 4], DE: [9, 4],
  AZ: [1, 5], NM: [2, 5], KS: [3, 5], AR: [4, 5], TN: [5, 5], NC: [6, 5], SC: [7, 5],
  OK: [3, 6], LA: [4, 6], MS: [5, 6], AL: [6, 6], GA: [7, 6],
  HI: [0, 7], TX: [3, 7], FL: [8, 7],
};
const stateName = (st) => results.house.states[st].name;

// Newsweek reports the state's plan. It applies to every Alaska race on this page.
const NOTES = { AK: 'Alaska tabulates ranked choices on Nov 18 if no one tops 50%.' };

// ------------------------------------------------------------------ the layout

const ARC = { cx: 400, base: 548, inner: 150, outer: 322 };
const CARD = { x: 40, y: 106, w: 500, h: 94, gap: 10 };
const MAP = { x: 820, y: 222, pitch: 66, tile: 60 };
const PANEL = { x: 40, y: 574, w: 720, h: 306 };
const SAVE = { x: 1368, y: 28, w: 192, h: 46 };

// Pass input through, and change at once, since a hover must answer immediately.
const QUIET = { customData: { handwave: { ghost: true, enter: 'none', change: 'none', exit: 'none' } } };
const FADE = { customData: { handwave: { ghost: true, enter: 'fade' } } };

const number = (n) => n.toLocaleString('en-US');
const percent = (p) => `${p.toFixed(1)}%`;
const asOfDay = new Date(results.asOfISO).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });

// ------------------------------------------------------------------ the seats

/** Every seat in order from left to right: Democrats, then no call, then Republicans. */
function seatList(tab) {
  const { races, notUp } = results[tab];
  const decided = (party, flip) => races.filter((r) => r.winner === party && r.flip === flip).map((race) => ({ party, kind: flip ? 'flip' : 'won', race }));
  const idle = (party) => Array.from({ length: notUp?.[party] ?? 0 }, () => ({ party, kind: 'notUp', race: null }));
  return [
    ...idle('D'), ...decided('D', false), ...decided('D', true),
    ...races.filter((r) => !r.called).map((race) => ({ party: null, kind: 'open', race })),
    ...decided('R', true), ...decided('R', false), ...idle('R'),
  ];
}

/** Places n seats in arcs of even spacing, sorted by angle so each block reads as a wedge. */
function arcOf(n) {
  const { cx, base, inner, outer } = ARC;
  const pitch = Math.sqrt((Math.PI / 2) * (outer ** 2 - inner ** 2) / n);
  const rows = Math.max(2, Math.round((outer - inner) / pitch));
  const radii = Array.from({ length: rows }, (_, i) => inner + (outer - inner) * (i / (rows - 1)));
  const sum = radii.reduce((a, b) => a + b, 0);
  let left = n;
  const spots = [];
  radii.forEach((r, i) => {
    const count = i === rows - 1 ? left : Math.round(n * r / sum);
    left -= count;
    for (let k = 0; k < count; k++) {
      const angle = Math.PI * (1 - k / (count - 1));
      spots.push({ x: cx + r * Math.cos(angle), y: base - r * Math.sin(angle), angle, row: i });
    }
  });
  spots.sort((a, b) => b.angle - a.angle || a.row - b.row);
  return { spots, size: Math.min(pitch * 0.8, 34) };
}

const SEATS = Object.fromEntries(TABS.map(({ id }) => {
  const list = seatList(id);
  const { spots, size } = arcOf(list.length);
  return [id, { size, seats: list.map((seat, i) => ({ ...seat, ...spots[i] })) }];
}));

const state = { tab: 'senate', hover: null, pinned: null };
const focusOf = (s) => s.hover ?? s.pinned;
const sameFocus = (a, b) => (a?.st ?? null) === (b?.st ?? null) && (a?.seat ?? null) === (b?.seat ?? null);

/** The race a focus points at, for a seat or for a state with one statewide race. */
function raceOf(s, focus) {
  if (focus?.seat !== undefined) return SEATS[s.tab].seats[focus.seat].race;
  if (focus?.st && s.tab !== 'house') return results[s.tab].races.find((r) => r.st === focus.st) ?? null;
  return null;
}

function drawSeats(out, s) {
  const { seats, size } = SEATS[s.tab];
  const focus = focusOf(s);
  const race = raceOf(s, focus);
  seats.forEach((seat, i) => {
    const tone = toneOf(seat.party, seat.kind);
    const lit = focus?.seat === i || (race && seat.race === race) || (s.tab === 'house' && focus?.st && seat.race?.st === focus.st);
    out.push(ellipse(`seat-${i}`, seat.x - size / 2, seat.y - size / 2, size, size, {
      tone,
      strokeColor: lit ? color.ink : tone.stroke,
      strokeWidth: lit ? 3 : size < 20 ? 1 : 1.5,
      strokeStyle: seat.kind === 'open' ? 'dashed' : 'solid',
      roughness: size < 20 ? 0.6 : 1,
      customData: { handwave: { enter: 'pop', cursor: 'pointer' } },
    }));
  });

  const { majority, seats: total, before, races } = results[s.tab];
  // Governors do not vote together, so that tab has no majority to mark.
  if (s.tab !== 'governors') {
    const angle = (seats[majority - 1].angle + seats[majority].angle) / 2;
    const at = (r) => [ARC.cx + r * Math.cos(angle), ARC.base - r * Math.sin(angle)];
    out.push(line('majority', [at(ARC.inner - 22), at(ARC.outer + 18)], { strokeColor: color.ink, strokeStyle: 'dashed', strokeWidth: 2, roughness: 0.5, ...FADE }));
  }
  out.push(text('middle', ARC.cx, ARC.base - 62, s.tab === 'governors' ? `${races.length} of ${total} were up` : `${majority} is a majority`, { size: 25, align: 'center', ...FADE }));
  out.push(text('before', ARC.cx, ARC.base - 26, `Going in: ${before.D} D, ${before.R} R`, { size: 20, align: 'center', color: color.muted, ...FADE }));
}

// ------------------------------------------------------------------ the tabs

function drawCards(out, s) {
  TABS.forEach(({ id, title }, i) => {
    const x = CARD.x + i * (CARD.w + CARD.gap);
    const { won, seats, races, majority } = results[id];
    const open = races.filter((r) => !r.called).length;
    const flips = (party) => races.filter((r) => r.flip && r.winner === party).length;
    const on = s.tab === id;
    out.push(rect(`tab-${id}`, x, CARD.y, CARD.w, CARD.h, {
      strokeColor: on ? color.ink : FAINT,
      strokeWidth: on ? 3 : 1.5,
      backgroundColor: on ? '#f8f9fa' : 'transparent',
      customData: { handwave: { cursor: 'pointer' } },
    }));
    out.push(text(`tab-${id}-title`, x + 20, CARD.y + 14, title, { size: 28, ...FADE }));

    // The numbers, each beside a dot in its legend color.
    let right = x + CARD.w - 18;
    [[`${open} no call`, OPEN, 'open'], [`${won.R} R`, TONES.R.won, 'r'], [`${won.D} D`, TONES.D.won, 'd']].forEach(([words, tone, key]) => {
      const t = text(`tab-${id}-${key}`, right, CARD.y + 18, words, { size: 24, align: 'right', ...FADE });
      out.push(t);
      out.push(ellipse(`tab-${id}-${key}-dot`, t.x - 23, CARD.y + 22, 17, 17, { tone, strokeStyle: key === 'open' ? 'dashed' : 'solid', strokeWidth: 1.5, ...FADE }));
      right = t.x - 36;
    });

    // The same split as the seats, on one bar.
    const barX = x + 20, barW = CARD.w - 40, barY = CARD.y + 60, barH = 18;
    const part = (key, from, count, tone, o = {}) => {
      if (!count) return;
      out.push(rect(`tab-${id}-bar-${key}`, barX + barW * from / seats, barY, Math.max(2, barW * count / seats - 2), barH, { tone, roundness: null, roughness: 0.5, strokeWidth: 1, ...o, ...FADE }));
    };
    part('kept', 0, won.D - flips('D'), TONES.D.won);
    part('flip', won.D - flips('D'), flips('D'), TONES.D.flip);
    part('open', won.D, open, OPEN, { strokeStyle: 'dashed' });
    part('rflip', won.D + open, flips('R'), TONES.R.flip);
    part('r', won.D + open + flips('R'), won.R - flips('R'), TONES.R.won);
    if (id !== 'governors') {
      const tick = barX + barW * majority / seats;
      out.push(line(`tab-${id}-tick`, [[tick, barY - 5], [tick, barY + barH + 5]], { strokeColor: color.ink, strokeWidth: 2, roughness: 0, ...FADE }));
    }
  });
}

// ------------------------------------------------------------------ the map

function drawMap(out, s) {
  const tab = TABS.find((t) => t.id === s.tab);
  const focus = focusOf(s);
  const focused = raceOf(s, focus)?.st ?? focus?.st;
  const count = s.tab === 'house' ? results.house.seats : results[s.tab].races.length;
  out.push(text('map-title', MAP.x + MAP.pitch + 10, MAP.y - 2, `${count} ${tab.races}`, { size: 28, ...FADE }));
  out.push(text('map-hint', MAP.x + MAP.pitch + 10, MAP.y + 32, 'Point at a state or a seat. Click to keep it.', { size: 20, color: color.muted, ...FADE }));

  for (const [st, [col, row]] of Object.entries(GRID)) {
    const x = MAP.x + col * MAP.pitch, y = MAP.y + row * MAP.pitch, size = MAP.tile;
    const lit = focused === st;
    const custom = { handwave: { cursor: 'pointer' } };
    if (s.tab === 'house') {
      const { D, R, open } = results.house.states[st];
      const flips = (party) => results.house.races.filter((r) => r.st === st && r.flip && r.winner === party).length;
      const seats = D + R + open;
      out.push(rect(`tile-${st}`, x, y, size, size, { tone: { fill: '#ffffff', stroke: lit ? color.ink : FAINT }, strokeWidth: lit ? 3 : 1.5, customData: custom }));
      out.push(text(`tile-${st}-t`, x + size / 2, y + 7, st, { size: 21, align: 'center', ...FADE }));
      out.push(text(`tile-${st}-n`, x + size / 2, y + 30, `${D}-${R}`, { size: 14, font: 6, align: 'center', color: color.muted, ...FADE }));
      const barX = x + 6, barW = size - 12, barY = y + size - 14;
      let from = 0;
      [['kept', D - flips('D'), TONES.D.won], ['flip', flips('D'), TONES.D.flip], ['open', open, OPEN], ['rflip', flips('R'), TONES.R.flip], ['r', R - flips('R'), TONES.R.won]].forEach(([key, n, tone]) => {
        if (!n) return;
        out.push(rect(`tile-${st}-${key}`, barX + barW * from / seats, barY, Math.max(1.5, barW * n / seats - 1), 9, { tone, roundness: null, roughness: 0, strokeWidth: 1, ...FADE }));
        from += n;
      });
    } else {
      const race = results[s.tab].races.find((r) => r.st === st);
      const kind = race && kindOf(race);
      const tone = race ? toneOf(race.winner, kind) : { fill: 'transparent', stroke: '#dee2e6' };
      out.push(rect(`tile-${st}`, x, y, size, size, {
        tone, strokeColor: lit ? color.ink : tone.stroke, strokeWidth: lit ? 3 : 1.5,
        strokeStyle: kind === 'open' ? 'dashed' : 'solid',
        customData: race ? custom : { handwave: {} },
      }));
      out.push(text(`tile-${st}-t`, x + size / 2, y + size / 2, st, { size: 23, align: 'center', valign: 'middle', color: !race ? FAINT : kind === 'flip' ? '#ffffff' : color.ink, ...FADE }));
    }
  }

  // The key, and what the numbers rest on.
  const keys = [['flip', 'flipped'], ['won', 'kept'], ...(s.tab === 'house' ? [] : [['notUp', 'not up']])];
  let x = MAP.x;
  const y = MAP.y + 8 * MAP.pitch + 6;
  for (const [kind, words] of keys) {
    out.push(ellipse(`key-${kind}-d`, x, y + 2, 20, 20, { tone: TONES.D[kind], strokeWidth: 1.5, ...FADE }));
    out.push(ellipse(`key-${kind}-r`, x + 24, y + 2, 20, 20, { tone: TONES.R[kind], strokeWidth: 1.5, ...FADE }));
    const t = text(`key-${kind}-t`, x + 52, y, words, { size: 21, ...FADE });
    out.push(t);
    x += 52 + t.width + 28;
  }
  out.push(ellipse('key-open', x, y + 2, 20, 20, { tone: OPEN, strokeStyle: 'dashed', strokeWidth: 1.5, ...FADE }));
  const openKey = text('key-open-t', x + 28, y, 'no call yet', { size: 21, ...FADE });
  out.push(openKey);
  if (s.tab !== 'house') {
    x += 28 + openKey.width + 28;
    out.push(rect('key-none', x, y + 2, 20, 20, { tone: { fill: 'transparent', stroke: '#dee2e6' }, strokeWidth: 1.5, ...FADE }));
    out.push(text('key-none-t', x + 28, y, 'no race', { size: 21, ...FADE }));
  }

  const notes = ['Counts: Associated Press. Calls: NBC News Decision Desk.'];
  notes.push({
    senate: 'Democratic seats include the independents who caucus with them.',
    house: 'Going in, Republicans include one independent, and two seats were vacant.',
    governors: 'NBC gives no governor total. These totals match ABC News.',
  }[s.tab]);
  notes.push('This page is a snapshot and does not update itself.');
  notes.forEach((words, i) => out.push(text(`note-${i}`, MAP.x, y + 34 + i * 26, words, { size: 19, color: color.muted, ...FADE })));
}

// ------------------------------------------------------------------ the panel

/** Adds panel elements under stable ids, so changing what the panel shows is one diff. */
function writer(out) {
  let n = 0;
  const id = (kind) => `panel-${kind}-${n++}`;
  return {
    // Names change with each refresh, so long words shrink to their room instead of running out of it.
    words: (x, y, words, { room, ...o } = {}) => {
      const size = o.size ?? 23;
      const width = measure(words, size).width;
      const limit = room ?? (o.align === 'right' ? x - LEFT : RIGHT - x);
      const t = text(id('t'), x, y, words, { ...o, size: width > limit ? size * limit / width : size, ...QUIET });
      out.push(t);
      return t;
    },
    bar: (x, y, w, h, tone) => out.push(rect(id('b'), x, y, w, h, { tone, roundness: null, roughness: 0.5, strokeWidth: 1, ...QUIET })),
    dot: (x, y, size, tone, dashed) => out.push(ellipse(id('d'), x, y, size, size, { tone, strokeWidth: 1.5, strokeStyle: dashed ? 'dashed' : 'solid', ...QUIET })),
    check: (x, y) => out.push(line(id('c'), [[x, y], [x + 7, y + 8], [x + 20, y - 9]], { strokeColor: color.ink, strokeWidth: 3, roughness: 0.4, ...QUIET })),
  };
}

const LEFT = PANEL.x + 24, RIGHT = PANEL.x + PANEL.w - 24, TOP = PANEL.y + 16;

const ahead = (race) => {
  const [first, second] = race.candidates;
  return `${first.name} ahead by ${number(first.votes - second.votes)} ${first.votes - second.votes === 1 ? 'vote' : 'votes'}`;
};

function statusWords(race) {
  if (!race.called) return race.status;
  return race.flip ? `Flipped to ${PARTY_NAME[race.winner]}` : `${PARTY_NAME[race.winner]} kept it`;
}

function panelRace(w, race, s) {
  const seats = results.house.states[race.st]?.seats;
  const heading = s.tab !== 'house'
    ? `${race.name ?? stateName(race.st)} ${TABS.find((t) => t.id === s.tab).office}${race.special ? ' (special)' : ''}`
    : seats === 1 ? `${stateName(race.st)} House seat` : `${stateName(race.st)} District ${race.district}`;
  w.words(LEFT, TOP, heading, { size: 32 });
  const status = w.words(RIGHT, TOP + 6, statusWords(race), { size: 23, align: 'right' });
  const kind = kindOf(race);
  w.dot(status.x - 28, TOP + 10, 20, toneOf(race.winner, kind), kind === 'open');
  w.words(LEFT, TOP + 44, `${percent(race.in)} of the expected vote is in`, { size: 21, color: color.muted });

  const nameX = LEFT + 30, barX = LEFT + 262, barMax = 180, rowH = 44;
  race.candidates.forEach((c, i) => {
    const y = TOP + 92 + i * rowH;
    if (c.won) w.check(LEFT, y + 14);
    w.words(nameX, y, `${c.name} (${c.party})`, { size: 25, room: barX - nameX - 12 });
    const tone = TONES[c.party]?.won ?? OTHER;
    w.bar(barX, y + 6, Math.max(3, barMax * c.pct / 100), 20, tone);
    w.words(barX + barMax + 12, y + 2, percent(c.pct), { size: 23 });
    w.words(RIGHT, y + 2, number(c.votes), { size: 22, align: 'right', color: color.muted });
  });
  let y = TOP + 92 + race.candidates.length * rowH + 2;
  if (!race.called) { w.words(LEFT, y, `${ahead(race)}.`, { size: 23 }); y += 32; }
  if (NOTES[race.st] && !race.called) w.words(LEFT, y, NOTES[race.st], { size: 21, color: color.muted });
}

/** A short list in two columns. Each row is a dot in its legend color and a line of text. */
function panelList(w, rows, y) {
  const half = Math.ceil(rows.length / 2);
  rows.forEach(({ words, kind, party }, i) => {
    const x = LEFT + (i < half ? 0 : (RIGHT - LEFT) / 2 + 6);
    const rowY = y + (i < half ? i : i - half) * 30;
    w.dot(x, rowY + 5, 16, toneOf(party, kind), kind === 'open');
    w.words(x + 24, rowY, words, { size: 21, room: (RIGHT - LEFT) / 2 - 34 });
  });
  return y + half * 30;
}

function panelHouseState(w, st) {
  const { name, D, R, open } = results.house.states[st];
  w.words(LEFT, TOP, `${name} House`, { size: 32 });
  w.words(RIGHT, TOP + 6, `${D} D, ${R} R${open ? `, ${open} no call` : ''}`, { size: 25, align: 'right' });
  const races = results.house.races.filter((r) => r.st === st && (r.flip || !r.called));
  if (!races.length) { w.words(LEFT, TOP + 54, 'No flips, and every seat here is called.', { size: 23 }); return; }
  const rows = races.map((r) => {
    const [a, b] = r.candidates;
    const seat = `${st}-${r.district}`;
    return { kind: kindOf(r), party: r.winner, words: r.called ? `${seat} ${a.name} over ${b.name}` : `${seat} ${a.name} ${a.pct} to ${b.pct}` };
  });
  panelList(w, rows, TOP + 54);
}

const flipWords = (flips) => `flipped to Democrats, ${flips.filter((r) => r.winner === 'R').length || 'none'} to Republicans`;
const noCallWords = (open) => (!open.length ? 'Every race is called' : `${open.length} ${open.length === 1 ? 'race has' : 'races have'} no call yet`);

/** The states with the most of something, largest first: "Arizona (5), Florida (5)". */
function mostIn(races, top) {
  const tally = {};
  for (const r of races) tally[r.st] = (tally[r.st] ?? 0) + 1;
  return Object.entries(tally).sort((a, b) => b[1] - a[1] || stateName(a[0]).localeCompare(stateName(b[0]))).slice(0, top).map(([st, n]) => `${stateName(st)} (${n})`).join(', ');
}

function panelSummary(w, s) {
  const { races } = results[s.tab];
  const flips = races.filter((r) => r.flip);
  const open = races.filter((r) => !r.called);
  if (s.tab === 'house') {
    const { estimate, cbsEstimate } = results.house;
    const toD = flips.filter((r) => r.winner === 'D').length;
    w.words(LEFT, TOP, `${toD} seats ${flipWords(flips)}`, { size: 26 });
    w.words(LEFT, TOP + 36, `Most in ${mostIn(flips, 4)}.`, { size: 21 });
    w.words(LEFT, TOP + 76, noCallWords(open), { size: 26 });
    if (open.length) w.words(LEFT, TOP + 112, `Most in ${mostIn(open, 3)}.`, { size: 21 });
    w.words(LEFT, TOP + 152, 'Where it may end', { size: 26 });
    w.words(LEFT, TOP + 188, `NBC News estimates ${estimate.D} D, ${estimate.R} R.`, { size: 21 });
    w.words(LEFT, TOP + 218, `CBS News estimated ${cbsEstimate.low} to ${cbsEstimate.high} D at ${cbsEstimate.at}.`, { size: 21 });
    return;
  }
  const what = s.tab === 'senate' ? 'seats' : 'governorships';
  const toD = flips.filter((r) => r.winner === 'D').length;
  w.words(LEFT, TOP, `${toD} ${what} ${flipWords(flips)}`, { size: 26 });
  const flipRows = flips.map((r) => {
    const [a, b] = r.candidates;
    return { kind: 'flip', party: r.winner, words: `${r.st} ${a.name} over ${b.name}` };
  });
  const y = panelList(w, flipRows, TOP + 44);
  w.words(LEFT, y + 14, noCallWords(open), { size: 26 });
  open.forEach((r, i) => {
    const rowY = y + 54 + i * 30;
    w.dot(LEFT, rowY + 5, 16, OPEN, true);
    w.words(LEFT + 24, rowY, `${r.name}: ${ahead(r)}, ${percent(r.in)} in`, { size: 21 });
  });
}

function drawPanel(out, s) {
  out.push(rect('panel', PANEL.x, PANEL.y, PANEL.w, PANEL.h, { strokeColor: FAINT, strokeWidth: 1.5, ...FADE }));
  const w = writer(out);
  const focus = focusOf(s);
  const race = raceOf(s, focus);
  if (race) return panelRace(w, race, s);
  const tab = TABS.find((t) => t.id === s.tab);
  if (focus?.seat !== undefined) {
    const { party } = SEATS[s.tab].seats[focus.seat];
    w.words(LEFT, TOP, party === 'D' ? 'A Democratic seat' : 'A Republican seat', { size: 32 });
    w.words(LEFT, TOP + 54, `This ${tab.office} seat was not up in 2026.`);
    return undefined;
  }
  if (focus?.st && s.tab === 'house') return panelHouseState(w, focus.st);
  if (focus?.st) {
    w.words(LEFT, TOP, stateName(focus.st), { size: 32 });
    w.words(LEFT, TOP + 54, `No ${tab.office} race here in 2026.`);
    return undefined;
  }
  return panelSummary(w, s);
}

// ------------------------------------------------------------------ the page

function view(s) {
  const out = [];
  out.push(text('title', 40, 16, 'Democrats won the House and the Senate', { size: 48, customData: { handwave: { ghost: true } } }));
  out.push(text('subtitle', 42, 72, `2026 midterms, as of ${asOfDay} at ${results.asOf}. Votes are still being counted, so totals will move.`, { size: 22, color: color.muted, ...FADE }));
  out.push(rect('save', SAVE.x, SAVE.y, SAVE.w, SAVE.h, { strokeColor: FAINT, strokeWidth: 1.5, customData: { handwave: { cursor: 'pointer' } } }));
  out.push(text('save-t', SAVE.x + SAVE.w / 2, SAVE.y + SAVE.h / 2, 'save .excalidraw', { size: 22, align: 'center', valign: 'middle', ...FADE }));
  drawCards(out, s);
  drawSeats(out, s);
  drawMap(out, s);
  drawPanel(out, s);
  return out;
}

const update = (options) => stage.show(view(state), { stagger: 0, morphSeconds: 0.12, ...options });

function setTab(id) {
  if (state.tab === id) return;
  state.tab = id;
  state.hover = null;
  state.pinned = null;
  update({ morphSeconds: 0.45, stagger: 0.0006 });
}

/** What is under a point. Seats are small, so the nearest one within reach counts. */
function targetAt(x, y) {
  const tile = /^tile-([A-Z]{2})$/.exec(stage.hit(x, y)?.id ?? '');
  if (tile) return { st: tile[1] };
  const { seats, size } = SEATS[state.tab];
  const reach = Math.max(12, size / 2 + 2);
  let best = null, bestDistance = reach;
  seats.forEach((seat, i) => {
    const distance = Math.hypot(seat.x - x, seat.y - y);
    if (distance <= bestDistance) { best = i; bestDistance = distance; }
  });
  return best === null ? null : { seat: best };
}

// ------------------------------------------------------------------ saving

// These only mean something on the live page.
const LIVE_ONLY = new Set(['save', 'save-t', 'map-hint']);

/** The block an element moves with in Excalidraw. A click selects the block and a double-click reaches one part of it. */
function blockOf(id, tab) {
  if (/^seat-\d+$/.test(id) || ['majority', 'middle', 'before'].includes(id)) return 'arc';
  if (id === 'panel' || id.startsWith('panel-')) return 'panel';
  if (id.startsWith('key-')) return 'key';
  if (id.startsWith('note-')) return 'notes';
  const card = /^tab-([a-z]+)/.exec(id);
  if (card) return `card-${card[1]}`;
  // A House tile also holds a count and a bar. Any other tile is only a shape and its label.
  const tile = /^tile-([A-Z]{2})/.exec(id);
  return tile && tab === 'house' ? `tile-${tile[1]}` : null;
}

/**
 * The page's scene as it would be drawn by hand, so it edits like a drawing: a tile's
 * label is bound to the tile, each block is a group, and the page's own settings are gone.
 */
function toDrawing(elements, tab) {
  return elements.filter((e) => !LIVE_ONLY.has(e.id)).map(({ customData, ...e }) => {
    const out = { ...e, groupIds: [blockOf(e.id, tab)].filter(Boolean) };
    const tile = /^tile-[A-Z]{2}$/.test(e.id);
    const label = /^tile-[A-Z]{2}-t$/.test(e.id);
    if (tile) out.boundElements = [{ type: 'text', id: `${e.id}-t` }];
    if (e.type === 'text') {
      Object.assign(out, { originalText: e.text, autoResize: true, containerId: label ? e.id.slice(0, -2) : null });
      if (label) out.verticalAlign = tab === 'house' ? 'top' : 'middle';
    }
    return out;
  });
}

const savedScene = () => toExcalidraw(toDrawing(view(state), state.tab));

function save() {
  const url = URL.createObjectURL(new Blob([savedScene()], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `election-2026-${state.tab}.excalidraw`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

stage.on('move', '*', ({ x, y }) => {
  const next = targetAt(x, y);
  if (sameFocus(next, state.hover)) return;
  state.hover = next;
  update();
});

stage.on('click', '*', ({ id, x, y }) => {
  const tab = /^tab-(\w+)$/.exec(id ?? '');
  if (tab) { setTab(tab[1]); return; }
  if (id === 'save') { save(); return; }
  const next = targetAt(x, y);
  state.pinned = sameFocus(next, state.pinned) ? null : next;
  update();
});

addEventListener('keydown', (e) => {
  const tab = TABS[Number(e.key) - 1];
  if (tab) setTab(tab.id);
});

// The canvas's fallback content is what a screen reader gets: every result as a table.
function describe() {
  const table = document.createElement('table');
  const row = (cells, tag = 'td') => {
    const tr = table.insertRow();
    for (const words of cells) { const cell = document.createElement(tag); cell.textContent = words; tr.append(cell); }
  };
  table.createCaption().textContent = `2026 election results as of ${asOfDay} at ${results.asOf}`;
  row(['Race', 'Status', 'Candidates', 'Share of expected vote in'], 'th');
  for (const { id, office } of TABS) {
    for (const race of results[id].races) {
      const name = id === 'house' ? `${stateName(race.st)} District ${race.district}` : `${race.name} ${office}`;
      row([name, statusWords(race), race.candidates.map((c) => `${c.name} (${c.party}) ${percent(c.pct)}`).join(', '), percent(race.in)]);
    }
  }
  canvas.replaceChildren(table);
}

describe();
update({ stagger: 0.0015, morphSeconds: 0.2 });
window.app = { stage, state, results, SEATS, GRID, PANEL, TABS, view, update, setTab, targetAt, savedScene };
