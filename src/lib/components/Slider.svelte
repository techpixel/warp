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
    style:--fill="{((value - min) / (max - min)) * 100}%"
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
  input {
    --fill: 50%;
    appearance: none;
    width: 100%;
    height: 16px;
    margin: 0;
    background: none;
    cursor: pointer;
  }
  input::-webkit-slider-runnable-track {
    height: 8px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: linear-gradient(to right, var(--ink) var(--fill), transparent var(--fill));
  }
  input::-moz-range-track {
    height: 6px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: linear-gradient(to right, var(--ink) var(--fill), transparent var(--fill));
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
