import { pathToCurve } from "svg-path-commander/util";
import { SHAPES, collectCurves, contentBBox, mapPoints, shapeToPath, subdivide, warpSvgElement } from "./warp-core.js";
import { alphaBounds, drawMesh, gridBounds, warpGrid, type Texture } from "./raster";
import {
  type Box, type Ctrl, type Pt,
  bounds, cagePath, copyCage, copyCtrl, edgePoint, fitCage, fitEdge, flattenCage, isCurved, joinAt, quadCage,
  insidePoly, splitEdge, straightCtrl, straightEdge, CURVE_SAMPLES,
} from "./cage";
import { MESH, type Dims, gridNodes, innerRC, meshInner } from "./mesh";
import { panelWarp } from "./panels";
import { pullField } from "./pull";
import { saveFile } from "./save";
import { PRESETS, layoutCage, type Layout, type Preset } from "./presets";

export const SUBDIVISIONS = 4; // pieces per cubic before warping SVG paths
export const MESH_CELLS = 32; // raster mesh cells per side
const MIN_VERTICES = 3;
const UNWARPABLE = ["text", "image", "use", "foreignObject"];

// ---------------------------------------------------------------- warp methods

// Every src/lib/warp/*.ts exporting `weights` and `deformer` is a method:
//   weights(x, y, rest, log) → Float64Array    depends only on the rest cage, so it's cached
//   deformer(rest, moved, log) → (w, out) => void    called once per frame, then per point
// Cages are flat [x0, y0, x1, y1, …] arrays.
type Log = (...values: unknown[]) => void;
type Weights = (x: number, y: number, rest: Float64Array, log: Log) => Float64Array | undefined;
type Apply = (w: Float64Array, out: Float64Array) => void;
// Options a method may read (others ignore them): `blend` is Hybrid's share of MVC.
type DeformOptions = { blend?: number };
type Deformer = (rest: Float64Array, moved: Float64Array, log: Log, options?: DeformOptions) => Apply;
// `panels` marks MVC: with connectors it warps each panel they split the cage
// into on its own (src/lib/panels.ts); its weights and deformer cover the rest.
// `color` is the method's accent (its pass, settings and menu option); `onColor` reads on it.
export type Method = { id: string; label: string; color: string; onColor: string; weights: Weights; deformer: Deformer; panels?: boolean };
const noop: Log = () => {};

// Known methods get a display name and come first, in this order.
const LABELS: Record<string, string> = { mvc: "Standard (MVC)", perspective_mvc: "Perspective", green: "Proportional (Green)", hybrid: "Hybrid" };
// Accent, and the text color that reads on it (white only where it has the contrast).
const COLORS: Record<string, [string, string]> = {
  mvc: ["#5549ff", "#fff"],
  perspective_mvc: ["#ffa449", "#000"],
  green: ["#b6ff49", "#000"],
  hybrid: ["#e149ff", "#000"],
};
const OTHER_COLOR: [string, string] = ["#5549ff", "#fff"];
const order = (id: string) => (id in LABELS ? Object.keys(LABELS).indexOf(id) : Infinity);

const modules = import.meta.glob<Record<string, unknown>>("./warp/*.ts", { eager: true });
export const methods: Method[] = Object.entries(modules)
  .flatMap(([path, mod]) => {
    const id = path.split("/").pop()!.replace(/\.ts$/, "");
    return typeof mod.weights === "function" && typeof mod.deformer === "function"
      ? [{
        id, label: LABELS[id] ?? id, color: (COLORS[id] ?? OTHER_COLOR)[0], onColor: (COLORS[id] ?? OTHER_COLOR)[1],
        weights: mod.weights as Weights, deformer: mod.deformer as Deformer, panels: id === "mvc",
      }]
      : [];
  })
  .sort((a, b) => order(a.id) - order(b.id));

export type CageType = "quad" | "mesh" | "fit" | "perspective";

// The Perspective cage only works with the Perspective method; the method works with any cage.
export const PERSPECTIVE_METHOD = "perspective_mvc";
const MIN_DEPTH = 0.2; // nearest a corner can come to the camera, as a share of the camera's distance
const MAX_TILT = 80; // degrees either way; past this the plane is edge-on and the warp degenerates
export type View = { x: number; y: number; w: number; h: number };
export type Orbit = { pitch: number; yaw: number; roll: number };
/** Where a connector dragged out of a point lands: an existing cage `vertex`, or a new point on edge `edge` at `t`. */
export type LinkTarget = { edge: number; t: number; vertex?: undefined } | { vertex: number };

// A cage comes from an SVG (a shape with id="cage", else the first shape; plus
// id="cage-deformed" if present) or JSON ({ rest, restCtrl?, moved?, movedCtrl? } or [[x, y], …]).
type CageSpec = { rest: Pt[]; restCtrl: Ctrl[]; moved?: Pt[]; movedCtrl?: Ctrl[] };

// Weights per render pass ("svg" paths, "raster" grid), indexed by call order.
// Each entry remembers its point, so a changed point is recomputed on its own.
type Pass = { method: Method; rest: Float64Array; pts: number[]; w: (Float64Array | null)[] };

// The rest cage sits this far outside the artwork (fraction of its longest
// side), so no warped point lies on the cage, where some methods are undefined.
const margin = (b: Box) => Math.max(b.width, b.height) * 0.01;

const HISTORY_LIMIT = 200; // undo steps kept

/** A (n + 1) × (n + 1) grid of points over `b`, flat. */
function boxGrid(b: Box, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) out.push(b.x + (b.width * i) / n, b.y + (b.height * j) / n);
  return out;
}
type Doc = Editor["doc"];
const sameDoc = (a: Doc, b: Doc) => (Object.keys(a) as (keyof Doc)[]).every((k) => a[k] === b[k]);

export class Editor {
  kind = $state<"svg" | "image" | null>(null);
  source = $state.raw<SVGSVGElement | null>(null); // pristine imported SVG, never mutated
  texture = $state.raw<Texture | null>(null); // imported images are warped as a textured mesh
  image = $state.raw<{ url: string; width: number; height: number } | null>(null);
  contentBox = $state.raw<Box | null>(null);
  /** The earlier passes' warp, original artwork to this pass's input, per render pass name; null for the first. */
  upstream = $state.raw<((name: string) => (p: Pt) => Pt) | null>(null);
  contentPts: number[] = []; // points sampled along the artwork, for the Freeform cage's fit
  fileName = "warped";

  restCage = $state.raw<Pt[]>([]); // around the original artwork
  restCtrl = $state.raw<Ctrl[]>([]);
  cage = $state.raw<Pt[]>([]); // where the user has dragged it
  ctrl = $state.raw<Ctrl[]>([]);
  // Points inside the cage: where they sit on the original, and how far they've
  // been dragged from where the outer cage alone would carry them. A mesh
  // cage's grid points come first (`dims` is its grid size); center points
  // added in the cage editor follow.
  inner = $state.raw<{ dims?: Dims; rest: Pt[]; offset: Pt[] } | null>(null);
  // Per cage edge: whether its curve was set (by the user or a preset). Edges
  // that weren't stay straight, their control points following their ends.
  bent = $state.raw<boolean[]>([]);
  // Linked pairs of cage points, drawn as connectors across a preset's cage.
  // Each point still moves on its own; the MVC (Panels) method folds the
  // warp along them.
  guides = $state.raw<[number, number][]>([]);
  // Per point (outer cage, then inner), in percent: how much of its pull applies.
  // Negative pulls the opposite way.
  strengths = $state.raw<number[]>([]);
  selected = $state.raw<number[]>([]); // point indices, numbered like strengths
  cageType = $state<CageType>("quad");
  // The Perspective cage's turn, in degrees: pitch tilts it about the x axis,
  // yaw turns it about the y axis, roll spins it in its own plane (z).
  orbit = $state.raw<Orbit>({ pitch: 0, yaw: 0, roll: 0 });
  // How strongly the Perspective cage foreshortens, in percent: 0 is flat, 100 a close, wide-angle camera.
  perspectiveStrength = $state(50);
  // The Hybrid method's mix, in percent: 0 is all MVC, 100 all Green.
  hybridGreen = $state(50);
  /** What the warp method's deformer is told (Hybrid reads its blend; others ignore it). */
  #options = $derived<DeformOptions>({ blend: 1 - this.hybridGreen / 100 });
  // Points each curved cage edge is broken into for the warp methods: more
  // follows the curve more closely, fewer is coarser (and quicker).
  smoothing = $state(CURVE_SAMPLES);
  // Bezier cage edges. Off, every edge acts straight; the curves are kept for when it's back on.
  curves = $state(true);
  cageChoice = $state<string | null>(null); // the cage tile shown as picked: a cage type or preset id ("fit" is Freeform)
  preset = $state<string | null>(null);

