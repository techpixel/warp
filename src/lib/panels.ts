// MVC by panels: connectors split the cage into panels, and each panel is
// warped on its own, so every connector is a sharp fold. Connectors run between
// cage points and center points (the nodes), and each center point is a corner
// shared by the panels around it, wherever it's been pulled. Where connectors
// cross with no center point there, the crossing is a corner too. With no
// connectors, the one panel is the cage.
//
// A panel with four corners (four sharp turns in its outline; any other points
// lie along its sides) is warped as a Coons patch: it blends straight across
// between opposite sides, so a bend along the top and bottom runs all the way
// through, where MVC would flatten out towards the middle. Any other panel is
// warped by MVC over its outline.

import { edgePoint, insidePoly, lerp, solveFor, type Ctrl, type Pt, type SplitWarp } from "./cage";
import { deformer as mvcDeformer, weights as mvcWeights } from "./warp/mvc";

export type PanelCage = {
  rest: Pt[];
  restCtrl: Ctrl[];
  moved: Pt[];
  movedCtrl: Ctrl[];
  /** Which edges are curved (in either cage); others are sampled as straight. */
  curved: boolean[];
  /** Points per curved edge, for panels warped by MVC. */
  samples: number;
  links: Links;
};

/**
 * The connectors, as straight segments between nodes: node i is cage point i,
 * and node n + k (n cage points) is center point k, at `rest[k]` on the rest
 * cage and `moved[k]` on the moved one.
 */
export type Links = { rest: Pt[]; moved: Pt[]; segments: [number, number][] };

/** How sharply a panel's outline must turn at a point (radians) for it to be a corner. */
const CORNER_TURN = Math.PI / 6;

/** A side of a panel, from one corner to the next: along cage edge `edge` (forwards or not), or straight. */
type Side = { edge: number; forward: boolean } | null;

/**
 * Where a rest point sits in its panel: its patch (u, v), or else its MVC
 * weights over the panel's outline. `at` is the point itself.
 */
type Spot = { at: Pt; uv?: Pt; w?: Float64Array };
export type PanelSpot = Spot & { panel: number };

type Panel = {
  /** The outline on the rest cage, flat, for finding which panel a point is in. */
  outline: Float64Array;
  locate: (p: Pt) => Spot;
  place: (spot: Spot) => Pt;
};

/** Maps points of the rest cage through the panels; a point in none of them (outside the cage) isn't located. */
export function panelWarp(cage: PanelCage): SplitWarp<PanelSpot> {
  const panels = buildPanels(cage);
  return {
    locate: (p) => {
      const panel = panels.findIndex((q) => insidePoly(p, q.outline));
      return panel < 0 ? null : { ...panels[panel].locate(p), panel };
    },
    place: (spot) => panels[spot.panel].place(spot),
  };
}

