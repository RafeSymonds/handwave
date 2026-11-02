// Scripted solutions, one list per level id. The test draws each with the real
// pointer and plays it on the fixed timestep, so these prove every level can be
// beaten, in more than one way. Each stroke is a list of waypoints the pen follows.

export const SOLUTIONS = {
  gap: [
    { name: 'bridge', strokes: [[[545, 578], [800, 606]]] },
    { name: 'kicker ramp', strokes: [[[460, 507], [548, 510], [548, 582], [460, 507]]] },
  ],
  wall: [
    { name: 'ramp onto the wall', strokes: [[[840, 682], [1016, 556], [1060, 556]]] },
    { name: 'solid wedge', strokes: [[[900, 680], [1006, 680], [1006, 572], [900, 680]]] },
  ],
  nudge: [
    { name: 'drop a small block', strokes: [[[340, 200], [390, 200], [390, 250], [340, 250], [340, 200]]] },
    { name: 'drop a beam', strokes: [[[300, 300], [385, 340]]] },
  ],
  gate: [
    { name: 'weigh down the plate', strokes: [[[730, 300], [790, 300], [790, 360], [730, 360], [730, 300]]] },
    { name: 'ramp over the gate', strokes: [[[760, 692], [972, 564], [1030, 564]]] },
  ],
  nails: [
    { name: 'long chute', strokes: [[[230, 322], [250, 330], [620, 480], [700, 505]]] },
    { name: 'ski jump', strokes: [[[243, 327], [250, 330], [620, 480], [640, 480]]] },
  ],
  hammer: [
    { name: 'line hammer', strokes: [[[20, 360], [420, 360]]] },
    { name: 'drop a block', strokes: [[[410, 500], [460, 500], [460, 550], [410, 550], [410, 500]]] },
  ],
  seesaw: [
    { name: 'short plank, small block', strokes: [[[440, 655], [640, 680], [1000, 726], [1070, 700]], [[480, 350], [560, 350], [560, 430], [480, 430], [480, 350]]] },
    { name: 'long plank, big block', strokes: [[[390, 648], [640, 680], [1000, 726], [1070, 700]], [[400, 420], [490, 420], [490, 510], [400, 510], [400, 420]]] },
  ],
  stones: [
    { name: 'three bridges', strokes: [[[410, 500], [630, 548]], [[770, 548], [1000, 588]], [[1130, 588], [1350, 628]]] },
    { name: 'bridge, kicker, bridge', strokes: [[[410, 500], [630, 548]], [[730, 552], [776, 530], [776, 552], [730, 552]], [[1130, 588], [1350, 628]]] },
  ],
};

/** The pen's positions along waypoints, as whole pixels, about `spacing` apart. */
export function tracePath(waypoints, spacing = 12) {
  const out = [waypoints[0].slice()];
  for (let i = 1; i < waypoints.length; i++) {
    const [ax, ay] = waypoints[i - 1], [bx, by] = waypoints[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / spacing));
    for (let s = 1; s <= steps; s++) out.push([Math.round(ax + ((bx - ax) * s) / steps), Math.round(ay + ((by - ay) * s) / steps)]);
  }
  return out;
}
