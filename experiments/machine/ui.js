// Everything on the page that is words: the inspector, the reference, the gallery,
// the hints under the label editor and the what-if chart. The reference, the "you can
// also add" lists and the hints are all generated from vocab.js, the table the parser
// reads, so they can't say anything the parser wouldn't do.

import { drawElement } from '/lib/render.js';
import { parseScene, rect } from '/lib/draw.js';
import { KINDS, MODES, PARTS, WORDS, readLabel, suggest, wordsFor } from './vocab.js';
import { infer, whyMode } from './graph.js';
import { settle } from './edit.js';

const h = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const round = (n) => (n >= 10 ? Math.round(n).toString() : (+n.toFixed(1)).toString());

const KIND_TONE = { source: 'blue', cache: 'blue', queue: 'amber', sink: 'green', state: 'gray', place: 'blue', lamp: 'amber', switch: 'green', clock: 'green' };
const toneVar = (kind) => KIND_TONE[kind] ?? 'gray';

export function sweepValues(number) {
  const v = number.value;
  if (number.percent) return [...new Set([10, 25, 50, 60, 70, 80, 90, 95, Math.round(v)])].filter((p) => p > 0 && p <= 100).sort((a, b) => a - b);
  if (number.whole) {
    // Close to the number itself, then far enough away to see what too much looks like.
    if (v <= 6) return [...new Set([...Array.from({ length: v + 2 }, (_, i) => i + 1), v * 2, v * 3, v * 4])].filter((n) => n >= 1).sort((a, b) => a - b).slice(0, 9);
    return [...new Set([1, Math.round(v / 4), Math.round(v / 2), v, Math.round(v * 1.5), v * 2, v * 3, v * 4])].filter((n) => n >= 1).sort((a, b) => a - b);
  }
  return [...new Set([v / 4, v / 2, v * 0.75, v, v * 1.25, v * 1.5, v * 2].map((n) => +n.toFixed(2)))].filter((n) => n > 0).sort((a, b) => a - b);
}

// The number's text swapped inside a word, such as "batch 4" to "batch 6".
export function withNumber(hit, index, value) {
  const n = hit.numbers[index];
  const from = n.start - hit.start, to = n.end - hit.start;
  return hit.text.slice(0, from) + (+value.toFixed(2)) + hit.text.slice(to);
}

const stepFor = (n) => (n.whole ? 1 : n.percent ? 5 : n.value < 1 ? 0.05 : n.value < 5 ? 0.25 : n.value < 20 ? 1 : 5);
const maxFor = (n) => (n.percent ? 100 : n.whole ? Math.max(10, n.value * 3) : Math.max(5, +(n.value * 3).toFixed(2)));

