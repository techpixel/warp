<!--
  A small outlined checkbox with its label to the right; checked, it fills
  with the ink color and shows a check mark in the accent.
-->
<script lang="ts">
  let {
    label,
    checked = $bindable(),
    onchange,
    disabled = false,
  }: { label: string; checked: boolean; onchange?: () => void; disabled?: boolean } = $props();
</script>

<label class="checkbox">
  <input type="checkbox" bind:checked {disabled} {onchange} />
  <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
  {label}
</label>

<style>
  .checkbox {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    width: fit-content;
    font-size: 12px;
    cursor: pointer;
  }
  .checkbox:has(input:disabled) {
    opacity: 0.4;
    cursor: default;
  }
  input {
    appearance: none;
    flex: none;
    width: 16px;
    height: 16px;
    margin: 0;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: none;
    cursor: inherit;
  }
  input:checked {
    background: var(--ink);
  }
  /* The check sits over the box, drawn in the accent so it shows on the ink fill. */
  svg {
    position: absolute;
    left: 2px;
    display: none;
    fill: none;
    stroke: var(--accent);
    stroke-width: 3.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    pointer-events: none;
  }
  input:checked + svg {
    display: block;
  }
  input:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
</style>
