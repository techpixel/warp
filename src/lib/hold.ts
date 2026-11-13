// Drags that end reliably, even where the pointerup goes missing.

/**
 * Holds a drag that press `e` started (capturing the pointer on `el`, unless
 * `capture` is false) until the button comes up, then calls `end` once. Embedded
 * in a host like Figma's plugin panel, the pointerup can go missing, which would
 * leave the drag following the pointer; so any sign of release ends it: a pointerup
 * or mouseup anywhere, a cancel, lost capture, the window losing focus, the next
 * press, or a move with no button held.
 */
export function hold(el: Element, e: PointerEvent, end: () => void, capture = true) {
  const signals = ["pointerup", "mouseup", "pointercancel", "pointerdown", "blur"];
  let over = false;
  const done = (ev?: Event) => {
    // Caught on the way down, a control losing focus (as this press takes it) is a blur too; only the window's counts.
    console.log("[warp:hold] signal", ev?.type, (ev?.target as Element)?.nodeName ?? ev?.target, "buttons" in (ev ?? {}) ? (ev as PointerEvent).buttons : "", { over }); // DEBUG
    if (over || (ev?.type === "blur" && ev.target !== window)) return;
    over = true;
    for (const s of signals) window.removeEventListener(s, done, true);
    window.removeEventListener("pointermove", idle, true);
    el.removeEventListener("lostpointercapture", done);
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    end();
  };
  const idle = (ev: PointerEvent) => ev.buttons === 0 && done();
  if (capture) {
    try { el.setPointerCapture(e.pointerId); } catch {}
    el.addEventListener("lostpointercapture", done);
  }
  // This press has already passed the window, so it won't end its own drag.
  for (const s of signals) window.addEventListener(s, done, true);
  window.addEventListener("pointermove", idle, true);
}
