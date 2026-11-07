<!--
  A labelled slider: an outlined track filled up to the value, with a round
  thumb. Double-clicking it resets to `reset`, if given.
-->
<script lang="ts">
  let {
    id,
    label,
    min,
    max,
    value,
    oninput,
    reset,
    disabled = false,
  }: {
    id: string;
    label: string;
    min: number;
    max: number;
    value: number;
    oninput: (value: number) => void;
    reset?: number;
    disabled?: boolean;
  } = $props();
</script>

<div class="slider">
  <label for={id}>{label}</label>
  <input
    {id}
    type="range"
    {min}
    {max}
    {value}
    {disabled}
    style:--fill={(value - min) / (max - min)}
    oninput={(e) => oninput(Number(e.currentTarget.value))}
    ondblclick={() => reset !== undefined && oninput(reset)}
  />
</div>

<style>
  .slider {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12px;
  }
  /* The input itself is the track, inset by half the thumb less the track's
     rounding, so the thumb's travel (on a wider, invisible track) puts its
     centre over each rounded end: at either end it covers the end whole, and the
     fill always reaches its centre. */
  input {
    --fill: 0.5; /* of the way along */
    appearance: none;
    box-sizing: border-box;
    width: calc(100% - 8px);
    height: 8px;
    margin: 4px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: linear-gradient(to right, var(--ink) calc(3px + (100% - 6px) * var(--fill)), transparent 0) no-repeat;
    cursor: pointer;
  }
  input::-webkit-slider-runnable-track {
    height: 6px;
    margin: 0 -5px;
  }
  input::-moz-range-track {
    height: 6px;
    background: none;
  }
  input::-webkit-slider-thumb {
    appearance: none;
    width: 16px;
    height: 16px;
    margin-top: -5px;
    border: 0;
    border-radius: 50%;
    background: var(--ink);
  }
  input::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border: 0;
    border-radius: 50%;
    background: var(--ink);
  }
  input:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  input:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
