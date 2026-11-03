// Everything on the page that is words: the palette, the bar, the inspector, the reference,
// the gallery, the hints under the label editor and the table view. The reference, the "you
// can also add" lists and the hints are generated from vocab.js, the table the parser reads,
// so they can't say anything the parser wouldn't do. Text from a drawing or a source is
// escaped on its way in, because a drawing can come from anyone.

import { drawElement } from '/lib/render.js';
import { parseScene, text as textElement } from '/lib/draw.js';
import { infer } from '../machine/graph.js';
import { settle } from '../machine/edit.js';
import { LEVELS, stateAt } from './alerts.js';
import { clock, dayClock, fmtAgo, showLevel, showValue, timeTicks } from './format.js';
import { levelColor } from './panels.js';
import { readDashboard, usesSource } from './read.js';
import { PANEL_NAMES, PARTS, readLabel, suggest, WORDS } from './vocab.js';

const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICONS = { check: '✓', triangle: '▲', octagon: '■', question: '?', cross: '✕', clock: '◷' };
const iconOf = (level) => `<span class="icon" aria-hidden="true">${ICONS[LEVELS[level]?.icon] ?? ''}</span>`;

export function createUi(m) {
  const insp = document.getElementById('inspector');
  const hints = document.getElementById('hints');
  const ref = document.getElementById('reference');
  const gallery = document.getElementById('gallery');
  const tableView = document.getElementById('tableview');
  const looking = document.getElementById('looking');
  const trouble = document.getElementById('trouble');
  const firing = document.getElementById('firing');
  const wallbar = document.getElementById('wallbar');
  const tape = document.getElementById('tape');
  const firingMenu = document.getElementById('firing-menu');
  const incidentMenu = document.getElementById('incident-menu');
  let message = null;
  let shown = '';
  let hoverPart = null;

  // ---------------------------------------------------------------- the palette

  const partsBox = document.getElementById('parts');
  partsBox.innerHTML = PARTS.map((p) => `<div class="part${p.id === 'grid' ? ' wide' : ''}" tabindex="0" role="button" data-part="${h(p.id)}" title="${h(p.says)}">${h(p.short)}</div>`).join('');
  partsBox.querySelectorAll('.part').forEach((el) => {
    const part = PARTS.find((p) => p.id === el.dataset.part);
    el.addEventListener('pointerdown', (e) => m.startPartDrag(e, { part }));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); m.addAtCenter({ part }); } });
    el.addEventListener('pointerenter', () => { hoverPart = part; renderInspector(true); });
    el.addEventListener('pointerleave', () => { hoverPart = null; renderInspector(true); });
  });

  function renderSources() {
    const box = document.getElementById('sources');
    const rows = [...m.catalog.values()].map((s) => {
      const why = m.failingNow?.get(s.name) ?? (s.ok === false ? s.why : null);
      const state = why ? `<span class="state bad" title="${h(why)}">✕</span>` : s.ok === true ? '<span class="state good">✓</span>' : '';
      const rowsOf = [...s.metrics.values()].slice(0, 30).map((row) => `<div class="metric" tabindex="0" role="button" data-source="${h(s.name)}" data-metric="${h(row.id)}" title="${h(`${row.name}${row.unit ? `, in ${row.unit}` : ''}. ${row.help ?? ''}`)}">${h(row.id)}</div>`).join('');
      const used = usesSource(m.dash, s.name);
      const metrics = rowsOf ? `<details ${used ? 'open' : ''}><summary>${s.metrics.size} metrics</summary>${rowsOf}</details>` : '';
      const empty = !s.metrics.size ? `<div class="source-type">${s.type === 'prometheus' ? 'Write any query, such as ' : s.type === 'push' ? 'Nothing sent yet. Write ' : 'Waiting for its first answer. Write '}<code>${h(s.name)}: up</code></div>` : '';
      return `<div class="source" data-name="${h(s.name)}"><div class="source-head">${state}<span>${h(s.name)}</span></div><div class="source-type">${h(s.type)}</div>${why ? `<div class="source-why">${h(why)}</div>` : ''}${metrics}${empty}</div>`;
    }).join('');
    const config = m.configError ? `<p id="config-error">${h(m.configError)}</p>` : '';
    const html = config + rows;
    if (box.dataset.html === html) return;
    const open = new Map([...box.querySelectorAll('.source')].map((el) => [el.dataset.name, el.querySelector('details')?.open]));
    box.dataset.html = html;
    box.innerHTML = html;
    // What you opened by hand stays open as sources update.
    for (const el of box.querySelectorAll('.source')) if (open.get(el.dataset.name) && el.querySelector('details')) el.querySelector('details').open = true;
    box.querySelectorAll('.metric').forEach((el) => {
      const payload = { source: el.dataset.source, metric: el.dataset.metric };
      el.addEventListener('pointerdown', (e) => m.startPartDrag(e, payload));
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); m.addAtCenter(payload); } });
    });
  }

  // ---------------------------------------------------------------- the bar

  function renderTime() {
    const { t0, t1 } = m.range();
    document.getElementById('range').textContent = `${t1 - t0 > 86400 ? dayClock(t0, false) : clock(t0)} to ${t1 - t0 > 86400 ? dayClock(t1, false) : clock(t1)}`;
    const updated = document.getElementById('updated');
    const at = m.link?.at;
    const late = m.link?.ok === false || (at && m.now() - at > 15);
    updated.textContent = at ? `updated ${clock(at)}, ${fmtAgo(m.now() - at)} ago` : m.link?.ok === false ? 'never updated' : 'waiting for data';
    updated.classList.toggle('late', !!late);
    const live = document.getElementById('btn-live');
    live.textContent = m.time.live ? 'pause' : 'go live';
    live.classList.toggle('on', !m.time.live);
    for (const b of document.querySelectorAll('[data-span]')) b.classList.toggle('on', Number(b.dataset.span) === m.time.span);
    document.getElementById('btn-zoomout').disabled = false;
  }

  function firingSummary() {
    const list = m.firingNow ?? [];
    const critical = list.filter((f) => f.rule.level === 'critical').length;
    const warn = list.length - critical;
    if (critical) return { cls: 'critical', level: 'critical', words: `${critical} critical${warn ? `, ${warn} warn` : ''}` };
    if (warn) return { cls: 'warn', level: 'warn', words: `${warn} warn` };
    const failing = m.failingNow?.size ?? 0;
    if (failing) return { cls: 'critical', level: 'failed', words: `${[...m.failingNow.keys()].join(', ')} failed` };
    const bad = m.silentNow?.length ?? 0;
    if (!m.ruleCount) return { cls: 'quiet', level: 'none', words: 'no alerts set' };
    if (bad) return { cls: 'quiet', level: 'nodata', words: `${bad} with no data` };
    return { cls: 'ok', level: 'ok', words: `${m.ruleCount} ok` };
  }

  function renderFiring() {
    const s = firingSummary();
    firing.className = s.cls;
    firing.innerHTML = `${s.level === 'none' ? '' : iconOf(s.level)}<span>${h(s.words)}</span>`;
    if (!firingMenu.hidden && !firingMenu.matches(':hover')) renderFiringMenu();
  }

  function renderFiringMenu() {
    const r = firing.getBoundingClientRect();
    firingMenu.style.left = `${r.left}px`;
    firingMenu.style.top = `${r.bottom + 4}px`;
    const rows = (m.firingNow ?? []).map((f) => `<button data-select="${h(f.owner)}" data-at="${f.since ?? ''}">${iconOf(f.rule.level)} ${h(f.name)} ${h(f.rule.op)} ${h(showLevel(f.rule.value, f.binding.unit))}<span>${h(f.rule.level)}, firing for ${fmtAgo(m.now() - (f.since ?? m.now()) + f.rule.for)}${f.series ? `, ${h(f.series)}` : ''}</span></button>`).join('');
    const silent = (m.silentNow ?? []).map((f) => `<button data-select="${h(f.owner)}">${iconOf('nodata')} ${h(f.name)}<span>no data, so this rule can't say</span></button>`).join('');
    const pending = (m.pendingNow ?? []).map((f) => `<button data-select="${h(f.owner)}">${iconOf('pending')} ${h(f.name)} ${h(f.rule.op)} ${h(showLevel(f.rule.value, f.binding.unit))}<span>crossed its level, and has not stayed there for ${h(fmtAgo(f.rule.for))} yet</span></button>`).join('');
    const failing = [...(m.failingNow ?? [])].map(([name, why]) => `<p>${iconOf('failed')} <b>${h(name)}</b> failed: ${h(why)}</p>`).join('');
    firingMenu.innerHTML = failing || rows || silent || pending ? failing + rows + pending + silent : `<p>Nothing firing. ${m.ruleCount} rule${m.ruleCount === 1 ? '' : 's'} on this drawing.</p>`;
  }

  firing.addEventListener('click', () => {
    firingMenu.hidden = !firingMenu.hidden;
    incidentMenu.hidden = true;
    if (!firingMenu.hidden) renderFiringMenu();
  });
  firingMenu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-select]');
    if (!b) return;
    firingMenu.hidden = true;
    m.select(b.dataset.select);
  });

  function renderLooking() {
    const s = firingSummary();
    const at = m.time.at;
    const now = m.now();
    const live = m.time.live;
    let html;
    if (live) {
      html = '<span><b>Live.</b> Every shape shows now.</span><span class="hint">Click a chart, or drag along the bottom, to look back.</span>';
    } else {
      const nowWords = s.level === 'ok' || s.level === 'none' ? 'Now: nothing firing' : `Now: ${s.words}`;
      const when = at ?? m.range().t1;
      html = `<span>${at === null ? 'Paused. ' : ''}Every shape shows <b>${h(dayClock(when))}</b>, ${h(fmtAgo(now - when))} ago.</span><button id="btn-back">back to live</button><span class="now ${h(s.cls)}">${h(nowWords)}</span>`;
    }
    looking.classList.toggle('live', live);
    if (looking.dataset.html !== html) {
      looking.dataset.html = html;
      looking.innerHTML = html;
      looking.querySelector('#btn-back')?.addEventListener('click', () => m.setLive(true));
    }
  }

  function renderTrouble() {
    const link = m.link;
    let words = '';
    if (link?.ok === false) {
      words = link.refused ? `This page can't read any data: ${link.why}. Open it on the machine running the server.` : `${link.why[0].toUpperCase()}${link.why.slice(1)}. ${link.at ? `Nothing on this page is newer than ${clock(link.at)}.` : 'Nothing on this page is current.'}`;
    }
    trouble.hidden = !words;
    if (trouble.textContent !== words) trouble.textContent = words;
  }

  function say(words, tone = 'ok') {
    const toast = document.getElementById('toast');
    toast.textContent = words;
    toast.className = tone === 'bad' ? 'bad' : '';
    toast.hidden = false;
    message = words;
    setTimeout(() => { if (message === words) toast.hidden = true; }, 4000);
  }

  function renderWall() {
    if (!m.wall) return;
    const s = firingSummary();
    const late = m.link?.ok === false || !m.link?.at || m.now() - m.link.at > 15;
    const names = [...(m.firingNow ?? []).map((f) => f.name), ...[...(m.failingNow ?? [])].map(([name, why]) => `${name}: ${why}`)].join(', ');
    const words = s.level === 'ok' ? 'all clear' : s.words;
    wallbar.className = late ? 'critical' : s.cls;
    wallbar.innerHTML = `<span class="state">${late ? iconOf('failed') : s.level === 'none' ? '' : iconOf(s.level)}<span>${h(late ? 'NOT UPDATING' : words)}</span></span><span class="names">${h(late ? (m.link?.why ?? 'waiting for data') : names)}</span><span class="when ${late ? 'late' : ''}">${h(m.title)} &middot; ${late && m.link?.at ? `last update ${h(clock(m.link.at))}, ${h(fmtAgo(m.now() - m.link.at))} ago` : `last ${h(fmtAgo(m.time.span))} to ${h(clock(m.range().t1))}, updated ${h(clock(m.link?.at ?? m.now()))}`}</span>`;
  }

  function renderButtons() {
    document.getElementById('btn-undo').disabled = !m.past.length;
    document.getElementById('btn-redo').disabled = !m.future.length;
    document.getElementById('btn-theme').textContent = m.theme.name === 'dark' ? 'light' : 'dark';
    document.getElementById('title').textContent = m.title;
    document.getElementById('title').title = m.title;
    document.getElementById('btn-incident').hidden = !usesSource(m.dash, 'demo');
  }

  // ---------------------------------------------------------------- the inspector

  function renderInspector(force = false) {
    const id = m.selected;
    // Under the pointer it holds still, so you can click a button or copy a query out of it.
    const tick = insp.matches(':hover') ? '' : Math.floor(m.now());
    const key = `${hoverPart?.id ?? ''}|${id ?? ''}|${m.version}|${tick}|${m.viewAt()}|${m.transitions.length}|${m.firingNow?.length}`;
    if (key === shown && !force) return;
    shown = key;
    const active = document.activeElement;
    if (insp.contains(active) && active.tagName === 'INPUT') return;
    const scroll = insp.scrollTop;
    if (hoverPart) partView(hoverPart);
    else if (id && m.dash.panels.get(id)) ownerView(m.dash.panels.get(id), 'shape');
    else if (id && m.dash.edges.get(id)) ownerView(m.dash.edges.get(id), 'arrow');
    else if (id && m.byId(id)?.type === 'text') noteView(m.byId(id));
    else overview();
    insp.scrollTop = scroll;
  }

  function stateLine(status) {
    if (!status || status.level === 'none') return '';
    return `<p class="state-line ${h(status.level)}" id="insp-state">${iconOf(status.level)}<span>${h(LEVELS[status.level].word)}${status.why ? `: ${h(status.why)}` : ''}</span></p>`;
  }

  function bindingRow(b, owner) {
    const at = m.viewAt();
    const read = m.data.readBinding(b, at, owner.kind);
    const source = m.catalog.get(b.source);
    const sourceWords = !m.catalog.size ? '' : source ? `${source.type}${source.ok === false ? `, failing: ${source.why}` : ''}` : 'not declared on this machine';
    const row = read.rows[0];
    let valueWords;
    if (read.failed) valueWords = `<span class="bad">${h(m.data.failure(b, read))}</span>`;
    else if (!read.rows.length) valueWords = read.waiting ? 'waiting...' : read.empty ? h(read.empty) : 'no numbers';
    else if (row.value === null || row.stale) valueWords = at !== null ? 'no data at that moment' : row.t ? `no data for ${h(fmtAgo(row.age))}. The last number was ${h(showValue(row.value ?? 0, b.unit))}.` : 'no data yet';
    else valueWords = `<b>${h(showValue(row.value, b.unit))}</b> at ${h(clock(row.t))}${read.rows.length > 1 ? `, and ${read.rows.length - 1} more series` : ''}`;
    const rules = b.rules.map((rule) => {
      const state = m.data.ruleState(rule, at);
      const level = state?.level ?? 'nodata';
      return `<div class="means">${iconOf(level)} ${h(rule.text)}: now ${h(state ? state.state : 'no data')}${state?.since ? ` since ${h(clock(state.since))}` : ''}</div>`;
    }).join('');
    return `<li class="binding" data-binding="${h(b.id)}"><code>${h(b.text)}</code>
      <span class="means">The number "${h(b.name)}"${b.unit ? `, in ${h(b.unit)}` : ', with no unit'}. From ${h(b.source)}${sourceWords ? ` (${h(sourceWords)})` : ''}, every ${h(fmtAgo(read.st?.interval ?? m.catalog.get(b.source)?.every ?? 5))}.</span>
      <div class="value">${valueWords}</div>${read.st?.dropped ? `<div class="means">Only the largest ${read.rows.length} of its ${read.rows.length + read.st.dropped} series are kept.</div>` : ''}${rules}</li>`;
  }

  function troubles(owner) {
    const all = m.dash.issues.filter((i) => i.id === owner.id);
    if (!all.length) return '';
    const rows = all.map((issue, n) => `<li class="${issue.level === 'error' ? 'bad' : 'note'}">${h(issue.message)}${issue.fix ? `<div><button class="fix" data-issue="${n}">use "${h(issue.fix.to)}"</button></div>` : ''}</li>`).join('');
    return `<h4>Worth fixing</h4><ul id="insp-problems">${rows}</ul>`;
  }

  function tableOfValues(owner) {
    if (!owner.bindings?.length || owner.kind === 'alerts') return '';
    const at = m.time.cursor ?? m.viewAt();
    const rows = [];
    for (const b of owner.bindings) {
      const read = m.data.readBinding(b, at, owner.kind);
      for (const row of read.rows.slice(0, 12)) rows.push(`<tr><td>${h(m.data.rowName(read, row))}</td><td>${row.value === null || row.stale ? 'no data' : h(showValue(row.value, b.unit))}</td></tr>`);
    }
    if (!rows.length) return '';
    return `<h4>${at !== null ? `Values at ${h(clock(at))}` : 'Values now'}</h4><table><tbody>${rows.join('')}</tbody></table>`;
  }

  function changesOn(owner) {
    const list = m.transitions.filter((tr) => tr.owner === owner.id).slice(-8).reverse();
    if (!list.length) return '';
    return `<h4>What changed in this range</h4><ul>${list.map((tr) => changeRow(tr)).join('')}</ul>`;
  }

  const changeRow = (tr) => `<li><button class="list-button" data-at="${tr.t}" data-select="${h(tr.owner)}"><em>${iconOf(tr.level)} ${h(tr.words)}</em><span>${h(clock(tr.t))}</span></button></li>`;

  function ownerView(owner, place) {
    const info = place === 'arrow' ? null : PANEL_NAMES[owner.kind];
    const status = owner.kind === 'alerts' || owner.kind === 'plain' ? null : m.data.status(owner, m.viewAt());
    const heading = place === 'arrow' ? (owner.watch ? 'arrow: what a chart watches' : owner.bindings.length ? 'arrow: traffic' : 'arrow') : info.name;
    const says = place === 'arrow'
      ? owner.watch ? 'This arrow says which shape a chart reads. Nothing travels along it.'
        : owner.bindings.length ? `This arrow shows a number${owner.flow ? ', and its dots move at that rate' : ''}.`
          : 'A line on the drawing. Add a source line to show the traffic on it.'
      : info.says;
    const why = place === 'arrow' ? '' : `<p class="why" id="insp-why">It counts as ${h(info.phrase)} because ${h(info.why)}.</p>`;
    const watching = owner.watching?.length ? `<p class="why">It reads ${h(owner.watching.map((id) => m.dash.panels.get(id)?.title || 'a shape').join(', '))}, through an arrow.</p>` : '';
    const rows = (owner.bindings ?? []).map((b) => bindingRow(b, owner)).join('');
    const understood = owner.understood?.filter((u) => u.word.id !== 'binding' && u.word.id !== 'named' && u.word.id !== 'unit').map((u) => `<li><code>${h(u.text)}</code><span class="means">${h(u.word.means)}</span></li>`).join('') ?? '';
    const used = new Set(owner.understood?.map((u) => u.word.id));
    const allowed = WORDS.filter((w) => w.re && w.on.includes(place) && !used.has(w.id) && !(w.group === 'panel' && owner.kind !== 'plain')).map((w) => `<li><button class="add-word" data-words="${h(w.example)}"><code>${h(w.example)}</code><span class="means">${h(w.means)}</span></button></li>`).join('');
    insp.innerHTML = `
      <h3 id="insp-what"><span class="kind">${h(heading)}</span></h3>
      <p id="insp-says">${h(says)}</p>${why}${watching}
      ${stateLine(status)}
      ${troubles(owner)}
      ${rows ? `<h4>What it is bound to</h4><ul id="insp-bindings">${rows}</ul>` : ''}
      ${tableOfValues(owner)}
      ${changesOn(owner)}
      ${understood ? `<h4>Other words it understood</h4><ul>${understood}</ul>` : ''}
      <div class="row"><button id="act-edit">edit label</button>${place === 'shape' ? '<button id="act-copy">copy</button>' : ''}<button id="act-delete">delete</button></div>
      ${allowed ? `<h4>You can also add</h4><ul>${allowed}</ul>` : ''}`;
    insp.querySelector('#act-edit').addEventListener('click', () => m.editLabelOf(owner.id));
    insp.querySelector('#act-copy')?.addEventListener('click', () => m.copy(owner.id));
    insp.querySelector('#act-delete').addEventListener('click', () => m.remove(owner.id));
    insp.querySelectorAll('.add-word').forEach((b) => b.addEventListener('click', () => m.addWord(owner.id, b.dataset.words)));
    insp.querySelectorAll('.fix').forEach((b) => b.addEventListener('click', () => m.applyFix(owner.id, m.dash.issues.filter((i) => i.id === owner.id)[Number(b.dataset.issue)])));
    insp.querySelectorAll('[data-at]').forEach((b) => b.addEventListener('click', () => m.setMoment(Number(b.dataset.at))));
  }

  function noteView(el) {
    insp.innerHTML = `
      <h3 id="insp-what"><span class="kind">note</span></h3>
      <p id="insp-says">This text does nothing. It is here to explain the drawing.</p>
      <p class="why">Text only counts when it is inside a shape or labels an arrow.</p>
      <div class="row"><button id="act-edit">edit</button><button id="act-delete">delete</button></div>`;
    insp.querySelector('#act-edit').addEventListener('click', () => m.editLabelOf(el.id));
    insp.querySelector('#act-delete').addEventListener('click', () => m.remove(el.id));
  }

  function partView(part) {
    const reads = part.label ? readLabel(part.label, 'shape', m.catalog.size ? m.catalog : null) : null;
    const words = WORDS.filter((w) => w.re && (w.group === 'alert' || w.group === 'setting') && w.on.includes('shape'));
    insp.innerHTML = `
      <h3 id="insp-what"><span class="kind">${h(part.short)}</span></h3>
      <p id="insp-says">${h(part.says)}</p>
      ${part.label ? `<p class="why">It starts with the label:</p><pre style="margin:2px 0;font-family:var(--code);font-size:13px">${h(part.label)}</pre>` : ''}
      ${reads?.understood.length ? `<h4>That label says</h4><ul>${reads.understood.map((u) => `<li><code>${h(u.text)}</code><span class="means">${h(u.word.means)}</span></li>`).join('')}</ul>` : ''}
      ${part.kind !== 'note' && part.kind !== 'grid' ? `<h4>It can also say</h4><ul>${words.map((w) => `<li><code>${h(w.example)}</code><span class="means">${h(w.means)}</span></li>`).join('')}</ul>` : ''}
      <p class="why" style="margin-top:10px">Drag it onto the board.</p>`;
  }

  function overview() {
    if (!m.doc.length) {
      insp.innerHTML = `<h3>Start here</h3>
        <p>A dashboard is a drawing. Draw your system, and shapes show live numbers.</p>
        <ol style="padding-left:20px;margin:6px 0">
          <li>Drag a panel from the left onto the board, or a metric under Sources.</li>
          <li>Click it to see what it is bound to. Double-click to change its label.</li>
          <li>Drag from its small blue circle to another shape to draw an arrow.</li>
        </ol>
        <p class="why">It stays a plain Excalidraw file, so you can also draw it there and drop it here.</p>`;
      return;
    }
    const firingRows = (m.painter?.firingAt(m.viewAt()) ?? []).map((f) => `<li><button class="list-button" data-select="${h(f.owner)}"><em>${iconOf(f.rule.level)} ${h(f.name)}</em><span>${h(f.rule.level)}</span></button></li>`).join('');
    const recent = m.transitions.slice(-14).reverse();
    const changes = recent.map(changeRow).join('');
    const issues = m.dash.issues.filter((i) => i.level === 'error');
    const sources = [...new Set([...m.dash.queries.values()].map((q) => q.source))].map((name) => {
      const s = m.catalog.get(name);
      const why = m.failingNow?.get(name) ?? (s?.ok === false ? s.why : null);
      const line = !s ? 'not declared on this machine' : why ? `failing: ${why}` : s.type;
      return `<li>${why || !s ? iconOf('failed') : iconOf('ok')} <b>${h(name)}</b> <span class="why">${h(line)}</span></li>`;
    }).join('');
    insp.innerHTML = `
      <h3>This dashboard</h3>
      <p class="why">${h([...m.dash.panels.values()].filter((p) => p.kind !== 'plain').length)} panels, ${h(m.dash.queries.size)} numbers, ${h(m.ruleCount)} alert rules. Click anything to see what it is bound to.</p>
      <h4>${m.viewAt() !== null ? `Firing at ${h(clock(m.viewAt()))}` : 'Firing now'}</h4>
      ${firingRows ? `<ul id="insp-firing">${firingRows}</ul>` : `<p class="why" id="insp-firing">Nothing.</p>`}
      ${changes ? `<h4>What changed in this range</h4><ul id="insp-changes">${changes}</ul>` : ''}
      ${issues.length ? `<h4>Worth fixing</h4><ul>${issues.map((i) => `<li class="bad">${h(i.message)}</li>`).join('')}</ul>` : ''}
      ${sources ? `<h4>Sources</h4><ul>${sources}</ul>` : ''}`;
    insp.querySelectorAll('[data-select],[data-at]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.select) m.select(b.dataset.select);
      if (b.dataset.at) m.setMoment(Number(b.dataset.at));
    }));
  }

  // ---------------------------------------------------------------- hints while typing

  let hintList = [];

  function renderHints(ta, ctx) {
    const before = ta.value.slice(0, ta.selectionStart);
    const catalog = m.catalog.size ? m.catalog : null;
    const read = readLabel(ta.value, ctx.place, catalog);
    const line = before.slice(before.lastIndexOf('\n') + 1).trim();
    hintList = ctx.isNote ? [] : suggest(before, ctx.place, catalog).slice(0, 7);
    const problem = read.problems.find((p) => p.level === 'error');
    const summary = ctx.isNote ? '<div class="read">A note does nothing, so it can say anything.</div>'
      : !ta.value.trim() ? '<div class="read">Type a name, a source line or one of these words.</div>'
        : problem ? `<div class="read bad">${h(problem.message)}</div>`
          : read.understood.length ? `<div class="read ok">Understood: ${read.understood.map((u) => (u.word.id === 'name' ? `the name "${h(u.text)}"` : h(u.text))).join(', ')}</div>` : '<div class="read">Nothing here reaches data yet.</div>';
    hints.innerHTML = summary + hintList.map((x, i) => `<button class="hint ${i === 0 && line ? 'first' : ''}" data-hint="${i}"><code>${h(x.shown)}</code><span>${h(x.means)}</span></button>`).join('') + '<div class="keys">Tab takes the first hint. Enter saves. Shift+Enter adds a line. Escape cancels.</div>';
    hints.hidden = false;
    const r = ta.getBoundingClientRect();
    const left = Math.max(6, Math.min(innerWidth - 366, r.left));
    const height = hints.getBoundingClientRect().height;
    hints.style.left = `${left}px`;
    hints.style.top = `${r.bottom + 6 + height > innerHeight ? Math.max(6, r.top - height - 6) : r.bottom + 6}px`;
  }

  function takeHint(ta, index = 0) {
    const pick = hintList[index];
    if (!pick) return false;
    const end = ta.selectionStart;
    ta.setRangeText(pick.insert, end - pick.replace, end, 'end');
    // Leave a number selected, since that is what you came to change.
    if (pick.kind === 'word') {
      const num = /\d+(?:\.\d+)?/.exec(pick.insert);
      if (num) ta.setSelectionRange(end - pick.replace + num.index, end - pick.replace + num.index + num[0].length);
    }
    ta.dispatchEvent(new Event('input'));
    return true;
  }

  hints.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const b = e.target.closest('[data-hint]');
    if (b) takeHint(document.getElementById('label'), Number(b.dataset.hint));
  });

  // ---------------------------------------------------------------- the reference

  function referenceHtml() {
    const section = (title, intro, words) => `
      <h3>${h(title)}</h3><p>${intro}</p>
      <table data-group="${h(title)}"><thead><tr><th>Write</th><th>On</th><th>What it does</th></tr></thead><tbody>
      ${words.map((w) => `<tr data-word="${h(w.id)}"><td><code>${h(w.example)}</code></td><td>${h(w.on.map((o) => (o === 'shape' ? 'a shape' : 'an arrow')).join(' or '))}</td><td>${h(w.means)}${w.also?.length ? `<div class="also">Suggested if you write: ${h(w.also.join(', '))}</div>` : ''}</td></tr>`).join('')}
      </tbody></table>`;
    const of = (group) => WORDS.filter((w) => w.group === group);
    const sources = [...m.catalog.values()].map((s) => `<tr><td><code>${h(s.name)}:</code></td><td>${h(s.type)}</td><td>${h(s.says ?? '')} ${s.metrics.size ? `It has: ${h([...s.metrics.keys()].slice(0, 24).join(', '))}.` : ''}</td></tr>`).join('');
    return `
      <button class="close" id="ref-close">close</button>
      <h2>What can I draw?</h2>
      <p>Draw your system. A shape's label says what it shows, one thing per line, and any other line is a name. Everything here is plain text in plain Excalidraw shapes, so you can draw it there too.</p>
      <input id="ref-search" type="search" placeholder="Search words, such as stale or threshold" aria-label="Search words">
      <div id="ref-body">
      ${section('Data', 'A source line shows a number. A source is a name, never an address, so a drawing you are sent can\'t read anything you have not declared.', of('data'))}
      ${section('Panels', 'One of these on its own line says how a shape shows its numbers.', of('panel'))}
      ${section('Alerts', 'Levels live in the label too. A shape shows its worst state with a word and an icon, and a chart shows every change.', of('alert'))}
      ${section('Settings', '', of('setting'))}
      <h3>Sources on this machine</h3>
      <p>Add your own in <code>experiments/dashboard/.sources.json</code>, which is not committed. <code>sources.example.json</code> shows how.</p>
      <table id="ref-sources"><tbody>${sources}</tbody></table>
      <h3>On the page</h3>
      <table><tbody>
        <tr><td>Drag a panel or a metric from the left</td><td>Add it. Drop a metric on a shape to add it to that shape.</td></tr>
        <tr><td>Double-click nothing</td><td>Add a new box and type its label.</td></tr>
        <tr><td>Click a shape's title or edge</td><td>Select it, and see what it is bound to.</td></tr>
        <tr><td>Drag a shape's title or edge</td><td>Move it. It snaps to a grid, so a grid of charts lines up.</td></tr>
        <tr><td>Drag a selected shape's corner</td><td>Resize it.</td></tr>
        <tr><td>Drag its blue circle</td><td>Draw an arrow to another shape. An arrow to a chart with no source lines makes it read that shape.</td></tr>
        <tr><td>Double-click a label</td><td>Change it, with hints as you type.</td></tr>
        <tr><td>Hover a chart</td><td>A line at that time across every chart, with the values.</td></tr>
        <tr><td>Drag across a chart</td><td>Zoom to that time.</td></tr>
        <tr><td>Click a chart, or drag along the bottom</td><td>Look back: every shape and arrow shows that moment.</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>Back to live, or close what is open.</td></tr>
        <tr><td><kbd>Space</kbd></td><td>Pause and go live.</td></tr>
        <tr><td><kbd>←</kbd> <kbd>→</kbd>, with <kbd>Shift</kbd> for bigger steps</td><td>Move the moment you are looking at.</td></tr>
        <tr><td><kbd>z</kbd></td><td>Zoom out.</td></tr>
        <tr><td><kbd>f</kbd>, <kbd>d</kbd>, <kbd>t</kbd>, <kbd>?</kbd></td><td>Wall view, dark mode, the table of every number, and this page.</td></tr>
        <tr><td><kbd>Delete</kbd></td><td>Delete what is selected.</td></tr>
        <tr><td><kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd>, with <kbd>Shift</kbd></td><td>Undo and redo.</td></tr>
        <tr><td><kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>D</kbd>, <kbd>S</kbd></td><td>Copy what is selected, and save.</td></tr>
      </tbody></table>
      </div>`;
  }

  function toggleReference() {
    if (!ref.hidden) { ref.hidden = true; return; }
    ref.innerHTML = referenceHtml();
    ref.querySelector('#ref-close').addEventListener('click', () => { ref.hidden = true; });
    ref.querySelector('#ref-search').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      ref.querySelectorAll('tr[data-word]').forEach((tr) => {
        const word = WORDS.find((w) => w.id === tr.dataset.word);
        const text = `${word.example} ${word.means} ${(word.also ?? []).join(' ')}`.toLowerCase();
        tr.hidden = !!q && !text.includes(q);
      });
      // A section with nothing left to show goes too, heading and all.
      ref.querySelectorAll('table[data-group]').forEach((table) => {
        const any = [...table.querySelectorAll('tr[data-word]')].some((tr) => !tr.hidden);
        table.hidden = !any;
        table.previousElementSibling.hidden = !any;
        table.previousElementSibling.previousElementSibling.hidden = !any;
      });
    });
    ref.hidden = false;
    ref.querySelector('#ref-search').focus();
  }

  // ---------------------------------------------------------------- the table view

  function renderTable() {
    const at = m.viewAt();
    const rows = [];
    const add = (owner, title) => {
      for (const b of owner.bindings ?? []) {
        const read = m.data.readBinding(b, at, owner.kind);
        const status = m.data.status({ bindings: [b], kind: owner.kind }, at);
        const list = read.rows.length ? read.rows : [{ name: b.name, value: null, stale: true, t: null }];
        for (const row of list.slice(0, 50)) {
          rows.push(`<tr data-owner="${h(owner.id)}" data-binding="${h(b.id)}"><td>${h(title)}</td><td>${h(read.rows.length ? m.data.rowName(read, row) : b.name)}</td><td><code>${h(b.source)}: ${h(b.query)}</code></td><td class="value">${row.value === null || row.stale ? 'no data' : h(showValue(row.value, b.unit))}</td><td>${iconOf(status.level)} ${h(LEVELS[status.level].word || '-')}</td><td>${row.t ? h(clock(row.t)) : '-'}</td></tr>`);
        }
      }
    };
    for (const panel of m.dash.panels.values()) add(panel, panel.title);
    for (const edge of m.dash.edges.values()) if (!edge.watch) add(edge, edge.title || 'an arrow');
    const html = `<button class="close" id="tv-close">close</button><h2>Every number</h2><p>${at !== null ? `At ${h(dayClock(at))}.` : 'Now.'} This is the same data the drawing shows.</p><table><thead><tr><th>Shape</th><th>Number</th><th>Bound to</th><th>Value</th><th>State</th><th>From</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
    tableView.innerHTML = html;
    tableView.querySelector('#tv-close').addEventListener('click', () => { tableView.hidden = true; });
  }

  function toggleTable() {
    tableView.hidden = !tableView.hidden;
    if (!tableView.hidden) renderTable();
  }
  document.getElementById('btn-table').addEventListener('click', toggleTable);

  // ---------------------------------------------------------------- the gallery

  let galleryBuilt = false;
  async function openGallery() {
    gallery.hidden = false;
    if (galleryBuilt) return;
    galleryBuilt = true;
    gallery.innerHTML = `
      <h2>Dashboards</h2>
      <p>Each of these is a plain .excalidraw file. Open one and change it, or start from nothing.</p>
      <div class="grid">
        <button class="card" data-scene="blank"><canvas></canvas><i>your own</i><b>A blank board</b><span>Drag on panels, or drop an .excalidraw file anywhere.</span></button>
        ${m.scenes.map((s) => `<button class="card" data-scene="${h(s.id)}"><canvas></canvas><i>${h(s.group)}</i><b>${h(s.title)}</b><span>${h(s.summary)}</span></button>`).join('')}
      </div>`;
    gallery.querySelectorAll('.card').forEach((card) => card.addEventListener('click', async () => {
      gallery.hidden = true;
      if (card.dataset.scene === 'blank') m.loadBlank(); else await m.loadScene(card.dataset.scene);
    }));
    await Promise.all(m.scenes.map(async (s) => {
      const data = await (await fetch(`./scenes/${s.id}.excalidraw`)).json();
      const elements = settle(infer(parseScene(data).elements));
      const dash = readDashboard(elements);
      const titles = [...dash.panels.values()].filter((p) => p.title).map((p) => textElement(`${p.id}-thumb`, p.el.x + 16, p.el.y + 14, p.title, { size: 34, color: '#1B2547' }));
      thumbnail(gallery.querySelector(`[data-scene="${s.id}"] canvas`), [...elements.filter((el) => !el.containerId), ...titles]);
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
    for (const el of elements) drawElement(ctx, m.theme.name === 'dark' ? { ...el, strokeColor: '#e6e4dc', backgroundColor: 'transparent' } : el);
  }

  document.getElementById('btn-gallery').addEventListener('click', openGallery);
  document.getElementById('btn-help').addEventListener('click', toggleReference);

  // ---------------------------------------------------------------- the incident menu

  document.getElementById('btn-incident').addEventListener('click', () => {
    incidentMenu.hidden = !incidentMenu.hidden;
    firingMenu.hidden = true;
    if (incidentMenu.hidden) return;
    const demo = m.catalog.get('demo');
    const r = document.getElementById('btn-incident').getBoundingClientRect();
    incidentMenu.style.left = `${Math.max(6, r.right - 340)}px`;
    incidentMenu.style.top = `${r.bottom + 4}px`;
    const running = demo?.active ?? [];
    incidentMenu.innerHTML = `<p>The demo source is a simulation. These change its numbers, and nothing else.</p>${(demo?.incidents ?? []).map((i) => `<button data-kind="${h(i.id)}" ${running.includes(i.id) ? 'class="on"' : ''}>${h(i.label)}${running.includes(i.id) ? ': running' : ''}<span>${h(i.says)}</span></button>`).join('')}<button data-fail="${demo?.ok === false ? '0' : '1'}">${demo?.ok === false ? 'make the source answer again' : 'make the source fail'}<span>Every request to it gets an error, so panels must say which source failed and why.</span></button><button data-recover="1">recover<span>Ends everything that is running.</span></button>`;
    incidentMenu.querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
      incidentMenu.hidden = true;
      if (b.dataset.kind) await m.incident({ kind: b.dataset.kind });
      else if (b.dataset.fail) await m.incident({ fail: b.dataset.fail === '1' });
      else await m.incident({ recover: true });
      refresh();
    }));
  });

  // ---------------------------------------------------------------- the tape: all of time on the screen

  const tapeLayout = { l: 12, r: 12 };
  function timeAtTape(clientX) {
    const r = tape.getBoundingClientRect();
    const { t0, t1 } = m.range();
    return t0 + ((clientX - r.left - tapeLayout.l) / (r.width - tapeLayout.l - tapeLayout.r)) * (t1 - t0);
  }
  tape.addEventListener('pointerdown', (e) => {
    tape.setPointerCapture(e.pointerId);
    m.setMoment(timeAtTape(e.clientX));
    const move = (ev) => m.setMoment(timeAtTape(ev.clientX));
    const up = () => { tape.removeEventListener('pointermove', move); tape.removeEventListener('pointerup', up); };
    tape.addEventListener('pointermove', move);
    tape.addEventListener('pointerup', up);
  });

  function drawTape() {
    const T = m.theme;
    const r = tape.getBoundingClientRect();
    if (!r.width) return;
    const dpr = window.devicePixelRatio || 1;
    if (tape.width !== Math.round(r.width * dpr) || tape.height !== Math.round(r.height * dpr)) { tape.width = Math.round(r.width * dpr); tape.height = Math.round(r.height * dpr); }
    const ctx = tape.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = T.surface;
    ctx.fillRect(0, 0, r.width, r.height);
    const { t0, t1 } = m.range();
    const X = (t) => tapeLayout.l + ((t - t0) / (t1 - t0)) * (r.width - tapeLayout.l - tapeLayout.r);
    const rowY = 16, rowH = 12;
    ctx.fillStyle = T.grid;
    ctx.fillRect(X(t0), rowY, X(t1) - X(t0), rowH);
    // Worst last, so the worst state shows wherever several overlap.
    const spans = [];
    for (const owner of [...m.dash.panels.values(), ...m.dash.edges.values()]) {
      for (const b of owner.own ?? owner.bindings) spans.push(...m.data.ruleSpans(b, t0, t1));
    }
    for (const level of ['nodata', 'pending', 'warn', 'critical']) {
      ctx.fillStyle = levelColor(T, level);
      ctx.globalAlpha = level === 'pending' ? 0.45 : 1;
      for (const s of spans) if (s.level === level) ctx.fillRect(X(s.a), rowY, Math.max(1, X(s.b) - X(s.a)), rowH);
    }
    ctx.globalAlpha = 1;
    ctx.font = '11px Nunito';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = T.muted;
    ctx.textAlign = 'left';
    ctx.fillText(spans.length ? 'alerts in this range' : 'time in this range', X(t0), 8);
    ctx.textAlign = 'right';
    ctx.fillText('drag along here to look back', X(t1), 8);
    ctx.textAlign = 'center';
    ctx.strokeStyle = T.axis;
    for (const tick of timeTicks(t0, t1, Math.max(3, Math.floor(r.width / 110))).ticks) {
      const x = X(tick.t);
      ctx.beginPath(); ctx.moveTo(x, rowY + rowH); ctx.lineTo(x, rowY + rowH + 4); ctx.stroke();
      ctx.fillText(tick.label, Math.max(26, Math.min(r.width - 26, x)), rowY + rowH + 12);
    }
    if (m.time.at !== null) {
      const x = X(m.time.at);
      ctx.strokeStyle = T.select;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, 2); ctx.lineTo(x, rowY + rowH + 4); ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = T.select;
      ctx.beginPath(); ctx.moveTo(x - 5, 2); ctx.lineTo(x + 5, 2); ctx.lineTo(x, 9); ctx.closePath(); ctx.fill();
    }
  }

  // ---------------------------------------------------------------- wiring

  function refresh() {
    renderTime();
    renderFiring();
    renderLooking();
    renderTrouble();
    renderWall();
    renderButtons();
    renderInspector();
    if (!tableView.hidden) renderTable();
  }

  return {
    refresh,
    tick: refresh,
    say,
    renderSources,
    drawTape,
    toggleReference,
    toggleTable,
    openGallery,
    closeGallery() { gallery.hidden = true; },
    closeTop() {
      if (!ref.hidden) { ref.hidden = true; return true; }
      if (!tableView.hidden) { tableView.hidden = true; return true; }
      if (!gallery.hidden && m.doc.length) { gallery.hidden = true; return true; }
      if (!firingMenu.hidden) { firingMenu.hidden = true; return true; }
      if (!incidentMenu.hidden) { incidentMenu.hidden = true; return true; }
      return false;
    },
    hints: { render: renderHints, take: takeHint, hide() { hints.hidden = true; } },
    stateAt,
  };
}
