// Cage shapes and geometry. A cage is a closed polygon of vertices in order
// (clockwise on screen) whose edges are cubic Beziers: edge i runs from vertex
// i to vertex i+1 with control points ctrl[i] = [c1, c2]. A straight edge has
// its control points at the 1/3 and 2/3 marks.

export type Pt = [number, number];
export type Ctrl = [Pt, Pt];
export type Box = { x: number; y: number; width: number; height: number };

/** Default points per curved edge when the cage is flattened for the warp methods. */
export const CURVE_SAMPLES = 16;

export const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const copyCage = (c: Pt[]) => c.map((p) => [...p] as Pt);
export const copyCtrl = (k: Ctrl[]) => k.map(([a, b]) => [[...a], [...b]] as Ctrl);
export const straightEdge = (a: Pt, b: Pt): Ctrl => [lerp(a, b, 1 / 3), lerp(a, b, 2 / 3)];
export const straightCtrl = (c: Pt[]): Ctrl[] => c.map((a, i) => straightEdge(a, c[(i + 1) % c.length]));

const grow = (b: Box, m: number): Box => ({ x: b.x - m, y: b.y - m, width: b.width + 2 * m, height: b.height + 2 * m });

/** Four corners around `b`, `m` outside it. */
export function quadCage(b: Box, m: number): Pt[] {
  const { x, y, width: w, height: h } = grow(b, m);
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}

/**
 * The `sides`-gon circumscribing flat [x0, y0, …] points: the intersections of
 * support lines at evenly spaced angles, pushed out by `m`. Always encloses
 * every point, and hugs convex outlines closely.
 */
export function fitCage(pts: number[], m: number, sides = 16): Pt[] {
  const normals = Array.from({ length: sides }, (_, k) => {
    const a = (2 * Math.PI * k) / sides;
    return [Math.cos(a), Math.sin(a)] as Pt;
  });
  const reach = normals.map(([nx, ny]) => {
    let h = -Infinity;
    for (let i = 0; i < pts.length; i += 2) h = Math.max(h, nx * pts[i] + ny * pts[i + 1]);
    return h + m;
  });
  // Corner k is where support lines k and k+1 meet.
  const corners = normals.map(([ax, ay], k) => {
    const j = (k + 1) % sides;
    const [bx, by] = normals[j];
    const det = ax * by - ay * bx;
    return [(reach[k] * by - reach[j] * ay) / det, (ax * reach[j] - bx * reach[k]) / det] as Pt;
  });
  // Sharp outlines (a rectangle) bunch several corners around the same spot;
  // keep the outermost of each bunch, so the cage still encloses everything.
  const box = bounds(corners);
  const near = 0.03 * Math.max(box.width, box.height);
  const center: Pt = [box.x + box.width / 2, box.y + box.height / 2];
  const reachOf = (p: Pt) => Math.hypot(p[0] - center[0], p[1] - center[1]);
  const kept: Pt[] = [];
  for (const p of corners) {
    const last = kept[kept.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < near) {
      if (reachOf(p) > reachOf(last)) kept[kept.length - 1] = p;
    } else kept.push(p);
  }
  const [first, last] = [kept[0], kept[kept.length - 1]];
  if (kept.length > 3 && Math.hypot(first[0] - last[0], first[1] - last[1]) < near) {
    if (reachOf(last) > reachOf(first)) kept[0] = last;
    kept.pop();
  }
  return kept;
}

function bezier(p0: Pt, c1: Pt, c2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0], a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1]];
}

/** The point at `t` along edge i (vertex i → i+1). */
export const edgePoint = (c: Pt[], k: Ctrl[], i: number, t: number) => bezier(c[i], k[i][0], k[i][1], c[(i + 1) % c.length], t);

