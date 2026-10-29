import { parsePathString, pathToCurve, shapeToPathArray } from "svg-path-commander/util";
import { SHAPES, collectCurves, contentBBox, mapPoints, subdivide, warpSvgElement } from "./warp-core.js";
import { alphaBounds, drawMesh, gridBounds, rasterize, warpGrid, type Texture } from "./raster";

type Pt = [number, number];

const SVG_NS = "http://www.w3.org/2000/svg";
// Root <svg> attributes that shouldn't be copied onto the wrapper <g>s.
const ROOT_ONLY = ["xmlns", "xmlns:xlink", "viewBox", "width", "height", "x", "y", "version", "preserveAspectRatio"];

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const stage = $<SVGSVGElement>("#stage");
const ghost = $<SVGGElement>("#ghost");
const content = $<SVGGElement>("#content");
const handles = $<SVGGElement>("#handles");
const cageEl = $<SVGPathElement>("#cage");
const cageRestEl = $<SVGPathElement>("#cage-rest");
const cageMorphEl = $<SVGPathElement>("#cage-morph");
const subdivInput = $<HTMLInputElement>("#subdiv");
const status = $<HTMLSpanElement>("#status");

let source: SVGSVGElement | null = null; // pristine imported root, never mutated (SVG imports only)
let kind: "svg" | "image" | null = null; // what's loaded; images can only be warped in raster mode
let isDefault = true; // showing a built-in sample, which follows the mode
let fileName = "warped";
let restCage: Pt[] = []; // cage around the original content, in order (starts as TL, TR, BR, BL)
let cage: Pt[] = []; // what the user has dragged it to

// ---------------------------------------------------------------- warp

// Every src/warp/*.ts exporting `weights` and `deformer` is a method:
//   weights(x, y, rest, log) → Float64Array    depends only on the rest cage, so it's cached
//   deformer(rest, moved, log) → (w, out) => void    called once per frame, then per point
// Cages are flat [x0, y0, x1, y1, …] arrays.
type Log = (...values: unknown[]) => void;
type Weights = (x: number, y: number, rest: Float64Array, log: Log) => Float64Array | undefined;
type Apply = (w: Float64Array, out: Float64Array) => void;
type Deformer = (rest: Float64Array, moved: Float64Array, log: Log) => Apply;
const noop: Log = () => {};
type Method = { label: string; weights: Weights; deformer: Deformer };

const modules = import.meta.glob<Record<string, unknown>>("./warp/*.ts", { eager: true });

const methods: Method[] = Object.entries(modules).flatMap(([path, mod]) => {
  const label = path.split("/").pop()!.replace(/\.ts$/, "");
  return typeof mod.weights === "function" && typeof mod.deformer === "function"
    ? [{ label, weights: mod.weights as Weights, deformer: mod.deformer as Deformer }]
    : [];
});

const methodSelect = $<HTMLSelectElement>("#method");
let method = methods[0];

// Curved edges are flattened into extra points (refreshed once per frame), so
// methods always see plain matching polygons. restVersion bumps whenever the
// flattened rest cage changes, which invalidates cached weights.
type Flat = { rest: Float64Array; moved: Float64Array };
let flat: Flat = { rest: new Float64Array(), moved: new Float64Array() };
let restVersion = 0;
let versions = 0; // source of restVersion values, unique across warp layers

// Multipass: warp layers run in order, each warping the previous one's output
// with its own cage pair. The layer being edited lives in the globals (restCage,
// cage, restCtrl, ctrl, …); `layers[active]` is synced from them before each frame.
type Layer = {
  restCage: Pt[]; cage: Pt[]; restCtrl: Ctrl[]; ctrl: Ctrl[];
  initialCage: Pt[]; initialCtrl: Ctrl[]; flat: Flat; restVersion: number;
};
let layers: Layer[] = [];
let active = 0;

function saveLayer() {
  layers[active] = { restCage, cage, restCtrl, ctrl, initialCage, initialCtrl, flat, restVersion };
}

function loadLayer(i: number) {
  active = i;
  ({ restCage, cage, restCtrl, ctrl, initialCage, initialCtrl, flat, restVersion } = layers[i]);
}

// Weights per render pass ("svg" paths, "raster" grid) and warp layer, indexed by
// call order. Each entry remembers its point, so a changed point is recomputed on its own.
type Pass = { key: string; pts: number[]; w: (Float64Array | null)[] };
let passes: Record<string, Pass> = {};
const clearWeights = () => (passes = {});

/** Returns a rest → deformed mapper through every warp layer, for one full pass over the same points. */
function beginPass(name: string): (p: Pt) => Pt {
  const maps = layers.map((L, i) => beginLayer(`${name}:${i}`, L));
  return (p) => maps.reduce((q, f) => f(q), p);
}

function beginLayer(name: string, L: Layer): (p: Pt) => Pt {
  const m = method;
  // An undeformed layer is the identity, so it's skipped.
  if (!m || L.flat.moved.every((v, k) => v === L.flat.rest[k])) return (p) => p;
  const key = `${m.label}|${L.restVersion}`;
  const pass = passes[name]?.key === key ? passes[name] : (passes[name] = { key, pts: [], w: [] });
  const flat = L.flat;
  let apply: Apply | null = null;
  try { apply = m.deformer(flat.rest, flat.moved, noop); } catch {}
  const out = new Float64Array(2);
  let i = 0;
  // Fall back to identity wherever the method doesn't give a real point.
  return (p) => {
    const k = i++;
    if (pass.pts[2 * k] !== p[0] || pass.pts[2 * k + 1] !== p[1] || pass.w[k] === undefined) {
      pass.pts[2 * k] = p[0];
      pass.pts[2 * k + 1] = p[1];
      try { pass.w[k] = m.weights(p[0], p[1], flat.rest, noop) ?? null; } catch { pass.w[k] = null; }
    }
    const w = pass.w[k];
    if (!apply || !w) return p;
    try { apply(w, out); } catch { return p; }
    return Number.isFinite(out[0]) && Number.isFinite(out[1]) ? [out[0], out[1]] : p;
  };
}

type Result = { out: Pt; error?: undefined } | { out?: undefined; error: string; detail?: unknown };

/** Runs the current method on one rest-space point (uncached) and says exactly what came back. */
function evaluate(p: Pt, log: Log = noop): Result {
  if (!method) return { error: "no method" };
  try {
    const w = method.weights(p[0], p[1], flat.rest, log);
    if (!w) return { error: `weights returned ${w}`, detail: w };
    const out = new Float64Array(2);
    method.deformer(flat.rest, flat.moved, log)(w, out);
    if (!Number.isFinite(out[0]) || !Number.isFinite(out[1])) return { error: `returned (${out[0]}, ${out[1]})`, detail: { weights: w, out } };
    return { out: [out[0], out[1]] };
  } catch (err) {
    return { error: `threw ${err instanceof Error ? err.message : String(err)}`, detail: err };
  }
}

/** Checks the method at the cage center; returns null if fine, otherwise a status message. */
let lastProblem = "";
function checkMethod(): string | null {
  if (!method) return "No functions exported from src/warp/*.ts";
  const p = centroid(restCage);
  const r = evaluate(p);
  if (!r.error) return (lastProblem = ""), null;

  const msg = `${method.label} ${r.error} for (${p.map((n) => n.toFixed(1)).join(", ")}) — showing unwarped`;
  // Log full inputs once per distinct problem so the console doesn't flood while dragging.
  if (msg !== lastProblem) {
    console.groupCollapsed(`[warp] ${msg}`);
    console.log("point", p);
    console.log("restCage", restCage);
    console.log("dragCage", cage);
    console.log("result", r.detail);
    console.groupEnd();
    lastProblem = msg;
  }
  return `${msg} (inputs in console)`;
}

function warpedClone() {
  const clone = source!.cloneNode(true) as SVGSVGElement;
  const n = Number(subdivInput.value);
  const deform = beginPass("svg");
  return warpSvgElement(clone, (curve: any) => mapPoints(subdivide(curve, n), deform)) as SVGSVGElement;
}

// ---------------------------------------------------------------- render

function fillGroup(g: SVGGElement, root: SVGSVGElement) {
  g.replaceChildren(...[...root.childNodes].map((n) => document.importNode(n, true)));
  for (const { name, value } of [...root.attributes]) {
    if (!ROOT_ONLY.includes(name)) g.setAttribute(name, value);
  }
}

// ---------------------------------------------------------------- raster mode

type Mode = "svg" | "raster";
let mode: Mode = "svg";
let texture: Texture | null = null;
const rasterCanvas = $<HTMLCanvasElement>("#raster");
const TEXTURE_PX = 2048; // longest side of the rasterized source
const meshSize = () => Number(subdivInput.value) * 6; // cells per side

async function buildTexture() {
  if (!source || !contentBox) return;
  // contentBox is the drawn extent (strokes included), so it's the whole picture;
  // the cage sits just outside it.
  const b = contentBox;
  const region = { x: b.x, y: b.y, w: b.width, h: b.height };
  const src = source;
  const tex = await rasterize(hasStrokes ? without(src, "stroke") : src, region, TEXTURE_PX);
  if (src === source) {
    texture = tex;
    render();
  }
}

