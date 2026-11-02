// Plain polygon and polyline helpers with no dependencies. Points are [x, y].

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

/** Douglas-Peucker. Keeps the first and last point. */
export function simplify(points, tolerance) {
  if (points.length < 3) return points.slice();
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1, worstDistance = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(points[i], points[a], points[b]);
      if (d > worstDistance) { worst = i; worstDistance = d; }
    }
    if (worst >= 0) {
      keep[worst] = true;
      stack.push([a, worst], [worst, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export function segmentDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}

/** Closest distance from a point to a polyline, closed or open. */
export function polylineDistance(p, points) {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) best = Math.min(best, segmentDistance(p, points[i - 1], points[i]));
  return best;
}

export function signedArea(points) {
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    total += x1 * y2 - x2 * y1;
  }
  return total / 2;
}

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

export function isConvex(points) {
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const c = cross(points[i], points[(i + 1) % points.length], points[(i + 2) % points.length]);
    if (Math.abs(c) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(c);
    else if (Math.sign(c) !== sign) return false;
  }
  return sign !== 0;
}

function segmentsCross(a, b, c, d) {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Whether a closed polygon's edges avoid each other. */
export function isSimple(points) {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])) return false;
    }
  }
  return true;
}

export function pointInPolygon(p, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Ear clipping. Returns triangles wound the same positive way. */
function triangulate(input) {
  const points = signedArea(input) > 0 ? input.slice() : input.slice().reverse();
  const triangles = [];
  let guard = points.length * points.length + 8;
  while (points.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < points.length; i++) {
      const a = points[(i + points.length - 1) % points.length], b = points[i], c = points[(i + 1) % points.length];
      if (cross(a, b, c) <= 1e-9) continue;
      const blocked = points.some((p) => p !== a && p !== b && p !== c && cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0);
      if (blocked) continue;
      triangles.push([a, b, c]);
      points.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) points.splice(0, 1); // Degenerate leftovers: drop a point and carry on.
  }
  if (points.length === 3 && Math.abs(signedArea(points)) > 1e-6) triangles.push(points.slice());
  return triangles;
}

/** A simple polygon as convex pieces: triangles merged while the result stays convex. */
export function convexPieces(polygon) {
  if (isConvex(polygon)) return [polygon];
  const pieces = triangulate(polygon);
  let merged = true;
  while (merged) {
    merged = false;
    outer:
    for (let a = 0; a < pieces.length; a++) {
      for (let b = a + 1; b < pieces.length; b++) {
        const union = mergeOnEdge(pieces[a], pieces[b]);
        if (union && isConvex(union)) {
          pieces[a] = union;
          pieces.splice(b, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return pieces;
}

function mergeOnEdge(p, q) {
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    for (let j = 0; j < q.length; j++) {
      if (q[j] === b && q[(j + 1) % q.length] === a) {
        const out = [];
        for (let k = 0; k < p.length; k++) out.push(p[(i + 1 + k) % p.length]);
        for (let k = 0; k < q.length - 2; k++) out.push(q[(j + 2 + k) % q.length]);
        return out;
      }
    }
  }
  return null;
}

/**
 * The four corners of each segment of a thick polyline, mitred so neighbours share
 * an edge. The ends taper to a point over `taper` pixels, so a ball running along
 * a surface rides up onto the line instead of hitting a blunt end.
 */
export function thickQuads(input, thickness, taper = 16) {
  // Give each end its own short tapered segment.
  const points = [input[0]];
  for (let i = 1; i < input.length; i++) {
    const a = input[i - 1], b = input[i];
    const length = dist(a, b);
    if (i === 1 && length > taper * 1.5) points.push([a[0] + ((b[0] - a[0]) * taper) / length, a[1] + ((b[1] - a[1]) * taper) / length]);
    if (i === input.length - 1 && length > taper * 1.5) points.push([b[0] + ((a[0] - b[0]) * taper) / length, b[1] + ((a[1] - b[1]) * taper) / length]);
    points.push(b);
  }
  const n = points.length;
  const along = [0];
  for (let i = 1; i < n; i++) along[i] = along[i - 1] + dist(points[i - 1], points[i]);
  const total = along[n - 1];
  const halves = along.map((d) => (thickness / 2) * Math.max(0.1, Math.min(1, Math.min(d, total - d) / taper)));

  const normals = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = points[i + 1][0] - points[i][0], dy = points[i + 1][1] - points[i][1];
    const length = Math.hypot(dx, dy) || 1;
    normals.push([-dy / length, dx / length]);
  }
  const offsets = points.map((_, i) => {
    const a = normals[Math.max(0, i - 1)], b = normals[Math.min(n - 2, i)];
    let mx = a[0] + b[0], my = a[1] + b[1];
    const m = Math.hypot(mx, my) || 1;
    mx /= m; my /= m;
    const c = Math.max(0.5, mx * b[0] + my * b[1]);
    return [(mx * halves[i]) / c, (my * halves[i]) / c];
  });
  const quads = [];
  for (let i = 0; i < n - 1; i++) {
    const [ax, ay] = points[i], [bx, by] = points[i + 1];
    let quad = [
      [ax + offsets[i][0], ay + offsets[i][1]],
      [bx + offsets[i + 1][0], by + offsets[i + 1][1]],
      [bx - offsets[i + 1][0], by - offsets[i + 1][1]],
      [ax - offsets[i][0], ay - offsets[i][1]],
    ];
    if (!isConvex(quad)) {
      // A sharp bend on a short segment: fall back to a plain box.
      const [nx, ny] = normals[i];
      const ha = halves[i], hb = halves[i + 1];
      quad = [[ax + nx * ha, ay + ny * ha], [bx + nx * hb, by + ny * hb], [bx - nx * hb, by - ny * hb], [ax - nx * ha, ay - ny * ha]];
    }
    quads.push(quad);
  }
  return quads;
}

export function centroid(points) {
  const area = signedArea(points);
  if (Math.abs(area) < 1e-6) {
    const n = points.length;
    return [points.reduce((s, p) => s + p[0], 0) / n, points.reduce((s, p) => s + p[1], 0) / n];
  }
  let cx = 0, cy = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    const f = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  return [cx / (6 * area), cy / (6 * area)];
}
