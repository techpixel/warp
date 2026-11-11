// A pass tugged where it can't go gives a little. Pulled any way, it bends into
// the Flag preset's warp (its cage, deformed as the preset deforms it, run through
// Green coordinates over the element's box), more the farther it's pulled, rubber-band style;
// the bend is a flag wave, rolling along all the while. Let go, the wave dies
// away as it rolls.
//
// An element isn't paths, so it's drawn as thin vertical strips (live copies,
// each clipped to its strip), each moved by the warp there and turned to its
// slope, as Green keeps shapes (turning them, not shearing), with a little
// overlap to cover the seams; everything stays crisp.

import { type Pt, edgePoint, fitEdge, flattenCage, straightCtrl } from "./cage";
import { methods } from "./editor.svelte";
import { PRESETS, layoutCage } from "./presets";

// The wave keeps growing the farther it's pulled, ever more slowly, toward its most.
const MAX_BEND = 24; // px: the wave at its strongest (within the strips' room, its height)
const BEND_REACH = 400; // px of pull for about two-thirds of the wave
const SETTLE_MS = 900;
const WAVE_MS = 700; // for the wave to roll one wavelength along
const FOLLOW_MS = 90; // how quickly it eases toward the pull: about two-thirds of the way in this long
const STRIP = 11; // px wide, about
const FADE_FROM = 0.4; // share of the way toward a fixed side that the wave starts to die away
const HOLD_FADE = 60; // px over which the wave eases in, leaving the pin's span perfectly flat
const OVERLAP = 2; // px each strip reaches into its neighbors, over the seams its turning opens

const noop = () => {};

/**
 * The warp's displacement (across and down) along the middle of a w × h box, at
 * each x in `xs`, with the preset's wave moved along by `shift` (of a wave) and
 * the box itself kept in place. With `fixed`, the wave dies away smoothly toward
 * that side, which stays put (Green doesn't hold a cage's sides exactly, so the
 * fading does it; and smoothly, so the side isn't turned either).
 */
