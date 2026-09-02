import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PRELOAD_ROUTE_IDS = ["routes/_app", "routes/_app._index"] as const;

const LINK_TAG = /<link\b[^>]*>/g;
const MODULEPRELOAD_REL = /\brel=(["'])modulepreload\1/;
const HREF_ATTR = /\bhref=(["'])([^"']+)\1/;
const MANIFEST_ASSIGNMENT = /^window\.__remixManifest=(\{[\s\S]*\});?\s*$/;

interface RouteManifestEntry {
  module: string;
  imports: readonly string[];
}

interface RemixManifest {
  routes: Record<string, RouteManifestEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function routeEntryFromUnknown(routeId: string, value: unknown): RouteManifestEntry {
  if (!isRecord(value) || typeof value.module !== "string") {
    throw new Error(`Route manifest entry ${routeId} is missing a string module field`);
  }

  if (value.imports !== undefined && !isStringArray(value.imports)) {
    throw new Error(`Route manifest entry ${routeId} has a non-string imports list`);
  }

  return { module: value.module, imports: value.imports ?? [] };
}

function parseRemixManifest(path: string): RemixManifest {
  const source = readFileSync(path, "utf8");
  const match = MANIFEST_ASSIGNMENT.exec(source);
  const manifestJson = match?.[1];
  if (!manifestJson) {
    throw new Error(`${path} does not assign window.__remixManifest to a JSON object`);
  }

  const parsed: unknown = JSON.parse(manifestJson);
  if (!isRecord(parsed) || !isRecord(parsed.routes)) {
    throw new Error(`${path} is missing a routes object`);
  }

  const routes = Object.fromEntries(
    Object.entries(parsed.routes).map(([routeId, value]) => [
      routeId,
      routeEntryFromUnknown(routeId, value),
    ])
  );
  return { routes };
}

function findRemixManifestPath(clientDir: string): string {
  const assetsDir = join(clientDir, "assets");
  if (!existsSync(assetsDir)) {
    throw new Error(`Remix manifest search requires ${assetsDir}`);
  }

  const matches = readdirSync(assetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => join(assetsDir, entry.name))
    .filter((path) => readFileSync(path, "utf8").startsWith("window.__remixManifest="));

  if (matches.length === 0) {
    throw new Error(`No Remix manifest asset found in ${assetsDir}`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple Remix manifest assets found: ${matches.join(", ")}`);
  }

  const manifestPath = matches.at(0);
  if (!manifestPath) {
    throw new Error(`No Remix manifest asset found in ${assetsDir}`);
  }
  return manifestPath;
}

function modulePreloadHrefs(html: string): Set<string> {
  const hrefs = new Set<string>();
  for (const match of html.matchAll(LINK_TAG)) {
    const tag = match[0];
    if (!MODULEPRELOAD_REL.test(tag)) continue;

    const hrefMatch = HREF_ATTR.exec(tag);
    const href = hrefMatch?.[2];
    if (href) hrefs.add(href);
  }
  return hrefs;
}

function lastModulePreloadEnd(html: string): number {
  let end: number | undefined;
  for (const match of html.matchAll(LINK_TAG)) {
    const tag = match[0];
    if (!MODULEPRELOAD_REL.test(tag)) continue;

    end = (match.index ?? 0) + tag.length;
  }

  if (end !== undefined) return end;

  const headEnd = html.indexOf("</head>");
  if (headEnd === -1) {
    throw new Error("index.html has no </head> tag for modulepreload injection");
  }
  return headEnd;
}

function uniqueHrefsForRoutes(manifest: RemixManifest): string[] {
  const hrefs: string[] = [];
  for (const routeId of PRELOAD_ROUTE_IDS) {
    const route = manifest.routes[routeId];
    if (!route) {
      throw new Error(`Route ${routeId} was not found in the Remix manifest`);
    }

    for (const href of [route.module, ...route.imports]) {
      if (!hrefs.includes(href)) hrefs.push(href);
    }
  }
  return hrefs;
}

function assetPathForHref(clientDir: string, href: string): string {
  if (!href.startsWith("/assets/")) {
    throw new Error(`Refusing to preload non-asset href from Remix manifest: ${href}`);
  }
  return join(clientDir, href.slice(1));
}

function assertAssetsExist(clientDir: string, hrefs: readonly string[]): number {
  let bytes = 0;
  for (const href of hrefs) {
    const path = assetPathForHref(clientDir, href);
    if (!existsSync(path)) {
      throw new Error(`Remix manifest href does not exist on disk: ${href} (${path})`);
    }
    bytes += statSync(path).size;
  }
  return bytes;
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} kB`;
}

function main(): void {
  const clientDir = resolve(
    process.argv[2] ?? fileURLToPath(new URL("../build/client", import.meta.url))
  );
  const indexPath = join(clientDir, "index.html");
  if (!existsSync(indexPath)) {
    throw new Error(`App-shell preload injection requires ${indexPath}`);
  }

  const manifestPath = findRemixManifestPath(clientDir);
  const manifest = parseRemixManifest(manifestPath);
  const routeHrefs = uniqueHrefsForRoutes(manifest);
  const hintedBytes = assertAssetsExist(clientDir, routeHrefs);
  const html = readFileSync(indexPath, "utf8");
  const existingHrefs = modulePreloadHrefs(html);
  const missingHrefs = routeHrefs.filter((href) => !existingHrefs.has(href));

  if (missingHrefs.length === 0) {
    console.log(
      `[app-shell-preload] ${PRELOAD_ROUTE_IDS.join(", ")} already hinted (${kb(hintedBytes)})`
    );
    return;
  }

  assertAssetsExist(clientDir, missingHrefs);
  const insertionPoint = lastModulePreloadEnd(html);
  const tags = missingHrefs.map((href) => `<link rel="modulepreload" href="${href}"/>`).join("");
  const updatedHtml = `${html.slice(0, insertionPoint)}${tags}${html.slice(insertionPoint)}`;

  // This runs before CSP hashing and precompression so both artifacts describe final index.html.
  writeFileSync(indexPath, updatedHtml);
  // index.html also serves /login and /setup; modulepreload is only a hint, not a paint blocker.
  console.log(
    `[app-shell-preload] added ${missingHrefs.length} modulepreloads for ${PRELOAD_ROUTE_IDS.join(
      ", "
    )} (${kb(hintedBytes)} hinted)`
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[app-shell-preload] ${message}`);
  process.exitCode = 1;
}
