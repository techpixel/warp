<script lang="ts">
  import { tick } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { flip } from "svelte/animate";
  import { scale, slide } from "svelte/transition";
  import Button from "#lib/components/Button.svelte";
  import Checkbox from "#lib/components/Checkbox.svelte";
  import Logo from "#lib/components/Logo.svelte";
  import Slider from "#lib/components/Slider.svelte";
  import Stage from "#lib/components/Stage.svelte";
  import Submenu from "#lib/components/Submenu.svelte";
  import WarpPass from "#lib/components/WarpPass.svelte";
  import { methods, PERSPECTIVE_METHOD } from "#lib/editor.svelte.js";
  import { connectFigma, inFigma, requestSelection } from "#lib/figma.js";
  import { tug } from "#lib/flutter.js";
  import { hold } from "#lib/hold.js";
  import { MAX_PASSES, Passes } from "#lib/passes.svelte.js";
  import { PRESETS, THUMB_VIEWBOX, thumbnailLines } from "#lib/presets.js";
  import plus from "#lib/assets/icons/plus.svg";

  const passes = new Passes();
  // In the Figma plugin, the selected layer is the artwork, and exports go back onto the canvas.
  /** In Figma: a layer is selected that hasn't been imported yet, so Import selection pulses. */
  let selectionReady = $state(false);
  if (inFigma) connectFigma((file) => passes.load(file), (ready) => (selectionReady = ready));

  // Motion takes the CSS `--ease` duration (300ms), and is skipped for reduced motion.
  const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const EASE_MS = reducedMotion ? 0 : 300;
  /**
   * The settings panel growing up from the bottom of the sidebar; the buttons
   * above it ride up with its top edge. Same timing as a pass scaling in.
   */
  const SLIDE_UP = { duration: EASE_MS, easing: cubicOut };
  /**
   * The settings panel sits at the bottom of the sidebar, so when its height
   * changes, its top edge moves: it slides there (with the same timing) instead
   * of jumping. A change mid-slide carries on from where the panel is.
   */
  const slideOnResize = (el: HTMLElement) => {
    const born = performance.now();
    let last = 0;
    const observer = new ResizeObserver(([entry]) => {
      const h = entry.borderBoxSize[0].blockSize, grew = h - last;
      last = h;
      // Its intro (SLIDE_UP) covers its first EASE_MS.
      if (!grew || !EASE_MS || performance.now() - born < EASE_MS) return;
      const now = getComputedStyle(el).transform;
      const from = (now === "none" ? 0 : new DOMMatrix(now).m42) + grew;
      for (const a of el.getAnimations()) if (a.id === "settle") a.cancel();
      el.animate([{ transform: `translateY(${from}px)` }, { transform: "none" }], {
        id: "settle",
        duration: EASE_MS,
        easing: "cubic-bezier(0.33, 1, 0.68, 1)", // cubicOut
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  };
  const editor = $derived(passes.current);
  let fileInput = $state<HTMLInputElement>();
  let cageInput = $state<HTMLInputElement>();

  // Which submenu is open, and where (its top-left, over the button that opened it).
  let menu = $state<{ kind: "method" | "more" | "advanced"; at: { x: number; y: number; w: number; h: number } } | null>(null);
  /** The selected pass's colors, which the menus take on. */
  const menuAccent = $derived(passes.active !== null ? editor.method : null);
  const openMenu = (kind: "method" | "more" | "advanced", e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menu = { kind, at: { x: r.left, y: r.top, w: r.width, h: r.height } };
  };

  // The cage tiles: three cage types (Perspective in place of Quad for the
  // Perspective method), then presets; "More" lists the rest.
  const ASPECT = 1.6; // matches the preset thumbnails' viewBox
  const box = (pts: [number, number][]) => pts.map(([x, y]) => `${x * ASPECT},${y}`).join(" ");
  const TYPE_TILES: { value: string; label: string; lines: string[] }[] = [
    {
      value: "fit",
      label: "Freeform",
      lines: [box([[0.1, 0.25], [0.35, 0], [0.7, 0.1], [1, 0.05], [0.9, 0.55], [1, 1], [0.55, 0.85], [0.15, 1], [0, 0.6], [0.1, 0.25]])],
    },
    { value: "quad", label: "Quad", lines: [box([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]])] },
    {
      value: "mesh",
      label: "Mesh",
      lines: [
        box([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]),
        ...[1 / 3, 2 / 3].flatMap((t) => [box([[t, 0], [t, 1]]), box([[0, t], [1, t]])]),
      ],
    },
  ];
  const PERSPECTIVE_TILE = {
    value: "perspective",
    label: "Perspective",
    lines: [box([[0.2, 0], [0.8, 0], [1, 1], [0, 1], [0.2, 0]])],
  };
  const typeTiles = $derived(
    editor.methodId === PERSPECTIVE_METHOD ? TYPE_TILES.map((t) => (t.value === "quad" ? PERSPECTIVE_TILE : t)) : TYPE_TILES,
  );
  const SHOWN_PRESETS = PRESETS.slice(0, 5);

  // The controls' heights, measured. The panel keeps room for the tallest set (so it
  // doesn't jump between passes), but as blank space that gives way before anything
  // scrolls when the window is short.
  let perspH = $state(0), slidersH = $state(0), slotH = $state(0);
  const SLIDERS_GAP = 8; // matches .sliders
  const controlsH = $derived(
    editor.perspective ? perspH : slidersH - (editor.methodId === "hybrid" ? 0 : slotH + SLIDERS_GAP),
  );
  const reserveH = $derived(Math.max(perspH, slidersH) - controlsH);
  const moreItems = PRESETS.slice(5).map((p) => ({ value: p.id, label: p.label }));
  const moreChosen = $derived(moreItems.some((i) => i.value === editor.cageChoice));

  /** The file a hidden input picked, cleared so picking the same file again still fires. */
  function picked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    return file;
  }

  // Dragging a pass by its grip moves it up or down the list, a row at a time.
  const PASS_STEP = 40; // a row and the gap below it
  const PAST_END = 128; // how far a pass is pulled past the first or last row before the wave creeps in
  const SIDEWAYS = 32; // how far it's pulled sideways before it stretches
  // Tugged where it can't go (sideways, or past the top or bottom of the list,
  // as a lone pass always is), it gives a little and settles when let go (see flutter.ts).
  /** The pass being dragged to a new spot, by id, which lifts a little meanwhile. */
  let lifted = $state<number | null>(null);
  function grabPass(e: PointerEvent, i: number) {
    let at = i, startY = e.clientY;
    const id = passes.list[i]?.id ?? null;
    const grip = e.currentTarget as HTMLElement;
    const pass = grip.closest<HTMLElement>(".pass");
    const give = pass && EASE_MS ? tug(pass) : null;
    passes.select(i);
    // Captured, so the drag keeps every move until the button comes up, wherever the pointer
    // goes. Reordering can move the grip's own node, which drops the capture, so it's taken
    // again after each move, and the window (which hears either way) does the listening.
    const capture = () => {
      try { if (grip.isConnected) grip.setPointerCapture(e.pointerId); } catch {}
    };
    capture();
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const last = passes.list.length - 1;
      const dy = ev.clientY - startY;
      const pastEnd = at === 0 && dy < -PAST_END ? dy + PAST_END : at === last && dy > PAST_END ? dy - PAST_END : 0;
      const sideways = Math.max(0, Math.abs(ev.clientX - e.clientX) - SIDEWAYS);
      if (sideways || pastEnd) give?.pull(sideways, pastEnd);
      else give?.release();
      if (last > 0 && Math.abs(ev.clientY - e.clientY) > 4) lifted = id;
      const to = Math.max(0, Math.min(last, at + Math.round(dy / PASS_STEP)));
      if (to === at) return;
      passes.move(at, to);
      startY += (to - at) * PASS_STEP;
      at = to;
      tick().then(capture);
    };
    window.addEventListener("pointermove", move);
    // Captured above (and again after each reorder), so `hold` doesn't capture or end on losing it.
    hold(grip, e, () => {
      window.removeEventListener("pointermove", move);
      if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
      give?.release();
      lifted = null;
    }, false);
  }

  function onkeydown(e: KeyboardEvent) {
    if (!editor.kind) return;
    if ((e.target as Element).closest("input:not([type=checkbox]):not([type=range]), [role=menu]")) return;
    // Cmd-Z (Ctrl-Z) undoes; with Shift, or Cmd-Y, redoes.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "z" || e.key === "Z" || e.key === "y")) {
      e.preventDefault();
      if (e.key === "y" || e.shiftKey) editor.redo();
      else editor.undo();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.key === "e" || e.key === "E") && passes.active !== null && !editor.perspective) editor.editing = !editor.editing;
    else if (e.key === "=" || e.key === "+") editor.zoomBy(1.25);
    else if (e.key === "-") editor.zoomBy(1 / 1.25);
    else if (e.key === "0") editor.view = editor.fitView;
    else if ((e.key === "Delete" || e.key === "Backspace") && !editor.editing) return;
    else if ((e.key === "Delete" || e.key === "Backspace") && editor.selectedGuide !== null) {
      e.preventDefault();
      editor.unlink(editor.selectedGuide);
    } else if ((e.key === "Delete" || e.key === "Backspace") && editor.selected.length) {
      e.preventDefault();
      editor.removePoints(editor.selected);
    }
  }