function wave(w: number, h: number, xs: number[], shift = 0, fixed?: "left" | "right") {
  const green = methods.find((m) => m.id === "green")!;
  const flag = PRESETS.find((p) => p.id === "flag")!;
  const { ring } = layoutCage(flag.layout);
  // The cage sits just outside the box, as the editor's does; a bend preset's
  // movement across scales with the other side (see Preset).
  const m = 1, x0 = -m, y0 = -m, cw = w + 2 * m, ch = h + 2 * m;
  const target = ([x, y]: Pt): Pt => {
    const u = (x - x0) / cw, v = (y - y0) / ch, [, v2] = flag.map(u + shift, v);
    const toward = fixed === "right" ? u : fixed === "left" ? 1 - u : 0;
    const t = Math.min(1, Math.max(0, (toward - FADE_FROM) / (1 - FADE_FROM)));
    return [x, y + (v2 - v) * cw * (1 - t * t * (3 - 2 * t))];
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
  const apply = green.deformer(rest, moved, noop, {}), out = new Float64Array(2);
  const dx: number[] = [], dy: number[] = [];
  for (const x of xs) {
    const wts = green.weights(x, h / 2, rest, noop);
    if (wts) apply(wts, out);
    const ok = wts && Number.isFinite(out[0]) && Number.isFinite(out[1]);
    dx.push(ok ? out[0] - x : 0);
    dy.push(ok ? out[1] - h / 2 : 0);
  }
  return { dx, dy };
}

type Tug = { pull(x: number, y: number): void; release(): void };
const tugs = new WeakMap<HTMLElement, Tug>();

/**
 * Takes over drawing `el` while it's tugged: `pull(x, y)` with how far past
 * where it can go the pointer is (px; either way sets the wave rolling, more the
 * farther it's pulled all told), and `release()` when the tug ends, to let it settle.
 * Given `pin` (a part of `el`, like the grip it's held by), the side it's on stays
 * put and the wave dies away toward it; otherwise it waves around its own middle.
 * One per element: grabbed again mid-settle, it carries on from there.
 */
export function tug(el: HTMLElement, pin?: HTMLElement): Tug {
  let t = tugs.get(el);
  if (!t) tugs.set(el, (t = startTug(el, pin)));
  return t;
}

function startTug(el: HTMLElement, pin?: HTMLElement): Tug {
  let bend = 0, phase = 0;
  let toBend = 0; // where the pull would put it, which it eases toward
  let layer: HTMLDivElement | null = null, strips: HTMLElement[] = [];
  // The wave (across and down) at each strip's middle and edges, and a quarter-wave
  // along: mixed by the phase, they roll it along without running the warp again each frame.
  let sinAt = { dx: [] as number[], dy: [] as number[] }, cosAt = sinAt, sinEdge = sinAt, cosEdge = sinAt, step = 0;
  let pinX = 0; // where across it's held still (px, as laid out)
  let settle: { b0: number; start: number } | null = null;
  let frame = 0, last = 0; // the running animation frame, and when the last one ran

  function build() {
    const w = el.offsetWidth, h = el.offsetHeight; // as laid out, before any scaling around it
    const n = Math.max(2, Math.round(w / STRIP));
    step = w / n;
    const r = el.getBoundingClientRect(), p = pin?.getBoundingClientRect(), unscale = w / r.width || 1;
    pinX = p ? (p.left + p.width / 2 - r.left) * unscale : w / 2;
    // Over the pin's own span, nothing moves or turns at all; the wave eases in beside it.
    const right = pinX > w / 2;
    const near = p ? (right ? p.left - r.left : p.right - r.left) * unscale : 0;
    const hold = (x: number) => {
      if (!p) return 1;
      const t = Math.min(1, Math.max(0, (right ? near - x : x - near) / HOLD_FADE));
      return t * t * (3 - 2 * t);
    };
    const mids = Array.from({ length: n }, (_, k) => (k + 0.5) * step);
    const xs = [...mids, ...Array.from({ length: n + 1 }, (_, k) => k * step), pinX];
    // The wave dies away toward the side nearest the pin, which stays put; and
    // less what's left of it at the pin, so that holds still and the rest swings around it.
    // Scaled so the wave's highest is 1 (and the movement across alongside).
    const fixed = pin ? (right ? "right" : "left") : undefined;
    const sin = wave(w, h, xs, 0, fixed), cos = wave(w, h, xs, 0.25, fixed);
    const most = Math.max(...sin.dy.map(Math.abs), ...cos.dy.map(Math.abs)) || 1;
    const split = ({ dx, dy }: { dx: number[]; dy: number[] }) => {
      const x0 = dx.at(-1)!, y0 = dy.at(-1)!;
      const at = (d: number[], d0: number, k: number) => ((d[k] - d0) / most) * hold(xs[k]);
      const pick = (ks: number[]) => ({ dx: ks.map((k) => at(dx, x0, k)), dy: ks.map((k) => at(dy, y0, k)) });
      return [pick([...Array(n).keys()]), pick(Array.from({ length: n + 1 }, (_, k) => n + k))];
    };
    [sinAt, sinEdge] = split(sin);
    [cosAt, cosEdge] = split(cos);
    const box = document.createElement("div");
    box.setAttribute("aria-hidden", "true");
    box.inert = true;
    box.style.cssText = `position: fixed; width: ${w}px; height: ${h}px; pointer-events: none; z-index: 30;
      transform-origin: ${pinX}px 50%;`;
    strips = mids.map((mid, k) => {
      const copy = el.cloneNode(true) as HTMLElement;
      copy.style.opacity = "";
      // Overlapping, to hide the seams between strips; the end strips are left
      // open outward, so anything drawn past the edges (an outline) still shows.
      const left = k ? k * step - OVERLAP : -h, right = k < n - 1 ? w - (k + 1) * step - OVERLAP : -h;
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
    // Follows the pass, which can still move between rows while waving, and
    // any scaling around it (it lifts while dragged): scaled by k around the pin,
    // the layer lands on its box.
    const r = el.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight, k = r.width / w || 1;
    box.style.left = `${r.left - pinX * (1 - k)}px`;
    box.style.top = `${r.top + (r.height - h) / 2}px`;
    box.style.transform = `scale(${k})`;
    // sin(2πu − phase): the wave rolls along as the phase grows.
    const c = Math.cos(phase) * bend, s = Math.sin(phase) * bend;
    const at = (f: { dx: number[]; dy: number[] }, g: typeof f, d: "dx" | "dy", k: number) => f[d][k] * c - g[d][k] * s;
    strips.forEach((strip, k) => {
      const x = at(sinAt, cosAt, "dx", k), y = at(sinAt, cosAt, "dy", k);
      const rise = at(sinEdge, cosEdge, "dy", k + 1) - at(sinEdge, cosEdge, "dy", k);
      const run = step + at(sinEdge, cosEdge, "dx", k + 1) - at(sinEdge, cosEdge, "dx", k);
      strip.style.transform = `translate(${x}px, ${y}px) rotate(${Math.atan2(rise, run)}rad)`;
    });
  }

  function tick(now: number) {
    const dt = now - (last || now);
    phase += (dt / WAVE_MS) * 2 * Math.PI;
    last = now;
    if (!settle) {
      // Eased toward the pull, so a quick move doesn't jump between wave and none.
      const k = 1 - Math.exp(-dt / FOLLOW_MS);
      bend += (toBend - bend) * k;
    } else {
      const t = Math.min(1, (now - settle.start) / SETTLE_MS);
      // The wave keeps rolling as it dies away.
      bend = settle.b0 * Math.exp(-5 * t);
      if (t >= 1) (bend = 0), (settle = null);
    }
    // Done once it's back at rest with nothing pulling (easing only ever nears 0, so near is enough).
    if (!settle && !toBend && Math.abs(bend) < 0.02) {
      bend = 0;
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
      // Either way pulls the wave in, by how far all told; up or down sets which way it starts.
      toBend = (y < 0 ? -1 : 1) * MAX_BEND * (1 - Math.exp(-Math.hypot(x, y) / BEND_REACH));
      run();
    },
    /** Lets it settle (unless it's settling already, or has nothing to settle). */
    release() {
      toBend = 0;
      if (settle || !bend) return;
      settle = { b0: bend, start: performance.now() };
      run();
    },
  };
}
