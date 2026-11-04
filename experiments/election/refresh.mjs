#!/usr/bin/env node
// Rewrites results.json from the data NBC News embeds in its results pages. The
// numbers are AP's, with projections by the NBC News Decision Desk. It stops
// without writing if the races do not add up to NBC's own totals, which is what
// would happen if NBC changed the shape of its pages.
//   node experiments/election/refresh.mjs [folder of saved <office>-results.html]

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const saved = process.argv[2];
const PAGES = 'https://www.nbcnews.com/politics/2026-elections';

async function load(office) {
  const name = `${office}-results`;
  const html = saved
    ? readFileSync(join(saved, `${name}.html`), 'utf8')
    : await (await fetch(`${PAGES}/${name}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Safari/537.36' } })).text();
  const blob = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(blob, `${name} has no embedded data`);
  return JSON.parse(blob[1]).props.pageProps;
}

const PARTY = { Dem: 'D', Rep: 'R' };
const toCandidate = (c) => ({ name: c.lastName, party: PARTY[c.party] ?? c.party, pct: c.percentVote, votes: c.vote, won: c.isWinner });

// The three who matter in a race, leaving out the write-in totals NBC lists as a candidate.
const topThree = (tooltip) => tooltip.candidates.filter((c) => !/write-in/i.test(c.lastName)).slice(0, 3).map(toCandidate);

// NBC's call codes: P projected, C too close to call, E too early to call.
const isCalled = (tooltip) => tooltip.callStatusCode === 'P';
const STATUS = { P: 'Called', C: 'Too close to call', E: 'Too early to call' };
const statusOf = (tooltip) => STATUS[tooltip.callStatusCode] ?? 'No call yet';
const winnerOf = (candidates) => candidates.find((c) => c.won)?.party ?? null;

/** The statewide races on the Senate or governor page. A special election's key has a suffix in the table. */
function statewide(page) {
  return page.tableData.states.map((row) => {
    const special = / Special$/.test(row.stateAbbr);
    const st = row.stateAbbr.replace(/ Special$/, '');
    const { tooltip } = page.mapData[special ? `${st}~P` : st];
    const candidates = topThree(tooltip);
    return {
      st, name: row.stateName.replace(/ Special$/, ''), special,
      in: tooltip.percentIn, called: isCalled(tooltip), status: statusOf(tooltip),
      flip: Boolean(row.dem.isFlip || row.rep.isFlip || row.ind?.isFlip),
      winner: winnerOf(candidates), candidates,
    };
  });
}

function districts(page) {
  return Object.values(page.mapData).map(({ tooltip, style, stateCode }) => {
    const candidates = topThree(tooltip).slice(0, 2);
    return {
      st: stateCode, district: Number(/District (\d+)$/.exec(tooltip.raceName)?.[1] ?? 0),
      in: tooltip.percentIn, called: isCalled(tooltip), status: statusOf(tooltip),
      flip: /flip/i.test(style.fill), winner: winnerOf(candidates), candidates,
    };
  }).sort((a, b) => a.st.localeCompare(b.st) || a.district - b.district);
}

const count = (races, party) => races.filter((r) => r.winner === party).length;

const [senatePage, governorPage, housePage] = [await load('senate'), await load('governor'), await load('house')];

const senateRaces = statewide(senatePage);
const governorRaces = statewide(governorPage);
const houseRaces = districts(housePage);

const senateBar = senatePage.bopData.bar;
const houseBar = housePage.bopData.bar;

// NBC gives no governor totals. These 14 seats were not up: DE KY NC NJ VA WA are
// Democratic and IN LA MO MS MT ND UT WV are Republican. With them the totals match
// ABC News's 28 and 20.
const governorsNotUp = { D: 6, R: 8 };

const results = {
  asOf: senatePage.lastModifiedFormatted,
  asOfISO: senatePage.currentTime,
  senate: {
    seats: 100, majority: 51,
    // The Democratic numbers include the independents who caucus with Democrats.
    before: { D: 47, R: 53 },
    won: { D: senateBar.dem.total, R: senateBar.rep.total },
    notUp: { D: senateBar.dem.notUpForElection, R: senateBar.rep.notUpForElection },
    races: senateRaces,
  },
  governors: {
    seats: 50, majority: 26,
    before: { D: 24, R: 26 },
    won: { D: governorsNotUp.D + count(governorRaces, 'D'), R: governorsNotUp.R + count(governorRaces, 'R') },
    notUp: governorsNotUp,
    races: governorRaces,
  },
  house: {
    seats: 435, majority: 218,
    // CBS News: 219 Republicans counts one independent who caucuses with them, and two seats were vacant.
    before: { D: 214, R: 219 },
    won: { D: houseBar.dem.total, R: houseBar.rep.total },
    estimate: { D: housePage.houseModelData.dem, R: housePage.houseModelData.rep },
    // Copied by hand from CBS News's live page, which publishes this as a sentence.
    cbsEstimate: { low: 251, high: 268, at: '1:28 PM ET' },
    races: houseRaces,
    states: Object.fromEntries(housePage.tableData.states.map((s) => [s.stateAbbr, { name: s.stateName, D: s.dem.seatsWon, R: s.rep.seatsWon, open: s.uncalledRaces, seats: s.totalSeats }])),
  },
};

// Everything below has to agree with NBC's own totals before anything is written.
const { senate, governors, house } = results;
assert.equal(senateRaces.length, 35, 'Senate races');
assert.equal(governorRaces.length, 36, 'governor races');
assert.equal(houseRaces.length, 435, 'House races');
assert.ok(houseRaces.every((r) => r.district > 0), 'every House race has a district number');
assert.equal(senate.notUp.D + count(senateRaces, 'D'), senate.won.D, 'Democratic Senate seats');
assert.equal(senate.notUp.R + count(senateRaces, 'R'), senate.won.R, 'Republican Senate seats');
assert.equal(count(senateRaces.filter((r) => r.flip), 'D'), senateBar.dem.flips, 'Senate flips to Democrats');
assert.equal(count(houseRaces, 'D'), house.won.D, 'Democratic House seats');
assert.equal(count(houseRaces, 'R'), house.won.R, 'Republican House seats');
for (const race of [...senateRaces, ...governorRaces, ...houseRaces]) assert.equal(race.called, race.winner !== null, `${race.st} has a winner exactly when it is called`);
for (const [st, s] of Object.entries(house.states)) {
  const seats = houseRaces.filter((r) => r.st === st);
  assert.deepEqual([count(seats, 'D'), count(seats, 'R'), seats.filter((r) => !r.called).length], [s.D, s.R, s.open], `House seats in ${st}`);
}

writeFileSync(join(here, 'results.json'), `${JSON.stringify(results, null, 1)}\n`);

const flips = (races) => races.filter((r) => r.flip);
console.log(`as of ${results.asOf}`);
console.log(`Senate D ${senate.won.D} R ${senate.won.R} open ${senateRaces.filter((r) => !r.called).map((r) => r.st)} flips ${flips(senateRaces).map((r) => `${r.st}>${r.winner}`)}`);
console.log(`Governors D ${governors.won.D} R ${governors.won.R} open ${governorRaces.filter((r) => !r.called).map((r) => r.st)} flips ${flips(governorRaces).map((r) => `${r.st}>${r.winner}`)}`);
console.log(`House D ${house.won.D} R ${house.won.R} open ${houseRaces.filter((r) => !r.called).length} flips ${flips(houseRaces).length}: ${flips(houseRaces).map((r) => `${r.st}-${r.district}>${r.winner ?? '?'}`)}`);
console.log(`NBC House flips ${houseBar.dem.flips} D, ${houseBar.rep.flips} R. Estimate D ${house.estimate.D} R ${house.estimate.R}`);
