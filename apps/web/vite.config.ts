import { vitePlugin as remix } from "@remix-run/dev";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const apiTarget = `http://localhost:${process.env.PORT || 4010}`;

export default defineConfig({
  plugins: [
    // ignoredRouteFiles keeps colocated *.test.tsx out of the route table (and the client
    // bundle) — otherwise Remix routes them and the browser tries to import vitest.
    remix({ ssr: false, ignoredRouteFiles: ["**/.*", "**/*.test.{ts,tsx}"] }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "~": new URL("./app", import.meta.url).pathname,
    },
  },
  server: {
    port: Number.parseInt(process.env.VITE_PORT || "4000", 10),
    // Same-origin in prod (the API serves the SPA); in dev the API runs on its own port,
    // so proxy the server-owned paths to it. Keeps lib/api.ts + setup-api.ts relative
    // paths working without a VITE_API_URL split-origin base.
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
      "/health": { target: apiTarget, changeOrigin: true },
      "/docs": { target: apiTarget, changeOrigin: true },
    },
  },
});
