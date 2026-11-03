// Where exports go. On the site they download; a host (the Figma plugin)
// can take them over with `setSaver`, to place them on its canvas instead.

export type Saver = (blob: Blob, name: string) => void;

function download(blob: Blob, name: string) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}

let saver: Saver = download;

export function setSaver(next: Saver) {
  saver = next;
}

/** Hands an exported file to the current saver. */
export function saveFile(blob: Blob, name: string) {
  saver(blob, name);
}