/** Whether edge i's control points are off the straight 1/3, 2/3 marks. */
export function isCurved(c: Pt[], k: Ctrl[], i: number) {
  const a = c[i], b = c[(i + 1) % c.length], [s1, s2] = straightEdge(a, b), [c1, c2] = k[i];
  const tol = 1e-9 * (Math.hypot(b[0] - a[0], b[1] - a[1]) + 1);
  return Math.hypot(c1[0] - s1[0], c1[1] - s1[1]) > tol || Math.hypot(c2[0] - s2[0], c2[1] - s2[1]) > tol;
}

/**
 * The cage as a flat [x0, y0, …] polygon: its vertices, plus samples along each
 * edge marked `curved`. The rest and deformed cages must be flattened with the
 * same `curved` and `samples` so the warp methods get matching polygons. Each
 * curved edge becomes `samples` straight pieces.
 */
export function flattenCage(c: Pt[], k: Ctrl[], curved: boolean[], samples = CURVE_SAMPLES): number[] {
  const out: number[] = [];
  c.forEach((p, i) => {
    out.push(...p);
    if (curved[i]) for (let s = 1; s < samples; s++) out.push(...edgePoint(c, k, i, s / samples));
  });
  return out;
}

/** Path data for the cage. */
export const cagePath = (c: Pt[], k: Ctrl[]) =>
  c.map((p, i) => `${i ? "" : `M${p}`}C${k[i][0]} ${k[i][1]} ${c[(i + 1) % c.length]}`).join("") + "Z";

/** Parameter of the point on edge i closest to `p`. */
export function nearestT(c: Pt[], k: Ctrl[], i: number, p: Pt) {
  let best = 0.5, bestD = Infinity;
  for (let s = 1; s < 200; s++) {
    const [x, y] = edgePoint(c, k, i, s / 200);
    const d = (x - p[0]) ** 2 + (y - p[1]) ** 2;
    if (d < bestD) (bestD = d), (best = s / 200);
  }
  return best;
}

/** Splits edge i at `t` (de Casteljau), keeping its shape. */
export function splitEdge(c: Pt[], k: Ctrl[], i: number, t: number): [Pt[], Ctrl[]] {
  const [c1, c2] = k[i], p0 = c[i], p3 = c[(i + 1) % c.length];
  const a = lerp(p0, c1, t), b = lerp(c1, c2, t), cc = lerp(c2, p3, t);
  const d = lerp(a, b, t), e = lerp(b, cc, t), f = lerp(d, e, t);
  return [c.toSpliced(i + 1, 0, f), k.toSpliced(i, 1, [a, d], [e, cc])];
}

/** Removes vertex i, joining its two edges into one (outer control points kept). */
export function joinAt(c: Pt[], k: Ctrl[], i: number): [Pt[], Ctrl[]] {
  const prev = (i - 1 + c.length) % c.length;
  const joined = k.with(prev, [k[prev][0], k[i][1]]);
  return [c.toSpliced(i, 1), joined.toSpliced(i, 1)];
}

/** Control points for the cubic from p0 to p3 passing through q1 at t = 1/3 and q2 at t = 2/3. */
export function fitEdge(p0: Pt, p3: Pt, q1: Pt, q2: Pt): Ctrl {
  const f = (j: 0 | 1) => {
    const a = 27 * q1[j] - 8 * p0[j] - p3[j]; // = 12 c1 + 6 c2
    const b = 27 * q2[j] - p0[j] - 8 * p3[j]; // = 6 c1 + 12 c2
    return [(2 * a - b) / 18, (2 * b - a) / 18];
  };
  const [x1, x2] = f(0), [y1, y2] = f(1);
  return [[x1, y1], [x2, y2]];
}

/** Whether `p` is inside the flat [x0, y0, …] polygon (even-odd). */
export function insidePoly([x, y]: Pt, poly: ArrayLike<number>) {
  let inside = false;
  for (let i = 0, n = poly.length / 2, j = n - 1; i < n; j = i++) {
    const xi = poly[2 * i], yi = poly[2 * i + 1], xj = poly[2 * j], yj = poly[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function bounds(c: Pt[]): Box {
  const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
