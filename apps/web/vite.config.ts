import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { vitePlugin as remix } from "@remix-run/dev";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

/**
 * Vite plugin that runs after each client build to extract SHA-256 hashes of
 * every inline <script> block from index.html and write the complete
 * Content-Security-Policy header value to build/client/.csp-header.txt.
 *
 * Running this in the Vite build (not the Dockerfile) means the file is produced
 * regardless of how the assets are deployed — Docker image, CDN, or otherwise
 * (SEC-V1-002).
 */
function cspHashPlugin(): Plugin {
  let outDir = "";
  return {
    name: "csp-hash",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const indexPath = join(outDir, "index.html");
      if (!existsSync(indexPath)) return;

      const html = readFileSync(indexPath, "utf8");
      const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
      const hashes: string[] = [];
      for (const match of html.matchAll(re)) {
        const content = match[1];
        if (content.trim()) {
          hashes.push(`'sha256-${createHash("sha256").update(content).digest("base64")}'`);
        }
      }

      const scriptSrc = ["'self'", ...hashes].join(" ");
      const cspHeader =
        `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; ` +
        "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

      writeFileSync(join(outDir, ".csp-header.txt"), cspHeader);
      console.log("[csp-hash] CSP header written:", cspHeader);
    },
  };
}

// The monorepo root package.json holds the released version; apps/web stays at 0.0.0.
const appVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
  .version as string;

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [
    // ignoredRouteFiles keeps colocated *.test.tsx out of the route table (and the client
    // bundle) — otherwise Remix routes them and the browser tries to import vitest.
    remix({ ssr: false, ignoredRouteFiles: ["**/.*", "**/*.test.{ts,tsx}"] }),
    tailwindcss(),
    cspHashPlugin(),
  ],
  resolve: {
    alias: {
      "~": new URL("./app", import.meta.url).pathname,
    },
  },
  optimizeDeps: {
    // The TipTap stack reaches the client through the @tulipfarm/editor workspace package, so Vite
    // discovers these only at runtime and re-optimizes mid-session (a one-time page reload when the
    // editor first opens). Pre-bundling them at startup avoids that flash.
    include: [
      "@tiptap/core",
      // @tiptap/pm has NO root export — only subpaths. List the ProseMirror modules the editor
      // stack pulls in (StarterKit + tables + the markdown bridge) so none triggers a mid-session
      // re-optimize. A bare "@tiptap/pm" here fails dep pre-bundling ("." is not exported).
      "@tiptap/pm/state",
      "@tiptap/pm/view",
      "@tiptap/pm/model",
      "@tiptap/pm/transform",
      "@tiptap/pm/commands",
      "@tiptap/pm/keymap",
      "@tiptap/pm/inputrules",
      "@tiptap/pm/history",
      "@tiptap/pm/dropcursor",
      "@tiptap/pm/gapcursor",
      "@tiptap/pm/schema-list",
      "@tiptap/pm/tables",
      "@tiptap/react",
      "@tiptap/react/menus",
      "@tiptap/starter-kit",
      "@tiptap/suggestion",
      "@tiptap/extension-placeholder",
      // NOTE: @tiptap/markdown + extension-table/-task-list/-task-item are deps of @tulipfarm/editor,
      // not apps/web, so they aren't resolvable here — Vite optimizes them transitively via the
      // workspace package on first editor load. Listing them would just print resolve warnings.
    ],
  },
  server: {
    port: Number.parseInt(process.env.VITE_PORT || "4000", 10),
  },
});