</script>

<svelte:window
  {onkeydown}
  onpointerdowncapture={() => editor.gesture(true)}
  onpointerupcapture={() => editor.gesture(false)}
  onpointercancelcapture={() => editor.gesture(false)}
  onpointermovecapture={(e) => e.buttons === 0 && editor.gesture(false)}
/>

<div class="app">
  <aside>
    <div class="top">
      <header>
        <Logo />
        <button
          type="button"
          class="new"
          aria-label="Add a warp pass"
          aria-haspopup="menu"
          aria-expanded={menu?.kind === "method"}
          disabled={!passes.base.kind || passes.list.length >= MAX_PASSES}
          onclick={(e) => openMenu("method", e)}
        >
          <img src={plus} width="24" height="24" alt="" />
        </button>
      </header>

      <!-- Always present (even empty), so the first pass is added to it and scales in like the rest. -->
      <div class="passes" role="listbox" aria-label="Warp passes">
        {#each passes.list as pass, i (pass.id)}
          <!-- Scales in when added, and back out when deleted; the others slide into place.
               Lifts a little while it's dragged to a new spot. -->
          <div
            class={{ lifted: lifted === pass.id }}
            animate:flip={{ duration: EASE_MS, easing: cubicOut }}
            transition:scale={{ start: 0.8, duration: EASE_MS, easing: cubicOut }}
          >
            <WarpPass
              label={pass.editor.method?.label ?? pass.editor.methodId}
              color={pass.editor.method?.color ?? "#5549ff"}
              onColor={pass.editor.method?.onColor ?? "#fff"}
              selected={passes.active === i}
              removable={passes.list.length > 1}
              onselect={() => passes.select(i)}
              onremove={() => passes.remove(i)}
              ongrab={(e) => grabPass(e, i)}
            />
          </div>
        {/each}
      </div>

      <div class="actions">
        {#if inFigma}
          <Button attention={selectionReady} onclick={requestSelection}>Import selection</Button>
          <Button primary disabled={!passes.base.kind} onclick={() => passes.export()}>Place</Button>
        {:else}
          <Button attention={!passes.base.kind} onclick={() => fileInput?.click()}>Open…</Button>
          <Button disabled={!passes.base.kind} onclick={() => passes.export()}>
            Export {passes.base.kind === "image" ? "PNG" : "SVG"}
          </Button>
        {/if}
        <input
          bind:this={fileInput}
          type="file"
          accept=".svg,image/svg+xml,image/png,image/jpeg,image/webp,image/gif"
          hidden
          onchange={(e) => {
            const file = picked(e);
            if (file) passes.load(file);
          }}
        />
      </div>
    </div>

    {#if passes.active !== null}
      <section
        in:slide={SLIDE_UP}
        {@attach slideOnResize}
        class="settings"
        aria-label="Pass settings"
        style:--accent={editor.method?.color}
        style:--on-accent={editor.method?.onColor}
      >
        <div class="heading">
          Cage
          <span class="rule"></span>
        </div>

        <div class="tiles" role="group" aria-label="Cage">
          {#each typeTiles as tile (tile.value)}
            <button
              type="button"
              aria-label={tile.label}
              aria-pressed={editor.cageChoice === tile.value}
              onclick={() => editor.chooseCage(tile.value)}
            >
              <svg viewBox={THUMB_VIEWBOX} aria-hidden="true">
                {#each tile.lines as points, i (i)}
                  <polyline {points} />
                {/each}
              </svg>
            </button>
          {/each}
          {#each SHOWN_PRESETS as preset (preset.id)}
            <button
              type="button"
              aria-label={preset.label}
              aria-pressed={editor.cageChoice === preset.id}
              onclick={() => editor.chooseCage(preset.id)}
            >
              <svg viewBox={THUMB_VIEWBOX} aria-hidden="true">
                {#each thumbnailLines(preset) as points, i (i)}
                  <polyline {points} />
                {/each}
              </svg>
            </button>
          {/each}
          <button
            type="button"
            class="more"
            aria-haspopup="menu"
            aria-expanded={menu?.kind === "more"}
            aria-pressed={moreChosen}
            onclick={(e) => openMenu("more", e)}
          >
            More
          </button>
        </div>

        <div class="row">
          <Button
            pressed={editor.editing}
            disabled={editor.perspective}
            onclick={() => (editor.editing = !editor.editing)}
          >
            Edit
          </Button>
          <Button pressed={menu?.kind === "advanced"} onclick={(e) => openMenu("advanced", e)}>Advanced</Button>
          <input
            bind:this={cageInput}
            type="file"
            accept=".svg,.json,image/svg+xml,application/json"
            hidden
            onchange={(e) => {
              const file = picked(e);
              if (file) editor.loadCageFile(file);
            }}
          />
        </div>

        <!-- Every method's controls are laid out in one spot (only the current one shown) to be
             measured; the box shows just the current one, and .reserve makes up the rest. -->
        <div class="controls" style:height={perspH || slidersH ? `${controlsH}px` : undefined}>
          <div
            class={["variant", "persp", { hidden: !editor.perspective }]}
            inert={!editor.perspective}
            bind:offsetHeight={perspH}
          >
          <Slider
            id="perspective-strength"
            label="Perspective strength"
            min={0}
            max={300}
            value={editor.perspectiveStrength}
            oninput={(v) => editor.setPerspectiveStrength(v)}
            reset={50}
          />
          <div class="rotation" role="group" aria-label="Rotation">
            {#each [["pitch", "X rot"], ["yaw", "Y rot"], ["roll", "Z rot"]] as const as [axis, label] (axis)}
              <label>
                <span>{label}</span>
                <span class="degrees">
                  <input
                    type="number"
                    step="1"
                    value={+editor.orbit[axis].toFixed(1)}
                    oninput={(e) => {
                      const v = parseFloat(e.currentTarget.value);
                      if (Number.isFinite(v)) editor.setOrbit({ [axis]: v });
                    }}
                  />°
                </span>
              </label>
            {/each}
          </div>
          </div>
          <div
            class={["variant", "sliders", { hidden: editor.perspective }]}
            inert={editor.perspective}
            bind:offsetHeight={slidersH}
          >
            <div
              class={["slot", { hidden: editor.methodId !== "hybrid" }]}
              inert={editor.methodId !== "hybrid"}
              bind:offsetHeight={slotH}
            >
              <Slider
                id="hybrid"
                label="Green Mix"
                min={0}
                max={100}
                value={editor.hybridGreen}
                oninput={(v) => (editor.hybridGreen = v)}
                reset={50}
              />
            </div>
            <Slider
              id="strength"
              label="Strength"
              min={-100}
              max={100}
              value={editor.strength}
              disabled={editor.cageChoice === "fit"}
              oninput={(v) => editor.setStrength(v)}
              reset={100}
            />
            <div class="smoothing">
              <Slider
                id="smoothing"
                label="Smoothing Complexity"
                min={1}
                max={32}
                value={editor.smoothing}
                oninput={(v) => (editor.smoothing = v)}
                reset={16}
                disabled={!editor.curves}
              />
              <Checkbox
                label="Smooth"
                bind:checked={editor.curves}
                onchange={() => {
                  try { localStorage.setItem("warp:curves", editor.curves ? "on" : "off"); } catch {}
                }}
              />
            </div>
          </div>
        </div>
        <div class="reserve" style:flex-basis="{reserveH}px"></div>
      </section>
    {/if}
  </aside>

  <Stage {editor} bare={passes.active === null} onfile={(file) => passes.load(file)} />
</div>

{#if menu?.kind === "method"}
  <Submenu
    accent={menuAccent?.color}
    onAccent={menuAccent?.onColor}
    label="Warp method"
    at={menu.at}
    items={methods.map((m) => ({ value: m.id, label: m.label, color: m.color, onColor: m.onColor }))}
    onselect={(id) => {
      menu = null;
      passes.add(id);
    }}
    onclose={() => (menu = null)}
  />
{:else if menu?.kind === "more"}
  <Submenu
    accent={menuAccent?.color}
    onAccent={menuAccent?.onColor}
    label="More cages"
    at={menu.at}
    width={160}
    items={moreItems}
    value={editor.cageChoice}
    onselect={(v) => {
      menu = null;
      editor.chooseCage(v);
    }}
    onclose={() => (menu = null)}
  />
{:else if menu?.kind === "advanced"}
  <!-- The Perspective cage follows its rotation, so it can't take an imported one. -->
  <Submenu
    accent={menuAccent?.color}
    onAccent={menuAccent?.onColor}
    label="Advanced"
    at={menu.at}
    width={160}
    items={[
      ...(editor.perspective ? [] : [{ value: "import", label: "Import cage…" }]),
      { value: "export", label: "Export cage" },
    ]}
    onselect={(v) => {
      menu = null;
      if (v === "import") cageInput?.click();
      else editor.exportCage();
    }}
    onclose={() => (menu = null)}
  />
{/if}

<style>
  .app {
    display: grid;
    grid-template-columns: 378px 1fr;
    height: 100vh;
    height: 100dvh;
  }
  aside {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    background: var(--panel);
    border-radius: 0 16px 16px 0;
  }
  /* The top (the passes) always shows in full; when the window is too short,
     the settings below it give way and scroll instead. */
  .top {
    display: flex;
    flex: 1 0 auto;
    flex-direction: column;
    padding: 16px 24px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .new {
    display: flex;
    margin-right: -4px;
    padding: 4px;
    color: inherit;
    background: none;
    border: 0;
    border-radius: 8px;
    cursor: pointer;
    transition: background-color var(--ease);
  }
  .new:hover:not(:disabled),
  .new[aria-expanded="true"] {
    background: rgb(255 255 255 / 0.2);
  }
  .new:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .new:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .passes {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 16px;
  }
  .passes > div {
    position: relative;
    transition: scale var(--ease);
  }
  /* Above the others, as it's carried over them. */
  .passes > .lifted {
    z-index: 1;
    scale: 1.03;
  }
  .actions {
    display: flex;
    gap: 6px;
    margin-top: auto;
    padding-top: 16px;
  }
  .settings {
    display: flex;
    flex: 0 1 auto;
    min-height: 0;
    overflow-y: auto;
    flex-direction: column;
    gap: 12px;
    padding: 16px 24px 24px;
    background: var(--accent);
    /* Fills in below while it slides up into a shorter height (see slideOnResize). */
    box-shadow: 0 100vh 0 0 var(--accent);
    transition: background-color var(--ease);
    /* Everything in the panel is drawn in the color that reads on its method's accent. */
    --ink: var(--on-accent, #fff);
    --line: var(--on-accent, #fff);
    --focus: var(--on-accent, #fff);
    --hover: color-mix(in srgb, var(--on-accent, #fff) 10%, transparent);
    color: var(--ink);
  }
  .heading {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 14px;
    line-height: 1;
  }
  /* A 1px rule in the panel's line color, so it reads on every method's accent. */
  .rule {
    flex: 1;
    min-width: 0;
    border-top: 1px solid var(--line);
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
  }
  .tiles button {
    height: 44px;
    padding: 5px;
    color: var(--ink);
    background: none;
    border: 1px solid var(--line);
    border-radius: 8px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: background-color var(--ease), color var(--ease);
  }
  .tiles button:hover:not(:disabled) {
    background: var(--hover);
  }
  .tiles button[aria-pressed="true"] {
    color: var(--accent);
    background: var(--ink);
  }
  .tiles button:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .tiles button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .tiles svg {
    display: block;
    width: 100%;
    height: 100%;
    fill: none;
    stroke: currentColor;
    stroke-width: 1;
    stroke-linejoin: round;
    opacity: 0.8;
    transition: opacity var(--ease);
  }
  .tiles polyline {
    vector-effect: non-scaling-stroke;
  }
  .tiles button:hover svg,
  .tiles button[aria-pressed="true"] svg {
    opacity: 1;
  }
  .row {
    display: flex;
    gap: 6px;
  }
  /* The sidebar's buttons, a size down from Button's default. */
  .actions > :global(.button),
  .row > :global(.button) {
    padding: 5px 8px;
    font-size: 14px;
  }
  .sliders {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  /* Clipped to the current controls; the taller hidden set would otherwise make it scroll. */
  .controls {
    display: grid;
    overflow: clip;
    overflow-clip-margin: 4px; /* room for focus rings */
  }
  .variant {
    grid-area: 1 / 1;
    align-self: start;
  }
  /* The rest of the tallest set's room, which shrinks away first. Its negative margin
     cancels the panel's gap, so at 0px it takes no space. */
  .reserve {
    flex-shrink: 1;
    min-height: 0;
    margin-top: -12px;
  }
  .hidden {
    visibility: hidden;
  }
  /* Hybrid's slider keeps its room when hidden, but below the others, so they don't leave a gap. */
  .slot.hidden {
    order: 1;
  }
  .persp {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .sliders > :global(.slider),
  .slot > :global(.slider) {
    padding-bottom: 4px;
  }
  .smoothing {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .rotation {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    font-size: 12px;
  }
  .rotation label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .degrees {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .rotation input {
    flex: 1;
    width: 0;
    min-width: 0;
    padding: 4px 8px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: none;
    color: var(--ink);
    font: inherit;
    font-size: 16px;
    font-variant-numeric: tabular-nums;
  }
  .rotation input:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  @media (max-width: 720px) {
    .app {
      grid-template-columns: 1fr;
      grid-template-rows: auto 1fr;
    }
    aside {
      max-height: 60dvh;
      border-radius: 0 0 16px 16px;
    }
    .top {
      padding: 16px;
    }
    .settings {
      padding: 16px;
      overflow-y: auto;
    }
    .tiles button {
      height: 36px;
    }
  }
</style>