function drawRaster() {
  const main = rasterCanvas.parentElement!;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(main.clientWidth * dpr), h = Math.round(main.clientHeight * dpr);
  if (rasterCanvas.width !== w || rasterCanvas.height !== h) {
    rasterCanvas.width = w;
    rasterCanvas.height = h;
  }
  const ctx = rasterCanvas.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const ctm = stage.getScreenCTM();
  if (mode !== "raster" || !texture || !ctm) return;

  // SVG units → canvas pixels via the stage's current zoom/pan.
  const origin = main.getBoundingClientRect();
  const toPx = ([x, y]: Pt): Pt => {
    const p = new DOMPoint(x, y).matrixTransform(ctm);
    return [(p.x - origin.left) * dpr, (p.y - origin.top) * dpr];
  };
  drawMesh(ctx, texture, warpGrid(texture, meshSize(), beginPass("raster")), toPx);
}

// Built-in samples: which file to load in each mode.
const SAMPLES: Record<string, { label: string; files: Record<Mode, string> }> = {
  checkerboard: { label: "Checkerboard", files: { svg: "/checkerboard.svg", raster: "/checkerboard.png" } },
  shapes: { label: "Shapes", files: { svg: "/example.svg", raster: "/example.svg" } },
};
const sampleSelect = $<HTMLSelectElement>("#sample");
let sample = "checkerboard";
try {
  const saved = localStorage.getItem("warp:sample");
  if (saved && saved in SAMPLES) sample = saved;
} catch {}

function setMode(m: Mode) {
  if (m === "svg" && kind === "image" && !isDefault) {
    status.textContent = "Images can only be warped in raster mode — import an SVG for vector mode.";
    return;
  }
  const changed = m !== mode;
  mode = m;
  for (const b of document.querySelectorAll<HTMLButtonElement>("#mode button")) {
    b.classList.toggle("on", b.dataset.mode === m);
  }
  $("#subdiv-label").textContent = m === "svg" ? "Subdivisions" : "Mesh";
  $("#export").textContent = m === "svg" ? "Export SVG" : "Export PNG";
  try { localStorage.setItem("warp:mode", m); } catch {}
  if (isDefault && changed && kind && SAMPLES[sample].files.svg !== SAMPLES[sample].files.raster) return loadDefault();
  if (m === "raster" && !texture) buildTexture();
  render();
}

let frame = 0;
function render() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    if (!kind) return;
    refreshFlat();
    const strokesOnly = mode === "raster" && hasStrokes;
    content.style.display = mode === "svg" || strokesOnly ? "" : "none";
    if (mode === "svg" && source) fillGroup(content, warpedClone());
    else if (strokesOnly && source) fillGroup(content, without(warpedClone(), "fill"));
    drawRaster();
    drawCage();
    drawDial();
    drawPoints();
    checkCage();
    const picked = (layers.length > 1 ? `Pass ${active + 1} of ${layers.length} · ` : "") + (selected.size ? `${selected.size} selected · ` : "");
    status.textContent = checkMethod() ?? picked + (cageWarning || cage.map(([x, y]) => `(${x.toFixed(0)}, ${y.toFixed(0)})`).join("  "));
  });
}

function drawCage() {
  // The cage being edited is drawn solid; the other one dashed.
  const [solid, solidCtrl, dashed, dashedCtrl] = cageMode === "deform"
    ? [cage, ctrl, restCage, restCtrl]
    : [restCage, restCtrl, cage, ctrl];
  cageEl.setAttribute("d", cagePath(solid, shownCtrl(solid, solidCtrl)));
  cageRestEl.setAttribute("d", cagePath(dashed, shownCtrl(dashed, dashedCtrl)));
  // The in-between cage the warp is using while morphing.
  if (morph !== 1 && restCage.length) {
    const mix = (a: Pt, b: Pt): Pt => lerp(a, b, morph);
    const shownRest = shownCtrl(restCage, restCtrl), shownMoved = shownCtrl(cage, ctrl);
    const c = restCage.map((p, i) => mix(p, cage[i]));
    const k = shownRest.map(([a, b], i) => [mix(a, shownMoved[i][0]), mix(b, shownMoved[i][1])] as Ctrl);
    cageMorphEl.setAttribute("d", cagePath(c, k));
  } else {
    cageMorphEl.removeAttribute("d");
  }

  // Keep handles ~7px on screen regardless of zoom.
  const scale = stage.getScreenCTM()?.a || 1;
  const r = 7 / scale;
  [...handles.children].forEach((h, i) => {
    h.setAttribute("cx", String(solid[i][0]));
    h.setAttribute("cy", String(solid[i][1]));
    h.setAttribute("r", String(r));
    h.classList.toggle("selected", selected.has(i));
  });

  // Bezier control handles: arm from each anchor to its control point.
  const s = 4.5 / scale;
  ctrlLayer.replaceChildren(...(curvesOn ? solidCtrl : []).flatMap(([c1, c2], i) => {
    const a = solid[i], b = solid[(i + 1) % solid.length];
    return ([[a, c1, 0], [b, c2, 1]] as [Pt, Pt, number][]).flatMap(([anchor, c, k]) => {
      const knob = svgEl("rect", { class: "ctrl-handle", x: c[0] - s, y: c[1] - s, width: s * 2, height: s * 2 });
      knob.dataset.edge = String(i);
      knob.dataset.k = String(k);
      return [svgEl("line", { class: "ctrl-arm", x1: anchor[0], y1: anchor[1], x2: c[0], y2: c[1] }), knob];
    });
  }));

  // Wide invisible hit paths on each edge, for double-click-to-insert.
  edgeHits.replaceChildren(...solid.map((a, i) => {
    const b = solid[(i + 1) % solid.length];
    const [c1, c2] = shownCtrl(solid, solidCtrl)[i];
    const hit = svgEl("path", { class: "edge-hit", d: `M${a}C${c1} ${c2} ${b}` });
    hit.dataset.edge = String(i);
    return hit;
  }));
}

const cagePath = (c: Pt[], k: Ctrl[]) =>
  c.map((p, i) => `${i ? "" : `M${p}`}C${k[i][0]} ${k[i][1]} ${c[(i + 1) % c.length]}`).join("") + "Z";

// ---------------------------------------------------------------- import

type Box = { x: number; y: number; width: number; height: number };
let contentBox: Box | null = null;

// The rest cage sits this far outside the content (fraction of its longest side),
// so no warped point ever lies on or outside the cage.
// Kept tiny so the cage hugs the shape, but non-zero: methods like Green's
// coordinates are undefined on the cage itself.
const CAGE_MARGIN = 0.005;
const cageMargin = (b: Box) => Math.max(b.width, b.height) * CAGE_MARGIN;

/** Sets up the cage, view and console around content occupying `box`. */
function setup(box: Box, name: string) {
  fileName = name.replace(/\.[a-z]+$/i, "") + "-warped";
  contentBox = box;
  const m = cageMargin(box);
  initialCage = [
    [box.x - m, box.y - m],
    [box.x + box.width + m, box.y - m],
    [box.x + box.width + m, box.y + box.height + m],
    [box.x - m, box.y + box.height + m],
  ];
  restCage = initialCage.map((p) => [...p] as Pt);
  cage = initialCage.map((p) => [...p] as Pt);
  restCtrl = straightCtrl(restCage);
  ctrl = straightCtrl(cage);
  initialCtrl = straightCtrl(initialCage);
  checkedFor = "";
  layers = [];
  active = 0;
  saveLayer();
  buildPassButtons();

  // Leave room around the content to drag the cage outward.
  const pad = Math.max(box.width, box.height) * 0.4;
  fitView = { x: box.x - pad, y: box.y - pad, w: box.width + pad * 2, h: box.height + pad * 2 };
  setView({ ...fitView });

  clearWeights();
  cageChanged();
  ($<HTMLButtonElement>('#mode [data-mode="svg"]')).disabled = kind === "image" && !isDefault;
}

/**
 * The SVG's drawn extent (strokes, markers, etc. included), found by rasterizing
 * around the geometric bbox and trimming transparent pixels. Never smaller than
 * the geometry, so every path point stays strictly inside the cage.
 */
