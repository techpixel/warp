// A pass tugged where it can't go gives a little. Pulled sideways (where a pass
// never goes), it stretches out from its middle; pulled past the top or bottom of
// the list, it squashes flatter (spreading a little), and bends into the Flag preset's warp (its cage, deformed as the preset
// deforms it, run through MVC over the element's box), the way it's pulled. Both
// follow the pull, rubber-band style, and mix on a diagonal one; the bend is a
// flag wave, rolling along all the while. Let go, the stretches spring back and
// the wave dies away as it rolls.
//
// An element isn't paths, so it's drawn as thin vertical strips (live copies,
// each clipped to its strip), each moved by the warp there and tilted to its
// slope, so they meet without seams and everything stays crisp.

import { type Pt, edgePoint, fitEdge, flattenCage, straightCtrl } from "./cage";
import { methods } from "./editor.svelte";
import { PRESETS, layoutCage } from "./presets";

const MAX_STRETCH = 0.06; // share of its width, approached as the pull grows
const REACH = 80; // px of pull for about two-thirds of the stretch
const MAX_BEND = 6; // px: the wave at its strongest
const BEND_REACH = 100; // px of pull for the wave to build to that, evenly
const SETTLE_MS = 900;
const WAVE_MS = 700; // for the wave to roll one wavelength along
const FOLLOW_MS = 90; // how quickly it eases toward the pull: about two-thirds of the way in this long
const STRIP = 11; // px wide, about

const noop = () => {};

/**
 * The warp's vertical displacement along the middle of a w × h box, at each x
 * in `xs`, with the preset's wave moved along by `shift` (of a wave) and the
 * box itself kept in place.
 */
function wave(w: number, h: number, xs: number[], shift = 0) {
  const mvc = methods.find((m) => m.id === "mvc")!;
  const flag = PRESETS.find((p) => p.id === "flag")!;
  const { ring } = layoutCage(flag.layout);
  // The cage sits just outside the box, as the editor's does; a bend preset's
  // movement across scales with the other side (see Preset).
  const m = 1, x0 = -m, y0 = -m, cw = w + 2 * m, ch = h + 2 * m;
  const target = ([x, y]: Pt): Pt => {
    const u = (x - x0) / cw, v = (y - y0) / ch, [, v2] = flag.map(u + shift, v);
    return [x, y + (v2 - v) * cw];
  };
  // As the editor applies a preset: each edge becomes the curve through the
  // preset's image of its thirds, and both cages are flattened alike for the method.
  const cage = ring.map(([u, v]): Pt => [x0 + u * cw, y0 + v * ch]);
  const ctrl = straightCtrl(cage);
  const bent = cage.map(target);
  const bentCtrl = cage.map((_, i) => fitEdge(
    bent[i], bent[(i + 1) % cage.length],
    target(edgePoint(cage, ctrl, i, 1 / 3)), target(edgePoint(cage, ctrl, i, 2 / 3)),
  ));
  const curved = cage.map(() => true);
  const rest = Float64Array.from(flattenCage(cage, ctrl, curved));
  const moved = Float64Array.from(flattenCage(bent, bentCtrl, curved));
  const apply = mvc.deformer(rest, moved, noop, {}), out = new Float64Array(2);
  return xs.map((x) => {
    const wts = mvc.weights(x, h / 2, rest, noop);
    if (!wts) return 0;
    apply(wts, out);
    return Number.isFinite(out[1]) ? out[1] - h / 2 : 0;
  });
}

/** How much of `max` a pull of `px` gives, for the stretch: quickly at first, then less and less. */
const rubber = (px: number, max: number) => Math.sign(px) * max * (1 - Math.exp(-Math.abs(px) / REACH));

type Tug = { pull(x: number, y: number): void; release(): void };
const tugs = new WeakMap<HTMLElement, Tug>();

/**
 * Takes over drawing `el` while it's tugged: `pull(x, y)` with how far past
 * where it can go the pointer is (px; x either way stretches across, y either way
 * flattens it and sets the wave rolling, that way up), and `release()` when the tug ends, to let it settle.
 * One per element: grabbed again mid-settle, it carries on from there.
 */
export function tug(el: HTMLElement): Tug {
  let t = tugs.get(el);
  if (!t) tugs.set(el, (t = startTug(el)));
  return t;
}

