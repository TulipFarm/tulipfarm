import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, posix, relative } from "node:path";
import { describe, expect, it } from "vitest";

function repoRoot(): string {
  let directory = __dirname;
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("pnpm-workspace.yaml not found");
    directory = parent;
  }
}

const ROOT = repoRoot();
const CATALOG = join(ROOT, "integrations");

function catalogFiles(directory = CATALOG): string[] {
  return readdirSync(directory)
    .flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? catalogFiles(path) : [relative(ROOT, path)];
    })
    .sort();
}

function dockerIgnorePatternMatches(path: string, pattern: string): boolean {
  const normalized = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  const candidates = [path];
  let parent = posix.dirname(path);
  while (parent !== ".") {
    candidates.push(parent);
    parent = posix.dirname(parent);
  }

  if (!normalized.includes("/")) {
    return candidates.some((candidate) => posix.matchesGlob(basename(candidate), normalized));
  }
  return candidates.some((candidate) => posix.matchesGlob(candidate, normalized));
}

function ignoredCatalogFiles(): string[] {
  const patterns = readFileSync(join(ROOT, ".dockerignore"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  return catalogFiles().filter((path) => {
    let ignored = false;
    for (const line of patterns) {
      const negated = line.startsWith("!");
      const pattern = negated ? line.slice(1) : line;
      if (dockerIgnorePatternMatches(path, pattern)) ignored = !negated;
    }
    return ignored;
  });
}

describe("bundled integrations container packaging", () => {
  it("copies the complete catalog to the production loader path", () => {
    const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
    const runtime = dockerfile.split("FROM node:26.5.0-slim AS runtime")[1];
    expect(runtime).toBeDefined();
    expect(runtime).toContain("WORKDIR /app");
    expect(runtime).toContain(
      "COPY --from=builder --chown=node:0 /app/integrations ./integrations"
    );

    const loader = readFileSync(join(ROOT, "packages/soul/src/integrations/bundled.ts"), "utf8");
    expect(loader).toContain('const IMAGE_INTEGRATIONS_DIR = "/app/integrations";');
    expect(dockerfile).toContain("COPY . .");
    expect(ignoredCatalogFiles()).toEqual([]);
  });

  describe("shared runtime container packaging", () => {
    const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
    const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
    it("retains and exercises the private native document child after production pruning", () => {
      expect(dockerfile).toContain("--external:@firecrawl/anydoc");
      expect(dockerfile).toContain("../../packages/files/src/document-child.ts");
      expect(dockerfile).toContain("cd /deploy && node check-document-runtime.mjs");
      expect(dockerfile.indexOf("cd /deploy && node check-document-runtime.mjs")).toBeGreaterThan(
        dockerfile.indexOf("deploy --prod --legacy /deploy")
      );
      expect(dockerfile).toContain(
        "COPY --from=builder --chown=node:0 /app/apps/api/dist/document-child.cjs ./document-child.cjs"
      );
      const runtime = dockerfile.split("FROM node:26.5.0-slim AS runtime")[1];
      expect(runtime).toContain(
        "RUN --network=none --mount=type=bind,from=builder,source=/deploy/check-document-runtime.mjs,target=/app/check-document-runtime.mjs"
      );
      expect(runtime.indexOf("node check-document-runtime.mjs")).toBeGreaterThan(
        runtime.indexOf("USER node")
      );
    });

    it("requires all four real conversions, PDF Markdown, OCR refusal, and page dimensions", () => {
      const smoke = readFileSync(join(ROOT, "scripts/check-document-runtime.mjs"), "utf8");
      expect(smoke).toContain('fromFiles("@firecrawl/anydoc/package.json").version, "0.2.4"');
      expect(smoke).toContain(
        `fromNative.resolve(\`@firecrawl/anydoc-\${process.platform}-\${process.arch}\${libc}\`)`
      );
      expect(smoke).toContain('for (const format of ["docx", "xlsx", "pptx", "pdf"])');
      expect(smoke).toContain("await convert(format, fixtures[format])");
      expect(smoke).toContain("assert.ok(outcome.text.includes(marker)");
      expect(smoke).toContain("assert.match(outcome.text, /^#{1,6} Packaged handbook");
      expect(smoke).toContain("assert.deepEqual(outcome.visual, visual)");
      expect(smoke).toContain("assert.deepEqual(capped,");
      expect(smoke).toContain('assert.deepEqual(await convert("pdf", pdfFixture(true)),');
      expect(smoke).toContain('reason: "needs_ocr"');
      expect(smoke).toContain("pages: [{ width: 1224, height: 1584 }]");
    });

    it("ships all production entrypoints in the same public image", () => {
      const runtime = dockerfile.split("FROM node:26.5.0-slim AS runtime")[1];
      expect(runtime).toContain("ENV NODE_ENV=production");
      expect(runtime).toContain('CMD ["node", "server.cjs"]');
      for (const [service, entrypoint] of [
        ["app", "server.cjs"],
        ["worker", "worker.cjs"],
        ["integration-worker", "integration-worker.cjs"],
      ]) {
        expect(runtime).toContain(`./${entrypoint}`);
        const definition = compose.split(`\n  ${service}:\n`)[1]?.split(/\n {2}[\w-]+:\n/)[0];
        expect(definition).toContain(
          `image: ghcr.io/tulipfarm/tulipfarm:\${TULIPFARM_VERSION:-latest}`
        );
        expect(definition).toContain("NODE_ENV: production");
        if (service !== "app") {
          expect(definition).toContain(`command: ["node", "${entrypoint}"]`);
        }
      }
    });

    it("passes the same explicit deployment configuration to every process", () => {
      for (const service of ["app", "worker", "integration-worker"]) {
        const definition = compose.split(`\n  ${service}:\n`)[1]?.split(/\n {2}[\w-]+:\n/)[0];
        expect(definition).toContain(`BUSINESS_ID: \${BUSINESS_ID:-tulipfarm-local}`);
        expect(definition).toContain(
          `RUNTIME_HOSTING_AUTHORITY: \${RUNTIME_HOSTING_AUTHORITY:-independent}`
        );
        expect(definition).toContain(`RUNTIME_INSTALLATION_ID: \${RUNTIME_INSTALLATION_ID:-}`);
      }
    });

    it("excludes local state and nested environment files from the build context", () => {
      const patterns = readFileSync(join(ROOT, ".dockerignore"), "utf8")
        .split(/\r?\n/)
        .filter((line) => line && !line.startsWith("#"));
      for (const path of [
        ".scratch/seeded-provider-key",
        ".worktrees/other-checkout/apps/api/.env.local",
        ".parity-123/.env",
        "apps/api/.env.local",
        "apps/worker/.env",
        "data/secrets.env",
        "data/worker.env",
        "data/integration-worker.env",
        "data/bucket.env",
        "soul/soul.yaml",
      ]) {
        let ignored = false;
        for (const pattern of patterns) {
          const negated = pattern.startsWith("!");
          if (dockerIgnorePatternMatches(path, negated ? pattern.slice(1) : pattern)) {
            ignored = !negated;
          }
        }
        expect(ignored, `${path} must never enter the public image build`).toBe(true);
      }
    });
  });
});
