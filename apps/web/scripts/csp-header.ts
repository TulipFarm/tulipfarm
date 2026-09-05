import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;

export function inlineScriptHashes(html: string): readonly string[] {
  return [...html.matchAll(INLINE_SCRIPT)]
    .map((match) => match[1] ?? "")
    .filter((content) => content.trim().length > 0)
    .map((content) => `'sha256-${createHash("sha256").update(content).digest("base64")}'`);
}

export function cspHeaderForHtml(html: string): string {
  const hashes = inlineScriptHashes(html);
  if (hashes.length === 0) {
    throw new Error("CSP generation found no non-empty inline scripts in index.html");
  }

  const scriptSrc = ["'self'", "'unsafe-eval'", ...hashes].join(" ");
  return (
    `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; ` +
    "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; " +
    // Stated rather than inherited from default-src: the sandbox frame that runs authored code is
    // served from this origin, and a reader deleting a `default-src` fallback should not silently
    // take the frame with it.
    "frame-src 'self'; frame-ancestors 'none'"
  );
}

export function writeCspHeader(clientDir: string): string {
  const indexPath = join(clientDir, "index.html");
  if (!existsSync(indexPath)) {
    throw new Error(`CSP generation requires ${indexPath}`);
  }
  const header = cspHeaderForHtml(readFileSync(indexPath, "utf8"));
  writeFileSync(join(clientDir, ".csp-header.txt"), header);
  return header;
}
