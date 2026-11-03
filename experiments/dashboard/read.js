// Read a dashboard out of a drawing. Shapes are panels, arrows are traffic or say what a
// chart watches, and labels say what is bound to what. This file has no DOM and no state,
// so anything it decides can be checked by reading the .excalidraw file.

import { isArrow, isShape, isText, ownerOf } from '../machine/graph.js';
import { readLabel } from './vocab.js';

export const MAX_QUERIES = 200;

const keyOf = (source, query) => `${source}\u0000${query}`;
export const queryKey = keyOf;

function makeBindings(ownerId, read) {
  return read.bindings.map((b, i) => ({
    ...b,
    id: `${ownerId}#${i}`,
    owner: ownerId,
    key: keyOf(b.source, b.query),
    stale: read.stale,
    every: read.every,
    rules: read.alerts.filter((a) => a.binding === i).map((a, n) => ({ ...a, id: `${ownerId}#${i}/${n}`, owner: ownerId })),
  }));
}

export function readDashboard(elements, catalog = null) {
  const words = new Map();
  for (const el of elements) {
    if (!isText(el) || el.customData?.machine?.note) continue;
    const owner = ownerOf(el);
    if (owner) words.set(owner, [...(words.get(owner) ?? []), el]);
  }
  // As typed: Excalidraw wraps `text` to fit its shape, and would break a query in two.
  const labelOf = (id) => (words.get(id) ?? []).map((t) => (t.containerId && t.originalText ? t.originalText : t.text)).join('\n');

  const panels = new Map();
  const edges = new Map();
  const issues = [];

  for (const el of elements) {
    if (!isShape(el)) continue;
    const label = labelOf(el.id);
    const read = readLabel(label, 'shape', catalog);
    const bindings = makeBindings(el.id, read);
    const kind = read.panel ?? (bindings.length ? 'box' : 'plain');
    panels.set(el.id, {
      id: el.id, el, label, kind, texts: words.get(el.id) ?? [],
      title: read.title ?? (kind === 'plain' ? '' : kind === 'alerts' ? 'alerts' : bindings[0]?.name ?? kind),
      hasTitle: !!read.title,
      bindings, own: bindings, pick: read.pick, range: read.range, axis: read.axis,
      understood: read.understood, problems: read.problems, watching: [],
    });
  }

  for (const el of elements) {
    if (!isArrow(el)) continue;
    const label = labelOf(el.id);
    const read = readLabel(label, 'arrow', catalog);
    const reversed = !el.endArrowhead && !!el.startArrowhead;
    const a = el.startBinding?.elementId ?? null, b = el.endBinding?.elementId ?? null;
    const known = (id) => (panels.has(id) ? id : null);
    edges.set(el.id, {
      id: el.id, el, label, texts: words.get(el.id) ?? [],
      from: known(reversed ? b : a), to: known(reversed ? a : b),
      title: read.title ?? '', flow: read.flow,
      bindings: makeBindings(el.id, read),
      understood: read.understood, problems: read.problems,
    });
  }

  // A panel with no source line of its own shows what an arrow joins it to.
  for (const edge of edges.values()) {
    if (edge.bindings.length) continue;
    const pairs = [[edge.from, edge.to], [edge.to, edge.from]];
    for (const [one, other] of pairs) {
      const panel = panels.get(one), target = panels.get(other);
      if (!panel || !target || !['chart', 'stat', 'meter', 'table'].includes(panel.kind) || panel.own.length) continue;
      panel.watching.push(target.id);
      edge.watch = true;
    }
  }
  for (const panel of panels.values()) {
    if (!panel.watching.length) continue;
    const seen = panel.watching.flatMap((id) => panels.get(id).own);
    const wanted = panel.pick?.toLowerCase();
    panel.bindings = wanted ? seen.filter((b) => b.name.toLowerCase() === wanted || b.query.toLowerCase() === wanted) : seen;
    if (wanted && !panel.bindings.length) {
      panel.problems.push({ line: 0, text: panel.pick, level: 'error', fix: null, message: `The shape this joins has no number called "${panel.pick}". It has ${seen.map((b) => b.name).join(', ') || 'none yet'}.` });
    }
    if (!panel.hasTitle) panel.title = panel.bindings.length === 1 ? panel.bindings[0].name : panels.get(panel.watching[0]).title || 'chart';
  }

  // A second panel of the same number on one drawing reads the same data.
  const queries = new Map();
  const note = (binding, instant) => {
    const key = `${instant ? 'instant' : 'range'}\u0000${binding.key}`;
    const q = queries.get(key) ?? { key, source: binding.source, query: binding.query, instant, every: null, rules: 0 };
    if (binding.every && (!q.every || binding.every < q.every)) q.every = binding.every;
    q.rules = Math.max(q.rules, Math.max(0, ...binding.rules.map((r) => r.for)));
    queries.set(key, q);
  };
  for (const panel of panels.values()) {
    for (const binding of panel.bindings) note(binding, panel.kind === 'table');
    // A shape's alerts need its history even when it only shows a table.
    if (panel.kind === 'table') for (const binding of panel.bindings) if (binding.rules.length) note(binding, false);
    if (['chart', 'stat', 'meter', 'table'].includes(panel.kind) && !panel.bindings.length && !panel.problems.length) {
      panel.problems.push({ line: 0, text: '', level: 'note', fix: null, empty: true, message: `Nothing to show yet. Add a line such as "machine: cpu", or draw an arrow to a box.` });
    }
    if (panel.kind === 'meter' && panel.bindings.length > 1) panel.problems.push({ line: 0, text: '', level: 'note', fix: null, message: `A meter shows one number, so it shows ${panel.bindings[0].name}. Use a table or a chart for more.` });
    for (const p of panel.problems) issues.push({ ...p, id: panel.id });
    for (const b of panel.own) {
      if (!b.hasUnit && catalog?.has(b.source)) issues.push({ id: panel.id, line: b.line, text: b.text, level: 'note', fix: null, message: `${b.name} has no unit, so its axis can't say what it counts. Add one to the line, such as "${b.text} in req/s".` });
    }
  }
  for (const edge of edges.values()) {
    for (const binding of edge.bindings) note(binding, false);
    for (const p of edge.problems) issues.push({ ...p, id: edge.id });
  }
  if (queries.size > MAX_QUERIES) {
    issues.push({ id: null, level: 'error', fix: null, line: 0, text: '', message: `This drawing asks for ${queries.size} different numbers. Only the first ${MAX_QUERIES} run.` });
  }

  return { panels, edges, issues, queries: new Map([...queries].slice(0, MAX_QUERIES)) };
}

export const usesSource = (dash, source) => [...dash.queries.values()].some((q) => q.source === source);

/** Every rule on a drawing. */
export function allRules(dash) {
  const out = [];
  const add = (owner) => { for (const b of owner.own ?? owner.bindings) for (const rule of b.rules) out.push({ rule, binding: b, owner }); };
  for (const panel of dash.panels.values()) add(panel);
  for (const edge of dash.edges.values()) add(edge);
  return out;
}
