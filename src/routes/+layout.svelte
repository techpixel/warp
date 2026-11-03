<script lang="ts">
  let { children } = $props();
</script>

{@render children()}

<style>
  :global(:root) {
    --bg: #131313;
    --panel: #000;
    --ink: #fff;
    --line: #fff;
    --line-muted: #6c6c6c;
    --muted: #999;
    --placeholder: #5d5d5d;
    --hover: rgb(255 255 255 / 0.1);
    --blink-light: rgb(255 255 255 / 0.25);
    --blink-dark: rgb(255 255 255 / 0.125);
    --focus: #fff;
    --accent: #5549ff;
    --menu: #2e2e2e;
    --pass-muted: #b4b4b4;
    --ease: 150ms ease; /* hover transitions, and menus expanding */
    color-scheme: dark;
  }
  :global(*) {
    box-sizing: border-box;
  }
  :global(html, body) {
    height: 100%;
    margin: 0;
  }
  :global(body) {
    background-color: var(--bg);
    color: var(--ink);
    font: 400 16px/normal "Familjen Grotesk", system-ui, sans-serif;
  }
</style>
