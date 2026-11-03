<!--
  A menu of options floating over the page with its top-left at `at` (screen
  pixels), as opened from a button. It expands out of that button (`at.w` ×
  `at.h`), and contracts back into it on closing. Its colors come from
  `accent` (the selected pass's color) and `onAccent` (the text on it).
  Arrow keys move, Enter picks, Escape or a click outside closes.
-->
<script lang="ts">
  import { cubicOut } from "svelte/easing";

  let {
    items,
    at,
    width = 326,
    label,
    value = null,
    accent,
    onAccent,
    onselect,
    onclose,
  }: {
    /** `color` (and `onColor`, the text on it) highlights the option instead of the accent. */
    items: { value: string; label: string; color?: string; onColor?: string }[];
    at: { x: number; y: number; w: number; h: number };
    width?: number;
    label: string;
    value?: string | null;
    accent?: string;
    onAccent?: string;
    onselect: (value: string) => void;
    onclose: () => void;
  } = $props();

  let menu: HTMLUListElement;

  const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const CONTRACT_MS = 150, FADE_MS = 100;
  /**
   * The `expand` animation run backwards (clipped down to the button it opened
   * from), then a fade out of what's left.
   */
  function contract(_node: Element) {
    const split = CONTRACT_MS / (CONTRACT_MS + FADE_MS);
    return {
      duration: reducedMotion ? 0 : CONTRACT_MS + FADE_MS,
      css: (t: number) => {
        const p = 1 - t; // 0 → 1 as it closes
        const k = p < split ? 1 - cubicOut(1 - p / split) : 1;
        const opacity = p < split ? 1 : 1 - cubicOut((p - split) / (1 - split));
        return `pointer-events: none; opacity: ${opacity}; clip-path: inset(0 calc((100% - var(--from-w)) * ${k}) calc((100% - var(--from-h)) * ${k}) 0 round 8px);`;
      },
    };
  }
  const options = () => [...menu.querySelectorAll<HTMLLIElement>("[role=menuitem]")];

  // One highlight behind the options, which slides to whichever has focus.
  let highlight = $state<{ top: number; height: number; color?: string } | null>(null);
  function onfocusin(e: FocusEvent) {
    const el = e.target as HTMLLIElement;
    const item = items.find((it) => it.value === el.dataset.value);
    highlight = { top: el.offsetTop, height: el.offsetHeight, color: item?.color };
  }

  // Opens on the current option (or the first), so the keyboard can carry on from there.
  $effect(() => {
    const els = options();
    (els.find((el) => el.dataset.value === value) ?? els[0])?.focus();
  });

  function onkeydown(e: KeyboardEvent) {
    const els = options();
    const i = els.indexOf(document.activeElement as HTMLLIElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      els[(i + (e.key === "ArrowDown" ? 1 : -1) + els.length) % els.length].focus();
    } else if ((e.key === "Enter" || e.key === " ") && i >= 0) {
      e.preventDefault();
      onselect(els[i].dataset.value!);
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      onclose();
    }
  }
</script>

<svelte:document onpointerdown={(e) => !menu.contains(e.target as Node) && onclose()} />

<ul
  bind:this={menu}
  class="submenu"
  role="menu"
  aria-label={label}
  style:left="{at.x}px"
  style:top="{at.y}px"
  style:width="{width}px"
  style:--from-w="{at.w}px"
  style:--from-h="{at.h}px"
  style:--accent={accent}
  style:--on-accent={onAccent}
  {onkeydown}
  {onfocusin}
  out:contract
>
  {#if highlight}
    <div
      class="highlight"
      aria-hidden="true"
      style:transform="translateY({highlight.top}px)"
      style:height="{highlight.height}px"
      style:background={highlight.color ?? "var(--accent)"}
    ></div>
  {/if}
  {#each items as item (item.value)}
    <li
      role="menuitem"
      tabindex="-1"
      data-value={item.value}
      aria-current={item.value === value || undefined}
      style:--item-on={item.onColor}
      onclick={() => onselect(item.value)}
      onpointerenter={(e) => e.currentTarget.focus()}
      onkeydown={() => {}}
    >
      {item.label}
    </li>
  {/each}
</ul>

<style>
  .submenu {
    position: fixed;
    z-index: 20;
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 4px;
    list-style: none;
    /* A dark shade of the accent, so the menu reads as its pass's. */
    background: color-mix(in srgb, var(--accent) 22%, var(--menu));
    border-radius: 8px;
    animation: expand var(--ease);
  }
  /* Grows from the button it opened from (the menu's top-left corner) to its full size. */
  @keyframes expand {
    from {
      clip-path: inset(0 calc(100% - var(--from-w)) calc(100% - var(--from-h)) 0 round 8px);
    }
    to {
      clip-path: inset(0 round 8px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .submenu {
      animation: none;
    }
    .highlight {
      transition: none;
    }
  }
  .highlight {
    position: absolute;
    top: 0;
    left: 4px;
    right: 4px;
    border-radius: 4px;
    transition:
      transform var(--ease),
      height var(--ease),
      background-color var(--ease);
  }
  li {
    position: relative;
    padding: 4px 6px;
    border-radius: 4px;
    font-size: 16px;
    line-height: 20px;
    white-space: nowrap;
    cursor: pointer;
    transition: color var(--ease);
  }
  li:focus {
    outline: none;
    color: var(--item-on, var(--on-accent, inherit));
  }
</style>
