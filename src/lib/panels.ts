// MVC by panels: connectors split the cage into panels, and each panel is
// warped by MVC over its own outline, so every connector is a sharp fold.
// Where connectors cross, the crossing is a corner shared by the panels
// around it. With no connectors, the one panel is the cage: plain MVC.

import { edgePoint, insidePoly, lerp, type Ctrl, type Pt } from "./cage";
import { deformer as mvcDeformer, weights as mvcWeights } from "./warp/mvc";

export type PanelCage = {
  rest: Pt[];
  restCtrl: Ctrl[];
  moved: Pt[];
  movedCtrl: Ctrl[];
  /** Which edges are curved (in either cage); others are sampled as straight. */
  curved: boolean[];
  guides: [number, number][];
  /** Points per curved edge, for panels warped by MVC. */
  samples: number;
};

/** A side of a panel, from one corner to the next: along cage edge `edge` (forwards or not), or straight. */
type Side = { edge: number; forward: boolean } | null;

type Panel = {
  /** The outline on the rest cage, flat, for finding which panel a point is in. */
  outline: Float64Array;
  map: (p: Pt) => Pt;
};

/** Maps points of the rest cage through the panels, or null for a point in none of them (outside the cage). */
export function panelWarp(cage: PanelCage): (p: Pt) => Pt | null {
  const panels = buildPanels(cage);
  return (p) => {
    const panel = panels.find((q) => insidePoly(p, q.outline));
    return panel ? panel.map(p) : null;
  };
}

function buildPanels({ rest, restCtrl, moved, movedCtrl, curved, guides, samples }: PanelCage): Panel[] {
  const n = rest.length;
  if (n < 3) return [];
  // Corners: the cage's points, then where connectors cross.
  const R: Pt[] = [...rest], M: Pt[] = [...moved];
  const adjacent = (a: number, b: number) => (a - b + n) % n === 1 || (b - a + n) % n === 1;
  const cuts = guides.filter(([a, b]) => a !== b && a < n && b < n && !adjacent(a, b));
  const along: { t: number; node: number }[][] = cuts.map(() => []);
  for (let i = 0; i < cuts.length; i++) {
    for (let j = i + 1; j < cuts.length; j++) {
      const [a, b] = cuts[i], [c, d] = cuts[j];
      if (a === c || a === d || b === c || b === d) continue;
      const hit = crossing(rest[a], rest[b], rest[c], rest[d]);
      if (!hit) continue;
      const node = R.length;
      R.push(lerp(rest[a], rest[b], hit.t));
      M.push(movedCrossing(moved[a], moved[b], moved[c], moved[d], hit.t, hit.u));
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
      panels.push(mvcPanel(face, sides));
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
      map: (p) => {
        const w = mvcWeights(p[0], p[1], restFlat);
        apply(w, out);
        return Number.isFinite(out[0]) && Number.isFinite(out[1]) ? [out[0], out[1]] : p;
      },
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
