/// <reference types="@figma/plugin-typings" />
// The Figma plugin's main thread: it reads the document and sends the selected
// layer to the editor UI (src/lib/figma.ts), and puts what the editor exports
// back on the canvas, beside the layer it came from.

// Image layers are warped as pixels, exported at this scale for detail; their
// warped result is shrunk back by the same factor when placed.
const IMAGE_SCALE = 2;
const GAP = 40; // between the original layer and its warped copy

type Place = { type: "place"; name: string; svg?: string; png?: Uint8Array };
type FromUI = { type: "selection" } | Place;

/** Where the layer being warped sits, so its warped copy can go beside it. */
let source: { x: number; y: number; width: number; scale: number } | null = null;
let importedId: string | null = null; // the layer last sent to the editor, until it's edited

figma.showUI(__html__, { width: 900, height: 570, themeColors: false });

/** Tells the editor whether a single layer is selected that it hasn't already imported (as it now is). */
function sendReady() {
  const selection = figma.currentPage.selection;
  figma.ui.postMessage({ type: "ready", ready: selection.length === 1 && selection[0].id !== importedId });
}

/** Whether `node` is the imported layer or inside it. */
function inImported(node: BaseNode | null) {
  for (; node; node = node.parent) if (node.id === importedId) return true;
  return false;
}

/** Editing the imported layer (or anything in it) makes it worth importing again. */
function onNodeChange({ nodeChanges }: NodeChangeEvent) {
  if (importedId === null) return;
  const edited = nodeChanges.some((c) => c.id === importedId || (c.type !== "DELETE" && inImported(c.node as BaseNode)));
  if (!edited) return;
  importedId = null;
  sendReady();
}

// Only the current page's changes are heard, so the listener moves with it.
let watched = figma.currentPage;
watched.on("nodechange", onNodeChange);
figma.on("currentpagechange", () => {
  watched.off("nodechange", onNodeChange);
  watched = figma.currentPage;
  watched.on("nodechange", onNodeChange);
  sendReady();
});
figma.on("selectionchange", sendReady);

/** A layer that's just an image (no children), which the editor warps as pixels. */
function isImage(node: SceneNode) {
  if ("children" in node || !("fills" in node) || !Array.isArray(node.fills)) return false;
  return (node.fills as readonly Paint[]).some((f) => f.type === "IMAGE" && f.visible !== false);
}

async function sendSelection() {
  const selection = figma.currentPage.selection;
  if (selection.length !== 1) {
    figma.notify(selection.length ? "Select a single layer (group several layers first)." : "Select a layer to warp.");
    return;
  }
  const node = selection[0];
  const box = node.absoluteBoundingBox;
  try {
    if (isImage(node)) {
      const png = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: IMAGE_SCALE } });
      figma.ui.postMessage({ type: "selection", name: node.name, png });
      source = box && { x: box.x, y: box.y, width: box.width, scale: IMAGE_SCALE };
    } else {
      const svg = await node.exportAsync({ format: "SVG_STRING" });
      figma.ui.postMessage({ type: "selection", name: node.name, svg });
      source = box && { x: box.x, y: box.y, width: box.width, scale: 1 };
    }
    importedId = node.id;
  } catch {
    figma.notify(`Couldn't export “${node.name}”.`, { error: true });
  }
  sendReady();
}

async function place({ name, svg, png }: Place) {
  let node: SceneNode;
  try {
    if (svg !== undefined) {
      node = figma.createNodeFromSvg(svg);
    } else if (png) {
      const image = figma.createImage(png);
      const { width, height } = await image.getSizeAsync();
      const scale = source?.scale ?? 1;
      const rect = figma.createRectangle();
      rect.resize(width / scale, height / scale);
      rect.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: image.hash }];
      node = rect;
    } else return;
  } catch {
    figma.notify("Couldn't place the export on the canvas.", { error: true });
    return;
  }
  node.name = name;
  if (source) {
    node.x = source.x + source.width + GAP;
    node.y = source.y;
  } else {
    node.x = figma.viewport.center.x - node.width / 2;
    node.y = figma.viewport.center.y - node.height / 2;
  }
  figma.currentPage.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);
}

figma.ui.onmessage = (msg: FromUI) => {
  if (msg.type === "selection") sendSelection();
  else if (msg.type === "place") place(msg);
};
