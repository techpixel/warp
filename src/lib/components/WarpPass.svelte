<!--
  One warp pass in the sidebar's list: filled while selected, outlined
  otherwise, with a delete button and a grip to drag it up or down the list.
-->
<script lang="ts">

  let {
    label,
    color,
    onColor,
    selected,
    removable,
    onselect,
    onremove,
    ongrab,
  }: {
    label: string;
    /** The method's accent and the color that reads on it, for while it's selected. */
    color: string;
    onColor: string;
    selected: boolean;
    /** False for the only pass, which can't be deleted. */
    removable: boolean;
    onselect: () => void;
    onremove: () => void;
    /** Pointer down on the grip: the list takes over the drag. */
    ongrab: (e: PointerEvent) => void;
  } = $props();
</script>

<div
  class={["pass", { selected }]}
  style:--pass-color={color}
  style:--pass-on={onColor}
  role="option"
  tabindex="0"
  aria-selected={selected}
  onclick={onselect}
  oncontextmenu={(e) => {
    e.preventDefault();
    if (removable) onremove();
  }}
  onkeydown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onselect();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      if (removable) onremove();
    }
  }}
>
  <span class="label">{label}</span>
  <button
    type="button"
    class="delete"
    aria-label="Remove {label} pass"
    disabled={!removable}
    onclick={(e) => {
      e.stopPropagation();
      onremove();
    }}
    onkeydown={(e) => e.stopPropagation()}
  >
    <!-- Lucide trash-2 -->
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6" />
    </svg>
  </button>
  <span
    class="grip"
    role="presentation"
    onpointerdown={(e) => {
      // No text selection or native drag (it would cancel the pointer events), and no click on the row.
      e.preventDefault();
      e.stopPropagation();
      ongrab(e);
    }}
    onclick={(e) => e.stopPropagation()}
  >
    <!-- Drawn inline (not an <img>) so it takes the row's text color. -->
    <svg width="18" height="10" viewBox="0 0 18 10" aria-hidden="true">
      <path d="M10 2C10 2.55228 9.55228 3 9 3C8.44772 3 8 2.55228 8 2C8 1.44772 8.44772 1 9 1C9.55228 1 10 1.44772 10 2ZM17 2C17 2.55228 16.5523 3 16 3C15.4477 3 15 2.55228 15 2C15 1.44772 15.4477 1 16 1C16.5523 1 17 1.44772 17 2ZM3 2C3 2.55228 2.55228 3 2 3C1.44772 3 1 2.55228 1 2C1 1.44772 1.44772 1 2 1C2.55228 1 3 1.44772 3 2ZM10 8C10 8.55228 9.55228 9 9 9C8.44772 9 8 8.55228 8 8C8 7.44772 8.44772 7 9 7C9.55228 7 10 7.44772 10 8ZM17 8C17 8.55228 16.5523 9 16 9C15.4477 9 15 8.55228 15 8C15 7.44772 15.4477 7 16 7C16.5523 7 17 7.44772 17 8ZM3 8C3 8.55228 2.55228 9 2 9C1.44772 9 1 8.55228 1 8C1 7.44772 1.44772 7 2 7C2.55228 7 3 7.44772 3 8Z" />
    </svg>
  </span>
</div>

<style>
  .pass {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 32px;
    padding: 0 8px;
    color: var(--pass-muted);
    border: 1px solid var(--pass-muted);
    border-radius: 8px;
    font-size: 14px;
    cursor: pointer;
    user-select: none;
    transition: color var(--ease), border-color var(--ease), background-color var(--ease);
  }
  /* Hovered, an unselected pass takes on its method's color. */
  .pass:not(.selected):hover {
    color: var(--pass-color);
    border-color: var(--pass-color);
  }
  .selected {
    color: var(--pass-on);
    background: var(--pass-color);
    border-color: var(--pass-color);
  }
  .selected .delete:hover:not(:disabled) {
    background: color-mix(in srgb, var(--pass-on) 20%, transparent);
  }
  .pass:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .label {
    flex: 1;
    min-width: 0;
  }
  .delete {
    display: flex;
    padding: 2px;
    color: inherit;
    background: none;
    border: 0;
    border-radius: 4px;
    cursor: pointer;
    transition: background-color var(--ease);
  }
  .delete:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .delete:hover:not(:disabled) {
    background: rgb(255 255 255 / 0.2);
  }
  .delete:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }
  .delete svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .grip svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .grip {
    display: flex;
    margin-right: -1px; /* the 18 × 10 icon sits on a 16 × 8 slot */
    padding: 6px 0 6px 8px;
    cursor: grab;
    touch-action: none;
  }
</style>