async function drawnBox(root: SVGSVGElement, g: Box): Promise<Box> {
  const pad = Math.max(g.width, g.height) * 0.25;
  const region = { x: g.x - pad, y: g.y - pad, w: g.width + pad * 2, h: g.height + pad * 2 };
  let tex: Texture;
  try {
    tex = await rasterize(root, region, 1024);
  } catch {
    return g;
  }
  const b = alphaBounds(tex.image, tex.width, tex.height);
  if (!b) return g;
  const unit = region.w / tex.width; // SVG units per pixel; pad by one to cover antialiasing
  const x0 = Math.min(g.x, region.x + (b.x0 - 1) * unit);
  const y0 = Math.min(g.y, region.y + (b.y0 - 1) * unit);
  const x1 = Math.max(g.x + g.width, region.x + (b.x1 + 1) * unit);
  const y1 = Math.max(g.y + g.height, region.y + (b.y1 + 1) * unit);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// Elements the warp can't reshape.
const UNWARPABLE = ["text", "image", "use", "foreignObject"];

/**
 * Checks what's in `root`: a reason it can't be warped (or null), and whether
 * any shape has a visible stroke. Uses a hidden attached copy so CSS, inherited
 * and presentation attributes all resolve.
 */
function inspect(root: SVGSVGElement): { problem: string | null; stroked: boolean } {
  const host = document.body.appendChild(svgEl("svg", { width: 0, height: 0, style: "position:absolute;visibility:hidden" }));
  try {
    const copy = host.appendChild(document.importNode(root, true));
    const stroked = [...copy.querySelectorAll(SHAPES.join(","))].some((el) => {
      const s = getComputedStyle(el);
      return s.display !== "none" && s.stroke !== "none" && parseFloat(s.strokeWidth) > 0 && parseFloat(s.strokeOpacity) > 0;
    });
    const found = UNWARPABLE.map((tag) => {
      const n = copy.querySelectorAll(tag).length;
      return n ? `${n} <${tag}>` : "";
    }).filter(Boolean);
    const problem = found.length
      ? `Only vector shapes can be warped. This SVG has ${found.join(", ")}. Convert text/images to paths first.`
      : null;
    return { problem, stroked };
  } finally {
    host.remove();
  }
}

// Strokes are drawn at their own width after warping (as in SVG mode), so raster
// mode warps a fills-only texture and draws the warped strokes on top as vectors.
let hasStrokes = false;

/** Copy of `root` with every shape set to `prop: none`. */
function without(root: SVGSVGElement, prop: "fill" | "stroke") {
  const clone = root.cloneNode(true) as SVGSVGElement;
  for (const el of clone.querySelectorAll<SVGElement>(SHAPES.join(","))) el.style.setProperty(prop, "none", "important");
  return clone;
}

let loadToken = 0;
async function load(text: string, name = "warped", builtIn = false) {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement as unknown as SVGSVGElement;
  if (root.nodeName !== "svg" || doc.querySelector("parsererror")) {
    status.textContent = "That file isn't a valid SVG.";
    return;
  }
  // A shape with id="cage" is the rest cage, not artwork.
  const tagged = root.querySelector("#cage");
  const embedded = tagged && findCageShape(root);
  const rest = embedded ? cageFromShape(embedded) : null;
  const preset = rest && withDeformed(root, rest);
  tagged?.remove();
  root.querySelector("#cage-deformed")?.remove();

  const geometry = contentBBox(root);
  if (!geometry) {
    status.textContent = "No paths or shapes found in that SVG.";
    return;
  }
  const { problem, stroked } = inspect(root);
  if (problem) {
    status.textContent = problem;
    return;
  }
  const token = ++loadToken;
  const box = await drawnBox(root, geometry);
  if (token !== loadToken) return; // a newer load started meanwhile

  source = root;
  hasStrokes = stroked;
  kind = "svg";
  isDefault = builtIn;
  texture = null;
  fillGroup(ghost, root);
  sampleContent(root, box);
  setup(box, name);
  if (preset) applyCage(preset);
  else if (tagged) status.textContent = `Couldn't read the id="cage" shape (needs ${MIN_VERTICES}+ points), using the default cage.`;
  if (mode === "raster") buildTexture();
  render();
}

let imageUrl = "";
async function loadImage(blob: Blob, name: string, builtIn = false) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    status.textContent = "Couldn't read that image.";
    return;
  }
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = url;

  const width = img.naturalWidth, height = img.naturalHeight;
  // Image pixels are the SVG units. Trim transparent borders so the cage hugs
  // what's actually drawn; the texture is that cropped area.
  const b = alphaBounds(img, width, height);
  if (!b) {
    status.textContent = "That image is fully transparent.";
    return;
  }
  ++loadToken;
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  const cropped = document.createElement("canvas");
  cropped.width = w;
  cropped.height = h;
  cropped.getContext("2d")!.drawImage(b.canvas, b.x0, b.y0, w, h, 0, 0, w, h);
  texture = { image: cropped, region: { x: b.x0, y: b.y0, w, h }, width: w, height: h };
  source = null;
  hasStrokes = false;
  kind = "image";
  isDefault = builtIn;
  ghost.replaceChildren(svgEl("image", { href: url, x: 0, y: 0, width, height }));
  content.replaceChildren();
  sampleContent(null, { x: b.x0, y: b.y0, width: w, height: h });
  setup({ x: b.x0, y: b.y0, width: w, height: h }, name);
  if (mode !== "raster") setMode("raster");
  else render();
}

async function loadDefault() {
  const path = SAMPLES[sample].files[mode];
  sampleSelect.value = sample;
  const res = await fetch(path);
  const name = path.slice(1);
  if (/\.svg$/i.test(path)) load(await res.text(), name, true);
  else loadImage(await res.blob(), name, true);
}

async function loadFile(file: File) {
  const isSvg = file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
  sampleSelect.value = "";
  if (isSvg) load(await file.text(), file.name);
  else if (file.type.startsWith("image/")) loadImage(file, file.name);
  else status.textContent = "Import an SVG or an image (PNG, JPEG, WebP…).";
}

// ---------------------------------------------------------------- drag

function toSvg(e: MouseEvent): Pt {
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(stage.getScreenCTM()!.inverse());
  return [p.x, p.y];
}

// ---------------------------------------------------------------- selection

// Selected vertices (indices into the cage) move together. Click selects one,
// shift-click toggles, the lasso (L, or shift-drag on the canvas) selects by area.
// Indices shift when points are added or removed, so that clears the selection.
let selected = new Set<number>();
let lassoTool = false;

function select(next: Iterable<number>) {
  selected = new Set(next);
  render();
}

/** Moves every selected vertex by (dx, dy) in the active cage. */
function moveSelection(dx: number, dy: number) {
  for (const j of selected) {
    const p = activeCage()[j];
    moveVertex(j, [p[0] + dx, p[1] + dy]);
  }
}

function removeSelection() {
  const doomed = [...selected].sort((a, b) => b - a);
  const room = restCage.length - MIN_VERTICES;
  if (doomed.length > room) status.textContent = `The cage needs at least ${MIN_VERTICES} points.`;
  for (const i of doomed.slice(0, Math.max(0, room))) removeVertex(i);
}

function setLassoTool(on: boolean) {
  lassoTool = on;
  $("#lasso-tool").classList.toggle("on", on);
  stage.classList.toggle("lasso-tool", on);
}

function makeHandle(i: number) {
  const h = document.createElementNS(SVG_NS, "circle");
  h.classList.add("handle");
  let last: Pt = [0, 0];

  h.addEventListener("pointerdown", (e) => {
    if (e.altKey || e.button === 2) return; // removal, see below
    if (e.shiftKey) {
      const next = new Set(selected);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      select(next);
      if (!next.has(i)) return;
    } else if (!selected.has(i)) {
      select([i]);
    }
    h.setPointerCapture(e.pointerId);
    h.classList.add("active");
    last = toSvg(e);
  });
  h.addEventListener("pointermove", (e) => {
    if (!h.hasPointerCapture(e.pointerId)) return;
    const p = toSvg(e);
    moveSelection(p[0] - last[0], p[1] - last[1]);
    last = p;
    render();
  });
  h.addEventListener("click", (e) => {
    if (e.altKey) removeVertex(i);
  });
  h.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    removeVertex(i);
  });
  h.addEventListener("pointerup", () => h.classList.remove("active"));
  h.addEventListener("lostpointercapture", () => h.classList.remove("active"));
  return h;
}

// ---------------------------------------------------------------- cage editing

// "deform" drags the deformed cage; "edit" reshapes the rest cage (the deformed
// vertex follows, keeping its current offset).
type CageMode = "deform" | "edit";
let cageMode: CageMode = "deform";
let initialCage: Pt[] = [];
const edgeHits = $<SVGGElement>("#edge-hits");
const ctrlLayer = $<SVGGElement>("#ctrls");

// Each edge i (vertex i → i+1) is a cubic Bezier with control points [c1, c2].
type Ctrl = [Pt, Pt];
let restCtrl: Ctrl[] = [];
let ctrl: Ctrl[] = [];
const CURVE_SAMPLES = 16; // points per curved edge when flattening for interp

let curvesOn = true;
try { curvesOn = localStorage.getItem("warp:curves") !== "off"; } catch {}

// With curves off every edge acts straight; stored control points are kept for later.
const activeCtrl = () => (cageMode === "deform" ? ctrl : restCtrl);
const shownCtrl = (c: Pt[], k: Ctrl[]) => (curvesOn ? k : straightCtrl(c));
const straightCtrl = (c: Pt[]): Ctrl[] =>
  c.map((a, i) => {
    const b = c[(i + 1) % c.length];
    return [lerp(a, b, 1 / 3), lerp(a, b, 2 / 3)];
  });

function bezier(p0: Pt, c1: Pt, c2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0], a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1]];
}

/** Whether edge i of layer L is curved in either cage (control points off the 1/3, 2/3 marks). */
function isCurved(L: Layer, i: number) {
  if (!curvesOn) return false;
  return [[L.restCage, L.restCtrl], [L.cage, L.ctrl]].some(([c, k]) => {
    const a = (c as Pt[])[i], b = (c as Pt[])[(i + 1) % c.length];
    const [c1, c2] = (k as Ctrl[])[i];
    const tol = 1e-9 * (Math.hypot(b[0] - a[0], b[1] - a[1]) + 1);
    const t1 = lerp(a, b, 1 / 3), t2 = lerp(a, b, 2 / 3);
    return Math.hypot(c1[0] - t1[0], c1[1] - t1[1]) > tol || Math.hypot(c2[0] - t2[0], c2[1] - t2[1]) > tol;
  });
}

/** Rebuilds the flattened polygons handed to interp functions, for every warp layer. */
function refreshFlat() {
  saveLayer();
  for (const L of layers) flatten(L);
  ({ flat, restVersion } = layers[active]);
}

