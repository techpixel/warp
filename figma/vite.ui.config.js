// Builds the plugin's UI (src/figma/index.html) into one self-contained HTML
// file, as Figma requires. Run in "figma" mode, which turns on src/lib/figma.ts.
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  root: resolve(import.meta.dirname, "../src/figma"),
  plugins: [svelte(), viteSingleFile()],
  build: {
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },
});