function startTug(el: HTMLElement): Tug {
  let stretch = 0, squish = 0, bend = 0, phase = 0; // squish: flattening, from a pull up or down
  let toStretch = 0, toSquish = 0, toBend = 0; // where the pull would put them, which they ease toward
  let layer: HTMLDivElement | null = null, strips: HTMLElement[] = [];
  // The wave at each strip's middle and edges, and a quarter-wave along: mixed by
  // the phase, they roll it along without running the warp again each frame.
  let sinAt: number[] = [], cosAt: number[] = [], sinEdge: number[] = [], cosEdge: number[] = [], step = 0;
  let settle: { s0: number; q0: number; b0: number; start: number } | null = null;
  let frame = 0, last = 0; // the running animation frame, and when the last one ran

  function build() {
    const w = el.offsetWidth, h = el.offsetHeight; // as laid out, before any scaling around it
    const n = Math.max(2, Math.round(w / STRIP));
    step = w / n;
    const mids = Array.from({ length: n }, (_, k) => (k + 0.5) * step);
    const xs = [...mids, ...Array.from({ length: n + 1 }, (_, k) => k * step)];
    const sin = wave(w, h, xs), cos = wave(w, h, xs, 0.25);
    const most = Math.max(...sin.map(Math.abs), ...cos.map(Math.abs)) || 1;
    [sinAt, sinEdge] = [sin.slice(0, n).map((d) => d / most), sin.slice(n).map((d) => d / most)];
    [cosAt, cosEdge] = [cos.slice(0, n).map((d) => d / most), cos.slice(n).map((d) => d / most)];
    const box = document.createElement("div");
    box.setAttribute("aria-hidden", "true");
    box.inert = true;
    box.style.cssText = `position: fixed; width: ${w}px; height: ${h}px; pointer-events: none; z-index: 30;`;
    strips = mids.map((mid, k) => {
      const copy = el.cloneNode(true) as HTMLElement;
      copy.style.opacity = "";
      // A hair of overlap hides the seams between strips.
      const left = Math.max(0, k * step - 0.5), right = Math.max(0, w - (k + 1) * step - 0.5);
      copy.style.cssText += `; position: absolute; inset: 0; width: ${w}px; height: ${h}px; margin: 0;
        clip-path: inset(-${h}px ${right}px -${h}px ${left}px); transform-origin: ${mid}px 50%;`;
      box.append(copy);
      return copy;
    });
    document.body.append(box);
    // Transparent rather than hidden, so it still takes the pointer (its grip stays grippable).
    el.style.opacity = "0";
    return (layer = box);
  }

  function teardown() {
    layer?.remove();
    layer = null;
    strips = [];
    el.style.opacity = "";
  }

  function draw() {
    const box = layer ?? build();
    // Follows the pass, which can still move between rows while stretched, and
    // any scaling around it (it lifts while dragged).
    const r = el.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight, k = r.width / w || 1;
    box.style.left = `${r.left + (r.width - w) / 2}px`;
    box.style.top = `${r.top + (r.height - h) / 2}px`;
    box.style.transform = `scale(${k * (1 + stretch + squish / 2)}, ${k * (1 - stretch / 2 - squish)})`;
    // sin(2πu − phase): the wave rolls along as the phase grows.
    const c = Math.cos(phase) * bend, s = Math.sin(phase) * bend;
    strips.forEach((strip, k) => {
      const y = sinAt[k] * c - cosAt[k] * s;
      const rise = (sinEdge[k + 1] - sinEdge[k]) * c - (cosEdge[k + 1] - cosEdge[k]) * s;
      strip.style.transform = `translateY(${y}px) skewY(${Math.atan(rise / step)}rad)`;
    });
  }

  function tick(now: number) {
    const dt = now - (last || now);
    phase += (dt / WAVE_MS) * 2 * Math.PI;
    last = now;
    if (!settle) {
      // Eased toward the pull, so a quick move doesn't jump between wave and none.
      const k = 1 - Math.exp(-dt / FOLLOW_MS);
      stretch += (toStretch - stretch) * k;
      squish += (toSquish - squish) * k;
      bend += (toBend - bend) * k;
    } else {
      const t = Math.min(1, (now - settle.start) / SETTLE_MS);
      // The stretches spring back with an overshoot; the wave keeps rolling as it dies away.
      const spring = Math.exp(-6 * t) * Math.cos(3 * Math.PI * t);
      stretch = settle.s0 * spring;
      squish = settle.q0 * spring;
      bend = settle.b0 * Math.exp(-5 * t);
      if (t >= 1) (stretch = squish = bend = 0), (settle = null);
    }
    // Done once it's back at rest with nothing pulling (easing only ever nears 0, so near is enough).
    if (!settle && !toStretch && !toSquish && !toBend && Math.abs(stretch) < 1e-3 && Math.abs(squish) < 1e-3 && Math.abs(bend) < 0.02) {
      stretch = squish = bend = 0;
      frame = last = 0;
      return teardown();
    }
    draw();
    frame = requestAnimationFrame(tick);
  }

  const run = () => {
    if (!frame) frame = requestAnimationFrame(tick);
  };

  return {
    pull(x: number, y: number) {
      settle = null;
      toStretch = rubber(Math.abs(x), MAX_STRETCH);
      toSquish = rubber(Math.abs(y), MAX_STRETCH);
      toBend = Math.sign(y) * MAX_BEND * Math.min(1, Math.abs(y) / BEND_REACH);
      run();
    },
    /** Lets it settle (unless it's settling already, or has nothing to settle). */
    release() {
      toStretch = toSquish = toBend = 0;
      if (settle || (!stretch && !squish && !bend)) return;
      settle = { s0: stretch, q0: squish, b0: bend, start: performance.now() };
      run();
    },
  };
}
