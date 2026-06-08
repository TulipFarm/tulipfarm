import { vitePlugin as remix } from "@remix-run/dev";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

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
  },
});
