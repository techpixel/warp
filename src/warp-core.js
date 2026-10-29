// Shared by the CLI (warp.js, via linkedom) and the browser page (src/app.ts).
import {
  getPathBBox,
  parsePathString,
  pathToCurve,
  pathToString,
  shapeToPathArray,
} from "svg-path-commander/util";

export const SHAPES = ["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"];

// Attributes that only make sense on the original shape, not on a <path>.
const SHAPE_ATTRS = ["x", "y", "width", "height", "rx", "ry", "cx", "cy", "r", "x1", "y1", "x2", "y2", "points"];

/** Every drawable shape under `root`, as [element, CurveArray]. */
export function collectCurves(root) {
  const out = [];
  for (const el of root.querySelectorAll(SHAPES.join(","))) {
    const pathArray = el.tagName.toLowerCase() === "path"
      ? parsePathString(el.getAttribute("d") || "")
      : shapeToPathArray(el);
    if (pathArray && pathArray.length) out.push([el, pathToCurve(pathArray)]);
  }
  return out;
}

/**
 * Runs `transform(curveArray, el)` over every shape under `root` (in place).
 * Non-path shapes are replaced by an equivalent <path>.
 */
export function warpSvgElement(root, transform) {
  const doc = root.ownerDocument;

  for (const [el, curve] of collectCurves(root)) {
    const d = pathToString(transform(curve, el), 3);

    if (el.tagName.toLowerCase() === "path") {
      el.setAttribute("d", d);
      continue;
    }

    const replacement = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    for (const { name, value } of [...el.attributes]) {
      if (!SHAPE_ATTRS.includes(name)) replacement.setAttribute(name, value);
    }
    replacement.setAttribute("d", d);
    el.replaceWith(replacement);
  }
  return root;
}

/** Union bbox of every shape under `root` (ignores `transform` attributes). */
export function contentBBox(root) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [, curve] of collectCurves(root)) {
    const b = getPathBBox(curve);
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x2);
    y2 = Math.max(y2, b.y2);
  }
  if (!Number.isFinite(x1)) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** Maps every coordinate pair of an absolute M/L/C path through `fn([x, y]) => [x, y]`. */
export function mapPoints(path, fn) {
  return path.map(([cmd, ...nums]) => {
    const out = [cmd];
    for (let i = 0; i + 1 < nums.length; i += 2) out.push(...fn([nums[i], nums[i + 1]]));
    return out;
  });
}

/**
 * Splits every cubic into `n` equal-t pieces. Non-affine warps only move
 * control points, so more pieces = closer to the "true" warped curve.
 */
export function subdivide(path, n) {
  if (n <= 1) return path;
  const out = [];
  let cur = [0, 0];
  for (const seg of path) {
    if (seg[0] !== "C") {
      out.push(seg);
      if (seg[0] === "M") cur = [seg[1], seg[2]];
      continue;
    }
    let p0 = cur, p1 = [seg[1], seg[2]], p2 = [seg[3], seg[4]], p3 = [seg[5], seg[6]];
    for (let k = n; k > 1; k--) {
      // Split off the first 1/k of what's left (de Casteljau).
      const t = 1 / k;
      const a = lerp(p0, p1, t), b = lerp(p1, p2, t), c = lerp(p2, p3, t);
      const d = lerp(a, b, t), e = lerp(b, c, t), f = lerp(d, e, t);
      out.push(["C", ...a, ...d, ...f]);
      p0 = f; p1 = e; p2 = c;
    }
    out.push(["C", ...p1, ...p2, ...p3]);
    cur = p3;
  }
  return out;
}

const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
