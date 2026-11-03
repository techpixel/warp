// A multipass warp: a list of passes, each an Editor with its own method and
// cage, applied in order (each warps what the ones before it made). `base`
// holds the imported artwork and is never warped; with no passes, it's what
// the canvas shows.

import { untrack } from "svelte";
import { Editor, PERSPECTIVE_METHOD } from "./editor.svelte";

type WarpPass = { id: number; editor: Editor; stop: () => void };

const DEFAULT_METHOD = "mvc"; // the pass new artwork starts with
export const MAX_PASSES = 4;

export class Passes {
  base = new Editor();
  list = $state.raw<WarpPass[]>([]);
  active = $state<number | null>(null);
  #nextId = 1;

  /** The editor the canvas and settings show: the selected pass, else the bare artwork. */
  current = $derived(this.active === null ? this.base : (this.list[this.active]?.editor ?? this.base));

  /** Adds a pass using method `methodId` after the others (up to MAX_PASSES), and selects it. */
  add(methodId: string) {
    if (!this.base.kind || this.list.length >= MAX_PASSES) return;
    const editor = new Editor();
    const prev = this.list.at(-1)?.editor;
    editor.setMethod(methodId);
    editor.adopt(prev ?? this.base, !!prev, methodId === PERSPECTIVE_METHOD ? "perspective" : "quad");
    // Each pass keeps its own undo history.
    const stop = $effect.root(() => {
      $effect(() => {
        const doc = editor.doc;
        untrack(() => editor.record(doc));
      });
    });
    this.list = [...this.list, { id: this.#nextId++, editor, stop }];
    this.select(this.list.length - 1);
  }

  /** Removes pass i, unless it's the only one. */
  remove(i: number) {
    const gone = this.list[i];
    if (!gone || this.list.length < 2) return;
    gone.stop();
    this.list = this.list.toSpliced(i, 1);
    this.#relinkFrom(i);
    if (this.active !== null) {
      const next = this.active > i ? this.active - 1 : this.active === i ? Math.min(i, this.list.length - 1) : this.active;
      this.select(next < 0 ? null : next);
    }
  }

  /** Moves pass `from` to position `to`, keeping the same pass selected. */
  move(from: number, to: number) {
    if (from === to || !this.list[from] || to < 0 || to >= this.list.length) return;
    const selected = this.active === null ? null : this.list[this.active];
    const list = this.list.toSpliced(from, 1);
    this.list = list.toSpliced(to, 0, this.list[from]);
    this.#relinkFrom(Math.min(from, to));
    if (selected) this.active = this.list.indexOf(selected);
  }

  select(i: number | null) {
    const view = this.current.view;
    this.active = i;
    // The view carries over, so switching passes doesn't jump the canvas.
    this.current.view = view;
  }

  /**
   * New artwork: loaded into the base, and every pass gets a fresh cage around
   * its share of it. With no passes yet, it starts with an MVC one.
   */
  async load(file: File) {
    await this.base.loadFile(file);
    this.#readopt();
    if (!this.list.length && this.base.kind) this.add(DEFAULT_METHOD);
  }

  #readopt() {
    this.list.forEach(({ editor }, i) => {
      editor.adopt(i ? this.list[i - 1].editor : this.base, i > 0, editor.cageType);
    });
  }

  /** After the order changes: each pass from `i` on takes its input from the pass now before it. Cages stay. */
  #relinkFrom(i: number) {
    for (let k = Math.max(0, i); k < this.list.length; k++) {
      this.list[k].editor.relink(k ? this.list[k - 1].editor : this.base, k > 0);
    }
  }

  /** Exports the artwork through every pass. */
  export() {
    (this.list.at(-1)?.editor ?? this.base).export();
  }
}
