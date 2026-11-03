// Images are warped as a textured triangle mesh. Only needs the forward map
// (rest → deformed), so any warp method works.

type Pt = [number, number];
export type Region = { x: number; y: number; w: number; h: number };
export type Texture = { image: CanvasImageSource; region: Region; width: number; height: number };

/** Warps every grid vertex of the texture's region; returns an (n+1)×(n+1) grid in SVG units. */
export function warpGrid(tex: Texture, n: number, deform: (p: Pt) => Pt): Pt[][] {
  const { x, y, w, h } = tex.region;
  const grid: Pt[][] = [];
  for (let r = 0; r <= n; r++) {
    const row: Pt[] = [];
    for (let c = 0; c <= n; c++) row.push(deform([x + (w * c) / n, y + (h * r) / n]));
    grid.push(row);
  }
  return grid;
}

/**
 * Draws the warped mesh. `toPx` maps SVG units to the context's pixel space.
 * Each cell is two affine-textured triangles, nudged outward slightly to hide seams.
 */
export function drawMesh(ctx: CanvasRenderingContext2D, tex: Texture, grid: Pt[][], toPx: (p: Pt) => Pt) {
  const n = grid.length - 1;
  const px = grid.map((row) => row.map(toPx));
  const sx = tex.width / n, sy = tex.height / n;

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const s00: Pt = [c * sx, r * sy], s10: Pt = [(c + 1) * sx, r * sy];
      const s01: Pt = [c * sx, (r + 1) * sy], s11: Pt = [(c + 1) * sx, (r + 1) * sy];
      const d00 = px[r][c], d10 = px[r][c + 1], d01 = px[r + 1][c], d11 = px[r + 1][c + 1];
      triangle(ctx, tex.image, [s00, s10, s11], [d00, d10, d11]);
      triangle(ctx, tex.image, [s00, s11, s01], [d00, d11, d01]);
    }
  }
}

function triangle(ctx: CanvasRenderingContext2D, img: CanvasImageSource, s: Pt[], d: Pt[]) {
  if (d.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return;

  // Affine map from source triangle to destination triangle.
  const [[x0, y0], [x1, y1], [x2, y2]] = s;
  const [[u0, v0], [u1, v1], [u2, v2]] = d;
  const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(det) < 1e-12) return;
  const a = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / det;
  const b = ((v1 - v0) * (y2 - y0) - (v2 - v0) * (y1 - y0)) / det;
  const c = ((u2 - u0) * (x1 - x0) - (u1 - u0) * (x2 - x0)) / det;
  const dd = ((v2 - v0) * (x1 - x0) - (v1 - v0) * (x2 - x0)) / det;
  const e = u0 - a * x0 - c * y0;
  const f = v0 - b * x0 - dd * y0;

  // Clip to the destination triangle with every edge pushed out ~1px, so
  // antialiased edges of neighbouring triangles overlap instead of leaving seams.
  ctx.save();
  ctx.beginPath();
  grow(d, 1).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, dd, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

/** Offsets each edge of triangle `t` outward by `by` and returns the new corners. */
function grow(t: Pt[], by: number): Pt[] {
  // Outward direction depends on winding.
  const [[x0, y0], [x1, y1], [x2, y2]] = t;
  const sign = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0) > 0 ? 1 : -1;
  // Each edge as a line: point + direction, shifted along its normal.
  const lines = t.map(([ax, ay], i) => {
    const [bx, by2] = t[(i + 1) % 3];
    const dx = bx - ax, dy = by2 - ay;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (sign * dy) / len, ny = (-sign * dx) / len;
    return { px: ax + nx * by, py: ay + ny * by, dx, dy };
  });
  // Corner i is where edge (i-1) meets edge i.
  return t.map((p, i) => {
    const a = lines[(i + 2) % 3], b = lines[i];
    const den = a.dx * b.dy - a.dy * b.dx;
    if (Math.abs(den) < 1e-9) return p;
    const k = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / den;
    const q: Pt = [a.px + a.dx * k, a.py + a.dy * k];
    // Very sharp corners can spike far out; cap the miter.
    return Math.hypot(q[0] - p[0], q[1] - p[1]) > by * 4 ? p : q;
  });
}

/** Bounds of a warped grid, ignoring non-finite points. */
export function gridBounds(grid: Pt[][]): Region | null {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const row of grid) for (const [x, y] of row) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    x1 = Math.min(x1, x); y1 = Math.min(y1, y);
    x2 = Math.max(x2, x); y2 = Math.max(y2, y);
  }
  return Number.isFinite(x1) ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
}

/** Pixel bounds of everything not fully transparent in `img` (exclusive max), or null if empty. */
export function alphaBounds(img: CanvasImageSource, width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1, canvas };
}