function buildPanels({ rest, restCtrl, moved, movedCtrl, curved, samples, links: graph }: PanelCage): Panel[] {
  const n = rest.length;
  if (n < 3) return [];
  // Corners: the cage's points, the center points, then where connectors cross.
  const R: Pt[] = [...rest, ...graph.rest], M: Pt[] = [...moved, ...graph.moved];
  const nodes = R.length;
  const adjacent = (a: number, b: number) => a < n && b < n && ((a - b + n) % n === 1 || (b - a + n) % n === 1);
  const cuts = graph.segments.filter(([a, b]) => a !== b && a < nodes && b < nodes && !adjacent(a, b));
  const along: { t: number; node: number }[][] = cuts.map(() => []);
  for (let i = 0; i < cuts.length; i++) {
    for (let j = i + 1; j < cuts.length; j++) {
      const [a, b] = cuts[i], [c, d] = cuts[j];
      if (a === c || a === d || b === c || b === d) continue;
      const hit = crossing(R[a], R[b], R[c], R[d]);
      if (!hit) continue;
      const node = R.length;
      R.push(lerp(R[a], R[b], hit.t));
      M.push(movedCrossing(M[a], M[b], M[c], M[d], hit.t, hit.u));
      along[i].push({ t: hit.t, node });
      along[j].push({ t: hit.u, node });
    }
  }

  // The graph: cage edges (side records which edge), and each connector broken at its crossings.
  const links = new Map<number, Map<number, Side>>();
  const join = (u: number, v: number, side: Side, back: Side) => {
    if (u === v) return;
    if (!links.has(u)) links.set(u, new Map());
    if (!links.has(v)) links.set(v, new Map());
    links.get(u)!.set(v, side);
    links.get(v)!.set(u, back);
  };
  for (let i = 0; i < n; i++) join(i, (i + 1) % n, { edge: i, forward: true }, { edge: i, forward: false });
  cuts.forEach(([a, b], i) => {
    const chain = [a, ...along[i].sort((p, q) => p.t - q.t).map((x) => x.node), b];
    for (let k = 1; k < chain.length; k++) join(chain[k - 1], chain[k], null, null);
  });

  // Faces: walk each directed link, turning as tightly as possible at every corner.
  const angle = (u: number, v: number) => Math.atan2(R[v][1] - R[u][1], R[v][0] - R[u][0]);
  const around = new Map<number, number[]>();
  for (const [u, nbrs] of links) around.set(u, [...nbrs.keys()].sort((p, q) => angle(u, p) - angle(u, q)));
  const seen = new Set<string>();
  const panels: Panel[] = [];
  for (const [u0, nbrs] of links) {
    for (const v0 of nbrs.keys()) {
      if (seen.has(`${u0},${v0}`)) continue;
      const face: number[] = [];
      let u = u0, v = v0;
      for (let guard = 0; guard < R.length * 4 && !seen.has(`${u},${v}`); guard++) {
        seen.add(`${u},${v}`);
        face.push(u);
        // At v, the next link is the one just before the way back to u, going around v.
        const ring = around.get(v)!, k = ring.indexOf(u);
        const w = ring[(k - 1 + ring.length) % ring.length];
        (u = v), (v = w);
      }
      // This walk goes round every panel the same way, and round the outside of
      // the cage the other way (whichever way the cage's own points run).
      if (face.length < 3 || signedArea(face.map((i) => R[i])) <= 0) continue;
      const sides = face.map((u, k) => links.get(u)!.get(face[(k + 1) % face.length]) ?? null);
      panels.push(coonsPanel(face, sides) ?? mvcPanel(face, sides));
    }
  }
  return panels;

  /** Point `t` along side k of a panel (from face[k] to the next corner) in the rest or moved cage. */
  function sidePoint(face: number[], sides: Side[], k: number, t: number, inMoved: boolean): Pt {
    const side = sides[k], c = inMoved ? moved : rest, ctrl = inMoved ? movedCtrl : restCtrl;
    if (side) return edgePoint(c, ctrl, side.edge, side.forward ? t : 1 - t);
    const P = inMoved ? M : R;
    return lerp(P[face[k]], P[face[(k + 1) % face.length]], t);
  }

  function mvcPanel(face: number[], sides: Side[]): Panel {
    const restFlat = outlineOf(face, sides, false), movedFlat = outlineOf(face, sides, true);
    const apply = mvcDeformer(restFlat, movedFlat);
    const out = new Float64Array(2);
    return {
      outline: restFlat,
      locate: (p) => ({ at: p, w: mvcWeights(p[0], p[1], restFlat) }),
      place: ({ at, w }) => {
        apply(w!, out);
        return Number.isFinite(out[0]) && Number.isFinite(out[1]) ? [out[0], out[1]] : at;
      },
    };
  }

  /**
   * The panel as a Coons patch over its four corners, or null if it hasn't
   * exactly four. A rest point is found on the rest patch (by Newton's method)
   * and carried to the same spot on the moved one.
   */
  function coonsPanel(face: number[], sides: Side[]): Panel | null {
    const m = face.length, at = (k: number, t: number) => sidePoint(face, sides, k, t, false);
    const heading = (a: Pt, b: Pt) => Math.atan2(b[1] - a[1], b[0] - a[0]);
    const corners: number[] = [];
    for (let k = 0; k < m; k++) {
      const prev = (k - 1 + m) % m;
      let turn = Math.abs(heading(at(k, 0), at(k, 0.01)) - heading(at(prev, 0.99), at(prev, 1)));
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      if (turn > CORNER_TURN) corners.push(k);
    }
    if (corners.length !== 4) return null;

    // Patch side j runs from corner j to corner j+1 along one or more panel sides,
    // each taking a share of it by its length on the rest cage.
    const chains = corners.map((from, j) => {
      const to = corners[(j + 1) % 4], pieces: number[] = [];
      for (let k = from; k !== to; k = (k + 1) % m) pieces.push(k);
      const lengths = pieces.map((k) => {
        let len = 0;
        for (let s = 0; s < 8; s++) {
          const a = at(k, s / 8), b = at(k, (s + 1) / 8);
          len += Math.hypot(b[0] - a[0], b[1] - a[1]);
        }
        return len;
      });
      const total = lengths.reduce((a, b) => a + b, 0) || 1;
      return { pieces, shares: lengths.map((l) => l / total) };
    });
    const along = (j: number, s: number, inMoved: boolean): Pt => {
      const { pieces, shares } = chains[j];
      for (let i = 0; i < pieces.length; i++) {
        if (s <= shares[i] || i === pieces.length - 1) return sidePoint(face, sides, pieces[i], shares[i] ? Math.min(1, s / shares[i]) : 0, inMoved);
        s -= shares[i];
      }
      return sidePoint(face, sides, pieces[0], 0, inMoved);
    };
    // Sides 0 and 2 run across (u), 1 and 3 down (v); 2 and 3 run backwards.
    const patch = (inMoved: boolean) => {
      const c = [0, 1, 2, 3].map((j) => along(j, 0, inMoved));
      return (u: number, v: number): Pt => {
        const a = along(0, u, inMoved), b = along(1, v, inMoved), cc = along(2, 1 - u, inMoved), d = along(3, 1 - v, inMoved);
        const blend = (i: 0 | 1) =>
          (1 - v) * a[i] + v * cc[i] + (1 - u) * d[i] + u * b[i] -
          ((1 - u) * (1 - v) * c[0][i] + u * (1 - v) * c[1][i] + u * v * c[2][i] + (1 - u) * v * c[3][i]);
        return [blend(0), blend(1)];
      };
    };
    const rest = patch(false), moved = patch(true);
    const restCorners = corners.map((k) => at(k, 0));
    const size = Math.max(...restCorners.flatMap((p) => restCorners.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1]))));
    const fallback = mvcPanel(face, sides);
    return {
      outline: fallback.outline,
      locate: (p) => {
        // Where the patch folds over itself, Newton's method can settle outside it; MVC takes those.
        const uv = solveFor(rest, p, [0.5, 0.5], 1e-7 * size);
        const within = (x: number) => x >= -0.02 && x <= 1.02;
        return uv && within(uv[0]) && within(uv[1]) ? { at: p, uv } : fallback.locate(p);
      },
      place: (spot) => (spot.uv ? moved(...spot.uv) : fallback.place(spot)),
    };
  }

  /** The panel's outline, flat, with curved cage edges broken into `samples` pieces. */
  function outlineOf(face: number[], sides: Side[], inMoved: boolean): Float64Array {
    const out: number[] = [];
    face.forEach((_, k) => {
      const side = sides[k], steps = side && curved[side.edge] ? samples : 1;
      for (let s = 0; s < steps; s++) out.push(...sidePoint(face, sides, k, s / steps, inMoved));
    });
    return Float64Array.from(out);
  }
}

/** Where segments a–b and c–d cross strictly inside both, as parameters along each, or null. */
function crossing(a: Pt, b: Pt, c: Pt, d: Pt): { t: number; u: number } | null {
  const r: Pt = [b[0] - a[0], b[1] - a[1]], s: Pt = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  const inside = (x: number) => x > 1e-6 && x < 1 - 1e-6;
  return inside(t) && inside(u) ? { t, u } : null;
}

/**
 * Where two deformed connectors cross: where they actually do, or, once
 * they've been dragged apart, midway between where each carries the crossing.
 */
function movedCrossing(a: Pt, b: Pt, c: Pt, d: Pt, t: number, u: number): Pt {
  const hit = crossing(a, b, c, d);
  if (hit) return lerp(a, b, hit.t);
  const p = lerp(a, b, t), q = lerp(c, d, u);
  return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
}

function signedArea(pts: Pt[]) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
}
