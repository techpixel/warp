// Mesh cages: a grid of points, `cols` cells across and `rows` down. The
// points around the outside are an ordinary cage (warped by the chosen
// method); the ones inside pull the artwork locally (see pull.ts).

import type { Box, Pt } from "./cage";

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
