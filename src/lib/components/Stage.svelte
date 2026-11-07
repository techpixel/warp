<!--
  The canvas: the faint original, the warped artwork (vector paths, or a
  textured mesh for images), and the cage with its draggable points.
-->
<script lang="ts">
  import { cagePath, edgePoint, insidePoly, nearestT, type Pt } from "#lib/cage.js";
  import { meshLines } from "#lib/mesh.js";
  import { drawMesh } from "#lib/raster.js";
  import { prepareWarp } from "#lib/warp-core.js";
  import { hold } from "#lib/hold.js";
  import { SUBDIVISIONS, type Editor, type LinkTarget } from "#lib/editor.svelte.js";

  // `bare`: just the artwork, with no cage (no warp pass is selected).
  let { editor, bare = false, onfile }: { editor: Editor; bare?: boolean; onfile: (file: File) => void } = $props();

  // Root <svg> attributes that shouldn't be copied onto the wrapper <g>s.
  const ROOT_ONLY = ["class", "xmlns", "xmlns:xlink", "viewBox", "width", "height", "x", "y", "version", "preserveAspectRatio"];

  let width = $state(0);
  let height = $state(0);
  let svg: SVGSVGElement;
  let dragover = $state(false);
  let panning = $state(false);

  const view = $derived(editor.view);
  // Screen px per SVG unit (the stage letterboxes the view, centered).
  const scale = $derived(width && height ? Math.min(width / view.w, height / view.h) : 1);

  // The warp grid: the original cage's bounds split evenly into near-square
  // cells (about GRID_CELLS along the longer side, and a multiple of a mesh
  // cage's own cells so its lines fall on the mesh), carried through the warp
  // so they show how it bends the space. Straight while the cage is reshaped.
  const GRID_CELLS = 24;
  const gridPath = $derived.by(() => {
    void editor.deformation;
    const rest = editor.restFlat;
    if (!editor.kind || bare || rest.length < 6) return "";
    const warp = editor.editing ? (p: Pt) => p : editor.beginPass("grid");
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < rest.length; k += 2) {
      x0 = Math.min(x0, rest[k]), x1 = Math.max(x1, rest[k]);
      y0 = Math.min(y0, rest[k + 1]), y1 = Math.max(y1, rest[k + 1]);
    }
    const cell = Math.max(x1 - x0, y1 - y0) / GRID_CELLS;
    if (!(cell > 0)) return "";
    const dims = editor.inner?.dims;
    /** How many cells across `span`: near-square, in whole multiples of `per`. */
    const count = (span: number, per = 1) => Math.max(1, Math.round(span / cell / per)) * per;
    // The n - 1 lines strictly inside (lo, hi) that split it into n equal parts.
    const steps = (lo: number, hi: number, n: number) => Array.from({ length: n - 1 }, (_, k) => lo + ((hi - lo) * (k + 1)) / n);
    const nx = count(x1 - x0, dims?.cols), ny = count(y1 - y0, dims?.rows);
    const at = ([x, y]: Pt) => `${+x.toFixed(2)} ${+y.toFixed(2)}`;
    const inside = (p: Pt) => insidePoly(p, rest);
    // Points on the cage itself: some methods are undefined there, and lose
    // precision just inside it, so two points a little way in (along the line,
    // toward its sample `inward` inside the cage) are warped and the line
    // through them carried back out to the edge.
    const onEdge = (p: Pt, inward: Pt): Pt => {
      const dx = inward[0] - p[0], dy = inward[1] - p[1], len = Math.hypot(dx, dy);
      const h = Math.min(cell / 32, len / 4) / (len || 1);
      const a = warp([p[0] + dx * h, p[1] + dy * h]), b = warp([p[0] + dx * 2 * h, p[1] + dy * 2 * h]);
      return [2 * a[0] - b[0], 2 * a[1] - b[1]];
    };
    /**
     * The warped parts of the line through `pts` that lie inside the cage, each
     * running right up to its edge (found by halving the gap between samples).
     */
    const line = (pts: Pt[]) => {
      let d = "", prev: Pt | null = null, was = false;
      for (const p of pts) {
        const is = inside(p);
        if (prev && is !== was) {
          let a = prev, b = p;
          for (let n = 0; n < 16; n++) {
            const m: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
            if (inside(m) === was) a = m;
            else b = m;
          }
          d += was ? `L${at(onEdge(a, prev))}` : `M${at(onEdge(b, p))}`;
        }
        if (is) d += `${prev ? "L" : "M"}${at(warp(p))}`; // entering already moved to the edge
        prev = p;
        was = is;
      }
      return d;
    };
    // A point every quarter cell, so bends show.
    const ys = [y0, ...steps(y0, y1, ny * 4), y1], xs = [x0, ...steps(x0, x1, nx * 4), x1];
    let d = "";
    for (const x of steps(x0, x1, nx)) d += line(ys.map((y): Pt => [x, y]));
    for (const y of steps(y0, y1, ny)) d += line(xs.map((x): Pt => [x, y]));
    // The grid's edge: the original cage's outline through the warp, a point
    // every quarter cell, each stepped in along its edge's inward normal.
    const n = rest.length / 2;
    let area = 0;
    for (let k = 0; k < n; k++) area += rest[2 * k] * rest[(2 * k + 3) % rest.length] - rest[(2 * k + 2) % rest.length] * rest[2 * k + 1];
    const turn = area > 0 ? 1 : -1;
    for (let k = 0; k < n; k++) {
      const a: Pt = [rest[2 * k], rest[2 * k + 1]], b: Pt = [rest[(2 * k + 2) % rest.length], rest[(2 * k + 3) % rest.length]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const ix = (-(b[1] - a[1]) / len) * turn * cell, iy = ((b[0] - a[0]) / len) * turn * cell;
      const edge = (p: Pt) => onEdge(p, [p[0] + ix, p[1] + iy]);
      const parts = Math.max(1, Math.ceil(len / (cell / 4)));
      d += k ? "" : `M${at(edge(a))}`;
      for (let j = 1; j <= parts; j++) d += `L${at(edge([a[0] + ((b[0] - a[0]) * j) / parts, a[1] + ((b[1] - a[1]) * j) / parts]))}`;
    }
    return d + "Z";
  });
  /**
   * Pressing a connector selects its two points; dragging it moves them together.
   * Window listeners rather than pointer capture, so a double-click still reaches it.
   */
  function grabConnector(e: PointerEvent, i: number) {
    if (e.button !== 0 || spaceHeld) return;
    e.stopPropagation();
    const [a, b] = editor.guides[i];
    editor.select(a, false);
    editor.select(b, true);
    const from = toSvg(e), A = solid[a];
    let dragging = false;
    const move = (ev: PointerEvent) => {
      // Starts once the pointer has moved a few screen pixels, so a click doesn't nudge it.
      if (!dragging && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return;
      dragging = true;
      const p = toSvg(ev);
      editor.dragPoint(a, [A[0] + p[0] - from[0], A[1] + p[1] - from[1]]);
    };
    window.addEventListener("pointermove", move);
    hold(e.currentTarget as Element, e, () => window.removeEventListener("pointermove", move), false);
  }

  // What the mouse does in the cage editor, shown while there's no notice. A mesh
  // cage keeps its grid, so it can't take new edge points or connectors.
  type Gesture = "drag" | "click" | "double" | "right";
  const hints = $derived.by((): [Gesture, string][] => {
    const mesh = !!editor.inner?.dims, linked = editor.guides.length > 0;
    // Double-clicking a point starts a connector; double-clicking a connector adds a center point.
    const double = !mesh && linked ? "Connect a point, or add a center point on a connector"
      : !mesh ? "Connect a point, then click where to"
      : linked ? "Add a center point on a connector"
      : "";
    return [
      ["drag", linked ? "Move a point or connector" : "Move a point"],
      ...(mesh ? [] : [["click", "Add a point on an edge"]] as [Gesture, string][]),
      ...(double ? [["double", double]] as [Gesture, string][] : []),
      ["right", "Remove a point or connector"],
    ];
  });
  const solid = $derived(editor.active);
  /** Every draggable point: the cage's, then a Mesh cage's inner ones. */
  const points = $derived(editor.perspective ? [] : [...solid, ...editor.innerShown]);
  const solidCtrl = $derived(editor.activeCtrl);
  const other = $derived(editor.editing ? editor.effCage : editor.restCage);
  const otherCtrl = $derived(editor.editing ? editor.effCtrlShown : editor.restCtrlShown);
  const edges = $derived(editor.perspective ? [] :
    solid.map((_, i) => Array.from({ length: 17 }, (_, k) => edgePoint(solid, solidCtrl, i, k / 16)).join(" ")),
  );
  /** Curve handles for the edges on either side of each selected cage point. */
  const knobs = $derived.by(() => {
    const n = solid.length;
    const seen = new Set<string>();
    if (!editor.curves) return [];
    return editor.selected.filter((i) => i < n).flatMap((i) => {
      const prev = (i - 1 + n) % n;
      return ([[i, 0], [prev, 1]] as [number, 0 | 1][]).flatMap(([edge, which]) => {
        const key = `${edge}-${which}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ key, edge, which, anchor: solid[i], at: solidCtrl[edge][which] }];
      });
    });
  });

  function fillGroup(g: SVGGElement, root: SVGSVGElement) {
    g.replaceChildren(...[...root.childNodes].map((n) => document.importNode(n, true)));
    for (const name of g.getAttributeNames()) if (name !== "class") g.removeAttribute(name);
    for (const { name, value } of [...root.attributes]) {
      if (!ROOT_ONLY.includes(name)) g.setAttribute(name, value);
    }
  }

  // The artwork groups and the raster canvas hold DOM that Svelte doesn't
  // manage, so they're filled by attachments, which re-run when what they read changes.

  /** What this pass starts from (the original, or the earlier passes' result), drawn faintly behind the warp. */
  const original = (g: SVGGElement) => {
    void editor.upstream;
    if (editor.source && !bare) fillGroup(g, editor.inputClone());
    else g.replaceChildren();
  };

  /**
   * The warped artwork, re-warped at most once per frame while dragging. Its
   * paths are copied in and parsed once per artwork; each frame only moves
   * their points, so large files stay quick.
   */
  let built: { g: SVGGElement; source: SVGSVGElement; warp: (fn: (p: Pt) => Pt) => void } | null = null;
  const warped = (g: SVGGElement) => {
    const source = editor.source;
    void editor.deformation;
    if (!source) {
      built = null;
      return void g.replaceChildren();
    }
    const frame = requestAnimationFrame(() => {
      if (built?.g !== g || built.source !== source) {
        fillGroup(g, source);
        built = { g, source, warp: prepareWarp(g, SUBDIVISIONS) };
      }
      built.warp(editor.chained("svg"));
    });
    return () => cancelAnimationFrame(frame);
  };

  /** An imported image, warped as a textured mesh. */
  const raster = (canvas: HTMLCanvasElement) => {
    void [editor.texture, editor.deformation, view, width, height];
    const frame = requestAnimationFrame(() => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(width * dpr), h = Math.round(height * dpr);
      if (canvas.width !== w || canvas.height !== h) (canvas.width = w), (canvas.height = h);
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, w, h);
      const grid = editor.kind === "image" ? editor.rasterGrid() : null;
      if (!grid || !editor.texture) return;
      const ox = (width - view.w * scale) / 2, oy = (height - view.h * scale) / 2;
      drawMesh(ctx, editor.texture, grid, ([x, y]) => [((x - view.x) * scale + ox) * dpr, ((y - view.y) * scale + oy) * dpr]);
    });
    return () => cancelAnimationFrame(frame);
  };

  function toSvg(e: MouseEvent): Pt {
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM()!.inverse());
    return [p.x, p.y];
  }

  // Red alignment lines shown while a point is dragged into line with others.
  let align = $state<{ x1: number; y1: number; x2: number; y2: number }[]>([]);
  const SNAP_PX = 6;
  const LINK_HIT_PX = 12; // how near a point or edge the pointer must be to link to it

  /**
   * Snaps `to` onto the x and y of the nearest other points (ones not moving
   * along with point i) within a few screen pixels, and sets the alignment
   * lines that show it.
   */
  function snap(i: number, to: Pt, moving: Set<number>): Pt {
    const others = points.filter((_, j) => j !== i && !moving.has(j));
    const out: Pt = [...to];
    for (const axis of [0, 1] as const) {
      let best: number | undefined, gap = SNAP_PX / scale;
      for (const q of others) {
        const d = Math.abs(q[axis] - to[axis]);
        if (d < gap) (gap = d), (best = q[axis]);
      }
      if (best !== undefined) out[axis] = best;
    }
    align = alignLines(out, others);
    return out;
  }

  /** The red lines through `p` and the `others` exactly in line with it, on x and on y. */
  function alignLines(p: Pt, others: Pt[]) {
    const eps = 0.5 / scale;
    return ([0, 1] as const).flatMap((axis) => {
      const lined = others.filter((q) => Math.abs(q[axis] - p[axis]) < eps);
      if (!lined.length) return [];
      const along = [p, ...lined].map((q) => q[1 - axis]);
      const lo = Math.min(...along), hi = Math.max(...along);
      return [axis === 0 ? { x1: p[0], y1: lo, x2: p[0], y2: hi } : { x1: lo, y1: p[1], x2: hi, y2: p[1] }];
    });
  }

  // Linking: after a double-click on a point (in the cage editor), a connector
  // follows the pointer until the next click, which lands it on a point
  // (linking it), or an edge or a connector (adding a linked point there).
  // Anywhere else, or Escape, cancels.
  let linking = $state<{ from: Pt; at: Pt; target: LinkTarget | null } | null>(null);
  let lastPress: { i: number; at: number; x: number; y: number } | null = null;

  function startLink(i: number) {
    const from = points[i];
    linking = { from, at: from, target: null };
    const move = (ev: PointerEvent) => {
      const { at, target } = linkTarget(i, toSvg(ev));
      linking = { from, at, target };
    };
    const end = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerdown", click, true);
      window.removeEventListener("keydown", key, true);
      linking = null;
      align = [];
    };
    // The click that lands it doesn't reach the canvas, so it can't also select or
    // drag, or (as a click on an edge) add a point of its own.
    const swallow = (ev: Event) => ev.stopPropagation();
    const click = (ev: PointerEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, true), 500);
      const target = ev.button === 0 ? linkTarget(i, toSvg(ev)).target : null;
      end();
      if (target) editor.linkTo(target);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      end();
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerdown", click, true);
    window.addEventListener("keydown", key, true);
  }

  /**
   * What a connector from point i lands on with the pointer at `c`: the nearest
   * other point, else the nearest spot on a connector, else the nearest spot on
   * an edge (slid along it into line with another point when that's close),
   * else nothing.
   */
  function linkTarget(i: number, c: Pt): { at: Pt; target: LinkTarget | null } {
    const hit = LINK_HIT_PX / scale;
    align = [];
    let vertex = -1, best = hit;
    points.forEach((p, j) => {
      const d = Math.hypot(p[0] - c[0], p[1] - c[1]);
      if (j !== i && d < best) (best = d), (vertex = j);
    });
    if (vertex >= 0) return { at: points[vertex], target: { vertex } };
    let connector = -1, along = 0;
    best = hit;
    editor.guides.forEach(([a, b], g) => {
      if (a === i || b === i) return;
      const A = points[a], B = points[b], dx = B[0] - A[0], dy = B[1] - A[1];
      const t = Math.max(0.02, Math.min(0.98, ((c[0] - A[0]) * dx + (c[1] - A[1]) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(A[0] + t * dx - c[0], A[1] + t * dy - c[1]);
      if (d < best) (best = d), (connector = g), (along = t);
    });
    if (connector >= 0) {
      const [a, b] = editor.guides[connector], A = points[a], B = points[b];
      return { at: [A[0] + along * (B[0] - A[0]), A[1] + along * (B[1] - A[1])], target: { connector, t: along } };
    }
    let edge = -1, t = 0;
    best = hit;
    solid.forEach((_, e) => {
      const te = nearestT(solid, solidCtrl, e, c), q = edgePoint(solid, solidCtrl, e, te);
      const d = Math.hypot(q[0] - c[0], q[1] - c[1]);
      if (d < best) (best = d), (edge = e), (t = te);
    });
    if (edge < 0) return { at: c, target: null };
    const snapped = alignOnEdge(edge, t, points);
    const at = edgePoint(solid, solidCtrl, edge, snapped.t);
    // Only the line it snapped to: everything on a straight edge lines up along the edge itself.
    if (snapped.axis !== null) align = alignLines(at, points).filter((l) => (l.x1 === l.x2) === (snapped.axis === 0));
    return { at, target: { edge, t: snapped.t } };
  }

  /**
   * Slides `t` along edge e so the spot there lines up on x or y with the
   * nearest of `pts` within snapping distance, if any; `axis` is the one it lined up on.
   */
  function alignOnEdge(e: number, t: number, pts: Pt[]): { t: number; axis: 0 | 1 | null } {
    const q = edgePoint(solid, solidCtrl, e, t);
    // Only along an axis the edge actually travels: sliding along a flat edge can't change its y.
    const a = edgePoint(solid, solidCtrl, e, Math.max(0, t - 0.01)), b = edgePoint(solid, solidCtrl, e, Math.min(1, t + 0.01));
    const run = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const axes = ([0, 1] as const).filter((axis) => Math.abs(b[axis] - a[axis]) > 0.2 * run);
    let snapTo: { axis: 0 | 1; value: number } | null = null, gap = SNAP_PX / scale;
    for (const p of pts) {
      for (const axis of axes) {
        const d = Math.abs(p[axis] - q[axis]);
        if (d < gap) (gap = d), (snapTo = { axis, value: p[axis] });
      }
    }
    if (!snapTo) return { t, axis: null };
    const { axis, value } = snapTo;
    // The nearest t where the edge reaches that x (or y), by sampling around t and refining linearly.
    const STEPS = 64;
    let found = t, bestDt = Infinity;
    let prev = edgePoint(solid, solidCtrl, e, 0)[axis] - value;
    for (let s = 1; s <= STEPS; s++) {
      const cur = edgePoint(solid, solidCtrl, e, s / STEPS)[axis] - value;
      if (prev === 0 || prev * cur < 0) {
        const ts = (s - 1 + (prev === 0 ? 0 : prev / (prev - cur))) / STEPS;
        if (ts > 0 && ts < 1 && Math.abs(ts - t) < bestDt) (bestDt = Math.abs(ts - t)), (found = ts);
      }
      prev = cur;
    }
    return { t: found, axis };
  }


  function grab(e: PointerEvent, i: number) {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (e.altKey && editor.editing) return editor.removeVertex(i);
    // A second press on the same cage point soon after is a double-click, which
    // starts a connector. (Caught here: pointer capture keeps dblclick from firing reliably.)
    const now = performance.now(), last = lastPress;
    lastPress = { i, at: now, x: e.clientX, y: e.clientY };
    if (editor.editing && last?.i === i && now - last.at < 400 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 6) {
      lastPress = null;
      editor.select(i, false);
      if (editor.linkFrom === i) startLink(i);
      return;
    }
    // Shift toggles the point in the selection; grabbing an unselected point selects just it.
    if (e.shiftKey) editor.select(i, true);
    else if (!editor.selected.includes(i)) editor.select(i, false);
    if (!editor.selected.includes(i)) return;
    const handle = e.currentTarget as SVGCircleElement;
    const [x, y] = toSvg(e), p = points[i];
    const offset: Pt = [p[0] - x, p[1] - y];
    const moving = new Set(editor.dragGroup(i));
    let dragging = false;
    const move = (ev: PointerEvent) => {
      // Starts once the pointer has moved a few screen pixels, so a click doesn't snap the point.
      if (!dragging && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return;
      dragging = true;
      const [mx, my] = toSvg(ev);
      editor.dragPoint(i, snap(i, [mx + offset[0], my + offset[1]], moving));
    };
    handle.addEventListener("pointermove", move);
    hold(handle, e, () => {
      handle.removeEventListener("pointermove", move);
      align = [];
    });
  }

  // Window listeners rather than pointer capture, so a double-click still reaches the knob.
  function grabKnob(e: PointerEvent, edge: number, which: 0 | 1) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const [x, y] = toSvg(e), c = solidCtrl[edge][which];
    const offset: Pt = [c[0] - x, c[1] - y];
    const move = (ev: PointerEvent) => {
      const [mx, my] = toSvg(ev);
      editor.moveCtrl(edge, which, [mx + offset[0], my + offset[1]]);
    };
    window.addEventListener("pointermove", move);
    hold(e.currentTarget as Element, e, () => window.removeEventListener("pointermove", move), false);
  }

  // Dragging empty canvas draws a selection rectangle (shift adds to the
  // selection), or orbits a Perspective cage; middle-drag or Space-drag pans.
  // Clicking it clears the selection.
  let spaceHeld = $state(false);
  let marquee = $state<{ from: Pt; to: Pt } | null>(null);

  function pan(e: PointerEvent) {
    if (!editor.kind || e.button > 1) return;
    if (e.button === 0 && !spaceHeld && !editor.perspective) return select(e);
    const orbiting = editor.perspective && e.button === 0 && !spaceHeld;
    const start = [e.clientX, e.clientY];
    let last = start, moved = false;
    panning = true;
    const move = (ev: PointerEvent) => {
      moved ||= Math.hypot(ev.clientX - start[0], ev.clientY - start[1]) > 3;
      const dx = ev.clientX - last[0], dy = ev.clientY - last[1];
      if (orbiting) editor.orbitBy(dx, dy);
      else editor.panBy(dx, dy, scale);
      last = [ev.clientX, ev.clientY];
    };
    svg.addEventListener("pointermove", move);
    hold(svg, e, () => {
      svg.removeEventListener("pointermove", move);
      panning = false;
      if (!moved && e.button === 0) editor.selected = [];
    });
  }

  function select(e: PointerEvent) {
    const from = toSvg(e), add = e.shiftKey, before = editor.selected;
    const move = (ev: PointerEvent) => {
      const to = toSvg(ev);
      // Starts once the pointer has moved a few screen pixels.
      if (!marquee && Math.hypot(to[0] - from[0], to[1] - from[1]) * scale < 3) return;
      marquee = { from, to };
      const x0 = Math.min(from[0], to[0]), x1 = Math.max(from[0], to[0]);
      const y0 = Math.min(from[1], to[1]), y1 = Math.max(from[1], to[1]);
      const inside = points.flatMap((p, i) => (p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1 ? [i] : []));
      editor.selected = add ? [...new Set([...before, ...inside])] : inside;
    };
    svg.addEventListener("pointermove", move);
    hold(svg, e, () => {
      svg.removeEventListener("pointermove", move);
      if (!marquee && !add) editor.selected = [];
      marquee = null;
    });
  }

  /** Space held down turns a drag into a pan (outside text fields). */
  function onkey(e: KeyboardEvent) {
    if (e.key !== " " || (e.target as Element).closest("input, textarea, select, [role=listbox], button")) return;
    if (e.type === "keydown") e.preventDefault();
    spaceHeld = e.type === "keydown";
  }

  // Pinch / ctrl|cmd + wheel zooms at the cursor; plain wheel / two-finger scroll pans.
  // Registered by hand so it can preventDefault (not passive).
  const wheelZoom = (el: SVGSVGElement) => {
    const wheel = (e: WheelEvent) => {
      if (!editor.kind) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) editor.zoomBy(Math.exp(-e.deltaY * 0.01), toSvg(e));
      else editor.panBy(-e.deltaX, -e.deltaY, scale);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  };
</script>

<svelte:window onkeydown={onkey} onkeyup={onkey} onblur={() => (spaceHeld = false)} />

<main
  class={{ dragover, editing: editor.editing && !bare }}
  bind:clientWidth={width}
  bind:clientHeight={height}
  ondragover={(e) => {
    e.preventDefault();
    dragover = true;
  }}
  ondragleave={() => (dragover = false)}
  ondrop={(e) => {
    e.preventDefault();
    dragover = false;
    const file = e.dataTransfer?.files[0];
    if (file) onfile(file);
  }}
>
  <canvas {@attach raster}></canvas>
  <svg
    bind:this={svg}
    {@attach wheelZoom}
    class={["board", { panning, orbit: editor.perspective && !spaceHeld, "space-pan": spaceHeld }]}
    viewBox="{view.x} {view.y} {view.w} {view.h}"
    xmlns="http://www.w3.org/2000/svg"
    role="application"
    aria-label="Warp canvas"
    onpointerdown={pan}
    ondblclick={() => editor.perspective && editor.setOrbit({ pitch: 0, yaw: 0, roll: 0 })}
  >
    <g class="ghost" {@attach original}></g>
    {#if editor.image}
      <image class="ghost" href={editor.image.url} x="0" y="0" width={editor.image.width} height={editor.image.height} />
    {/if}
    <g class="warped" {@attach warped}></g>
    <path class="grid" d={gridPath} />
    {#if editor.kind && !bare}
      <path class="cage-other" d={cagePath(other, otherCtrl)} />
      <path class="cage" d={cagePath(solid, solidCtrl)} />
      {#each editor.guideLines as line, i (i)}
        <polyline class="mesh-line" points={line} />
        {#if editor.editing}
        <polyline
          class="guide-hit"
          points={line}
          role="presentation"
          onpointerdown={(e) => grabConnector(e, i)}
          ondblclick={(e) => editor.addCenter(i, toSvg(e))}
          oncontextmenu={(e) => {
            e.preventDefault();
            editor.unlink(i);
          }}
        >
        </polyline>
        {/if}
      {/each}
      {#if editor.shownGrid}
        {#each meshLines(editor.shownGrid) as line, i (i)}
          <polyline class="mesh-line dotted" points={line} />
        {/each}
      {/if}
      <g>
        {#each editor.editing ? edges : [] as points, i (i)}
          <polyline
            class="edge-hit"
            {points}
            role="presentation"
            onpointerdown={(e) => e.stopPropagation()}
            onclick={(e) => editor.insertVertex(i, nearestT(solid, solidCtrl, i, toSvg(e)))}
          />
        {/each}
      </g>
      <g>
        {#each knobs as knob (knob.key)}
          <line class="arm" x1={knob.anchor[0]} y1={knob.anchor[1]} x2={knob.at[0]} y2={knob.at[1]} />
          <rect
            class="knob"
            x={knob.at[0] - 4 / scale}
            y={knob.at[1] - 4 / scale}
            width={8 / scale}
            height={8 / scale}
            role="presentation"
            onpointerdown={(e) => grabKnob(e, knob.edge, knob.which)}
            ondblclick={() => editor.straighten(knob.edge)}
          >
          </rect>
        {/each}
      </g>
      <g>
        {#each points as p, i (i)}
          <circle
            class={["handle", { selected: editor.selected.includes(i), inner: i >= solid.length }]}
            cx={p[0]}
            cy={p[1]}
            r={5 / scale}
            role="presentation"
            onpointerdown={(e) => grab(e, i)}
            oncontextmenu={(e) => {
              e.preventDefault();
              editor.removeVertex(i);
            }}
          />
        {/each}
      </g>
      {#each editor.editing ? editor.crossings : [] as crossing, i (i)}
        {@const r = 7 / scale}
        <g
          class="axis-target"
          role="button"
          tabindex="-1"
          aria-label="Add a center point where the connectors cross"
          onpointerdown={(e) => e.stopPropagation()}
          onclick={() => editor.addCrossing(crossing.on)}
          onkeydown={() => {}}
        >
          <circle cx={crossing.at[0]} cy={crossing.at[1]} {r} />
          <path d="M{crossing.at[0] - r / 2} {crossing.at[1]}h{r}M{crossing.at[0]} {crossing.at[1] - r / 2}v{r}" />
        </g>
      {/each}
      {#if linking}
        <line class="link-preview" x1={linking.from[0]} y1={linking.from[1]} x2={linking.at[0]} y2={linking.at[1]} />
        {#if linking.target}
          <circle class="link-target" cx={linking.at[0]} cy={linking.at[1]} r={7 / scale} />
        {/if}
      {/if}
    {/if}
    {#each align as l, i (i)}
      <line class="align" {...l} />
    {/each}
    {#if marquee}
      <rect
        class="marquee"
        x={Math.min(marquee.from[0], marquee.to[0])}
        y={Math.min(marquee.from[1], marquee.to[1])}
        width={Math.abs(marquee.to[0] - marquee.from[0])}
        height={Math.abs(marquee.to[1] - marquee.from[1])}
      />
    {/if}
  </svg>

  {#snippet mouse(gesture: Gesture)}
    <!-- A drag is the four-way move arrow; a click, a mouse with the pressed button
         filled (with a 2 for a double-click). Both centre on x = 8, and every icon is
         as wide as the one with the 2, so the labels line up. -->
    <svg class="gesture" width="22" height="16" viewBox="0 0 22 16" aria-hidden="true">
      {#if gesture === "drag"}
        <path d="M8 1.5v13M1.5 8h13M6 3.5l2-2 2 2M6 12.5l2 2 2-2M3.5 6l-2 2 2 2M12.5 6l2 2-2 2" />
      {:else}
        <g transform="translate(2 0)">
          <rect x="1.5" y="1.5" width="9" height="13" rx="4.5" />
          <path d="M6 1.5v5M1.5 6.5h9" />
          <path class="pressed" d={gesture === "right" ? "M6 1.5a4.5 4.5 0 0 1 4.5 4.5v.5H6z" : "M6 1.5a4.5 4.5 0 0 0-4.5 4.5v.5H6z"} />
        </g>
        {#if gesture === "double"}
          <text x="15" y="11.5">2</text>
        {/if}
      {/if}
    </svg>
  {/snippet}
  {#if !bare && editor.editing && !editor.status}
    <ul class="status hints" aria-label="Cage editor controls">
      {#each hints as [gesture, text] (text)}
        <li>{@render mouse(gesture)}{text}</li>
      {/each}
    </ul>
  {:else}
    <p class="status" aria-live="polite">{bare ? "" : editor.status}</p>
  {/if}

  <div class="zoom">
    <button type="button" aria-label="Zoom out" onclick={() => editor.zoomBy(1 / 1.25)}>−</button>
    <button type="button" aria-label="Zoom to fit" onclick={() => (editor.view = editor.fitView)}>{Math.round(editor.zoom * 100)}%</button>
    <button type="button" aria-label="Zoom in" onclick={() => editor.zoomBy(1.25)}>+</button>
  </div>
</main>

<style>
  main {
    position: relative;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background-color: var(--bg);
  }
  main.dragover {
    outline: 2px dashed var(--ink);
    outline-offset: -12px;
  }
  canvas,
  .board {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  canvas {
    pointer-events: none;
  }
  .board {
    display: block;
    touch-action: none;
    cursor: crosshair;
  }
  .board.space-pan {
    cursor: grab;
  }
  .board.panning {
    cursor: grabbing;
  }
  .board.orbit {
    cursor: move;
  }
  .marquee {
    fill: rgb(255 255 255 / 0.06);
    stroke: var(--ink);
    stroke-width: 1;
    stroke-dasharray: 4 3;
    vector-effect: non-scaling-stroke;
    pointer-events: none;
  }
  /* The original shows faintly behind the warp; while the cage is edited, it's the
     other way round. (An image's warp is on the canvas, below; then it goes on top.) */
  .ghost,
  .warped,
  canvas {
    transition: opacity var(--ease);
  }
  .ghost,
  .editing .warped,
  .editing canvas {
    opacity: 0.15;
    pointer-events: none;
  }
  .editing .ghost {
    opacity: 1;
  }
  .editing canvas {
    z-index: 1;
  }
  .cage,
  .cage-other {
    fill: none;
    vector-effect: non-scaling-stroke;
    pointer-events: none;
  }
  .cage {
    stroke: var(--ink);
    stroke-width: 1.5;
  }
  .cage-other {
    stroke: var(--line-muted);
    stroke-width: 1;
    stroke-dasharray: 4 4;
  }
  /* Opacity on the whole path, so crossings aren't brighter. */
  .grid {
    fill: none;
    stroke: var(--ink);
    stroke-width: 1;
    opacity: 0.25;
    vector-effect: non-scaling-stroke;
    pointer-events: none;
  }
  .mesh-line {
    fill: none;
    stroke: var(--ink);
    stroke-width: 1;
    opacity: 0.5;
    vector-effect: non-scaling-stroke;
    pointer-events: none;
  }
  .link-preview {
    stroke: var(--ink);
    stroke-width: 1;
    stroke-dasharray: 3 3;
    vector-effect: non-scaling-stroke;
    pointer-events: none;
  }
  .link-target {
    fill: none;
    stroke: var(--ink);
    stroke-width: 1.5;
    stroke-dasharray: 2 2;
    vector-effect: non-scaling-stroke;
    pointer-events: none;
  }
  .axis-target {
    cursor: copy;
  }
  /* Clicking a marker focuses it; the browser's focus ring would scale with the zoom into a blob. */
  .axis-target:focus {
    outline: none;
  }
  .axis-target circle {
    fill: var(--panel);
    stroke: var(--ink);
    stroke-width: 1.5;
    stroke-dasharray: 2 2;
    vector-effect: non-scaling-stroke;
    transition: fill var(--ease);
  }
  .axis-target path {
    stroke: var(--ink);
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
    transition: stroke var(--ease);
  }
  .axis-target:hover circle {
    fill: var(--ink);
    stroke-dasharray: none;
  }
  .axis-target:hover path {
    stroke: var(--panel);
  }
  .arm {
    stroke: var(--ink);
    stroke-width: 1;
    opacity: 0.6;
    vector-effect: non-scaling-stroke;
    pointer-events: none;
  }
  .knob {
    fill: var(--panel);
    stroke: var(--ink);
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
    cursor: move;
    transition: fill var(--ease);
  }
  .knob:hover {
    fill: var(--ink);
  }
  .guide-hit {
    fill: none;
    stroke: transparent;
    stroke-width: 10;
    vector-effect: non-scaling-stroke;
    cursor: pointer;
    transition: stroke var(--ease);
  }
  .align {
    stroke: #ff3b30;
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
    pointer-events: none;
  }
  .mesh-line.dotted {
    stroke-dasharray: 2 3;
  }
  .guide-hit:hover {
    stroke: rgb(255 255 255 / 0.12);
  }
  .edge-hit {
    fill: none;
    stroke: transparent;
    stroke-width: 12;
    vector-effect: non-scaling-stroke;
    cursor: copy;
    transition: stroke var(--ease);
  }
  .edge-hit:hover {
    stroke: rgb(255 255 255 / 0.12);
  }
  .handle {
    fill: var(--panel);
    stroke: var(--ink);
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
    cursor: move;
    transition: fill var(--ease), stroke var(--ease);
  }
  .handle:hover {
    fill: var(--ink);
  }
  .handle.selected {
    fill: var(--ink);
    stroke: var(--panel);
    stroke-width: 2;
  }
  .status {
    position: absolute;
    left: 16px;
    bottom: 16px;
    max-width: min(560px, calc(100% - 180px));
    margin: 0;
    font-size: 12px;
    color: var(--muted);
    pointer-events: none;
  }
  /* One to a line. */
  .hints {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 0;
    list-style: none;
  }
  .hints li {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .gesture {
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 1;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .gesture .pressed {
    fill: currentColor;
    stroke: none;
  }
  .gesture text {
    fill: currentColor;
    stroke: none;
    font-size: 9px;
  }
  .zoom {
    position: absolute;
    right: 16px;
    bottom: 12px;
    display: flex;
    border-radius: 8px;
    background: var(--panel);
    overflow: hidden;
  }
  .zoom button {
    min-width: 32px;
    padding: 6px 8px;
    border: 0;
    background: none;
    color: var(--ink);
    font: inherit;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition: background-color var(--ease);
  }
  .zoom button:hover {
    background: var(--hover);
  }
  .zoom button:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: -2px;
  }
  @media (max-width: 720px) {
    .status {
      max-width: calc(100% - 32px);
      bottom: 56px;
    }
  }
</style>
