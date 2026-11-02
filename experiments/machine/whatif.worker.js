// Runs one drawing many times with different luck, away from the page so it can't
// drop a frame. Each run is seeded, so the same drawing gives the same spread.

import { readGraph } from './graph.js';
import { FlowSim } from './sim.js';

const STEP = 1 / 20;

self.onmessage = ({ data }) => {
  const { job, variants, seeds, seconds, sampleEvery = 2 } = data;
  for (let v = 0; v < variants.length; v++) {
    const graph = readGraph(variants[v].elements);
    for (let s = 0; s < seeds; s++) {
      const sim = new FlowSim(graph, 1000 + s * 7919);
      const waiting = [];
      let next = 0;
      for (let i = 0, n = Math.round(seconds / STEP); i < n; i++) {
        sim.step(STEP);
        if (sim.time >= next) { waiting.push(sim.waiting()); next += sampleEvery; }
      }
      const stats = sim.stats();
      self.postMessage({ job, variant: v, seed: s, waiting, final: stats.waiting, average: stats.average, slowest: stats.slowest, finished: stats.finished, dropped: stats.dropped, wasted: stats.wasted });
    }
  }
  self.postMessage({ job, done: true });
};
