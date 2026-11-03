// The editor's side of the Figma plugin (see src/figma/code.ts). The plugin
// build runs in "figma" mode; on the site `inFigma` is false and none of this runs.
//
// Messages to the plugin: { type: "selection" } asks for the selected layer;
// { type: "place", name, svg } or { type: "place", name, png } puts an export
// on the canvas. From it: { type: "selection", name, svg } or
// { type: "selection", name, png } is the layer to warp, and { type: "ready", ready }
// says whether a layer is selected that hasn't been imported yet.

import { setSaver } from "./save";

export const inFigma = import.meta.env.MODE === "figma";

type FromPlugin =
  | { type: "selection"; name: string; svg?: string; png?: Uint8Array<ArrayBuffer> }
  | { type: "ready"; ready: boolean };

const post = (msg: object) => parent.postMessage({ pluginMessage: msg }, "*");

/** Asks the plugin for the selected layer, which arrives through `connectFigma`'s `load`. */
export function requestSelection() {
  post({ type: "selection" });
}

/**
 * Hooks the editor up to the plugin: the selected layer is opened with `load`
 * (now, and whenever `requestSelection` is called), `onReady` hears whether
 * there's a new layer to import, and exports are placed on the Figma canvas
 * instead of downloading.
 */
export function connectFigma(load: (file: File) => void, onReady: (ready: boolean) => void) {
  window.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data?.pluginMessage as FromPlugin | undefined;
    if (msg?.type === "ready") return onReady(msg.ready);
    if (msg?.type !== "selection") return;
    if (msg.svg !== undefined) load(new File([msg.svg], `${msg.name}.svg`, { type: "image/svg+xml" }));
    else if (msg.png) load(new File([msg.png], `${msg.name}.png`, { type: "image/png" }));
  });
  setSaver(async (blob, name) => {
    const base = name.replace(/\.(svg|png)$/i, "");
    if (blob.type === "image/png") post({ type: "place", name: base, png: new Uint8Array(await blob.arrayBuffer()) });
    else post({ type: "place", name: base, svg: await blob.text() });
  });
  requestSelection();
}
