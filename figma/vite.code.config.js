// Builds the plugin's main thread (src/figma/code.ts) into one script for Figma's sandbox.
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(import.meta.dirname, "../src/figma/code.ts"),
      formats: ["iife"],
      name: "warp",
      fileName: () => "code.js",
    },
    target: "es2017",
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: false,
  },
});
