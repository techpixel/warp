// Inner points' pulls, spread over the cage: a thin-plate spline that takes
// each inner point's pull at that point and is held at zero along the cage,
// so the pulls fade out smoothly toward the edges.

import type { Pt } from "./cage";

const EDGE_SAMPLES = 96; // points along the cage held at zero
const REGULARIZATION = 1e-7; // in the cage-size units the system is solved in

/** φ(r) = r² log r, the thin-plate kernel (written in r² to skip a square root). */
const kernel = (r2: number) => (r2 > 0 ? 0.5 * r2 * Math.log(r2) : 0);

/**
 * The pull at any point, from `pulls` at `centers` and zero along the flat
 * [x0, y0, …] cage outline. Null if there's nothing to pull or it can't be solved.
 */
export function pullField(centers: Pt[], pulls: Pt[], cage: Float64Array): ((p: Pt) => Pt) | null {
  if (!centers.length || pulls.every(([x, y]) => !x && !y)) return null;
  const edge = outlineSamples(cage, EDGE_SAMPLES);
  const nodes = [...centers, ...edge];
  const values = [...pulls, ...edge.map((): Pt => [0, 0])];

  // Work in units of the cage's size, so the system is well conditioned.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of nodes) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
  const size = Math.max(x1 - x0, y1 - y0) || 1;
  const norm = ([x, y]: Pt): Pt => [(x - x0) / size, (y - y0) / size];
  const pts = nodes.map(norm);

  // [K P; Pᵀ 0] [w; a] = [v; 0], with P = [1 x y].
  const n = pts.length, m = n + 3;
  const A = Array.from({ length: m }, () => new Float64Array(m));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) A[i][j] = kernel((pts[i][0] - pts[j][0]) ** 2 + (pts[i][1] - pts[j][1]) ** 2);
    // A touch of smoothing: closely spaced points along a straight edge leave the exact system near singular.
    A[i][i] += REGULARIZATION;
    const row = [1, pts[i][0], pts[i][1]];
    for (let k = 0; k < 3; k++) (A[i][n + k] = row[k]), (A[n + k][i] = row[k]);
  }
  const rhs = Array.from({ length: m }, (_, i): Pt => (i < n ? [values[i][0], values[i][1]] : [0, 0]));
  const sol = solve(A, rhs);
  if (!sol) return null;

  return (p) => {
    const [x, y] = norm(p);
    let fx = sol[n][0] + sol[n + 1][0] * x + sol[n + 2][0] * y;
    let fy = sol[n][1] + sol[n + 1][1] * x + sol[n + 2][1] * y;
    for (let i = 0; i < n; i++) {
      const k = kernel((x - pts[i][0]) ** 2 + (y - pts[i][1]) ** 2);
      fx += sol[i][0] * k;
      fy += sol[i][1] * k;
    }
    return Number.isFinite(fx) && Number.isFinite(fy) ? [fx, fy] : [0, 0];
  };
}

/**
 * About `count` points spaced evenly around the flat [x0, y0, …] outline, plus
 * the corners between long segments. Spaced along the edges, not just at their ends: a straight edge
 * is only its two ends, and holding the field at those alone lets it push
 * artwork out through the edge's middle.
 */
function outlineSamples(cage: Float64Array, count: number): Pt[] {
  const n = cage.length / 2;
  const at = (i: number): Pt => [cage[2 * (i % n)], cage[2 * (i % n) + 1]];
  let perimeter = 0;
  for (let i = 0; i < n; i++) perimeter += Math.hypot(at(i + 1)[0] - at(i)[0], at(i + 1)[1] - at(i)[1]);
  const spacing = perimeter / count || 1;
  const out: Pt[] = [];
  // `next` is how far along the outline the next sample falls, measured from segment i's start.
  let next = 0;
  for (let i = 0; i < n; i++) {
    const a = at(i), b = at(i + 1), len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // A corner between long segments is sampled too, so the field is held right at it.
    if (next > 0.25 * spacing && len >= spacing) next = 0;
    for (; next < len; next += spacing) out.push([a[0] + ((b[0] - a[0]) * next) / len, a[1] + ((b[1] - a[1]) * next) / len]);
    next -= len;
  }
  return out;
}

/** Gaussian elimination with partial pivoting, for two right-hand sides at once. Consumes its inputs. */
function solve(A: Float64Array[], b: Pt[]): Pt[] | null {
  const m = A.length;
  for (let c = 0; c < m; c++) {
    let piv = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = c + 1; r < m; r++) {
      const f = A[r][c] / A[c][c];
      if (!f) continue;
      for (let k = c; k < m; k++) A[r][k] -= f * A[c][k];
      b[r] = [b[r][0] - f * b[c][0], b[r][1] - f * b[c][1]];
    }
  }
  const x: Pt[] = Array.from({ length: m }, (): Pt => [0, 0]);
  for (let r = m - 1; r >= 0; r--) {
    let sx = b[r][0], sy = b[r][1];
    for (let k = r + 1; k < m; k++) (sx -= A[r][k] * x[k][0]), (sy -= A[r][k] * x[k][1]);
    x[r] = [sx / A[r][r], sy / A[r][r]];
  }
  return x;
}