function flatten(L: Layer) {
  const { restCage, cage, restCtrl, ctrl } = L;
  const rest: number[] = [], moved: number[] = [];
  restCage.forEach((_, i) => {
    rest.push(...restCage[i]);
    moved.push(...cage[i]);
    if (!isCurved(L, i)) return;
    const j = (i + 1) % restCage.length;
    for (let k = 1; k < CURVE_SAMPLES; k++) {
      const t = k / CURVE_SAMPLES;
      rest.push(...bezier(restCage[i], ...restCtrl[i], restCage[j], t));
      moved.push(...bezier(cage[i], ...ctrl[i], cage[j], t));
    }
  });
  if (rest.length !== L.flat.rest.length || rest.some((v, k) => v !== L.flat.rest[k])) L.restVersion = ++versions;
  // Morph: the warp uses the cage `morph` of the way from rest to deformed.
  if (morph !== 1) for (let k = 0; k < moved.length; k++) moved[k] = rest[k] + morph * (moved[k] - rest[k]);
  L.flat = { rest: Float64Array.from(rest), moved: Float64Array.from(moved) };
}

/** Maps flat [x0, y0, …] points through the first `upTo` warp layers (uncached). */
function throughLayers(pts: number[], upTo: number): number[] {
  const m = method;
  const out = pts.slice();
  if (!m) return out;
  const o = new Float64Array(2);
  for (const L of layers.slice(0, upTo)) {
    let apply: Apply;
    try { apply = m.deformer(L.flat.rest, L.flat.moved, noop); } catch { continue; }
    for (let i = 0; i < out.length; i += 2) {
      try {
        const w = m.weights(out[i], out[i + 1], L.flat.rest, noop);
        if (!w) continue;
        apply(w, o);
        if (Number.isFinite(o[0]) && Number.isFinite(o[1])) (out[i] = o[0]), (out[i + 1] = o[1]);
      } catch {}
    }
  }
  return out;
}

// ---------------------------------------------------------------- multipass

const passButtons = $<HTMLDivElement>("#passes");

function buildPassButtons() {
  passButtons.replaceChildren(...layers.map((_, i) => {
    const b = el("button", { textContent: String(i + 1), title: `Edit warp pass ${i + 1}` });
    b.classList.toggle("on", i === active);
    b.addEventListener("click", () => switchLayer(i));
    return b;
  }));
  $<HTMLButtonElement>("#pass-remove").disabled = layers.length < 2;
}

function switchLayer(i: number) {
  if (i === active || !layers[i]) return;
  stopDial();
  saveLayer();
  loadLayer(i);
  dialBase = null;
  dialAngle = 0;
  checkedFor = "";
  buildPassButtons();
  cageChanged();
}

/**
 * Adds a warp pass after the last one, with a plain rectangle cage around
 * everything the earlier passes produce. Deforming it warps that result again.
 */
function addLayer() {
  if (!kind || !contentBox) return;
  refreshFlat();
  const b = contentBox;
  const pts = [...contentPts];
  for (let t = 0; t < 1; t += 1 / 32) {
    pts.push(b.x + b.width * t, b.y, b.x + b.width, b.y + b.height * t);
    pts.push(b.x + b.width * (1 - t), b.y + b.height, b.x, b.y + b.height * (1 - t));
  }
  const out = throughLayers(pts, layers.length);
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (let i = 0; i < out.length; i += 2) {
    x1 = Math.min(x1, out[i]); x2 = Math.max(x2, out[i]);
    y1 = Math.min(y1, out[i + 1]); y2 = Math.max(y2, out[i + 1]);
  }
  if (!Number.isFinite(x1)) return;
  // Sampled points can miss a curve's furthest bulge, so leave a bit more room than the first cage.
  const m = cageMargin({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 }) * 4;
  const rect: Pt[] = [[x1 - m, y1 - m], [x2 + m, y1 - m], [x2 + m, y2 + m], [x1 - m, y2 + m]];
  layers.push({
    restCage: copyCage(rect), cage: copyCage(rect), restCtrl: straightCtrl(rect), ctrl: straightCtrl(rect),
    initialCage: copyCage(rect), initialCtrl: straightCtrl(rect),
    flat: { rest: new Float64Array(), moved: new Float64Array() }, restVersion: 0,
  });
  switchLayer(layers.length - 1);
}

/** Removes the pass being edited (later passes keep their cages). */
function removeLayer() {
  if (layers.length < 2) return;
  stopDial();
  layers.splice(active, 1);
  loadLayer(Math.max(0, active - 1));
  dialBase = null;
  dialAngle = 0;
  checkedFor = "";
  clearWeights();
  buildPassButtons();
  cageChanged();
}

$("#pass-add").addEventListener("click", addLayer);
$("#pass-remove").addEventListener("click", removeLayer);

// ---------------------------------------------------------------- morph

// Tweens the warp between the original (0) and the deformation (1) without
// changing either cage. Animate loops it back and forth with an ease in/out.
const MORPH_PERIOD = 3000; // ms for a full there-and-back
const morphInput = $<HTMLInputElement>("#morph");
const morphButton = $<HTMLButtonElement>("#morph-play");
let morph = 1;
let morphFrame = 0;

function setMorph(t: number) {
  morph = t;
  morphInput.value = String(Math.round(t * 100));
  $("#morph-val").textContent = `${Math.round(t * 100)}%`;
}

function playMorph() {
  if (!kind || morphFrame) return;
  // Start the cosine wherever the slider is, so playback doesn't jump.
  const phase = Math.acos(1 - 2 * morph);
  const start = performance.now() - (phase / (2 * Math.PI)) * MORPH_PERIOD;
  const tick = (now: number) => {
    setMorph((1 - Math.cos((2 * Math.PI * (now - start)) / MORPH_PERIOD)) / 2);
    render();
    morphFrame = requestAnimationFrame(tick);
  };
  morphFrame = requestAnimationFrame(tick);
  morphButton.textContent = "Stop";
  morphButton.classList.add("on");
}

function stopMorph() {
  if (!morphFrame) return;
  cancelAnimationFrame(morphFrame);
  morphFrame = 0;
  morphButton.textContent = "Animate";
  morphButton.classList.remove("on");
}

const toggleMorph = () => (morphFrame ? stopMorph() : playMorph());
morphButton.addEventListener("click", toggleMorph);
morphInput.addEventListener("input", () => {
  stopMorph();
  setMorph(Number(morphInput.value) / 100);
  render();
});
// Double-click the slider to snap back to the full deformation.
morphInput.addEventListener("dblclick", () => {
  stopMorph();
  setMorph(1);
  render();
});
setMorph(1);
const MIN_VERTICES = 3;

const activeCage = () => (cageMode === "deform" ? cage : restCage);
const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

function centroid(c: Pt[]): Pt {
  const n = c.length || 1;
  return [c.reduce((s, p) => s + p[0], 0) / n, c.reduce((s, p) => s + p[1], 0) / n];
}

const shift = (p: Pt, dx: number, dy: number): Pt => [p[0] + dx, p[1] + dy];

/** Moves vertex i of the active cage; its two control points travel with it. */
function moveVertex(i: number, to: Pt) {
  const n = restCage.length, prev = (i - 1 + n) % n;
  const layers: [Pt[], Ctrl[]][] = cageMode === "deform" ? [[cage, ctrl]] : [[restCage, restCtrl], [cage, ctrl]];
  // In edit mode the deformed vertex follows the rest vertex by the same delta.
  const dx = to[0] - activeCage()[i][0], dy = to[1] - activeCage()[i][1];
  for (const [c, k] of layers) {
    c[i] = shift(c[i], dx, dy);
    k[i][0] = shift(k[i][0], dx, dy);
    k[prev][1] = shift(k[prev][1], dx, dy);
  }
}

/** Moves control point k (0 = c1, 1 = c2) of edge i in the active cage. */
function moveCtrl(i: number, k: 0 | 1, to: Pt) {
  const cur = activeCtrl()[i][k];
  const dx = to[0] - cur[0], dy = to[1] - cur[1];
  activeCtrl()[i][k] = to;
  if (cageMode === "edit") ctrl[i][k] = shift(ctrl[i][k], dx, dy);
}

/** Splits edge i at parameter t in both cages (de Casteljau), keeping its shape. */
function insertVertex(i: number, t: number) {
  const j = (i + 1) % restCage.length;
  for (const [c, k] of [[restCage, restCtrl], [cage, ctrl]] as [Pt[], Ctrl[]][]) {
    const [c1, c2] = shownCtrl(c, k)[i];
    const a = lerp(c[i], c1, t), b = lerp(c1, c2, t), cc = lerp(c2, c[j], t);
    const d = lerp(a, b, t), e = lerp(b, cc, t), f = lerp(d, e, t);
    c.splice(i + 1, 0, f);
    k.splice(i, 1, [a, d], [e, cc]);
  }
  cageChanged();
}

/** Removes vertex i, joining its two edges into one (outer control points kept). */
function removeVertex(i: number) {
  if (restCage.length <= MIN_VERTICES) {
    status.textContent = `The cage needs at least ${MIN_VERTICES} points.`;
    return;
  }
  const n = restCage.length, prev = (i - 1 + n) % n;
  for (const [c, k] of [[restCage, restCtrl], [cage, ctrl]] as [Pt[], Ctrl[]][]) {
    k[prev] = [k[prev][0], k[i][1]];
    k.splice(i, 1);
    c.splice(i, 1);
  }
  cageChanged();
}

/** Makes edge i straight again in the active cage (and the deformed one in edit mode). */
function straightenEdge(i: number) {
  const layers: [Pt[], Ctrl[]][] = cageMode === "deform" ? [[cage, ctrl]] : [[restCage, restCtrl], [cage, ctrl]];
  for (const [c, k] of layers) {
    const a = c[i], b = c[(i + 1) % c.length];
    k[i] = [lerp(a, b, 1 / 3), lerp(a, b, 2 / 3)];
  }
  render();
}