  methodId = $state(methods[0]?.id ?? "");
  editing = $state(false); // reshaping the rest cage instead of deforming
  notice = $state(""); // a one-off message, cleared when the cage changes

  fitView = $state.raw<View>({ x: 0, y: 0, w: 100, h: 100 });
  view = $state.raw<View>({ x: 0, y: 0, w: 100, h: 100 });

  #passes: Record<string, Pass> = {};
  #lastRest = new Float64Array();

  method = $derived(methods.find((m) => m.id === this.methodId));

  /** Point i's strength as a fraction (inner points come after the cage's). */
  #s = (i: number) => (this.strengths[i] ?? 100) / 100;
  // The deformed cage the warp uses: each point's pull scaled by its strength.
  // Each control point follows the strength of the vertex it hangs off.
  effCage = $derived(this.cage.map((p, i) => scaleFrom(this.restCage[i], p, this.#s(i))));
  effCtrl = $derived(this.ctrl.map(([c1, c2], i): Ctrl => [
    scaleFrom(this.restCtrl[i][0], c1, this.#s(i)),
    scaleFrom(this.restCtrl[i][1], c2, this.#s((i + 1) % this.cage.length)),
  ]));
  /** The control points as drawn: straight edges while curves are off. */
  restCtrlShown = $derived(this.curves ? this.restCtrl : straightCtrl(this.restCage));
  effCtrlShown = $derived(this.curves ? this.effCtrl : straightCtrl(this.effCage));
  /** The cage as drawn and dragged: the rest cage while editing, else the deformed one as the warp uses it. */
  active = $derived(this.editing ? this.restCage : this.effCage);
  activeCtrl = $derived(this.editing ? this.restCtrlShown : this.effCtrlShown);
  zoom = $derived(this.fitView.w / this.view.w);

  // Methods see plain matching polygons: curved edges (in either cage) are
  // flattened into extra points. A new restFlat invalidates cached weights, so
  // it keeps its identity while its contents don't change.
  curved = $derived(this.restCage.map((_, i) =>
    this.curves && (isCurved(this.restCage, this.restCtrl, i) || isCurved(this.cage, this.ctrl, i))));
  restFlat = $derived.by(() => {
    const next = flattenCage(this.restCage, this.restCtrl, this.curved, this.smoothing);
    const last = this.#lastRest;
    if (next.length === last.length && next.every((v, k) => v === last[k])) return last;
    return (this.#lastRest = Float64Array.from(next));
  });
  movedFlat = $derived(Float64Array.from(flattenCage(this.effCage, this.effCtrl, this.curved, this.smoothing)));

  /** Where the outer cage alone carries each inner point. */
  innerBase = $derived(this.inner ? this.inner.rest.map((p) => this.#warpOne(p, this.movedFlat)) : []);
  /** The inner points as drawn: on the original while editing, else where the warp puts them. */
  innerShown = $derived.by((): Pt[] => {
    const inner = this.inner;
    if (!inner) return [];
    if (this.editing) return inner.rest;
    const n = this.restCage.length;
    return this.innerBase.map((b, k) => scaleFrom(b, [b[0] + inner.offset[k][0], b[1] + inner.offset[k][1]], this.#s(n + k)));
  });
  /** A mesh cage's whole grid as drawn, for its inner lines. */
  shownGrid = $derived(this.inner?.dims ? gridNodes(this.active, this.innerShown, this.inner.dims) : null);

  /**
   * Removed connectors' end points. A removed connector still shows as a
   * dotted line while center points sit along it, but links nothing.
   */
  loose = $state.raw<[number, number][]>([]);

  /** The dotted lines of removed connectors, through the center points along each, as drawn. */
  looseLines = $derived.by(() => {
    const c = this.restCage, rest = this.inner?.rest ?? [];
    if (!rest.length) return [];
    const size = Math.max(bounds(c).width, bounds(c).height);
    return this.loose.flatMap(([a, b]) => {
      const A = c[a], B = c[b], d: Pt = [B[0] - A[0], B[1] - A[1]], len2 = d[0] ** 2 + d[1] ** 2 || 1;
      const along = rest.flatMap((p, k) => {
        const t = ((p[0] - A[0]) * d[0] + (p[1] - A[1]) * d[1]) / len2;
        const off = Math.abs((p[0] - A[0]) * d[1] - (p[1] - A[1]) * d[0]) / Math.sqrt(len2);
        return t > 0 && t < 1 && off < size * 0.01 ? [{ t, k }] : [];
      });
      if (!along.length) return [];
      along.sort((p, q) => p.t - q.t);
      return [[this.active[a], ...along.map(({ k }) => this.innerShown[k]), this.active[b]].join(" ")];
    });
  });

  /** The connectors between linked points, as drawn. */
  guideLines = $derived(this.guides.map(([a, b]) => `${this.active[a]} ${this.active[b]}`));

  /** The inner points' pulls on top of the outer cage's warp, as a field over the original. Null when nothing pulls. */
  pulls = $derived.by(() => {
    const n = this.restCage.length, inner = this.inner;
    if (!inner) return null;
    const pulls = inner.offset.map(([x, y], k): Pt => [x * this.#s(n + k), y * this.#s(n + k)]);
    return pullField(inner.rest, pulls, this.restFlat);
  });

  // ---------------------------------------------------------------- undo
  // Everything an edit to the cage changes. All of it is replaced (never
  // mutated) on change, so a snapshot is just these references.

  /** The cage as it stands, for undo. */
  doc = $derived({
    restCage: this.restCage, restCtrl: this.restCtrl, cage: this.cage, ctrl: this.ctrl, inner: this.inner,
    bent: this.bent, guides: this.guides, loose: this.loose, strengths: this.strengths, cageType: this.cageType,
    orbit: this.orbit, perspectiveStrength: this.perspectiveStrength, cageChoice: this.cageChoice, preset: this.preset,
    hybridGreen: this.hybridGreen,
  });
  #past: Doc[] = [];
  #future: Doc[] = [];
  #current: Doc | null = null;
  #historySource: unknown = null;
  #restored: Doc | null = null; // what undo or redo just put back, so recording it isn't a new step
  #gesture = false; // a pointer is down
  #gestureRecorded = false; // this gesture already made a step; its later changes fold into it

  /** Records the cage after a change (called whenever `doc` changes). A whole drag is one step. */
  record(doc: Doc) {
    const restored = this.#restored;
    this.#restored = null;
    if (this.#historySource !== this.source) {
      // New artwork: a fresh history.
      this.#historySource = this.source;
      this.#past = [];
      this.#future = [];
    } else if (this.#current && !(restored && sameDoc(doc, restored)) && !(this.#gesture && this.#gestureRecorded)) {
      this.#past.push(this.#current);
      if (this.#past.length > HISTORY_LIMIT) this.#past.shift();
      this.#future = [];
      this.#gestureRecorded = this.#gesture;
    }
    this.#current = doc;
  }

  /** A pointer went down (true) or up (false): changes in between are one step. */
  gesture(down: boolean) {
    this.#gesture = down;
    this.#gestureRecorded = false;
  }

  undo() {
    const doc = this.#past.pop();
    if (!doc || !this.#current) return;
    this.#future.push(this.#current);
    this.#restore(doc);
  }

  redo() {
    const doc = this.#future.pop();
    if (!doc || !this.#current) return;
    this.#past.push(this.#current);
    this.#restore(doc);
  }

  #restore(doc: Doc) {
    this.#restored = doc;
    this.#current = doc;
    ({
      restCage: this.restCage, restCtrl: this.restCtrl, cage: this.cage, ctrl: this.ctrl, inner: this.inner,
      bent: this.bent, guides: this.guides, loose: this.loose, strengths: this.strengths, cageType: this.cageType,
      orbit: this.orbit, perspectiveStrength: this.perspectiveStrength, cageChoice: this.cageChoice, preset: this.preset,
    hybridGreen: this.hybridGreen,
    } = doc);
    this.selected = [];
    this.notice = "";
  }

  /** With MVC and connectors, the warp through the panels (null outside them). Without connectors it's plain MVC. */
  panelMap = $derived(this.method?.panels && this.guides.length
    ? panelWarp({
      rest: this.restCage, restCtrl: this.restCtrlShown, moved: this.effCage, movedCtrl: this.effCtrlShown,
      curved: this.curved, guides: this.guides, samples: this.smoothing,
    })
    : null);

  /** Everything the warp depends on, for redrawing when any of it changes. */
  deformation = $derived([this.method, this.restFlat, this.movedFlat, this.pulls, this.panelMap, this.upstream, this.#options]);

  /** The points the Strength slider sets: the selection, or every point. */
  strengthTargets = $derived(this.selected.length ? this.selected : this.strengths.map((_, i) => i));
  strength = $derived(this.strengths[this.strengthTargets[0]] ?? 100);

  perspective = $derived(this.cageType === "perspective");

  /** A notice or a method problem to show under the canvas; empty when there's nothing to say. */
  status = $derived(this.#checkMethod() ?? this.notice);

  constructor() {
    try {
      this.curves = localStorage.getItem("warp:curves") !== "off";
    } catch {}
  }

  // -------------------------------------------------------------- warp

  /**
   * Returns a rest → deformed mapper for one full pass over the same points:
   * the outer cage's warp, plus the inner points' pulls.
   */
  beginPass(name: string): (p: Pt) => Pt {
    const base = this.#beginCagePass(name);
    const field = this.pulls;
    if (!field) return base;
    return (p) => {
      const q = base(p), d = field(p);
      return [q[0] + d[0], q[1] + d[1]];
    };
  }

  #beginCagePass(name: string): (p: Pt) => Pt {
    const m = this.method, rest = this.restFlat, moved = this.movedFlat;
    // Undeformed is the identity, so it's skipped.
    if (!m || moved.every((v, k) => v === rest[k])) return (p) => p;
    const panels = this.panelMap;
    if (panels) {
      // Only points outside every panel (outside the cage) fall back to MVC, uncached.
      return (p) => panels(p) ?? this.#warpOne(p, moved, false);
    }
    const old = this.#passes[name];
    const pass = old?.method === m && old.rest === rest ? old : (this.#passes[name] = { method: m, rest, pts: [], w: [] });
    let apply: Apply | null = null;
    try { apply = m.deformer(rest, moved, noop, this.#options); } catch {}
    const out = new Float64Array(2);
    let i = 0;
    // Fall back to identity wherever the method doesn't give a real point.
    return (p) => {
      const k = i++;
      if (pass.pts[2 * k] !== p[0] || pass.pts[2 * k + 1] !== p[1] || pass.w[k] === undefined) {
        pass.pts[2 * k] = p[0];
        pass.pts[2 * k + 1] = p[1];
        try { pass.w[k] = m.weights(p[0], p[1], rest, noop) ?? null; } catch { pass.w[k] = null; }
      }
      const w = pass.w[k];
      if (!apply || !w) return p;
      try { apply(w, out); } catch { return p; }
      return Number.isFinite(out[0]) && Number.isFinite(out[1]) ? [out[0], out[1]] : p;
    };
  }

  /** One point through the outer cage's warp to `moved` (uncached). */
  #warpOne(p: Pt, moved: Float64Array, panels = true): Pt {
    const m = this.method;
    if (!m) return p;
    if (panels && moved === this.movedFlat && this.panelMap) {
      const q = this.panelMap(p);
      if (q) return q;
    }
    try {
      const w = m.weights(p[0], p[1], this.restFlat, noop);
      const out = new Float64Array(2);
      if (w) m.deformer(this.restFlat, moved, noop, this.#options)(w, out);
      return w && Number.isFinite(out[0]) && Number.isFinite(out[1]) ? [out[0], out[1]] : p;
    } catch {
      return p;
    }
  }

  /** Runs the method once at the cage center; a status message if it fails there. */
  #checkMethod(): string | null {
    const m = this.method;
    if (!this.kind) return null;
    if (!m) return "No warp functions found in src/lib/warp/*.ts";
    const c = this.restCage, n = c.length || 1;
    const p: Pt = [c.reduce((s, q) => s + q[0], 0) / n, c.reduce((s, q) => s + q[1], 0) / n];
    let problem = "";
    try {
      const w = m.weights(p[0], p[1], this.restFlat, noop);
      const out = new Float64Array(2);
      if (!w) problem = `weights returned ${w}`;
      else {
        m.deformer(this.restFlat, this.movedFlat, noop, this.#options)(w, out);
        if (!Number.isFinite(out[0]) || !Number.isFinite(out[1])) problem = `returned (${out[0]}, ${out[1]})`;
      }
    } catch (err) {
      problem = `threw ${err instanceof Error ? err.message : String(err)}`;
    }
    return problem ? `${m.label} ${problem} at the cage center. Showing it unwarped.` : null;
  }

  // ---------------------------------------------------------------- passes
  // In a multipass warp each pass is an Editor of its own. All share the
  // imported artwork; a later pass warps what the earlier ones made of it, so
  // its cage lives in their output (its `contentBox` and `contentPts`).

  /** The original artwork through the earlier passes and then this one. */
  chained(name: string): (p: Pt) => Pt {
    const own = this.beginPass(name), up = this.upstream?.(name);
    return up ? (p) => own(up(p)) : own;
  }

  /**
   * Takes on the artwork as `prev` leaves it: `prev`'s own (as a plain loader,
   * when `chain` is false) or warped through it. The cage stays as it is.
   */
  relink(prev: Editor, chain: boolean) {
    this.kind = prev.kind;
    this.source = prev.source;
    this.texture = prev.texture;
    this.image = prev.image; // shared, so not revoked here
    this.fileName = prev.fileName;
    this.upstream = chain ? (name) => prev.chained(`${name}:next`) : null;
    // An image's corners alone don't show where a warp takes it, so a grid over it stands in.
    const pts = prev.kind === "image" && prev.contentBox ? boxGrid(prev.contentBox, 12) : prev.contentPts;
    if (chain) {
      const deform = prev.beginPass("content:next");
      this.contentPts = [];
      for (let k = 0; k < pts.length; k += 2) this.contentPts.push(...deform([pts[k], pts[k + 1]]));
    } else this.contentPts = pts;
    const xs = this.contentPts.filter((_, k) => k % 2 === 0), ys = this.contentPts.filter((_, k) => k % 2 === 1);
    const x = Math.min(...xs), y = Math.min(...ys);
    this.contentBox = xs.length ? { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y } : null;
    this.#passes = {};
  }

  /** As `relink`, with a fresh cage of `type` around the artwork. */
  adopt(prev: Editor, chain: boolean, type: CageType = "quad") {
    this.relink(prev, chain);
    this.view = prev.view;
    this.fitView = prev.fitView;
    this.setCageType(type);
  }

  /** What this pass starts from (the original, or the earlier passes' output), for the faint copy behind the warp. */
  inputClone() {
    const clone = this.source!.cloneNode(true) as SVGSVGElement;
    const up = this.upstream?.("input");
    return up ? (warpSvgElement(clone, (curve: any) => mapPoints(subdivide(curve, SUBDIVISIONS), up)) as SVGSVGElement) : clone;
  }

  warpedClone() {
    const clone = this.source!.cloneNode(true) as SVGSVGElement;
    const deform = this.chained("svg");
    return warpSvgElement(clone, (curve: any) => mapPoints(subdivide(curve, SUBDIVISIONS), deform)) as SVGSVGElement;
  }

  /** The image's warped mesh, in SVG units. */
  rasterGrid() {
    return this.texture && warpGrid(this.texture, MESH_CELLS, this.chained("raster"));
  }

  // -------------------------------------------------------------- cage

  /** Call after the points are replaced or renumbered. */
  #cageChanged() {
    this.notice = "";
    this.preset = null;
    this.selected = [];
  }

  /**
   * Any change to the cage while editing, or moving a preset's points, makes it a
   * Freeform one (as the cage tiles show). A Freeform cage has no strength, so the
   * current strengths are baked into its shape first.
   */
  #markFreeform() {
    if (!this.editing && !PRESETS.some((p) => p.id === this.cageChoice)) return;
    this.cageChoice = "fit";
    if (this.strengths.every((s) => s === 100)) return;
    const n = this.restCage.length, inner = this.inner;
    this.cage = this.effCage;
    this.ctrl = this.effCtrl;
    if (inner) this.inner = { ...inner, offset: inner.offset.map(([x, y], k): Pt => [x * this.#s(n + k), y * this.#s(n + k)]) };
    this.#resetStrengths();
  }

  #resetStrengths() {
    this.strengths = Array(this.restCage.length + (this.inner?.rest.length ?? 0)).fill(100);
  }

  /** Picks the warp method, leaving the Perspective cage if the new method can't use it. */
  setMethod(id: string) {
    this.methodId = id;
    if (id !== PERSPECTIVE_METHOD && this.perspective) this.setCageType("quad");
  }

  setCageType(type: CageType) {
    const box = this.contentBox;
    if (!box) return;
    // The Perspective cage needs the Perspective method (which works with every cage).
    if (type === "perspective" && this.methodId !== PERSPECTIVE_METHOD) type = "quad";
    this.cageType = type;
    this.orbit = { pitch: 0, yaw: 0, roll: 0 };
    if (type === "perspective") this.editing = false;
    const m = margin(box);
    this.restCage = type === "fit" ? fitCage(this.contentPts, m) : quadCage(box, m);
    this.restCtrl = straightCtrl(this.restCage);
    this.cage = copyCage(this.restCage);
    this.ctrl = copyCtrl(this.restCtrl);
    this.inner = null;
    this.guides = [];
    this.loose = [];
    this.bent = this.restCage.map(() => false);
    if (type === "mesh") this.#buildLayout({ ...MESH, guides: "none", mesh: true });
    this.#resetStrengths();
    this.cageChoice = type;
    this.#cageChanged();
  }

  /** Turns the Perspective cage by a screen drag (degrees per px), or to `to`. */
  orbitBy(dx: number, dy: number) {
    this.setOrbit({ yaw: this.orbit.yaw + dx * 0.4, pitch: this.orbit.pitch + dy * 0.4 });
  }

  /** Turns the Perspective cage to `to` (any angles left out keep their values). */
  setOrbit(to: Partial<Orbit>) {
    if (!this.perspective) return;
    const { pitch, yaw, roll } = { ...this.orbit, ...to };
    const clamp = (a: number) => Math.max(-MAX_TILT, Math.min(MAX_TILT, a));
    const wrap = (a: number) => a - 360 * Math.round(a / 360); // to [-180, 180]
    this.orbit = { pitch: clamp(pitch), yaw: clamp(yaw), roll: wrap(roll) };
    this.cage = orbitCorners(this.restCage, this.orbit, this.perspectiveStrength / 100);
    this.ctrl = straightCtrl(this.cage);
    this.bent = this.cage.map(() => false);
  }

  setPerspectiveStrength(value: number) {
    this.perspectiveStrength = value;
    this.setOrbit(this.orbit);
  }

  /** Replaces the cage with a layout's, undeformed, over the artwork. */
  #buildLayout(layout: Layout) {
    const box = this.contentBox!;
    const { ring, guides } = layoutCage(layout);
    const m = margin(box), x = box.x - m, y = box.y - m, w = box.width + 2 * m, h = box.height + 2 * m;
    this.restCage = ring.map(([u, v]) => [x + u * w, y + v * h]);
    this.restCtrl = straightCtrl(this.restCage);
    this.cage = copyCage(this.restCage);
    this.ctrl = copyCtrl(this.restCtrl);
    const dims = { cols: layout.cols, rows: layout.rows };
    this.inner = layout.mesh ? { dims, rest: meshInner(box, m, dims), offset: innerRC(dims).map((): Pt => [0, 0]) } : null;
    this.guides = guides;
    this.loose = [];
    this.bent = this.restCage.map(() => false);
    this.#resetStrengths();
    this.#cageChanged();
    this.#addCrossings();
  }

  /** Deforms the current cage by a preset: its points move, and its edges bend to follow. */
  applyPreset(p: Preset) {
    const box = this.contentBox;
    if (!box) return;
    // A preset leaves the Perspective cage for a plain one.
    if (this.perspective) {
      this.cageType = "quad";
      this.orbit = { pitch: 0, yaw: 0, roll: 0 };
    }
    // Build the preset's own cage over the artwork, then deform it.
    this.#buildLayout(p.layout);
    const rest = this.restCage, restCtrl = this.restCtrl;
    const b = bounds(rest);
    // The preset moves points by fractions of a unit box. A bend scales each
    // direction's movement by the other side (see Preset), so an Arc lifts by the
    // same share of the width on a wide wordmark as on a tall shape.
    const [sx, sy] = p.bend ? [b.height, b.width] : [b.width, b.height];
    const target = ([x, y]: Pt): Pt => {
      const u = (x - b.x) / b.width, v = (y - b.y) / b.height;
      const [u2, v2] = p.map(u, v);
      return [x + (u2 - u) * sx, y + (v2 - v) * sy];
    };
    const cage = rest.map(target);
    // Each edge becomes the cubic through the preset's image of its 1/3 and 2/3 points.
    this.ctrl = rest.map((_, i) => fitEdge(
      cage[i], cage[(i + 1) % rest.length],
      target(edgePoint(rest, restCtrl, i, 1 / 3)), target(edgePoint(rest, restCtrl, i, 2 / 3)),
    ));
    this.cage = cage;
    this.bent = cage.map((_, i) => isCurved(cage, this.ctrl, i));
    // Inner points go where the preset puts them, as offsets from where the
    // outer cage (at full strength) now carries them.
    const inner = this.inner;
    if (inner) {
      const full = Float64Array.from(flattenCage(this.cage, this.ctrl, this.curved, this.smoothing));
      const base = inner.rest.map((q) => this.#warpOne(q, full));
      this.inner = { ...inner, offset: inner.rest.map((q, k) => {
        const t = target(q);
        return [t[0] - base[k][0], t[1] - base[k][1]];
      }) };
    }
    this.notice = "";
    this.preset = p.id;
    this.cageChoice = p.id;
  }

  /** Picks from the cage dropdown: a cage type or a preset. */
  chooseCage(value: string) {
    const preset = PRESETS.find((p) => p.id === value);
    if (preset) this.applyPreset(preset);
    else this.setCageType(value as CageType);
  }

  /** Where point i (outer cage, then inner) is drawn. */
  shownPoint(i: number): Pt {
    const n = this.active.length;
    return i < n ? this.active[i] : this.innerShown[i - n];
  }

  /** Clicking a point selects it; with `add`, toggles it in the selection. */
  select(i: number, add: boolean) {
    if (!add) this.selected = [i];
    else this.selected = this.selected.includes(i) ? this.selected.filter((j) => j !== i) : [...this.selected, i];
  }

  /**
   * Drags point i to `to`. A selected point brings the rest of the selection
   * along. Points are drawn where their strength puts them, so a drag moves
   * the full-strength position by the drag ÷ strength; at 0% they can't move.
   */
  dragPoint(i: number, to: Pt) {
    const from = this.shownPoint(i);
    const dx = to[0] - from[0], dy = to[1] - from[1];
    const movable = (j: number) => this.editing || Math.abs(this.#s(j)) >= 0.01;
    const group = this.dragGroup(i).filter(movable);
    if (!movable(i)) this.notice = "This point's strength is 0%. Raise it to move the point.";
    const n = this.active.length;
    const targets = group.map((j): [number, Pt] => {
      const p = this.shownPoint(j);
      return [j, [p[0] + dx, p[1] + dy]];
    });
    // Outer points first: inner offsets are measured from where the outer cage carries them.
    for (const [j, p] of targets) if (j < n) this.#moveVertex(j, p);
    for (const [j, p] of targets) if (j >= n) this.#moveInner(j - n, p);
    this.preset = null;
    this.#markFreeform();
  }

  /** The points that move when point i is dragged: the selection, if i is in it, else just i. */
  dragGroup(i: number) {
    return this.selected.includes(i) ? this.selected : [i];
  }

  /** Puts point i at `to` on its own (no selection or links), as typed into the cage editor. */
  placePoint(i: number, to: Pt) {
    const n = this.active.length;
    if (i < n) this.#moveVertex(i, to);
    else this.#moveInner(i - n, to);
    this.preset = null;
    this.#markFreeform();
  }

  isLinked = (a: number, b: number) => this.guides.some(([p, q]) => (p === a && q === b) || (p === b && q === a));

  /** Links two cage points (not a Mesh cage's inner ones) with a connector. */
  link(a: number, b: number) {
    if (this.#editOnly()) return;
    const n = this.restCage.length;
    if (a === b || a >= n || b >= n || this.isLinked(a, b)) return;
    this.guides = [...this.guides, [a, b]];
    this.loose = this.loose.filter(([p, q]) => !((p === a && q === b) || (p === b && q === a)));
    this.#addCrossings();
    this.#markFreeform();
  }

  /** Removes connector i; its points move on their own again. */
  unlink(i: number) {
    if (this.#editOnly()) return;
    this.loose = [...this.loose, this.guides[i]];
    this.guides = this.guides.toSpliced(i, 1);
    this.#markFreeform();
  }

  /** Puts a center point wherever connectors cross and none is yet. */
  #addCrossings() {
    const found = this.crossings.map((c) => c.rest);
    if (!found.length || this.inner?.dims) return;
    const inner = this.inner ?? { rest: [], offset: [] };
    this.inner = { ...inner, rest: [...inner.rest, ...found], offset: [...inner.offset, ...found.map((): Pt => [0, 0])] };
    this.strengths = [...this.strengths, ...found.map(() => 100)];
  }

  /** The point a connector can start from: the one selected cage point, while editing. */
  linkFrom = $derived(
    this.editing && this.selected.length === 1 && this.selected[0] < this.restCage.length && !this.inner?.dims && !this.perspective
      ? this.selected[0]
      : undefined,
  );

  /**
   * Where two connectors cross on the original cage: each is a spot to add a
   * center point. `at` is where it's drawn (carried through the warp unless editing).
   */
  crossings = $derived.by((): { rest: Pt; at: Pt }[] => {
    const c = this.restCage, g = this.guides;
    if (this.perspective || g.length < 2) return [];
    const size = Math.max(bounds(c).width, bounds(c).height);
    const taken = this.inner?.rest ?? [];
    const found: Pt[] = [];
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const [a, b] = g[i], [p, q] = g[j];
        if (a === p || a === q || b === p || b === q) continue; // connectors sharing a point meet there
        const x = segmentCrossing(c[a], c[b], c[p], c[q]);
        const near = (o: Pt) => x && Math.hypot(o[0] - x[0], o[1] - x[1]) < size * 0.01;
        if (x && !taken.some(near) && !found.some(near)) found.push(x);
      }
    }
    if (this.editing) return found.map((rest) => ({ rest, at: rest }));
    void this.deformation;
    const deform = this.beginPass("crossings");
    return found.map((rest) => ({ rest, at: deform(rest) }));
  });

  /** Links the selected point to an existing point, or to a new point added on an edge; keeps it selected. */
  linkTo(target: LinkTarget) {
    if (this.#editOnly()) return;
    const sel = this.linkFrom;
    if (sel === undefined || target.vertex === sel) return;
    if (target.vertex !== undefined) return this.link(sel, target.vertex);
    this.insertVertex(target.edge, target.t);
    const kept = sel > target.edge ? sel + 1 : sel;
    this.link(kept, target.edge + 1);
    this.selected = [kept];
  }

  /** Straightens the edges on either side of `points`, or every edge when none are given. */
  straightenAround(points: number[]) {
    const n = this.restCage.length;
    const edges = points.length
      ? new Set(points.filter((i) => i < n).flatMap((i) => [i, (i - 1 + n) % n]))
      : new Set(this.restCage.keys());
    for (const i of edges) this.straighten(i);
  }

  /** Removes the given cage points, highest first so the others keep their numbers meanwhile. */
  removePoints(points: number[]) {
    for (const i of [...points].sort((a, b) => b - a)) this.removeVertex(i);
  }

  /**
   * Moves outer vertex i of the active cage. Bent edges' control points travel
   * with it; unbent edges stay straight. Reshaping the rest cage carries the
   * deformed vertex along.
   */
  #moveVertex(i: number, to: Pt) {
    const from = this.active[i], s = this.editing ? 1 : this.#s(i);
    const dx = (to[0] - from[0]) / s, dy = (to[1] - from[1]) / s;
    const prev = (i - 1 + this.active.length) % this.active.length;
    const shift = ([x, y]: Pt): Pt => [x + dx, y + dy];
    const moveCtrl = (k: Ctrl[]) => {
      const out = k.with(i, [shift(k[i][0]), k[i][1]]);
      return out.with(prev, [out[prev][0], shift(out[prev][1])]);
    };
    if (this.editing) {
      this.restCage = this.restCage.with(i, shift(this.restCage[i]));
      this.restCtrl = moveCtrl(this.restCtrl);
    }
    this.cage = this.cage.with(i, shift(this.cage[i]));
    this.ctrl = moveCtrl(this.ctrl);
    this.#followStraight([prev, i]);
  }

  /** Resets the control points of whichever of `edges` aren't bent to the straight 1/3, 2/3 marks. */
  #followStraight(edges: number[]) {
    const n = this.cage.length;
    for (const e of edges) {
      if (this.bent[e]) continue;
      const f = (e + 1) % n;
      this.restCtrl = this.restCtrl.with(e, straightEdge(this.restCage[e], this.restCage[f]));
      this.ctrl = this.ctrl.with(e, straightEdge(this.cage[e], this.cage[f]));
    }
  }

  /** Moves inner point k: on the original while editing (keeping its pull), else sets its pull. */
  #moveInner(k: number, to: Pt) {
    const inner = this.inner!;
    if (this.editing) this.inner = { ...inner, rest: inner.rest.with(k, to) };
    else {
      const [bx, by] = this.innerBase[k], s = this.#s(this.restCage.length + k);
      this.inner = { ...inner, offset: inner.offset.with(k, [(to[0] - bx) / s, (to[1] - by) / s]) };
    }
  }

  /**
   * Moves control point `which` (0 = c1, 1 = c2) of edge i in the active cage.
   * Knobs are drawn where strength puts them, so this undoes that to find the
   * control point to store.
   */
  moveCtrl(i: number, which: 0 | 1, to: Pt) {
    const j = (i + 1) % this.cage.length;
    // The stored change to this knob.
    let delta: Pt;
    if (this.editing) {
      const cur = this.restCtrl[i][which];
      delta = [to[0] - cur[0], to[1] - cur[1]];
    } else {
      const s = this.#s(which ? j : i);
      if (Math.abs(s) < 0.01) return void (this.notice = "This point's strength is 0%. Raise it to bend its edges.");
      const next = scaleFrom(this.restCtrl[i][which], to, 1 / s), cur = this.ctrl[i][which];
      delta = [next[0] - cur[0], next[1] - cur[1]];
    }
    this.#shiftCtrl(i, which, delta);
    this.bent = this.bent.with(i, true);
    this.preset = null;
    this.#markFreeform();
  }

  /** Moves a stored control point by `d`; while editing, the rest cage's too (the deformed edge keeps its bend). */
  #shiftCtrl(edge: number, which: 0 | 1, [dx, dy]: Pt) {
    const shift = (k: Ctrl[]) => {
      const p = k[edge][which], moved: Pt = [p[0] + dx, p[1] + dy];
      return k.with(edge, which ? [k[edge][0], moved] : [moved, k[edge][1]]);
    };
    if (this.editing) this.restCtrl = shift(this.restCtrl);
    this.ctrl = shift(this.ctrl);
  }

  /** Makes edge i straight again in the active cage (and the deformed one while editing); it follows its ends from then on. */
  straighten(i: number) {
    const j = (i + 1) % this.cage.length;
    if (this.editing) this.restCtrl = this.restCtrl.with(i, straightEdge(this.restCage[i], this.restCage[j]));
    this.ctrl = this.ctrl.with(i, straightEdge(this.cage[i], this.cage[j]));
    if (this.editing || !isCurved(this.restCage, this.restCtrl, i)) this.bent = this.bent.with(i, false);
    this.preset = null;
    this.#markFreeform();
  }

  setStrength(value: number) {
    if (this.perspective || this.cageChoice === "fit") return;
    const targets = new Set(this.strengthTargets);
    this.strengths = this.strengths.map((s, i) => (targets.has(i) ? value : s));
    this.notice = "";
  }

  /** True (with a notice) unless editing the cage: only the cage editor adds, removes or links points. */
  #editOnly() {
    if (!this.editing) this.notice = "Use Edit to change the cage's points and connectors.";
    return !this.editing;
  }

  #meshFixed() {
    if (this.inner?.dims) this.notice = "A mesh cage keeps its grid. Switch to Quad or Freeform to add or remove points.";
    return !!this.inner?.dims || this.perspective;
  }

  /** Adds a center point at `at` on the original (the cage's middle by default), and selects it. */
  addCenter(at?: Pt) {
    if (this.#editOnly()) return;
    if (this.perspective || !this.restCage.length) return;
    if (at && !insidePoly(at, this.restFlat)) return void (this.notice = "Center points go inside the cage.");
    const c = this.restCage, n = c.length;
    const p: Pt = at ?? [c.reduce((s, q) => s + q[0], 0) / n, c.reduce((s, q) => s + q[1], 0) / n];
    const inner = this.inner ?? { rest: [], offset: [] };
    this.inner = { ...inner, rest: [...inner.rest, p], offset: [...inner.offset, [0, 0]] };
    this.strengths = [...this.strengths, 100];
    this.notice = "";
    this.selected = [n + inner.rest.length];
    this.#markFreeform();
  }

  /** Removes inner point k, unless it's one of a mesh cage's grid points. */
  #removeInner(k: number) {
    const inner = this.inner!, dims = inner.dims;
    if (dims && k < (dims.cols - 1) * (dims.rows - 1)) {
      this.notice = "That's one of the mesh's grid points; only added center points can be removed.";
      return;
    }
    const rest = inner.rest.toSpliced(k, 1);
    this.inner = rest.length || dims ? { ...inner, rest, offset: inner.offset.toSpliced(k, 1) } : null;
    this.strengths = this.strengths.toSpliced(this.restCage.length + k, 1);
    this.selected = [];
    this.#markFreeform();
  }

  /** Splits edge i at parameter t in both cages (as drawn, so straight while curves are off). */
  insertVertex(i: number, t: number) {
    if (this.#editOnly()) return;
    if (this.#meshFixed()) return;
    const shown = (c: Pt[], k: Ctrl[]) => (this.curves ? k : straightCtrl(c));
    [this.restCage, this.restCtrl] = splitEdge(this.restCage, shown(this.restCage, this.restCtrl), i, t);
    [this.cage, this.ctrl] = splitEdge(this.cage, shown(this.cage, this.ctrl), i, t);
    this.bent = this.bent.toSpliced(i + 1, 0, this.bent[i]);
    this.strengths = this.strengths.toSpliced(i + 1, 0, 100);
    const shift = ([a, b]: [number, number]): [number, number] => [a > i ? a + 1 : a, b > i ? b + 1 : b];
    this.guides = this.guides.map(shift);
    this.loose = this.loose.map(shift);
    this.#cageChanged();
    this.#markFreeform();
  }

  removeVertex(i: number) {
    if (this.#editOnly()) return;
    if (i >= this.restCage.length) return this.#removeInner(i - this.restCage.length);
    if (this.#meshFixed()) return;
    if (this.restCage.length <= MIN_VERTICES) {
      this.notice = `The cage needs at least ${MIN_VERTICES} points.`;
      return;
    }
    [this.restCage, this.restCtrl] = joinAt(this.restCage, this.restCtrl, i);
    [this.cage, this.ctrl] = joinAt(this.cage, this.ctrl, i);
    const prev = (i - 1 + this.bent.length) % this.bent.length;
    this.bent = this.bent.with(prev, this.bent[prev] || this.bent[i]).toSpliced(i, 1);
    this.strengths = this.strengths.toSpliced(i, 1);
    const drop = (pairs: [number, number][]) => pairs
      .filter(([a, b]) => a !== i && b !== i)
      .map(([a, b]): [number, number] => [a > i ? a - 1 : a, b > i ? b - 1 : b]);
    this.guides = drop(this.guides);
    this.loose = drop(this.loose);
    this.#cageChanged();
    this.#markFreeform();
  }

  #applyCage(spec: CageSpec) {
    this.restCage = copyCage(spec.rest);
    this.restCtrl = copyCtrl(spec.restCtrl);
    this.cage = copyCage(spec.moved ?? spec.rest);
    this.ctrl = copyCtrl(spec.movedCtrl ?? spec.restCtrl);
    this.bent = this.restCage.map((_, i) => isCurved(this.restCage, this.restCtrl, i) || isCurved(this.cage, this.ctrl, i));
    this.inner = null;
    this.guides = [];
    this.loose = [];
    this.#resetStrengths();
    this.cageChoice = null;
    this.#cageChanged();
    if (this.contentBox) this.fitAround([this.contentBox, bounds(this.restCage), bounds(this.cage)]);
  }

  async loadCageFile(file: File) {
    if (!this.kind || this.perspective) return;
    const text = await file.text();
    let spec: CageSpec | null;
    if (/\.json$/i.test(file.name) || file.type === "application/json") {
      spec = cageFromJson(text);
    } else {
      const doc = new DOMParser().parseFromString(text, "image/svg+xml");
      const root = doc.documentElement;
      spec = doc.querySelector("parsererror") ? null : cageFromDoc(root);
      if (!spec) {
        const first = root.querySelector(SHAPES.join(","));
        const rest = first && cageFromShape(first);
        spec = rest && { rest: rest.pts, restCtrl: rest.ctrl };
      }
    }
    if (!spec) this.notice = `Couldn't read a cage (${MIN_VERTICES}+ points) from ${file.name}.`;
    else this.#applyCage(spec);
  }

  // -------------------------------------------------------------- import

  async loadFile(file: File) {
    if (file.type === "image/svg+xml" || /\.svg$/i.test(file.name)) this.loadSvg(await file.text(), file.name);
    else if (file.type.startsWith("image/")) this.loadImage(file, file.name);
    else this.notice = "Open an SVG or an image (PNG, JPEG, WebP…).";
  }

  loadSvg(text: string, name: string) {
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    const root = doc.documentElement as unknown as SVGSVGElement;
    if (root.nodeName !== "svg" || doc.querySelector("parsererror")) return void (this.notice = "That file isn't a valid SVG.");
    // A shape with id="cage" (and optionally id="cage-deformed") is the cage, not artwork.
    const embedded = cageFromDoc(root);
    root.querySelector("#cage")?.remove();
    root.querySelector("#cage-deformed")?.remove();

    const found = UNWARPABLE.flatMap((tag) => {
      const n = root.querySelectorAll(tag).length;
      return n ? [`${n} <${tag}>`] : [];
    });
    if (found.length) {
      this.notice = `Only vector shapes can be warped. This SVG has ${found.join(", ")}. Convert them to paths first.`;
      return;
    }
    const box = contentBBox(root);
    if (!box) return void (this.notice = "No paths or shapes found in that SVG.");

    this.source = root;
    this.texture = null;
    this.#setImage(null);
    this.kind = "svg";
    this.contentPts = samplePaths(root);
    this.#setup(box, name);
    if (embedded) this.#applyCage(embedded);
  }

  async loadImage(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      URL.revokeObjectURL(url);
      this.notice = "Couldn't read that image.";
      return;
    }
    // Image pixels are the SVG units. Trim transparent borders so the cage hugs
    // what's actually drawn; the texture is that cropped area.
    const b = alphaBounds(img, img.naturalWidth, img.naturalHeight);
    if (!b) {
      URL.revokeObjectURL(url);
      this.notice = "That image is fully transparent.";
      return;
    }
    const w = b.x1 - b.x0, h = b.y1 - b.y0;
    const cropped = Object.assign(document.createElement("canvas"), { width: w, height: h });
    cropped.getContext("2d")!.drawImage(b.canvas, b.x0, b.y0, w, h, 0, 0, w, h);
    const box = { x: b.x0, y: b.y0, width: w, height: h };

    this.source = null;
    this.texture = { image: cropped, region: { x: box.x, y: box.y, w, h }, width: w, height: h };
    this.#setImage({ url, width: img.naturalWidth, height: img.naturalHeight });
    this.kind = "image";
    this.contentPts = [box.x, box.y, box.x + w, box.y, box.x + w, box.y + h, box.x, box.y + h];
    this.#setup(box, name);
  }

  #setImage(next: Editor["image"]) {
    if (this.image) URL.revokeObjectURL(this.image.url);
    this.image = next;
  }

  /** Sets up the cage and view around artwork occupying `box`. */
  #setup(box: Box, name: string) {
    this.fileName = name.replace(/\.[a-z]+$/i, "") + "-warped";
    this.contentBox = box;
    this.#passes = {};
    this.fitAround([box]);
    this.setCageType(this.cageType);
  }

  // -------------------------------------------------------------- export

  export() {
    if (this.kind === "image") this.#exportPng();
    else if (this.source) this.#exportSvg();
  }

  #exportSvg() {
    const out = this.warpedClone();
    // Grow the viewBox if the warp pushed content outside it.
    const box = contentBBox(out);
    const vb = out.getAttribute("viewBox")?.split(/[\s,]+/).map(Number);
    if (box && vb?.length === 4) {
      const x = Math.min(vb[0], box.x), y = Math.min(vb[1], box.y);
      const x2 = Math.max(vb[0] + vb[2], box.x + box.width), y2 = Math.max(vb[1] + vb[3], box.y + box.height);
      out.setAttribute("viewBox", [x, y, x2 - x, y2 - y].join(" "));
      out.removeAttribute("width");
      out.removeAttribute("height");
    }
    saveFile(new Blob([new XMLSerializer().serializeToString(out)], { type: "image/svg+xml" }), `${this.fileName}.svg`);
  }

  #exportPng() {
    const texture = this.texture, grid = this.rasterGrid();
    const box = grid && gridBounds(grid);
    if (!texture || !grid || !box) return;
    // Keep roughly the texture's pixel density, capped so huge warps don't blow up.
    const density = Math.min(texture.width / texture.region.w, 8192 / Math.max(box.w, box.h));
    const canvas = Object.assign(document.createElement("canvas"), {
      width: Math.max(1, Math.ceil(box.w * density)),
      height: Math.max(1, Math.ceil(box.h * density)),
    });
    drawMesh(canvas.getContext("2d")!, texture, grid, ([x, y]) => [(x - box.x) * density, (y - box.y) * density]);
    canvas.toBlob((blob) => blob && saveFile(blob, `${this.fileName}.png`), "image/png");
  }

  /**
   * Downloads the cage, as shown (straight edges when Smooth is off), as an SVG in
   * the artwork's coordinates. Only the moved cage (id="cage-deformed") is drawn;
   * the original (id="cage") sits in <defs>, so Import can still read both back.
   */
  exportCage() {
    if (!this.restCage.length) return;
    const rest = this.restCage, restCtrl = this.restCtrlShown, moved = this.effCage, movedCtrl = this.effCtrlShown;
    const b = bounds([moved, movedCtrl.flat()].flat()), pad = Math.max(b.width, b.height) * 0.05;
    const vb = [b.x - pad, b.y - pad, b.width + 2 * pad, b.height + 2 * pad].map((v) => +v.toFixed(3)).join(" ");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">
  <defs><path id="cage" d="${cagePath(rest, restCtrl)}" /></defs>
  <path id="cage-deformed" d="${cagePath(moved, movedCtrl)}" fill="none" stroke="#000" vector-effect="non-scaling-stroke" />
</svg>
`;
    saveFile(new Blob([svg], { type: "image/svg+xml" }), `${this.fileName}-cage.svg`);
  }

  // -------------------------------------------------------------- view

  /** Fits the view around every box, with room to drag the cage outward. */
  fitAround(boxes: Box[]) {
    const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
    const w = Math.max(...boxes.map((b) => b.x + b.width)) - x, h = Math.max(...boxes.map((b) => b.y + b.height)) - y;
    const pad = Math.max(w, h) * 0.35;
    this.fitView = { x: x - pad, y: y - pad, w: w + pad * 2, h: h + pad * 2 };
    this.view = this.fitView;
  }

  /** Zooms by `factor` (>1 = in) keeping SVG point `at` fixed on screen. */
  zoomBy(factor: number, at?: Pt) {
    const v = this.view;
    const [ax, ay] = at ?? [v.x + v.w / 2, v.y + v.h / 2];
    factor = Math.min(64 / this.zoom, Math.max(0.1 / this.zoom, factor));
    this.view = { x: ax - (ax - v.x) / factor, y: ay - (ay - v.y) / factor, w: v.w / factor, h: v.h / factor };
  }

  /** Pans by a screen distance, at `scale` screen px per SVG unit. */
  panBy(dxPx: number, dyPx: number, scale: number) {
    this.view = { ...this.view, x: this.view.x - dxPx / scale, y: this.view.y - dyPx / scale };
  }
}

// ---------------------------------------------------------------- helpers

/**
 * The rectangle spanned by `rect` (TL, TR, BR, BL), turned in 3D about its
 * center (roll in its own plane, then pitch about the horizontal axis, then
 * yaw about the vertical) and
 * projected through a camera in front of it, 1.25 / `strength` rectangle-widths
 * away: 0 is infinitely far (no foreshortening), 3 well inside one width. That
 * close, a steep turn would swing the near corners up to or past the camera,
 * so each corner stays at least a fifth of the camera distance in front of it.
 */
function orbitCorners(rect: Pt[], orbit: Orbit, strength: number): Pt[] {
  const b = bounds(rect);
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  const depth = (0.8 * strength) / Math.max(b.width, b.height); // 1 / camera distance
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const [yaw, pitch, roll] = [rad(orbit.yaw), rad(orbit.pitch), rad(orbit.roll)];
  const [cyw, syw, cp, sp, cr, sr] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch), Math.cos(roll), Math.sin(roll)];
  return rect.map(([px, py]) => {
    // Roll: clockwise on screen as it grows.
    const x = (px - cx) * cr - (py - cy) * sr, y = (px - cx) * sr + (py - cy) * cr;
    // Pitch: the top tips toward the camera as pitch grows; yaw: the right side recedes.
    const y1 = y * cp, z1 = y * sp;
    const x2 = x * cyw - z1 * syw, z2 = x * syw + z1 * cyw;
    const k = 1 / Math.max(MIN_DEPTH, 1 + z2 * depth);
    return [cx + x2 * k, cy + y1 * k];
  });
}

/** Where segments a–b and p–q cross, strictly inside both, or null. */
function segmentCrossing(a: Pt, b: Pt, p: Pt, q: Pt): Pt | null {
  const r: Pt = [b[0] - a[0], b[1] - a[1]], s: Pt = [q[0] - p[0], q[1] - p[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null; // parallel
  const t = ((p[0] - a[0]) * s[1] - (p[1] - a[1]) * s[0]) / den;
  const u = ((p[0] - a[0]) * r[1] - (p[1] - a[1]) * r[0]) / den;
  const inside = (v: number) => v > 1e-6 && v < 1 - 1e-6;
  return inside(t) && inside(u) ? [a[0] + t * r[0], a[1] + t * r[1]] : null;
}

/** The point `k` of the way from `r` to `p` (beyond 1 overshoots, negative goes the other way). */
const scaleFrom = (r: Pt, p: Pt, k: number): Pt => [r[0] + k * (p[0] - r[0]), r[1] + k * (p[1] - r[1])];

/** Points along every shape (8 per curve segment), as flat [x0, y0, …]. */
function samplePaths(root: SVGSVGElement) {
  const pts: number[] = [];
  for (const [, curve] of collectCurves(root)) {
    let at: Pt = [0, 0];
    for (const seg of curve as unknown as (string | number)[][]) {
      const n = seg.slice(1) as number[];
      if (seg[0] === "C") {
        for (let k = 1; k <= 8; k++) {
          const t = k / 8, u = 1 - t;
          const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
          pts.push(a * at[0] + b * n[0] + c * n[2] + d * n[4], a * at[1] + b * n[1] + c * n[3] + d * n[5]);
        }
      } else if (n.length) {
        pts.push(n[0], n[1]);
      }
      if (n.length) at = [n[n.length - 2], n[n.length - 1]];
    }
  }
  return pts;
}

/** A cage from the first subpath of an SVG shape: one vertex per segment, Bezier controls kept. */
function cageFromShape(el: Element): { pts: Pt[]; ctrl: Ctrl[] } | null {
  const pathArray = (shapeToPath(el) || null) as Parameters<typeof pathToCurve>[0] | null;
  if (!pathArray?.length) return null;
  const curve = pathToCurve(pathArray) as unknown as (string | number)[][];
  if (curve[0]?.[0] !== "M") return null;
  const pts: Pt[] = [], ctrl: Ctrl[] = [];
  let at: Pt = [curve[0][1] as number, curve[0][2] as number];
  for (const seg of curve.slice(1)) {
    if (seg[0] !== "C") break;
    const [c1x, c1y, c2x, c2y, x, y] = seg.slice(1) as number[];
    if (x === at[0] && y === at[1] && c1x === x && c1y === y && c2x === x && c2y === y) continue; // zero-length
    pts.push(at);
    ctrl.push([[c1x, c1y], [c2x, c2y]]);
    at = [x, y];
  }
  if (!pts.length) return null;
  // Open path: close it with a straight edge back to the start.
  if (at[0] !== pts[0][0] || at[1] !== pts[0][1]) {
    pts.push(at);
    ctrl.push(straightEdge(at, pts[0]));
  }
  return pts.length >= MIN_VERTICES ? { pts, ctrl } : null;
}

function cageFromDoc(root: Element): CageSpec | null {
  const sel = SHAPES.join(",");
  const pick = (el: Element | null) => el && (el.matches(sel) ? el : el.querySelector(sel));
  const shape = pick(root.querySelector("#cage"));
  const rest = shape && cageFromShape(shape);
  if (!rest) return null;
  const deformed = pick(root.querySelector("#cage-deformed"));
  const moved = deformed && cageFromShape(deformed);
  return moved?.pts.length === rest.pts.length
    ? { rest: rest.pts, restCtrl: rest.ctrl, moved: moved.pts, movedCtrl: moved.ctrl }
    : { rest: rest.pts, restCtrl: rest.ctrl };
}

const isPt = (v: unknown): v is Pt => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n));
const isPts = (v: unknown): v is Pt[] => Array.isArray(v) && v.every(isPt);
const isCtrls = (v: unknown, n: number): v is Ctrl[] =>
  Array.isArray(v) && v.length === n && v.every((e) => Array.isArray(e) && e.length === 2 && e.every(isPt));

function cageFromJson(text: string): CageSpec | null {
  let data: any;
  try { data = JSON.parse(text); } catch { return null; }
  if (isPts(data)) data = { rest: data };
  const rest = data?.rest;
  if (!isPts(rest) || rest.length < MIN_VERTICES) return null;
  const n = rest.length;
  const restCtrl = isCtrls(data.restCtrl, n) ? data.restCtrl : straightCtrl(rest);
  if (!isPts(data.moved) || data.moved.length !== n) return { rest, restCtrl };
  const moved = data.moved as Pt[];
  return { rest, restCtrl, moved, movedCtrl: isCtrls(data.movedCtrl, n) ? data.movedCtrl : straightCtrl(moved) };
}
