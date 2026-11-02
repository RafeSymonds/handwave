// The levels. Coordinates are stage pixels on a 1600 by 900 page, with the HUD
// above y = 122.
//
//   ground   chains of points, each solid down to the bottom of the page
//   blocks   convex polygons
//   hazards  convex polygons that end the run
//   pins     nails: a stroke through one pivots on it, a stroke through two is fixed
//   plate    {x, y, w, load}: holds the gate open while `load` of mass rests on it
//   gate     {x, y, w, h}: a bar that rises by its own height
//   ink      how much line you get
//   stars    [most ink for three stars, most ink for two]

// Round a chain's corners by `radius` pixels, so a ball keeps its speed through them.
function curve(points, radius = 70, samples = 8) {
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1], [cx, cy] = points[i], [nx, ny] = points[i + 1];
    const r = Math.min(radius, Math.hypot(cx - px, cy - py) / 2, Math.hypot(nx - cx, ny - cy) / 2);
    const inLength = Math.hypot(cx - px, cy - py), outLength = Math.hypot(nx - cx, ny - cy);
    const a = [cx + ((px - cx) * r) / inLength, cy + ((py - cy) * r) / inLength];
    const b = [cx + ((nx - cx) * r) / outLength, cy + ((ny - cy) * r) / outLength];
    for (let s = 0; s <= samples; s++) {
      const t = s / samples, u = 1 - t;
      out.push([u * u * a[0] + 2 * u * t * cx + t * t * b[0], u * u * a[1] + 2 * u * t * cy + t * t * b[1]]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

export const LEVELS = [
  {
    id: 'gap',
    name: 'Mind the gap',
    hint: 'Draw a line across the gap, then press space to let go.',
    ground: [curve([[-40, 300], [130, 320], [560, 600]]), [[790, 620], [1640, 620]]],
    ball: { x: 96, y: 290 },
    flag: { x: 1320, y: 620 },
    ink: 800,
    stars: [280, 500],
  },
  {
    id: 'wall',
    name: 'Over the wall',
    hint: 'A line falls when you let go and stays where it lands. Lean one on the wall.',
    ground: [curve([[-40, 200], [150, 220], [620, 690], [1640, 690]], 120)],
    blocks: [[[1020, 570], [1085, 570], [1085, 690], [1020, 690]]],
    ball: { x: 90, y: 188 },
    flag: { x: 1420, y: 690 },
    ink: 800,
    stars: [270, 450],
  },
  {
    id: 'nudge',
    name: 'Nudge',
    hint: 'The ball will not move by itself. Drop something on it. A closed loop is heavy.',
    ground: [curve([[330, 480], [470, 480], [560, 500], [980, 780], [1640, 790]])],
    ball: { x: 400, y: 453 },
    flag: { x: 1380, y: 790 },
    ink: 520,
    stars: [130, 260],
  },
  {
    id: 'gate',
    name: 'Heavy hands',
    hint: 'The amber plate opens the gate while something heavy sits on it.',
    ground: [curve([[-40, 210], [130, 230], [620, 700], [1640, 700]], 120)],
    blocks: [[[640, 430], [880, 430], [880, 462], [640, 462]]],
    plate: { x: 680, y: 420, w: 160, load: 14 },
    gate: { x: 980, y: 580, w: 36, h: 120 },
    ball: { x: 80, y: 198 },
    flag: { x: 1350, y: 700 },
    ink: 700,
    stars: [250, 420],
  },
  {
    id: 'nails',
    name: 'Two nails',
    hint: 'A line through two nails stays fixed. There is nothing else to catch the ball.',
    ground: [[[800, 640], [1640, 640]]],
    hazards: [[[-40, 860], [800, 860], [800, 960], [-40, 960]]],
    pins: [{ x: 250, y: 330 }, { x: 620, y: 480 }],
    ball: { x: 300, y: 180 },
    flag: { x: 1400, y: 640 },
    ink: 700,
    stars: [440, 560],
  },
  {
    id: 'hammer',
    name: 'Hammer',
    hint: 'A line through one nail swings. Get the length right, or find something cheaper.',
    ground: [[[-40, 800], [1640, 800]]],
    pins: [{ x: 420, y: 360 }],
    ball: { x: 475, y: 773 },
    flag: { x: 1250, y: 800 },
    ink: 720,
    stars: [210, 420],
  },
  {
    id: 'stones',
    name: 'Stepping stones',
    hint: 'Three bridges only just fit. How far can the ball fly?',
    ground: [curve([[-40, 190], [100, 210], [420, 520]]), [[620, 560], [780, 560]], [[990, 600], [1140, 600]], [[1340, 640], [1640, 640]]],
    hazards: [[[-40, 860], [1640, 860], [1640, 960], [-40, 960]]],
    ball: { x: 70, y: 180 },
    flag: { x: 1500, y: 640 },
    ink: 700,
    stars: [600, 690],
  },
  {
    id: 'seesaw',
    name: 'Seesaw',
    hint: 'The flag is up there. The ball needs a push from something falling a long way.',
    ground: [[[-40, 640], [260, 640], [270, 780], [1190, 780], [1200, 200], [1640, 200]]],
    blocks: [[[420, 300], [860, 300], [860, 340], [420, 340]], [[420, 262], [444, 262], [444, 300], [420, 300]]],
    pins: [{ x: 640, y: 680 }],
    ball: { x: 960, y: 640 },
    flag: { x: 640, y: 300 },
    ink: 1200,
    stars: [1000, 1120],
  },
];