// Drag a control knob to curve its edge; double-click it to straighten the edge.
ctrlLayer.addEventListener("pointerdown", (e) => {
  const knob = e.target as SVGElement;
  if (!knob.classList.contains("ctrl-handle")) return;
  e.stopPropagation();
  const i = Number(knob.dataset.edge), k = Number(knob.dataset.k) as 0 | 1;
  const [x, y] = toSvg(e);
  const c = activeCtrl()[i][k];
  const offset: Pt = [c[0] - x, c[1] - y];
  // Window listeners rather than pointer capture, so dblclick still targets the knob.
  const move = (ev: PointerEvent) => {
    const [mx, my] = toSvg(ev);
    moveCtrl(i, k, [mx + offset[0], my + offset[1]]);
    render();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
});
ctrlLayer.addEventListener("dblclick", (e) => {
  const knob = e.target as SVGElement;
  if (knob.classList.contains("ctrl-handle")) straightenEdge(Number(knob.dataset.edge));
});

/** Call after the number of vertices changes. */
function cageChanged() {
  selected = new Set();
  handles.replaceChildren(...cage.map((_, i) => makeHandle(i)));
  buildCageRows();
  render();
}

function setCageMode(m: CageMode) {
  if (m === "edit") stopDial();
  cageMode = m;
  for (const b of document.querySelectorAll<HTMLButtonElement>("#cage-mode button")) {
    b.classList.toggle("on", b.dataset.cageMode === m);
  }
  $("#reset").textContent = m === "deform" ? "Reset cage" : "Reset shape";
  $("#reset").title = m === "deform" ? "Undo the deformation" : "Back to the original cage";
  buildCageRows();
  render();
}

for (const b of document.querySelectorAll<HTMLButtonElement>("#cage-mode button")) {
  b.addEventListener("click", () => setCageMode(b.dataset.cageMode as CageMode));
}

const curvesInput = $<HTMLInputElement>("#curves");
curvesInput.checked = curvesOn;
curvesInput.addEventListener("change", () => {
  curvesOn = curvesInput.checked;
  try { localStorage.setItem("warp:curves", curvesOn ? "on" : "off"); } catch {}
  render();
});

// ---------------------------------------------------------------- dial

// A ring at the cage center. Turning it carries the deformation around the cage:
// each pull (deformed − rest) is stored in its point's outward/sideways frame,
// read as a loop over angle, and re-sampled rotated by the knob's angle θ. So a
// pull on one point slides to its neighbours as you turn, outward stays outward,
// and a full turn comes back. Shift snaps to angles that land points on points;
// double-click returns to the top. Any other cage edit rebases it.
const dialLayer = $<SVGGElement>("#dial");
const dialInput = $<HTMLInputElement>("#dial-on");
let dialOn = false;
try { dialOn = localStorage.getItem("warp:dial") === "on"; } catch {}
dialInput.checked = dialOn;
let dialAngle = 0;
let dialBase: { cage: Pt[]; ctrl: Ctrl[] } | null = null;
let dialLast = ""; // the cage the dial last produced

const TAU = 2 * Math.PI;
const cageKey = () => JSON.stringify([cage, ctrl]);
const wrap = (a: number) => ((a % TAU) + TAU) % TAU;
/** Angle of `p` around `c`, clockwise from the top (same as the knob). */
const angleAround = (c: Pt, p: Pt) => wrap(Math.atan2(p[0] - c[0], c[1] - p[1]));

/** Drops the dial's base if the cage was edited some other way since the dial last set it. */
function syncDial() {
  if (dialBase && cageKey() !== dialLast) {
    dialBase = null;
    dialAngle = 0;
  }
}

// The pull loop is resampled into FIELD_RES bins around the circle, so it can be
// blurred by `spread` (a wrapped Gaussian, σ in degrees) to share each pull with
// its neighbours. Spread 0 is plain point-to-point interpolation.
const FIELD_RES = 720;
type Field = { o: Float64Array; t: Float64Array };
const spreadInput = $<HTMLInputElement>("#dial-spread");
try { spreadInput.value = localStorage.getItem("warp:spread") ?? spreadInput.value; } catch {}
const dialSpread = () => (Number(spreadInput.value) * Math.PI) / 180;

/** Each rest point's pull as (outward, clockwise) components around `c`, as a blurred loop over angle. */
function pullField(c: Pt, rest: Pt[], base: Pt[], spread: number): Field {
  const nodes = rest.map((r, i) => {
    const a = angleAround(c, r);
    const d: Pt = [base[i][0] - r[0], base[i][1] - r[1]];
    return { a, o: d[0] * Math.sin(a) - d[1] * Math.cos(a), t: d[0] * Math.cos(a) + d[1] * Math.sin(a) };
  }).sort((p, q) => p.a - q.a);
  const o = new Float64Array(FIELD_RES), t = new Float64Array(FIELD_RES);
  for (let b = 0; b < FIELD_RES; b++) {
    const a = (b / FIELD_RES) * TAU;
    let k = nodes.findIndex((n) => n.a > a) - 1;
    if (k < 0) k = nodes.length - 1; // before the first node: between the last and first
    const p = nodes[k], q = nodes[(k + 1) % nodes.length];
    const f = wrap(a - p.a) / (wrap(q.a - p.a) || TAU);
    o[b] = p.o + (q.o - p.o) * f;
    t[b] = p.t + (q.t - p.t) * f;
  }
  const sigma = (spread / TAU) * FIELD_RES;
  if (sigma < 0.5) return { o, t };
  const reach = Math.min(Math.ceil(sigma * 3), FIELD_RES);
  const kernel = Array.from({ length: 2 * reach + 1 }, (_, k) => Math.exp(-(((k - reach) / sigma) ** 2) / 2));
  const sum = kernel.reduce((a, b) => a + b, 0);
  const bo = new Float64Array(FIELD_RES), bt = new Float64Array(FIELD_RES);
  for (let b = 0; b < FIELD_RES; b++) {
    let so = 0, st = 0;
    for (let k = 0; k < kernel.length; k++) {
      const src = (((b + k - reach) % FIELD_RES) + FIELD_RES) % FIELD_RES;
      so += kernel[k] * o[src];
      st += kernel[k] * t[src];
    }
    bo[b] = so / sum;
    bt[b] = st / sum;
  }
  return { o: bo, t: bt };
}

/** Moves the pulls `theta` further around (clockwise), read from `field`. */
function carryPulls(c: Pt, rest: Pt[], field: Field, theta: number): Pt[] {
  return rest.map((r) => {
    const a = angleAround(c, r);
    const x = (wrap(a - theta) / TAU) * FIELD_RES, b0 = Math.floor(x) % FIELD_RES, b1 = (b0 + 1) % FIELD_RES, f = x - Math.floor(x);
    const o = field.o[b0] + (field.o[b1] - field.o[b0]) * f, t = field.t[b0] + (field.t[b1] - field.t[b0]) * f;
    return [r[0] + o * Math.sin(a) + t * Math.cos(a), r[1] - o * Math.cos(a) + t * Math.sin(a)];
  });
}

// Fields are rebuilt only when the base or spread changes, not on every move.
let dialFields: { base: object; spread: number; cage: Field; ctrl: Field } | null = null;

function setDialAngle(theta: number) {
  if (!dialBase) dialBase = { cage: copyCage(cage), ctrl: copyCtrl(ctrl) };
  const { c } = dialGeometry();
  const spread = dialSpread();
  if (dialFields?.base !== dialBase || dialFields.spread !== spread) {
    dialFields = {
      base: dialBase,
      spread,
      cage: pullField(c, restCage, dialBase.cage, spread),
      ctrl: pullField(c, restCtrl.flat(), dialBase.ctrl.flat(), spread),
    };
  }
  cage = carryPulls(c, restCage, dialFields.cage, theta);
  const moved = carryPulls(c, restCtrl.flat(), dialFields.ctrl, theta);
  ctrl = restCtrl.map((_, i) => [moved[2 * i], moved[2 * i + 1]] as Ctrl);
  dialAngle = theta;
  dialLast = cageKey();
}

spreadInput.addEventListener("input", () => {
  $("#dial-spread-val").textContent = `${spreadInput.value}°`;
  try { localStorage.setItem("warp:spread", spreadInput.value); } catch {}
  syncDial();
  if (dialBase) setDialAngle(dialAngle);
  render();
});
$("#dial-spread-val").textContent = `${spreadInput.value}°`;

/** Ring at the rest cage's centroid, sized from the rest cage so it stays put while turning. */
function dialGeometry() {
  const c = centroid(restCage);
  const xs = restCage.map((p) => p[0]), ys = restCage.map((p) => p[1]);
  const r = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 0.3;
  return { c, r };
}

function drawDial() {
  syncDial();
  if (!dialOn || cageMode !== "deform" || !restCage.length) return dialLayer.replaceChildren();
  const { c, r } = dialGeometry();
  const px = 1 / (stage.getScreenCTM()?.a || 1);
  const onRing = (theta: number, rr = r): Pt => [c[0] + rr * Math.sin(theta), c[1] - rr * Math.cos(theta)];
  // A tick toward each cage point.
  const ticks = restCage.map((p) => {
    const a = angleAround(c, p);
    const [x1, y1] = onRing(a, r - 5 * px), [x2, y2] = onRing(a, r + 5 * px);
    return svgEl("line", { class: "dial-tick", x1, y1, x2, y2 });
  });
  const [kx, ky] = onRing(dialAngle);
  // Arc showing how far each pull is shared (±σ around the knob).
  const sp = Math.min(dialSpread(), Math.PI - 1e-3);
  const [sx, sy] = onRing(dialAngle - sp), [ex, ey] = onRing(dialAngle + sp);
  const arc = sp > 0 ? [svgEl("path", { class: "dial-spread", d: `M${sx} ${sy}A${r} ${r} 0 ${sp > Math.PI / 2 ? 1 : 0} 1 ${ex} ${ey}` })] : [];
  const label = svgEl("text", { class: "dial-label", x: kx + 12 * px, y: ky - 12 * px, "font-size": 12 * px });
  label.textContent = `${Math.round((wrap(dialAngle) * 180) / Math.PI) % 360}°`;
  dialLayer.replaceChildren(
    svgEl("circle", { class: "dial-ring", cx: c[0], cy: c[1], r }),
    ...arc,
    ...ticks,
    svgEl("circle", { class: "dial-hit", cx: c[0], cy: c[1], r, "stroke-width": 16 * px }),
    svgEl("circle", { class: "dial-knob", cx: kx, cy: ky, r: 7 * px }),
    label,
  );
}

dialLayer.addEventListener("pointerdown", (e) => {
  if (!(e.target as Element).matches(".dial-hit, .dial-knob")) return;
  e.stopPropagation();
  stopDial();
  syncDial();
  const { c } = dialGeometry();
  // Shift snaps to rotations that carry one point exactly onto another.
  const angles = restCage.map((p) => angleAround(c, p));
  const snaps = angles.flatMap((a) => angles.map((b) => wrap(b - a)));
  const turn = (ev: PointerEvent) => {
    let theta = angleAround(c, toSvg(ev));
    if (ev.shiftKey) {
      theta = snaps.reduce((best, s) => {
        const d = (x: number) => Math.min(wrap(x - theta), wrap(theta - x));
        return d(s) < d(best) ? s : best;
      }, 0);
    }
    setDialAngle(theta);
    render();
  };
  turn(e);
  dialLayer.classList.add("active");
  const up = () => {
    dialLayer.classList.remove("active");
    window.removeEventListener("pointermove", turn);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", turn);
  window.addEventListener("pointerup", up);
});
dialLayer.addEventListener("dblclick", () => {
  syncDial();
  if (!dialBase) return;
  setDialAngle(0);
  render();
});
dialInput.addEventListener("change", () => {
  dialOn = dialInput.checked;
  try { localStorage.setItem("warp:dial", dialOn ? "on" : "off"); } catch {}
  if (!dialOn) stopDial();
  render();
});

// Autoplay: keeps the dial turning clockwise, one turn every DIAL_PERIOD ms.
// Grabbing the dial, hiding it or switching to Edit stops it.
const DIAL_PERIOD = 6000;
const playButton = $<HTMLButtonElement>("#dial-play");
let dialFrame = 0;

function playDial() {
  if (!kind || dialFrame) return;
  if (cageMode !== "deform") setCageMode("deform");
  if (!dialOn) {
    dialOn = dialInput.checked = true;
    try { localStorage.setItem("warp:dial", "on"); } catch {}
  }
  syncDial();
  let last = performance.now();
  const tick = (now: number) => {
    syncDial(); // a manual edit while playing becomes the new base
    setDialAngle(wrap(dialAngle + ((now - last) / DIAL_PERIOD) * TAU));
    last = now;
    render();
    dialFrame = requestAnimationFrame(tick);
  };
  dialFrame = requestAnimationFrame(tick);
  playButton.textContent = "Pause";
  playButton.classList.add("on");
  showDial();
}

function stopDial() {
  if (!dialFrame) return;
  cancelAnimationFrame(dialFrame);
  dialFrame = 0;
  playButton.textContent = "Play";
  playButton.classList.remove("on");
  showDial();
}

const toggleDial = () => (dialFrame ? stopDial() : playDial());

// The dial stays hidden until it's in use: the pointer near the ring, dragging
// it, or autoplay. Hidden, it still catches the pointer, so it can be grabbed.
let dialHover = false;
const showDial = () => dialLayer.classList.toggle("shown", dialHover || !!dialFrame);
stage.addEventListener("pointermove", (e) => {
  if (!dialOn || !restCage.length) return;
  const { c, r } = dialGeometry();
  const [x, y] = toSvg(e);
  const near = Math.abs(Math.hypot(x - c[0], y - c[1]) - r) < 32 / (stage.getScreenCTM()?.a || 1);
  if (near !== dialHover) {
    dialHover = near;
    showDial();
  }
});
stage.addEventListener("pointerleave", () => {
  dialHover = false;
  showDial();
});
playButton.addEventListener("click", toggleDial);

// Double-click an edge to add a point there (at the nearest spot on the curve).
edgeHits.addEventListener("dblclick", (e) => {
  const i = Number((e.target as SVGElement).dataset.edge);
  if (!Number.isInteger(i)) return;
  const c = activeCage(), [c1, c2] = shownCtrl(c, activeCtrl())[i];
  const a = c[i], b = c[(i + 1) % c.length];
  const [x, y] = toSvg(e);
  let best = 0.5, bestD = Infinity;
  for (let k = 1; k < 200; k++) {
    const t = k / 200;
    const [px, py] = bezier(a, c1, c2, b, t);
    const d = (px - x) ** 2 + (py - y) ** 2;
    if (d < bestD) (bestD = d), (best = t);
  }
  insertVertex(i, best);
});

// ---------------------------------------------------------------- points console

const cageRows = $<HTMLTableSectionElement>("#cage-rows");

const fmt = (n: number) => (Number.isFinite(n) ? String(+n.toFixed(2)) : String(n));
const fmtPt = (p: Pt) => `(${fmt(p[0])}, ${fmt(p[1])})`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

function svgEl(tag: string, attrs: Record<string, string | number>) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function buildCageRows() {
  // Inputs edit the active cage; the muted column shows the other one.
  $("#cage-other").textContent = cageMode === "deform" ? "rest" : "deformed";
  cageRows.replaceChildren(...activeCage().map((_, i) => {
    const inputs = [0, 1].map((k) => {
      const input = el("input", { type: "number", step: "any" });
      input.dataset.corner = String(i);
      input.dataset.axis = String(k);
      input.addEventListener("input", () => {
        const v = parseFloat(input.value);
        if (!Number.isFinite(v)) return;
        const p = [...activeCage()[i]] as Pt;
        p[k] = v;
        moveVertex(i, p);
        render();
      });
      return el("td", {}, input);
    });
    const remove = el("button", { className: "small", textContent: "×", title: "Remove point" });
    remove.disabled = restCage.length <= MIN_VERTICES;
    remove.addEventListener("click", () => removeVertex(i));
    const other = el("td", { className: "muted" });
    other.dataset.other = String(i);
    return el("tr", {}, el("td", {}, String(i + 1)), other, ...inputs, el("td", {}, remove));
  }));
}

function drawPoints() {
  // Cage inputs follow drags, except the one being typed in.
  const active = activeCage(), other = cageMode === "deform" ? restCage : cage;
  for (const input of cageRows.querySelectorAll("input")) {
    if (input === document.activeElement) continue;
    input.value = fmt(active[+input.dataset.corner!][+input.dataset.axis!]);
  }
  for (const td of cageRows.querySelectorAll<HTMLElement>("[data-other]")) {
    td.textContent = fmtPt(other[+td.dataset.other!]);
  }
  [...cageRows.children].forEach((tr, i) => tr.classList.toggle("selected", selected.has(i)));
}

$<HTMLInputElement>("#show-points").addEventListener("change", (e) => {
  $(".workspace").classList.toggle("no-points", !(e.target as HTMLInputElement).checked);
  if (kind) render();
});

// ---------------------------------------------------------------- zoom / pan

type View = { x: number; y: number; w: number; h: number };
let fitView: View = { x: 0, y: 0, w: 100, h: 100 };
let view: View = { ...fitView };
const zoomLabel = $<HTMLButtonElement>("#zoom-fit");
const MIN_ZOOM = 0.1, MAX_ZOOM = 64;

function setView(v: View) {
  view = v;
  stage.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
  zoomLabel.textContent = `${Math.round((fitView.w / v.w) * 100)}%`;
  if (kind) render(); // handles are sized in screen px
}

/** Zooms by `factor` (>1 = in) keeping SVG point `at` fixed on screen. */
function zoomBy(factor: number, at: Pt = [view.x + view.w / 2, view.y + view.h / 2]) {
  const zoom = fitView.w / view.w;
  factor = Math.min(MAX_ZOOM / zoom, Math.max(MIN_ZOOM / zoom, factor));
  const w = view.w / factor, h = view.h / factor;
  setView({ x: at[0] - (at[0] - view.x) / factor, y: at[1] - (at[1] - view.y) / factor, w, h });
}

function panBy(dxPx: number, dyPx: number) {
  const scale = stage.getScreenCTM()?.a || 1;
  setView({ ...view, x: view.x - dxPx / scale, y: view.y - dyPx / scale });
}

// Pinch / ctrl|cmd + wheel zooms at the cursor; plain wheel / two-finger scroll pans.
stage.addEventListener("wheel", (e) => {
  if (!kind) return;
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY * 0.01), toSvg(e));
  else panBy(-e.deltaX, -e.deltaY);
}, { passive: false });

