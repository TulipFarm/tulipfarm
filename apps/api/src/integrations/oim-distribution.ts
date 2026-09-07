import type { EgressHttpPort } from "@tulipfarm/integrations";
import { sendGovernedRequest } from "@tulipfarm/integrations";
import { type OimManifest, oimPackageDigest, parseOimManifest } from "@tulipfarm/schema";

const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_COMPANION_BYTES = 2 * 1024 * 1024;

export interface DirectOimPackage {
  readonly source: string;
  readonly ref: string;
  readonly manifest: OimManifest;
  readonly companions: ReadonlyMap<string, string>;
}

export function isDirectOimSource(source: string): boolean {
  try {
    const url = new URL(source);
    return url.protocol === "https:" && url.pathname.endsWith("/oim.yml");
  } catch {
    return false;
  }
}

export function safeDirectOimSource(source: string): string {
  const url = new URL(source);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function readText(
  http: EgressHttpPort,
  source: string,
  maxBytes: number
): Promise<{ readonly url: string; readonly text: string }> {
  const result = await sendGovernedRequest(http, { url: source, method: "GET" });
  if (result.kind === "cross_origin_redirect") {
    throw new Error(`package URL redirects to another origin: ${result.to}`);
  }
  if (result.kind === "redirect_limit") throw new Error("package URL redirects too many times");
  if (result.response.status < 200 || result.response.status >= 300) {
    throw new Error(`package URL returned HTTP ${result.response.status}`);
  }
  const body = result.response.body;
  const text =
    typeof body === "string"
      ? body
      : body instanceof Uint8Array
        ? new TextDecoder().decode(body)
        : undefined;
  if (text === undefined) throw new Error("package URL did not return text");
  if (Buffer.byteLength(text) > maxBytes) {
    throw new Error(`package file exceeds ${maxBytes} bytes`);
  }
  return { url: result.url, text };
}

function companionUrl(manifestUrl: URL, path: string): URL {
  const segments = path.split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    path.includes("\\")
  ) {
    throw new Error(`files: ${path} must stay within the package directory`);
  }
  const companion = new URL(path, manifestUrl);
  const packageDirectory = new URL(".", manifestUrl);
  if (
    companion.origin !== manifestUrl.origin ||
    !companion.pathname.startsWith(packageDirectory.pathname)
  ) {
    throw new Error(`files: ${path} must stay under the oim.yml URL`);
  }
  return companion;
}

/** Fetches only `oim.yml` and the relative companion files it declares. */
export async function fetchDirectOimPackage(
  source: string,
  http: EgressHttpPort
): Promise<DirectOimPackage> {
  let requested: URL;
  try {
    requested = new URL(source);
  } catch {
    throw new Error("package URL is invalid");
  }
  if (requested.protocol !== "https:") throw new Error("package URL must use https");
  if (requested.username !== "" || requested.password !== "") {
    throw new Error("package URL must not contain credentials");
  }
  if (!requested.pathname.endsWith("/oim.yml")) {
    throw new Error("package URL must name oim.yml");
  }

  const manifestResponse = await readText(http, requested.href, MAX_MANIFEST_BYTES);
  const manifestUrl = new URL(manifestResponse.url);
  let manifest: OimManifest;
  try {
    manifest = parseOimManifest(manifestResponse.text);
  } catch (error) {
    throw new Error(
      `oim.yml is not a valid manifest: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const companions = new Map<string, string>();
  for (const file of manifest.files ?? []) {
    const url = companionUrl(manifestUrl, file.path);
    const response = await readText(http, url.href, MAX_COMPANION_BYTES);
    if (new URL(response.url).origin !== manifestUrl.origin) {
      throw new Error(`files: ${file.path} must use the oim.yml origin`);
    }
    companions.set(file.path, response.text);
  }

  return {
    source: safeDirectOimSource(source),
    ref: `sha256:${oimPackageDigest(manifest)}`,
    manifest,
    companions,
  };
}
