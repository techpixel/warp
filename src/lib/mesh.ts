// Mesh cages: a grid of points, `cols` cells across and `rows` down. The
// points around the outside are an ordinary cage (warped by the chosen
// method); the ones inside pull the artwork locally (see pull.ts). With MVC,
// the whole grid is one smooth surface instead (meshWarp).

import { edgePoint, insidePoly, lerp, solveFor, type Box, type Ctrl, type Pt, type SplitWarp } from "./cage";

export type Dims = { cols: number; rows: number };

/** The plain Mesh cage: 3×3 cells, so 4×4 points. */
export const MESH: Dims = { cols: 3, rows: 3 };

/**
 * Grid [row, col] of each outer point, in cage order: clockwise from the
 * top-left, `cols` along the top, `rows` down the right, and so on.
 */
function ringRC({ cols, rows }: Dims): [number, number][] {
  return [
    ...Array.from({ length: cols }, (_, k): [number, number] => [0, k]),
    ...Array.from({ length: rows }, (_, k): [number, number] => [k, cols]),
    ...Array.from({ length: cols }, (_, k): [number, number] => [rows, cols - k]),
    ...Array.from({ length: rows }, (_, k): [number, number] => [rows - k, 0]),
  ];
}

/** Grid [row, col] of each inner point, row by row. */
export function innerRC({ cols, rows }: Dims): [number, number][] {
  return Array.from({ length: (rows - 1) * (cols - 1) }, (_, k): [number, number] => [1 + Math.floor(k / (cols - 1)), 1 + (k % (cols - 1))]);
}

/** The inner points of an evenly spaced grid over `b`, `m` outside it. */
export function meshInner(b: Box, m: number, dims: Dims): Pt[] {
  const x = b.x - m, y = b.y - m, w = b.width + 2 * m, h = b.height + 2 * m;
  return innerRC(dims).map(([r, c]) => [x + (w * c) / dims.cols, y + (h * r) / dims.rows]);
}

/** The grid of points from the outer ring and inner points. */
export function gridNodes(ring: Pt[], inner: Pt[], dims: Dims): Pt[][] {
  const g: Pt[][] = Array.from({ length: dims.rows + 1 }, () => Array<Pt>(dims.cols + 1));
  ringRC(dims).forEach(([r, c], i) => (g[r][c] = ring[i]));
  innerRC(dims).forEach(([r, c], i) => (g[r][c] = inner[i]));
  return g;
}

/** The grid's inner rows and columns, as polyline points. */
export function meshLines(grid: Pt[][]): string[] {
  const rows = grid.slice(1, -1);
  const cols = grid[0].slice(1, -1).map((_, k) => grid.map((row) => row[k + 1]));
  return [...rows, ...cols].map((pts) => pts.join(" "));
}

type MeshCage = { ring: Pt[]; ctrl: Ctrl[]; inner: Pt[] };

/** The rest side of a mesh cage's warp (see meshWarp), built once while the rest cage stands. */
export type MeshRest = { dims: Dims; locate: (p: Pt) => Pt | null };

/** How finely each cell's outline is traced along the rest surface, per side. */
const OUTLINE_STEPS = 8;

/**
 * Finds rest points on the smooth surface through a mesh cage's rest grid: a
 * point is found from the middle of the cell it's in. The cells' outlines are
 * traced along the surface, so a curved outer edge's bulge is in its cell.
 * Null outside the grid, or where the surface folds and the point is found
 * outside its own cell.
 */
export function meshRest(dims: Dims, rest: MeshCage): MeshRest {
  const restAt = surface(dims, rest);
  const trace = (from: Pt, to: Pt) =>
    Array.from({ length: OUTLINE_STEPS }, (_, k) => restAt(from[0] + ((to[0] - from[0]) * k) / OUTLINE_STEPS, from[1] + ((to[1] - from[1]) * k) / OUTLINE_STEPS)).flat();
  const cells = Array.from({ length: dims.rows * dims.cols }, (_, k) => {
    const r = Math.floor(k / dims.cols), c = k % dims.cols;
    const corners: Pt[] = [[c, r], [c + 1, r], [c + 1, r + 1], [c, r + 1]];
    return { r, c, outline: corners.flatMap((a, j) => trace(a, corners[(j + 1) % 4])) };
  });
  const xs = rest.ring.map((p) => p[0]), ys = rest.ring.map((p) => p[1]);
  const tol = 1e-7 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const slack = 0.02;
  return {
    dims,
    locate: (p) => {
      const cell = cells.find((c) => insidePoly(p, c.outline));
      const st = cell && solveFor(restAt, p, [cell.c + 0.5, cell.r + 0.5], tol);
      if (!st) return null;
      const within = (x: number, lo: number) => x >= lo - slack && x <= lo + 1 + slack;
      return within(st[0], cell.c) && within(st[1], cell.r) ? st : null;
    },
  };
}