// Dragging empty canvas pans, or draws a lasso with the lasso tool or shift.
// A lasso replaces the selection; with shift it adds, with alt it subtracts.
// A click without dragging clears the selection.
const lassoEl = $<SVGPathElement>("#lasso");

function startLasso(e: PointerEvent) {
  const pts: Pt[] = [toSvg(e)];
  const mode = e.shiftKey ? "add" : e.altKey ? "subtract" : "replace";
  stage.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    pts.push(toSvg(ev));
    lassoEl.setAttribute("d", `M${pts.join("L")}Z`);
  };
  const up = () => {
    stage.removeEventListener("pointermove", move);
    lassoEl.removeAttribute("d");
    const px = 1 / (stage.getScreenCTM()?.a || 1);
    const [x0, y0] = pts[0];
    const tiny = pts.every(([x, y]) => Math.hypot(x - x0, y - y0) < 4 * px);
    if (tiny) {
      if (mode === "replace") select([]);
      return;
    }
    const poly = Float64Array.from(pts.flat());
    const inside = activeCage().flatMap((p, i) => (insidePoly(p[0], p[1], poly) ? [i] : []));
    if (mode === "add") select([...selected, ...inside]);
    else if (mode === "subtract") select([...selected].filter((i) => !inside.includes(i)));
    else select(inside);
  };
  stage.addEventListener("pointermove", move);
  stage.addEventListener("pointerup", up, { once: true });
  stage.addEventListener("pointercancel", up, { once: true });
}

