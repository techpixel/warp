// One-click deformations. Each builds its own cage over the artwork's box,
// then moves it: `map` takes a point's position in the box, (u, v) in [0, 1]²,
// to where it should go, in the same units.
//
// A layout's cage has `cols` edges along the top and bottom and `rows` down
// each side. Guide lines link opposite points across the cage (top to bottom
// for "cols", side to side for "rows", both for "grid"). A `mesh` layout is a
// full grid instead, with movable points inside where its lines cross.

export type Layout = { cols: number; rows: number; guides: "cols" | "rows" | "grid" | "none"; mesh?: boolean };
// `bend` presets move points across along a curve that runs the other way (an
// Arc lifts points along a curve across the width), so how far they move scales
// with that other side; the rest scale the picture, each direction by its own side.
// Either way a preset looks the same on wide and tall artwork.
export type Preset = { id: string; label: string; layout: Layout; bend: boolean; map: (u: number, v: number) => [number, number] };

const { sin, PI, hypot, max } = Math;

/** Scales (u, v) about the center by `f(r)`, r = distance from center (0.707 at the corners). */
const radial = (f: (r: number) => number) => (u: number, v: number): [number, number] => {
  const s = f(hypot(u - 0.5, v - 0.5));
  return [0.5 + (u - 0.5) * s, 0.5 + (v - 0.5) * s];
};
const falloff = (r: number) => max(0, 1 - (r / Math.SQRT1_2) ** 2);
const columns = (cols: number): Layout => ({ cols, rows: 1, guides: "cols" });
const rowsOf = (rows: number): Layout => ({ cols: 1, rows, guides: "rows" });
const mesh = (cols: number, rows: number): Layout => ({ cols, rows, guides: "none", mesh: true });

export const PRESETS: Preset[] = [
  { id: "arc", label: "Arc", bend: true, layout: columns(4), map: (u, v) => [u, v - 0.28 * sin(PI * u) * (1 - 0.3 * v)] },
  { id: "fisheye", label: "Fisheye", bend: false, layout: mesh(3, 3), map: radial((r) => 1 + 0.45 * falloff(r)) },
  { id: "flag", label: "Flag", bend: true, layout: columns(4), map: (u, v) => [u, v + 0.12 * sin(2 * PI * u)] },
  { id: "bulge", label: "Bulge", bend: true, layout: rowsOf(4), map: (u, v) => [0.5 + (u - 0.5) * (1 + 0.4 * sin(PI * v)), v] },
  { id: "pinch", label: "Pinch", bend: false, layout: mesh(3, 3), map: radial((r) => 1 - 0.35 * falloff(r)) },
  { id: "wave", label: "Wave", bend: true, layout: mesh(6, 3), map: (u, v) => [u + 0.04 * sin(2 * PI * v), v + 0.08 * sin(4 * PI * u)] },
  { id: "rise", label: "Rise", bend: true, layout: columns(4), map: (u, v) => [u, v - 0.18 * sin(PI * (u - 0.5))] },
  { id: "squeeze", label: "Squeeze", bend: true, layout: rowsOf(4), map: (u, v) => [0.5 + (u - 0.5) * (1 - 0.35 * sin(PI * v)), v] },
  { id: "taper", label: "Taper", bend: false, layout: { cols: 1, rows: 1, guides: "none" }, map: (u, v) => [0.5 + (u - 0.5) * (0.55 + 0.45 * v), v] },
];

/** The layout's cage, its guide lines (as index pairs) and its grid size, in unit-box coordinates. */
export function layoutCage(layout: Layout): { ring: [number, number][]; guides: [number, number][] } {
  const { cols, rows, guides } = layout;
  const ring: [number, number][] = [
    ...Array.from({ length: cols }, (_, k): [number, number] => [k / cols, 0]),
    ...Array.from({ length: rows }, (_, k): [number, number] => [1, k / rows]),
    ...Array.from({ length: cols }, (_, k): [number, number] => [1 - k / cols, 1]),
    ...Array.from({ length: rows }, (_, k): [number, number] => [0, 1 - k / rows]),
  ];
  // Index of the point at column c on the top/bottom, row r on the right/left.
  const top = (c: number) => c, bottom = (c: number) => cols + rows + (cols - c);
  const right = (r: number) => cols + r, left = (r: number) => (2 * cols + rows + (rows - r)) % ring.length;
  const colPairs = Array.from({ length: cols - 1 }, (_, k): [number, number] => [top(k + 1), bottom(k + 1)]);
  const rowPairs = Array.from({ length: rows - 1 }, (_, k): [number, number] => [left(k + 1), right(k + 1)]);
  const pairs = guides === "cols" ? colPairs : guides === "rows" ? rowPairs : guides === "grid" ? [...colPairs, ...rowPairs] : [];
  return { ring, guides: pairs };
}

const ASPECT = 1.6; // thumbnail box width : height

/** viewBox for a preset thumbnail, with room for the deformation to overshoot. */
export const THUMB_VIEWBOX = `${-0.35 * ASPECT} -0.4 ${1.7 * ASPECT} 1.8`;

/** The preset's cage outline and guide lines (or mesh lines), deformed, as polyline `points` strings. */
export function thumbnailLines(p: Preset): string[] {
  const steps = Array.from({ length: 13 }, (_, k) => k / 12);
  const line = (a: [number, number], b: [number, number]) =>
    steps.map((t) => p.map(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)).map(([x, y]) => `${x * ASPECT},${y}`).join(" ");
  const { ring, guides } = layoutCage(p.layout);
  const outline = ring.map((a, i) => line(a, ring[(i + 1) % ring.length]));
  const { cols, rows } = p.layout;
  const inner = p.layout.mesh
    ? [
        ...Array.from({ length: cols - 1 }, (_, k) => line([(k + 1) / cols, 0], [(k + 1) / cols, 1])),
        ...Array.from({ length: rows - 1 }, (_, k) => line([0, (k + 1) / rows], [1, (k + 1) / rows])),
      ]
    : guides.map(([a, b]) => line(ring[a], ring[b]));
  return [...outline, ...inner];
}
