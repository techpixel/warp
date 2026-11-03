<!--
  The sidebar's outlined text button. With `pressed` set it's a toggle,
  filled while on. With `attention`, it blinks to say it's the thing to do next.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    children,
    onclick,
    pressed,
    disabled = false,
    attention = false,
  }: {
    children: Snippet;
    onclick: (e: MouseEvent) => void;
    pressed?: boolean;
    disabled?: boolean;
    attention?: boolean;
  } = $props();
</script>

<button type="button" class={["button", { attention }]} aria-pressed={pressed} {disabled} {onclick}>
  {@render children()}
</button>

<style>
  .button {
    flex: 1 0 0;
    min-width: 0;
    padding: 4px 8px;
    color: var(--ink);
    background: none;
    border: 1px solid var(--line);
    border-radius: 8px;
    font: inherit;
    font-size: 16px;
    line-height: normal;
    text-align: center;
    cursor: pointer;
    transition: background-color var(--ease), color var(--ease);
  }
  .button:hover:not(:disabled) {
    background: var(--hover);
  }
  .button[aria-pressed="true"],
  .button[aria-pressed="true"]:hover {
    color: var(--accent);
    background: var(--ink);
  }
  /* A steady pulse between light and dark gray: 1s each way, with no pause between. */
  .attention {
    animation: blink 1s ease-in-out infinite alternate;
  }
  @keyframes blink {
    from {
      background-color: var(--blink-light);
    }
    to {
      background-color: var(--blink-dark);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .attention {
      animation: none;
    }
  }
  .button:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .button:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