let panned = false;
stage.addEventListener("pointerdown", (e) => {
  if (!kind || (e.target as Element).closest("#handles, #ctrls, #dial") || e.button > 1) return;
  if (e.button === 0 && (lassoTool || e.shiftKey)) return startLasso(e);
  panned = false;
  let last = [e.clientX, e.clientY];
  const start = last;
  const move = (ev: PointerEvent) => {
    if (!panned && Math.hypot(ev.clientX - start[0], ev.clientY - start[1]) < 4) return;
    if (!panned) stage.setPointerCapture(ev.pointerId);
    panned = true;
    stage.classList.add("panning");
    panBy(ev.clientX - last[0], ev.clientY - last[1]);
    last = [ev.clientX, ev.clientY];
  };
  const up = () => {
    stage.removeEventListener("pointermove", move);
    stage.classList.remove("panning");
    if (!panned && e.button === 0 && selected.size) select([]);
  };
  stage.addEventListener("pointermove", move);
  stage.addEventListener("pointerup", up, { once: true });
  stage.addEventListener("pointercancel", up, { once: true });
});

$("#zoom-in").addEventListener("click", () => zoomBy(1.25));
$("#zoom-out").addEventListener("click", () => zoomBy(1 / 1.25));
zoomLabel.addEventListener("click", () => setView({ ...fitView }));

window.addEventListener("keydown", (e) => {
  // Checkboxes and sliders keep focus after a click; they shouldn't swallow shortcuts.
  const selectAll = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a";
  if (kind && selectAll && !(e.target as Element).closest("input:not([type=checkbox]):not([type=range]), select")) {
    e.preventDefault();
    return select(activeCage().map((_, i) => i));
  }
  if (!kind || e.metaKey || e.ctrlKey || (e.target as Element).closest("input:not([type=checkbox]):not([type=range]), select")) return;
  if (e.key === "p" || e.key === "P") toggleDial();
  else if (e.key === "m" || e.key === "M") toggleMorph();
  else if (e.key === "l" || e.key === "L") setLassoTool(!lassoTool);
  else if (e.key === "Escape") {
    if (selected.size) select([]);
    else if (lassoTool) setLassoTool(false);
  } else if ((e.key === "Delete" || e.key === "Backspace") && selected.size) {
    e.preventDefault();
    removeSelection();
  } else if (e.key.startsWith("Arrow") && selected.size) {
    // Nudge the selection 1 screen pixel (10 with shift).
    e.preventDefault();
    const step = (e.shiftKey ? 10 : 1) / (stage.getScreenCTM()?.a || 1);
    const [dx, dy] = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key as "ArrowLeft"] ?? [0, 0];
    moveSelection(dx * step, dy * step);
    render();
  }
  else if (e.key === "=" || e.key === "+") zoomBy(1.25);
  else if (e.key === "-") zoomBy(1 / 1.25);
  else if (e.key === "0") setView({ ...fitView });
});

// ---------------------------------------------------------------- cage import / export

// A custom cage can come from the artwork itself (a shape with id="cage", and
// optionally id="cage-deformed", removed before warping), or from a separate
// SVG/JSON file in the same units.
type CageSpec = { rest: Pt[]; restCtrl: Ctrl[]; moved?: Pt[]; movedCtrl?: Ctrl[] };
let initialCtrl: Ctrl[] = [];
let contentPts: number[] = []; // sample of content points, for the enclosure check
let cageWarning = "";
let checkedFor = ""; // the warp layers the warning was computed for
const MAX_CONTENT_PTS = 2000;

const copyCage = (c: Pt[]) => c.map((p) => [...p] as Pt);
const copyCtrl = (k: Ctrl[]) => k.map(([a, b]) => [[...a], [...b]] as Ctrl);
const straightEdge = (a: Pt, b: Pt): Ctrl => [lerp(a, b, 1 / 3), lerp(a, b, 2 / 3)];

/** Cage from the first subpath of an SVG shape: one vertex per segment, Bezier controls kept. */
function cageFromShape(el: Element): CageSpec | null {
  const pathArray = el.tagName.toLowerCase() === "path"
    ? parsePathString(el.getAttribute("d") || "")
    : shapeToPathArray(el as any);
  if (!pathArray?.length) return null;
  const curve = pathToCurve(pathArray) as unknown as (string | number)[][];
  if (curve[0]?.[0] !== "M") return null;
  const rest: Pt[] = [], restCtrl: Ctrl[] = [];
  let at: Pt = [curve[0][1] as number, curve[0][2] as number];
  for (const seg of curve.slice(1)) {
    if (seg[0] !== "C") break;
    const [c1x, c1y, c2x, c2y, x, y] = seg.slice(1) as number[];
    if (x === at[0] && y === at[1] && c1x === x && c1y === y && c2x === x && c2y === y) continue;
    rest.push(at);
    restCtrl.push([[c1x, c1y], [c2x, c2y]]);
    at = [x, y];
  }
  if (!rest.length) return null;
  // Open path: close it with a straight edge back to the start.
  if (at[0] !== rest[0][0] || at[1] !== rest[0][1]) {
    rest.push(at);
    restCtrl.push(straightEdge(at, rest[0]));
  }
  return rest.length >= MIN_VERTICES ? { rest, restCtrl } : null;
}

/** The cage shape in an SVG document: id="cage" (or the first shape inside it), else the first shape. */
function findCageShape(root: Element): Element | null {
  const sel = SHAPES.join(",");
  const tagged = root.querySelector("#cage");
  if (tagged) return tagged.matches(sel) ? tagged : tagged.querySelector(sel);
  return root.querySelector(sel);
}

const isPt = (v: unknown): v is Pt => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n));
const isPts = (v: unknown, n?: number): v is Pt[] => Array.isArray(v) && v.every(isPt) && (n === undefined || v.length === n);
const isCtrls = (v: unknown, n: number): v is Ctrl[] => Array.isArray(v) && v.length === n && v.every((e) => Array.isArray(e) && e.length === 2 && e.every(isPt));

/** { rest, restCtrl?, moved?, movedCtrl? }, or a bare [[x, y], …] list of rest points. */
function cageFromJson(text: string): CageSpec | null {
  let data: any;
  try { data = JSON.parse(text); } catch { return null; }
  if (isPts(data)) data = { rest: data };
  const rest = data?.rest;
  if (!isPts(rest) || rest.length < MIN_VERTICES) return null;
  const n = rest.length;
  const restCtrl = isCtrls(data.restCtrl, n) ? data.restCtrl : straightCtrl(rest);
  if (!isPts(data.moved, n)) return { rest, restCtrl };
  const moved = data.moved as Pt[];
  return { rest, restCtrl, moved, movedCtrl: isCtrls(data.movedCtrl, n) ? data.movedCtrl : straightCtrl(moved) };
}

/** Makes `spec` the cage (and what Reset shape goes back to), and fits the view around it. */
function applyCage(spec: CageSpec) {
  initialCage = copyCage(spec.rest);
  initialCtrl = copyCtrl(spec.restCtrl);
  restCage = copyCage(spec.rest);
  restCtrl = copyCtrl(spec.restCtrl);
  cage = copyCage(spec.moved ?? spec.rest);
  ctrl = copyCtrl(spec.movedCtrl ?? spec.restCtrl);
  checkedFor = "";

  if (contentBox) {
    const xs = [contentBox.x, contentBox.x + contentBox.width, ...restCage.map((p) => p[0]), ...cage.map((p) => p[0])];
    const ys = [contentBox.y, contentBox.y + contentBox.height, ...restCage.map((p) => p[1]), ...cage.map((p) => p[1])];
    const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y;
    const pad = Math.max(w, h) * 0.25;
    fitView = { x: x - pad, y: y - pad, w: w + pad * 2, h: h + pad * 2 };
    setView({ ...fitView });
  }
  cageChanged();
}

/** Samples points along every shape (or the image's outline), for the enclosure check. */
function sampleContent(root: SVGSVGElement | null, box: Box) {
  const pts: number[] = [];
  if (root) {
    for (const [, curve] of collectCurves(root)) {
      let at: Pt = [0, 0];
      for (const seg of curve as unknown as (string | number)[][]) {
        const n = seg.slice(1) as number[];
        if (seg[0] === "C") {
          for (let t = 1; t <= 8; t++) pts.push(...bezier(at, [n[0], n[1]], [n[2], n[3]], [n[4], n[5]], t / 8));
        } else {
          pts.push(n[0], n[1]);
        }
        at = [n[n.length - 2], n[n.length - 1]];
      }
    }
  } else {
    for (let t = 0; t < 1; t += 1 / 16) {
      pts.push(box.x + box.width * t, box.y, box.x + box.width, box.y + box.height * t);
      pts.push(box.x + box.width * (1 - t), box.y + box.height, box.x, box.y + box.height * (1 - t));
    }
  }
  const step = Math.max(1, Math.ceil(pts.length / 2 / MAX_CONTENT_PTS));
  contentPts = [];
  for (let i = 0; i < pts.length; i += 2 * step) contentPts.push(pts[i], pts[i + 1]);
  checkedFor = "";
}

