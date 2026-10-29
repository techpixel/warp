import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    {
      // Serve demo/index.html at /demo as well as /demo/.
      name: "demo-route",
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === "/demo" || req.url?.startsWith("/demo?")) req.url = req.url.replace("/demo", "/demo/");
          next();
        });
      },
    },
  ],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        demo: resolve(import.meta.dirname, "demo/index.html"),
      },
    },
  },
});