/**
 * A mesh cage's warp as one smooth surface through its whole grid: a
 * Catmull-Rom surface through the points, bent across the outer cells so it
 * runs along the cage's (maybe curved) edges exactly. A rest point is found on
 * the rest surface (meshRest) and carried to the same spot on the moved one.
 */
export function meshWarp(rest: MeshRest, moved: MeshCage): SplitWarp<Pt> {
  const movedAt = surface(rest.dims, moved);
  return { locate: rest.locate, place: (st) => movedAt(...st) };
}

/** Samples per cell along each side, for the surface's side corrections. */
const SIDE_STEPS = 32;

/** The point at grid position (s, t) (s across, t down, in cells) on the surface through `cage`. */
function surface(dims: Dims, { ring, ctrl, inner }: MeshCage): (s: number, t: number) => Pt {
  const { cols, rows } = dims;
  const g = gridNodes(ring, inner, dims);
  // Beyond the grid, each row and column carries straight on.
  const at = (r: number, c: number): Pt => {
    const ext = (a: Pt, b: Pt): Pt => [2 * a[0] - b[0], 2 * a[1] - b[1]];
    if (r < 0) return ext(at(0, c), at(1, c));
    if (r > rows) return ext(at(rows, c), at(rows - 1, c));
    if (c < 0) return ext(at(r, 0), at(r, 1));
    if (c > cols) return ext(at(r, cols), at(r, cols - 1));
    return g[r][c];
  };
  const spline = (p0: Pt, p1: Pt, p2: Pt, p3: Pt, f: number): Pt => {
    const one = (i: 0 | 1) =>
      0.5 * (2 * p1[i] + (p2[i] - p0[i]) * f + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * f * f + (3 * p1[i] - p0[i] - 3 * p2[i] + p3[i]) * f * f * f);
    return [one(0), one(1)];
  };
  const cell = (x: number, n: number) => Math.max(0, Math.min(n - 1, Math.floor(x)));
  const grid = (s: number, t: number): Pt => {
    const c = cell(s, cols), r = cell(t, rows);
    const across = [-1, 0, 1, 2].map((dr) => spline(at(r + dr, c - 1), at(r + dr, c), at(r + dr, c + 1), at(r + dr, c + 2), s - c));
    return spline(across[0], across[1], across[2], across[3], t - r);
  };

  // The cage edge along each side's cell k, and which way it runs.
  type Run = { i: number; forward: boolean };
  const sides: Record<"top" | "bottom" | "left" | "right", Run[]> = { top: [], bottom: [], left: [], right: [] };
  const rc = ringRC(dims);
  rc.forEach(([r0, c0], i) => {
    const [r1, c1] = rc[(i + 1) % rc.length];
    if (r0 === r1) (r0 === 0 ? sides.top : sides.bottom)[Math.min(c0, c1)] = { i, forward: c1 > c0 };
    else (c0 === 0 ? sides.left : sides.right)[Math.min(r0, r1)] = { i, forward: r1 > r0 };
  });
  const edge = (side: keyof typeof sides, x: number, n: number): Pt => {
    const k = cell(x, n), { i, forward } = sides[side][k];
    return edgePoint(ring, ctrl, i, forward ? x - k : 1 - (x - k));
  };
  // How far a side's correction reaches in: all of it at the side, none from one cell in.
  const fade = (d: number) => (d >= 1 ? 0 : 1 - 3 * d * d + 2 * d * d * d);
  const gap = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
  // A side's correction depends on s or t alone, so it's tabulated (when first
  // needed) and read off between samples, rather than worked out for every point.
  const table = (n: number, f: (x: number) => Pt) => {
    let pts: Pt[] | null = null;
    return (x: number): Pt => {
      pts ??= Array.from({ length: n * SIDE_STEPS + 1 }, (_, k) => f(k / SIDE_STEPS));
      const y = Math.max(0, Math.min(n * SIDE_STEPS, x * SIDE_STEPS)), k = Math.min(n * SIDE_STEPS - 1, Math.floor(y));
      return lerp(pts[k], pts[k + 1], y - k);
    };
  };
  const top = table(cols, (s) => gap(edge("top", s, cols), grid(s, 0))), bottom = table(cols, (s) => gap(edge("bottom", s, cols), grid(s, rows)));
  const left = table(rows, (t) => gap(edge("left", t, rows), grid(0, t))), right = table(rows, (t) => gap(edge("right", t, rows), grid(cols, t)));

  return (s, t) => {
    const p = grid(s, t);
    for (const [w, side, x] of [[fade(t), top, s], [fade(rows - t), bottom, s], [fade(s), left, t], [fade(cols - s), right, t]] as const) {
      if (!w) continue;
      const d = side(x);
      (p[0] += d[0] * w), (p[1] += d[1] * w);
    }
    return p;
  };
}