/** Even-odd test against a flat [x0, y0, …] polygon. */
function insidePoly(x: number, y: number, poly: Float64Array) {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[2 * i], yi = poly[2 * i + 1], xj = poly[2 * j], yj = poly[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function selfIntersects(poly: Float64Array) {
  const n = poly.length / 2;
  const P = (i: number): Pt => [poly[2 * (i % n)], poly[2 * (i % n) + 1]];
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent through the wrap
      const a = P(i), b = P(i + 1), c = P(j), d = P(j + 1);
      const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  }
  return false;
}

/** Recomputes the cage warning when the flattened rest cage has changed. */
function checkCage() {
  // Later passes see the content as the earlier passes leave it.
  const before = layers.slice(0, active);
  const key = [active, restVersion, ...before.map((L) => `${L.restVersion}:${L.flat.moved.join()}`)].join("|");
  if (checkedFor === key) return;
  checkedFor = key;
  const pts = throughLayers(contentPts, active);
  const total = pts.length / 2;
  let outside = 0;
  for (let i = 0; i < pts.length; i += 2) if (!insidePoly(pts[i], pts[i + 1], flat.rest)) outside++;
  const issues = [
    selfIntersects(flat.rest) ? "the rest cage crosses itself" : "",
    outside ? `${outside} of ${total} sampled content points are outside the rest cage` : "",
  ].filter(Boolean);
  cageWarning = issues.length ? `Warning: ${issues.join("; ")}.` : "";
}

async function loadCageFile(file: File) {
  if (!kind) return;
  const text = await file.text();
  let spec: CageSpec | null = null;
  if (/\.json$/i.test(file.name) || file.type === "application/json") {
    spec = cageFromJson(text);
  } else {
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    const shape = doc.querySelector("parsererror") ? null : findCageShape(doc.documentElement);
    const rest = shape && cageFromShape(shape);
    spec = rest && withDeformed(doc.documentElement, rest);
  }
  if (!spec) {
    status.textContent = `Couldn't read a cage (${MIN_VERTICES}+ points) from ${file.name}.`;
    return;
  }
  applyCage(spec);
}

/** Closed path data for a cage as currently shown (straight edges when Curves is off). */
function cageD(c: Pt[], k: Ctrl[]) {
  const r = (n: number) => +n.toFixed(3);
  const shown = shownCtrl(c, k);
  return c.map((p, i) => {
    const q = c[(i + 1) % c.length];
    return `${i ? "" : `M${r(p[0])} ${r(p[1])}`}C${[...shown[i][0], ...shown[i][1], ...q].map(r).join(" ")}`;
  }).join("") + "Z";
}

/**
 * Cages as standalone SVG: red paths, id="cage" for the rest cage and, with
 * `deformed`, id="cage-deformed". The viewBox covers the artwork and the cages,
 * and Import cage reads both back.
 */
function cageSvg(deformed: boolean) {
  const vb = source?.getAttribute("viewBox")?.split(/[\s,]+/).map(Number);
  const box = vb?.length === 4 ? { x: vb[0], y: vb[1], width: vb[2], height: vb[3] } : contentBox;
  const all = deformed ? [...restCage, ...cage] : restCage;
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  if (box) xs.push(box.x, box.x + box.width), ys.push(box.y, box.y + box.height);
  const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y;
  const pad = Math.max(w, h) * 0.02;
  const viewBox = [x - pad, y - pad, w + pad * 2, h + pad * 2].map((n) => +n.toFixed(3)).join(" ");
  const path = (id: string, d: string) =>
    `  <path id="${id}" d="${d}" fill="none" stroke="#ff0000" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>\n`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">\n`
    + path("cage", cageD(restCage, restCtrl))
    + (deformed ? path("cage-deformed", cageD(cage, ctrl)) : "")
    + "</svg>\n";
}

/** Adds the id="cage-deformed" shape in `root` (if it matches the rest cage's points) to `spec`. */
function withDeformed(root: Element, spec: CageSpec): CageSpec {
  const tagged = root.querySelector("#cage-deformed");
  const shape = tagged && (tagged.matches(SHAPES.join(",")) ? tagged : tagged.querySelector(SHAPES.join(",")));
  const moved = shape && cageFromShape(shape);
  return moved && moved.rest.length === spec.rest.length ? { ...spec, moved: moved.rest, movedCtrl: moved.restCtrl } : spec;
}

/** Copies the icage SVG to the clipboard, or downloads it if the clipboard isn't available. */
async function copyIcage() {
  if (!kind) return;
  const svg = cageSvg(false);
  try {
    await navigator.clipboard.writeText(svg);
    status.textContent = `Copied the rest cage (${restCage.length} points) as SVG.`;
  } catch {
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(blob),
      download: `${fileName.replace(/-warped$/, "")}-icage.svg`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
    status.textContent = "Clipboard unavailable, downloaded the rest cage as SVG instead.";
  }
}

function exportCage() {
  const blob = new Blob([cageSvg(true)], { type: "image/svg+xml" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `${fileName.replace(/-warped$/, "")}-cage.svg`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------- export

async function exportPng() {
  if (!texture) return;
  refreshFlat();
  const grid = warpGrid(texture, meshSize(), beginPass("raster"));
  const box = gridBounds(grid);
  if (!box) return;
  // Keep roughly the texture's pixel density, capped so huge warps don't blow up.
  const density = Math.min(texture.width / texture.region.w, 8192 / Math.max(box.w, box.h));
  const canvas = Object.assign(document.createElement("canvas"), {
    width: Math.max(1, Math.ceil(box.w * density)),
    height: Math.max(1, Math.ceil(box.h * density)),
  });
  const ctx = canvas.getContext("2d")!;
  drawMesh(ctx, texture, grid, ([x, y]) => [(x - box.x) * density, (y - box.y) * density]);
  if (hasStrokes && source) {
    const strokes = await rasterize(without(warpedClone(), "fill"), box, Math.max(canvas.width, canvas.height));
    ctx.drawImage(strokes.image, 0, 0, canvas.width, canvas.height);
  }
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `${fileName}.png` });
    a.click();
    URL.revokeObjectURL(a.href);
  }, "image/png");
}

function exportSvg() {
  if (mode === "raster") return exportPng();
  if (!source) return;
  refreshFlat();
  const out = warpedClone();

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

  const blob = new Blob([new XMLSerializer().serializeToString(out)], { type: "image/svg+xml" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `${fileName}.svg` });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------- wiring

$<HTMLInputElement>("#file").addEventListener("change", (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) loadFile(file);
});

$("#reset").addEventListener("click", () => {
  if (cageMode === "deform") {
    cage = restCage.map((p) => [...p] as Pt);
    ctrl = restCtrl.map(([a, b]) => [[...a], [...b]] as Ctrl);
    render();
  } else {
    restCage = copyCage(initialCage);
    cage = copyCage(initialCage);
    restCtrl = copyCtrl(initialCtrl);
    ctrl = copyCtrl(initialCtrl);
    cageChanged();
  }
});

$("#export").addEventListener("click", exportSvg);
$("#export-cage").addEventListener("click", exportCage);
$("#lasso-tool").addEventListener("click", () => setLassoTool(!lassoTool));
$("#copy-cage").addEventListener("click", copyIcage);
$<HTMLInputElement>("#cage-file").addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) loadCageFile(file);
});

methodSelect.replaceChildren(...methods.map((m, i) => new Option(m.label, String(i))));
try {
  const saved = methods.findIndex((m) => m.label === localStorage.getItem("warp:method"));
  if (saved >= 0) method = methods[saved];
} catch {}
methodSelect.value = String(methods.indexOf(method));
methodSelect.addEventListener("change", () => {
  method = methods[Number(methodSelect.value)];
  try { localStorage.setItem("warp:method", method.label); } catch {}
  render();
});

for (const b of document.querySelectorAll<HTMLButtonElement>("#mode button")) {
  b.addEventListener("click", () => setMode(b.dataset.mode as Mode));
}
try {
  if (localStorage.getItem("warp:mode") === "raster") setMode("raster");
} catch {}

subdivInput.addEventListener("input", () => {
  $("#subdiv-val").textContent = subdivInput.value;
  render();
});

$<HTMLInputElement>("#show-ghost").addEventListener("change", (e) => {
  ghost.style.display = (e.target as HTMLInputElement).checked ? "" : "none";
});

const drop = $<HTMLElement>("#drop");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("dragover");
});
drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("dragover");
  const file = e.dataTransfer?.files[0];
  if (file) loadFile(file);
});

window.addEventListener("resize", () => kind && render());

sampleSelect.replaceChildren(
  Object.assign(new Option("Imported file", ""), { disabled: true, hidden: true }),
  ...Object.entries(SAMPLES).map(([key, { label }]) => new Option(label, key)),
);
sampleSelect.addEventListener("change", () => {
  if (!(sampleSelect.value in SAMPLES)) return;
  sample = sampleSelect.value;
  try { localStorage.setItem("warp:sample", sample); } catch {}
  loadDefault();
});

loadDefault();