export function createUi(m) {
  const insp = document.getElementById('inspector');
  const hints = document.getElementById('hints');
  const ref = document.getElementById('reference');
  const gallery = document.getElementById('gallery');
  const whatif = document.getElementById('whatif');
  const pill = document.getElementById('mode-pill');
  let shown = '';
  let scrubbing = false;
  let liveTick = () => {};
  let hoverPart = null;

  // ---------------------------------------------------------------- the inspector

  const target = () => hoverPart ? { part: hoverPart } : m.selected ? { id: m.selected } : m.hover ? { id: m.hover } : {};

  function renderInspector(force = false) {
    if (scrubbing) return;
    const t = target();
    const key = `${t.part?.id ?? ''}|${t.id ?? ''}|${m.version}`;
    if (key === shown && !force) return;
    shown = key;
    liveTick = () => {};
    if (t.part) return partView(t.part);
    const node = t.id && m.graph.nodes.get(t.id);
    const edge = t.id && m.graph.edges.get(t.id);
    if (node) return nodeView(node);
    if (edge) return edgeView(edge);
    const el = t.id && m.byId(t.id);
    if (el?.type === 'text') return noteView(el);
    overview();
  }

  function understood(item, place) {
    if (!item.hits.length) return '';
    const rows = item.hits.map((hit, i) => {
      const sliders = hit.numbers.map((n, k) => `<div class="scrub" data-hit="${i}" data-num="${k}"><input type="range" aria-label="${h(hit.word.title ?? hit.word.head)}" min="${n.whole && n.value >= 1 ? 1 : 0}" max="${maxFor(n)}" step="${stepFor(n)}" value="${n.value}"><b>${n.value}</b>${m.graph.mode === 'flow' ? `<button class="compare" title="Run many futures at each value and compare them">compare</button>` : ''}</div>`).join('');
      return `<li class="word-ok"><code>${h(hit.text.trim())}</code><span class="means">${h(hit.word.means)}</span>${sliders}</li>`;
    }).join('');
    return `<h4>It understood</h4><ul>${rows}</ul>`;
  }

  function troubles(id) {
    const list = m.graph.issues.filter((i) => i.id === id);
    if (!list.length) return '';
    const rows = list.map((issue, n) => {
      const fix = issue.suggest && issue.text ? `<button class="fix" data-issue="${n}">use "${h(fixedWords(issue))}"</button>` : issue.suggestLine ? `<button class="fix" data-issue="${n}">use "${h(issue.suggestLine)}"</button>` : '';
      return `<li class="word-bad ${issue.level === 'error' ? 'bad' : 'note'}">${h(issue.message)}${fix ? `<div>${fix}</div>` : ''}</li>`;
    }).join('');
    return `<h4>Worth fixing</h4><ul>${rows}</ul>`;
  }

  const fixedWords = (issue) => issue.text.replace(new RegExp(`^${issue.text.split(' ')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), issue.suggest);

  function allowedHere(kind, place, used, fromKind = null) {
    const words = wordsFor(kind, place, m.graph.mode === 'none' ? 'states' : m.graph.mode, fromKind).filter((w) => !used.has(w.id));
    if (!words.length) return '';
    const rows = words.map((w) => `<li><button class="add-word" data-words="${h(w.example)}"><code>${h(w.example)}</code><span class="means">${h(w.means)}</span></button></li>`).join('');
    return `<h4>You can also add</h4><ul>${rows}</ul>`;
  }

  function nodeView(node) {
    const info = KINDS[node.kind] ?? KINDS.idle;
    const tone = toneVar(node.kind);
    const poke = m.pokeFor(node);
    const nameLine = node.name && node.name !== node.kind && node.name !== info.name ? `<p class="why">"${h(node.name)}" is just its name.</p>` : '';
    insp.innerHTML = `
      <h3 id="insp-what"><span class="kind" style="color:var(--${tone});border-color:var(--${tone});background:var(--${tone}-fill)">${h(info.name)}</span></h3>
      <p id="insp-says">${h(info.says)}</p>
      <p class="why" id="insp-why">It counts as ${h(info.phrase ?? info.name)} because ${h(info.why)}.</p>
      ${m.stats?.bottleneck?.id === node.id && ['backing up', 'turning away', 'wasting'].includes(m.stats.verdict) ? '<p class="bad">This shape is what is holding the drawing back right now.</p>' : ''}
      ${nameLine}
      <div class="live" id="insp-live"></div>
      <canvas id="insp-spark"></canvas>
      ${poke ? `<div class="row"><button id="act-poke">${h(poke.label)}</button></div>` : ''}
      ${troubles(node.id)}
      ${understood(node, 'shape')}
      ${allowedHere(node.kind, 'shape', new Set(node.hits.map((x) => x.word.id)))}
      <div class="row">
        <button id="act-edit">edit label</button>
        <button id="act-copy">copy</button>
        ${node.kind !== 'chart' && m.graph.mode !== 'none' ? '<button id="act-chart">add a chart of this</button>' : ''}
        <button id="act-delete">delete</button>
      </div>`;
    bindItem(node);
    liveTick = () => liveNode(node.id);
    liveTick();
  }

  function edgeView(edge) {
    const fromName = edge.from ? m.graph.nodes.get(edge.from)?.name || 'a shape' : 'nothing';
    const toName = edge.to ? m.graph.nodes.get(edge.to)?.name || 'a shape' : 'nothing';
    const mode = m.graph.mode;
    let says = `An arrow from ${fromName} to ${toName}.`;
    if (edge.watch) says = 'This arrow joins a chart to what it watches. Nothing travels along it.';
    else if (!edge.from && edge.to) says = `An arrow from nothing marks where things begin: ${toName}.`;
    else if (mode === 'flow') says = `Work travels along this arrow from ${fromName} to ${toName}.`;
    else if (mode === 'states') says = edge.event ? `In ${fromName}, the event "${edge.event}" moves to ${toName}.` : edge.params.guard && edge.after === undefined && !edge.afterExpr ? `Moves from ${fromName} to ${toName} as soon as its guard is true.` : `Moves from ${fromName} to ${toName} by itself after a while.`;
    else if (mode === 'chain') says = `Each step, some walkers go from ${fromName} to ${toName}.`;
    else if (mode === 'logic') says = `Carries a 1 or a 0 from ${fromName} to ${toName}.`;
    const place = 'arrow';
    insp.innerHTML = `
      <h3 id="insp-what"><span class="kind" style="color:var(--ink);border-color:var(--ink)">arrow</span></h3>
      <p id="insp-says">${h(says)}</p>
      ${edge.event && mode === 'states' && edge.from === m.sim?.current ? '<p class="why">Click it, press its button, or press its number key to fire it.</p>' : ''}
      <p class="why">Drag either end to another shape to rewire it.</p>
      ${troubles(edge.id)}
      ${understood(edge, place)}
      ${edge.watch || mode === 'logic' ? '' : allowedHere(null, place, new Set(edge.hits.map((x) => x.word.id)), m.graph.nodes.get(edge.from)?.kind)}
      <div class="row"><button id="act-edit">edit label</button><button id="act-delete">delete</button></div>`;
    bindItem(edge);
  }

  function noteView(el) {
    insp.innerHTML = `
      <h3 id="insp-what"><span class="kind" style="color:var(--muted);border-color:var(--muted)">note</span></h3>
      <p id="insp-says">This text does nothing. It is here to explain the drawing.</p>
      <p class="why">Text only counts when it is inside a shape or labels an arrow. Drag it to move it. Double-click to change it.</p>
      <div class="row"><button id="act-edit">edit</button><button id="act-delete">delete</button></div>`;
    insp.querySelector('#act-edit').addEventListener('click', () => m.editNote(el.id));
    insp.querySelector('#act-delete').addEventListener('click', () => m.remove(el.id));
  }

  function partView(part) {
    const info = KINDS[part.kind] ?? {};
    const mode = part.kind === 'state' ? 'states' : info.mode === 'logic' ? 'logic' : 'flow';
    const example = part.label ? readLabel(part.label, 'shape', mode) : null;
    const words = wordsFor(part.kind, 'shape', mode);
    insp.innerHTML = `
      <h3 id="insp-what"><span class="kind">${h(part.short)}</span></h3>
      <p id="insp-says">${h(part.says ?? info.says ?? '')}</p>
      ${part.label ? `<p class="why">Starts with the label <code>${h(part.label.replace(/\n/g, ' / '))}</code>. You can change it after you drop it.</p>` : ''}
      ${example && example.hits.length ? '' : ''}
      ${words.length ? `<h4>Its words</h4><ul>${words.map((w) => `<li><code>${h(w.example)}</code><span class="means">${h(w.means)}</span></li>`).join('')}</ul>` : ''}
      <p class="why" style="margin-top:10px">Drag it onto the board. Drop it on an arrow to put it in line.</p>`;
  }

  function overview() {
    const graph = m.graph;
    if (m.empty()) {
      insp.innerHTML = `<h3>Start here</h3>
        <p>A drawing is a program. Shapes are parts, arrows join them, and labels say what they do.</p>
        <ol style="padding-left:20px;margin:6px 0">
          <li>Drag a part from the left onto the board.</li>
          <li>Hover it and drag from its small blue circle to another shape.</li>
          <li>Click anything to see what it understood.</li>
        </ol>
        <p class="why">Everything stays a plain Excalidraw file, so you can also draw it there and drop it here.</p>`;
      return;
    }
    const demo = m.demoInfo();
    const rows = [...graph.nodes.values()].map((n) => `<li><button class="list-button" data-select="${h(n.id)}">${h(n.name || KINDS[n.kind]?.name || 'shape')}<span>${h(KINDS[n.kind]?.name ?? '')}</span></button></li>`).join('');
    const problems = graph.issues.filter((i) => !i.id);
    insp.innerHTML = `
      <h3>This drawing</h3>
      <p id="insp-why">${h(whyMode(graph))}</p>
      ${demo ? `<p class="why">${h(demo.summary)}</p>` : ''}
      ${problems.length ? `<h4>Worth fixing</h4><ul>${problems.map((i) => `<li class="${i.level === 'error' ? 'bad' : 'note'}">${h(i.message)}</li>`).join('')}</ul>` : ''}
      <h4>What it thinks each shape is</h4>
      <ul>${rows}</ul>
      <p class="why" style="margin-top:10px">Hover or click a shape to see what it understood and what else it can say.</p>`;
  }

  function liveNode(id) {
    const live = document.getElementById('insp-live');
    if (!live) return;
    const node = m.graph.nodes.get(id);
    const sim = m.sim;
    if (!node || !sim) { live.textContent = ''; return; }
    if (sim.mode === 'flow') {
      const v = sim.metrics(node);
      const parts = [];
      if (node.kind === 'workers') parts.push(`${v.busy} busy`, `${v.waiting} waiting`);
      else if (node.kind === 'queue' || node.kind === 'batch' || node.kind === 'merge') parts.push(`${v.waiting} waiting`);
      else if (node.kind === 'delay') parts.push(`${v.busy} inside`);
      else if (node.kind === 'cache') parts.push(`${Math.round(v.hitrate)}% hit`);
      else if (node.kind === 'sink') parts.push(`${v.done} done`, `${round(v.rate)}/s`);
      if (['source', 'router', 'limiter', 'split'].includes(node.kind)) parts.push(`${round(v.rate)}/s going through`);
      if (v.dropped) parts.push(`${v.dropped} turned away`);
      live.textContent = parts.join(', ');
      spark(sim.series(id), sim.defaultMetric(node).key);
    } else if (sim.mode === 'states') {
      live.textContent = sim.current === id ? 'The machine is here now.' : '';
    } else if (sim.mode === 'chain') {
      live.textContent = node.kind === 'place' ? `${Math.round(sim.share(id) * 100)}% now, ${Math.round((sim.longRun.get(id) ?? 0) * 100)}% in the long run` : '';
      if (node.kind === 'place') spark(sim.series(), id);
    } else if (sim.mode === 'logic') {
      live.textContent = `Output is ${sim.value(id)}`;
      spark(sim.series(), id);
    }
  }

  function spark(samples, key) {
    const c = document.getElementById('insp-spark');
    if (!c) return;
    const r = c.getBoundingClientRect();
    if (!r.width) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(r.width * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    const pts = samples.slice(-120);
    if (pts.length < 2) return;
    const max = Math.max(1e-6, ...pts.map((p) => p[key] ?? 0));
    ctx.strokeStyle = '#d9d8d2';
    ctx.beginPath(); ctx.moveTo(0, r.height - 1); ctx.lineTo(r.width, r.height - 1); ctx.stroke();
    ctx.strokeStyle = '#a35200';
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = (i / (pts.length - 1)) * r.width;
      const y = r.height - 2 - ((p[key] ?? 0) / max) * (r.height - 8);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = '#7A776E';
    ctx.font = '11px Nunito';
    ctx.textAlign = 'right';
    ctx.fillText(round(max), r.width - 2, 10);
  }

  function bindItem(item) {
    insp.querySelector('#act-edit')?.addEventListener('click', () => m.editLabelOf(item.id));
    insp.querySelector('#act-delete')?.addEventListener('click', () => m.remove(item.id));
    insp.querySelector('#act-copy')?.addEventListener('click', () => m.copy(item.id));
    insp.querySelector('#act-chart')?.addEventListener('click', () => m.addChartOf(item.id));
    insp.querySelector('#act-poke')?.addEventListener('click', () => m.poke(item.id));
    insp.querySelectorAll('.add-word').forEach((b) => b.addEventListener('click', () => m.addWord(item.id, b.dataset.words)));
    insp.querySelectorAll('.fix').forEach((b) => b.addEventListener('click', () => {
      const issue = m.graph.issues.filter((i) => i.id === item.id)[Number(b.dataset.issue)];
      m.applyFix(issue);
    }));
    insp.querySelectorAll('.scrub').forEach((row) => {
      const hit = item.hits[Number(row.dataset.hit)];
      const index = Number(row.dataset.num);
      const input = row.querySelector('input');
      const value = row.querySelector('b');
      let words = hit.text.trim();
      input.addEventListener('pointerdown', () => { scrubbing = true; m.beginEdit(); });
      input.addEventListener('input', () => {
        const next = withNumber(hit, index, Number(input.value)).trim();
        value.textContent = input.value;
        m.scrub(item.id, words, next);
        words = next;
      });
      const finish = () => {
        scrubbing = false;
        m.endEdit();
        shown = '';
        renderInspector();
      };
      input.addEventListener('change', finish);
      row.querySelector('.compare')?.addEventListener('click', () => compare(item, hit, index));
    });
    insp.querySelectorAll('[data-select]').forEach((b) => b.addEventListener('click', () => m.select(b.dataset.select)));
  }

  insp.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-select]');
    if (b && !b.dataset.bound) m.select(b.dataset.select);
  });

  // ---------------------------------------------------------------- the bar

  function renderBar() {
    pill.textContent = m.graph.mode === 'none' ? (m.empty() ? 'Nothing on the board yet.' : 'Draw an arrow between two shapes to run it.') : whyMode(m.graph);
    pill.title = pill.textContent;
    document.getElementById('btn-run').textContent = m.running ? 'pause' : 'run';
    document.getElementById('btn-run').classList.toggle('on', !m.running);
    for (const b of document.querySelectorAll('[data-speed]')) b.classList.toggle('on', Number(b.dataset.speed) === m.speed);
    document.getElementById('btn-undo').disabled = !m.past.length;
    document.getElementById('btn-redo').disabled = !m.future.length;
    const flow = m.graph.mode === 'flow';
    const btn = document.getElementById('btn-whatif');
    btn.disabled = !flow;
    btn.title = flow ? 'Run this drawing forward many times with different luck' : 'What if runs a flow of work many times. This drawing has no luck in it to vary.';
  }

  // ---------------------------------------------------------------- hints while typing

  const hintList = [];

  function renderHints(ta, ctx) {
    const caret = ta.selectionStart;
    const before = ta.value.slice(0, caret);
    const lineStart = before.lastIndexOf('\n') + 1;
    const typed = /([A-Za-z]*)$/.exec(before.slice(lineStart))[1];
    const mode = m.graph.mode === 'none' ? 'states' : m.graph.mode;
    const list = suggest(typed, ctx.place, mode, ctx.kind).slice(0, typed ? 5 : 6);
    hintList.length = 0;
    hintList.push(...list.map((w) => ({ word: w, typed, start: caret - typed.length })));
    const read = readLabel(ta.value, ctx.place, mode);
    const problems = read.problems.filter((p) => p.level === 'error');
    const summary = !ta.value.trim() ? '<div class="read">Type a name or one of these words.</div>'
      : problems.length ? `<div class="read bad">${h(problems[0].message)}</div>`
        : read.hits.length ? `<div class="read ok">Understood: ${read.hits.map((x) => h(x.text.trim())).join(', ')}</div>`
          : ctx.place === 'arrow' && mode === 'states' ? `<div class="read ok">An event called "${h(read.name.toLowerCase())}"</div>` : `<div class="read">Reads as a name: "${h(read.name)}"</div>`;
    hints.innerHTML = summary + hintList.map((x, i) => `<button class="hint ${i === 0 && typed ? 'first' : ''}" data-hint="${i}"><code>${h(x.word.example)}</code><span>${h(x.word.means)}</span></button>`).join('') + '<div class="keys">Tab takes the first hint. Enter saves. Shift+Enter adds a line. Escape cancels.</div>';
    hints.hidden = false;
    const r = ta.getBoundingClientRect();
    const left = Math.max(6, Math.min(innerWidth - 346, r.left + r.width / 2 - 170));
    const hh = hints.getBoundingClientRect().height;
    const below = r.bottom + 6;
    hints.style.left = `${left}px`;
    hints.style.top = `${below + hh > innerHeight ? Math.max(6, r.top - hh - 6) : below}px`;
  }

  function takeHint(ta, index = 0) {
    const pick = hintList[index];
    if (!pick) return false;
    const words = pick.word.example;
    ta.setRangeText(words, pick.start, ta.selectionStart, 'end');
    // Leave a number selected, since that is what you came to change.
    const num = /\d+(?:\.\d+)?/.exec(words);
    if (num) ta.setSelectionRange(pick.start + num.index, pick.start + num.index + num[0].length);
    ta.dispatchEvent(new Event('input'));
    return true;
  }

  // Clicks on hints must not take focus from the text box.
  hints.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const b = e.target.closest('[data-hint]');
    if (b) takeHint(document.getElementById('label'), Number(b.dataset.hint));
  });

  // ---------------------------------------------------------------- the reference

  function referenceHtml() {
    const section = (title, mode, intro, words) => `
      <h3>${h(title)}</h3>
      <p>${intro}</p>
      <table data-mode="${mode}"><thead><tr><th>Write</th><th>On</th><th>What it does</th></tr></thead><tbody>
      ${words.map((w) => `<tr data-word="${w.id}"><td><code>${h(w.example)}</code></td><td class="on">${w.on === 'shape' ? 'a shape' : 'an arrow'}</td><td>${h(w.means)}${w.whole ? ' Goes alone on its line.' : ''}${w.also?.length ? `<div class="also">Suggested if you write: ${h(w.also.join(', '))}</div>` : ''}</td></tr>`).join('')}
      </tbody></table>`;
    const of = (mode) => WORDS.filter((w) => (w.modes ?? [w.mode]).includes(mode));
    return `
      <button class="close" id="ref-close">close</button>
      <h2>What can I draw?</h2>
      <p>Shapes are parts, arrows join them, and labels say what they do. You don't need any special syntax: put these words in a label, in any order. Other words are just names. Everything here is plain Excalidraw, so you can draw it there too.</p>
      <input id="ref-search" type="search" placeholder="Search words, such as cache or timeout" aria-label="Search words">
      <div id="ref-body">
      ${section(`Work: ${MODES.flow.name}`, 'flow', `A drawing runs this way when ${MODES.flow.why}. Tokens travel along arrows. A diamond chooses between its arrows. A shape with arrows in and none out ends work and counts it. Any other shape holds work until the next shape has room.`, of('flow'))}
      ${section(`States: ${MODES.states.name}`, 'states', `A drawing runs this way when ${MODES.states.why}. One shape is current. An arrow from nothing marks where it begins.`, of('states'))}
      ${section(`Chance: ${MODES.chain.name}`, 'chain', `A drawing runs this way when ${MODES.chain.why}. Walkers stand on shapes and take an arrow by its share each step. An unlabelled arrow takes what is left of 100%, and anything left over stays put.`, of('chain'))}
      ${section(`Logic: ${MODES.logic.name}`, 'logic', `A drawing runs this way when ${MODES.logic.why}. A word below has to be a whole line of the label, so name a shape on its own line: <code>set</code> then <code>switch</code>. Arrows carry a 1 or a 0, and changes take time to travel.`, of('logic'))}
      ${section('Any drawing', 'any', 'These work whichever way the drawing runs.', of('any'))}
      <h3>On the page</h3>
      <table><tbody>
        <tr><td>Drag from a part on the left</td><td>Add it. Drop it on an arrow to put it in line.</td></tr>
        <tr><td>Double-click nothing</td><td>Add an empty shape.</td></tr>
        <tr><td>Click a shape or arrow</td><td>Select it, and see what it understood.</td></tr>
        <tr><td>Drag a shape</td><td>Move it. Its label and arrows follow.</td></tr>
        <tr><td>Drag a selected shape's corner</td><td>Resize it.</td></tr>
        <tr><td>Drag its blue circle</td><td>Draw an arrow to another shape, or to itself.</td></tr>
        <tr><td>Drag an arrow's end</td><td>Rewire it. Let go over nothing to put it back.</td></tr>
        <tr><td>Double-click a label</td><td>Change it, with hints as you type.</td></tr>
        <tr><td>Click a worker's box</td><td>Kill it, and click again to bring it back.</td></tr>
        <tr><td>Click a switch</td><td>Turn it on or off.</td></tr>
        <tr><td><kbd>Delete</kbd></td><td>Delete what is selected, with its label and arrows.</td></tr>
        <tr><td><kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd>, with <kbd>Shift</kbd></td><td>Undo and redo.</td></tr>
        <tr><td><kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>D</kbd></td><td>Copy what is selected.</td></tr>
        <tr><td><kbd>Space</kbd>, <kbd>.</kbd></td><td>Pause and run, and step.</td></tr>
        <tr><td><kbd>1</kbd> to <kbd>9</kbd></td><td>Fire a state machine's events.</td></tr>
        <tr><td><kbd>?</kbd></td><td>This page.</td></tr>
      </tbody></table>
      </div>`;
  }

  function openReference() {
    if (!ref.innerHTML) {
      ref.innerHTML = referenceHtml();
      ref.querySelector('#ref-close').addEventListener('click', closeReference);
      ref.querySelector('#ref-search').addEventListener('input', (e) => {
        const q = e.target.value.trim().toLowerCase();
        ref.querySelectorAll('tr[data-word]').forEach((tr) => {
          const word = WORDS.find((w) => w.id === tr.dataset.word);
          const text = `${word.example} ${word.means} ${(word.also ?? []).join(' ')}`.toLowerCase();
          tr.hidden = !!q && !text.includes(q);
        });
      });
    }
    ref.hidden = false;
    ref.querySelector('#ref-search').focus();
  }
  function closeReference() { ref.hidden = true; }
  const referenceOpen = () => !ref.hidden;

  // ---------------------------------------------------------------- the gallery

  let galleryBuilt = false;
  async function openGallery() {
    gallery.hidden = false;
    m.setGalleryOpen(true);
    if (galleryBuilt) return;
    galleryBuilt = true;
    const demos = await (await fetch('./scenes/demos.json')).json();
    gallery.innerHTML = `
      <h2>Runnable diagrams</h2>
      <p>Each of these is a plain drawing that runs. Pick one and change it, or start from nothing.</p>
      <div class="grid">
        <button class="card" data-demo="blank"><canvas></canvas><i>your own</i><b>A blank board</b><span>Drag on parts, or drop an .excalidraw file anywhere.</span></button>
        ${demos.map((d) => `<button class="card" data-demo="${h(d.id)}"><canvas></canvas><i>${h(d.group)}</i><b>${h(d.title)}</b><span>${h(d.summary)}</span></button>`).join('')}
      </div>`;
    gallery.querySelectorAll('.card').forEach((card) => card.addEventListener('click', () => {
      closeGallery();
      if (card.dataset.demo === 'blank') m.loadBlank(); else m.loadDemo(card.dataset.demo);
    }));
    thumbnail(gallery.querySelector('[data-demo="blank"] canvas'), [{ ...rect('blank-thumb', 200, 60, 900, 460, { strokeStyle: 'dashed', strokeColor: '#7A776E', backgroundColor: 'transparent' }) }]);
    await Promise.all(demos.map(async (d) => {
      const data = await (await fetch(`./scenes/${d.id}.excalidraw`)).json();
      const elements = settle(infer(parseScene(data).elements)).filter((el) => !el.customData?.machine?.note);
      thumbnail(gallery.querySelector(`[data-demo="${d.id}"] canvas`), elements);
    }));
  }

  function thumbnail(canvas, elements) {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const el of elements) {
      const corners = el.points ? el.points.map(([x, y]) => [el.x + x, el.y + y]) : [[el.x, el.y], [el.x + (el.width ?? 0), el.y + (el.height ?? 0)]];
      for (const [x, y] of corners) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
    }
    const scale = Math.min(r.width / (right - left + 20), r.height / (bottom - top + 20));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (r.width / 2 - (scale * (left + right)) / 2), dpr * (r.height / 2 - (scale * (top + bottom)) / 2));
    for (const el of elements) drawElement(ctx, el);
  }

  function closeGallery() { gallery.hidden = true; m.setGalleryOpen(false); }
  const galleryOpen = () => !gallery.hidden;

  // ---------------------------------------------------------------- what if

  let worker = null;
  let job = 0;

  function stopWhatIf() {
    worker?.terminate();
    worker = null;
  }

  function closeWhatIf() {
    stopWhatIf();
    whatif.hidden = true;
    m.whatif = null;
  }

  function startWorker(variants, seeds, seconds, onResult, onDone) {
    stopWhatIf();
    worker = new Worker(new URL('./whatif.worker.js', import.meta.url), { type: 'module' });
    const id = ++job;
    worker.onmessage = ({ data }) => {
      if (data.job !== id) return;
      if (data.done) { stopWhatIf(); onDone(); } else onResult(data);
    };
    worker.onerror = (e) => { console.error(`what if failed: ${e.message}`); stopWhatIf(); };
    worker.postMessage({ job: id, variants, seeds, seconds });
  }

  /** Run the drawing as it stands many times and draw every run. */
  function futures(seeds = 40, seconds = 120) {
    const state = { type: 'futures', runs: [], seeds, seconds, done: false };
    m.whatif = state;
    whatif.hidden = false;
    whatif.innerHTML = `<button class="close" id="wi-close">close</button><h3>What if the luck had been different?</h3><canvas id="wi-chart"></canvas><p id="wi-words">Running ${seeds} futures...</p><p class="note">Each line is the same drawing with different random numbers, ${seconds} seconds ahead from an empty start.</p>`;
    whatif.querySelector('#wi-close').addEventListener('click', closeWhatIf);
    startWorker([{ elements: m.doc }], seeds, seconds, (r) => { state.runs.push(r); drawFutures(state); }, () => {
      state.done = true;
      const ends = state.runs.map((r) => r.final).sort((a, b) => a - b);
      const at = (q) => ends[Math.min(ends.length - 1, Math.floor(ends.length * q))];
      state.low = at(0.1); state.median = at(0.5); state.high = at(0.9);
      document.getElementById('wi-words').textContent = `After ${seconds} seconds, ${state.median} are waiting in a typical run. In 8 runs out of 10 it is between ${state.low} and ${state.high}.`;
      drawFutures(state);
    });
    drawFutures(state);
  }

  function chartCanvas(id) {
    const c = document.getElementById(id);
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(r.width * dpr);
    c.height = Math.round(r.height * dpr);
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: r.width, h: r.height };
  }

  function drawFutures(state) {
    const { ctx, w, h: height } = chartCanvas('wi-chart');
    const pad = { l: 44, r: 12, t: 10, b: 26 };
    const max = Math.max(10, ...state.runs.flatMap((r) => r.waiting));
    const X = (i, n) => pad.l + (i / Math.max(1, n - 1)) * (w - pad.l - pad.r);
    const Y = (v) => height - pad.b - (v / max) * (height - pad.t - pad.b);
    axes(ctx, pad, w, height, max, '0', `${state.seconds}s`, 'waiting');
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(24, 100, 171, 0.32)';
    for (const r of state.runs) {
      ctx.beginPath();
      r.waiting.forEach((v, i) => { if (i === 0) ctx.moveTo(X(i, r.waiting.length), Y(v)); else ctx.lineTo(X(i, r.waiting.length), Y(v)); });
      ctx.stroke();
    }
    if (state.done && state.runs.length) {
      const n = state.runs[0].waiting.length;
      ctx.strokeStyle = '#c92a2a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const sorted = state.runs.map((r) => r.waiting[i]).sort((a, b) => a - b);
        const v = sorted[Math.floor(sorted.length / 2)];
        if (i === 0) ctx.moveTo(X(i, n), Y(v)); else ctx.lineTo(X(i, n), Y(v));
      }
      ctx.stroke();
      ctx.fillStyle = '#c92a2a';
      ctx.font = '14px Excalifont';
      ctx.textAlign = 'left';
      ctx.fillText('the middle of all the runs', pad.l + 6, pad.t + 14);
    }
  }

  function axes(ctx, pad, w, height, max, left, right, name) {
    ctx.strokeStyle = '#7A776E';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, height - pad.b); ctx.lineTo(w - pad.r, height - pad.b);
    ctx.stroke();
    ctx.fillStyle = '#7A776E';
    ctx.font = '14px Excalifont';
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.round(max)), pad.l - 6, pad.t + 12);
    ctx.fillText('0', pad.l - 6, height - pad.b);
    if (left) { ctx.textAlign = 'left'; ctx.fillText(left, pad.l, height - 8); }
    if (right) { ctx.textAlign = 'right'; ctx.fillText(right, w - pad.r, height - 8); }
    if (name) { ctx.textAlign = 'center'; ctx.fillText(name, (pad.l + w - pad.r) / 2, height - 8); }
  }

  /** Run the drawing at several values of one number and compare them. */
  function compare(item, hit, index) {
    const number = hit.numbers[index];
    const values = sweepValues(number);
    const seeds = 24, seconds = 120;
    const word = hit.word.title ?? hit.word.head;
    const state = { type: 'compare', word, values, current: number.value, cells: values.map(() => []), done: false, item: item.id, hit, index, seeds };
    m.whatif = state;
    whatif.hidden = false;
    whatif.innerHTML = `<button class="close" id="wi-close">close</button><h3>What if "${h(hit.text.trim())}" were something else?</h3><canvas id="wi-chart"></canvas><p id="wi-words">Running ${seeds} futures at each of ${values.length} values...</p><p class="note">Each column is seconds per job, start to finish: the dot is the middle run and the bar is 8 runs in 10. Click a column to use that value.</p>`;
    whatif.querySelector('#wi-close').addEventListener('click', closeWhatIf);
    const variants = values.map((value) => ({ value, elements: m.docWith(item.id, hit.text.trim(), withNumber(hit, index, value).trim()) }));
    startWorker(variants, seeds, seconds, (r) => { state.cells[r.variant].push(r); drawCompare(state); }, () => {
      state.done = true;
      const med = state.cells.map((rows) => median(rows.map((r) => r.average)));
      let best = 0;
      med.forEach((v, i) => { if (v < med[best]) best = i; });
      state.best = values[best];
      state.medians = med;
      const nowAt = values.indexOf(number.value);
      const now = nowAt >= 0 ? `Now, at ${number.value}, each job takes about ${round(med[nowAt])}s. ` : '';
      document.getElementById('wi-words').textContent = `${now}Fastest at ${state.best}: about ${round(med[best])}s.`;
      drawCompare(state);
    });
    drawCompare(state);
    document.getElementById('wi-chart').addEventListener('click', (e) => {
      if (!state.layout) return;
      const r = e.target.getBoundingClientRect();
      const x = e.clientX - r.left;
      const i = state.layout.findIndex((c) => Math.abs(c.x - x) < c.half);
      if (i >= 0) { m.scrub(item.id, hit.text.trim(), withNumber(hit, index, values[i]).trim(), true); shown = ''; renderInspector(); closeWhatIf(); }
    });
  }

  const median = (list) => { if (!list.length) return 0; const s = [...list].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

  function drawCompare(state) {
    const { ctx, w, h: height } = chartCanvas('wi-chart');
    const pad = { l: 44, r: 12, t: 12, b: 34 };
    const all = state.cells.flat().map((r) => r.average);
    const max = Math.max(1, ...all);
    const Y = (v) => height - pad.b - (v / max) * (height - pad.t - pad.b);
    axes(ctx, pad, w, height, max, null, null, null);
    const col = (w - pad.l - pad.r) / state.values.length;
    state.layout = state.values.map((value, i) => {
      const x = pad.l + col * (i + 0.5);
      const rows = state.cells[i].map((r) => r.average).sort((a, b) => a - b);
      const on = value === state.current;
      if (on) { ctx.fillStyle = '#fff3bf'; ctx.fillRect(x - col / 2 + 2, pad.t, col - 4, height - pad.t - pad.b); }
      if (rows.length) {
        const low = rows[Math.floor(rows.length * 0.1)], high = rows[Math.min(rows.length - 1, Math.floor(rows.length * 0.9))], mid = rows[Math.floor(rows.length / 2)];
        ctx.strokeStyle = '#1864ab';
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x, Y(low)); ctx.lineTo(x, Y(high)); ctx.stroke();
        ctx.fillStyle = '#c92a2a';
        ctx.beginPath(); ctx.arc(x, Y(mid), 6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#1B2547';
        ctx.font = '14px Excalifont';
        ctx.textAlign = 'center';
        ctx.fillText(`${round(mid)}s`, x, Math.max(pad.t + 12, Y(high) - 8));
      }
      ctx.fillStyle = on ? '#a35200' : '#1B2547';
      ctx.font = '16px Excalifont';
      ctx.textAlign = 'center';
      ctx.fillText(`${state.word} ${value}`, x, height - 12);
      return { x, half: col / 2 };
    });
  }

  // ---------------------------------------------------------------- wiring

  document.getElementById('btn-help').addEventListener('click', () => (referenceOpen() ? closeReference() : openReference()));
  document.getElementById('btn-demos').addEventListener('click', openGallery);
  document.getElementById('btn-whatif').addEventListener('click', () => futures());

  return {
    refresh() { renderBar(); renderInspector(); },
    live() { liveTick(); },
    forceInspector() { shown = ''; renderInspector(); },
    showPart(part) { hoverPart = part; renderInspector(); },
    hints: { render: renderHints, take: takeHint, hide() { hints.hidden = true; } },
    openReference, closeReference, referenceOpen, openGallery, closeGallery, galleryOpen, futures, closeWhatIf,
    partsTable: PARTS,
  };
}
