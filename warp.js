#!/usr/bin/env node
// Usage: node warp.js input.svg [output.svg]   (omit output to print to stdout)
import { readFileSync, writeFileSync } from "node:fs";
import { DOMParser } from "linkedom";
import { warpSvgElement } from "./src/lib/warp-core.js";

/**
 * Customize me.
 *
 * Receives a CurveArray: every segment is absolute and converted to cubics, i.e.
 *   [["M", x, y], ["C", x1, y1, x2, y2, x, y], ...]
 * so warping is just moving points around. Return a PathArray.
 *
 * `el` is the source element, if you need its attributes.
 */
function transform(path, el) {
  return path;
}

function warpSvg(source) {
  const doc = new DOMParser().parseFromString(source, "image/svg+xml");
  warpSvgElement(doc.documentElement, transform);
  return doc.toString();
}

const [input, output] = process.argv.slice(2);
if (!input) {
  console.error("Usage: node warp.js input.svg [output.svg]");
  process.exit(1);
}

const result = warpSvg(readFileSync(input, "utf8"));
if (output) writeFileSync(output, result);
else process.stdout.write(result + "\n");
