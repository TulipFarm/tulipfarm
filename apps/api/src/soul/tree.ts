import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// Read-only soul-repo filesystem helpers backing the Soul Explorer routes.
// The soul repo is a real git directory on disk; these walk and read it safely.

export type TreeNode = {
  name: string;
  path: string; // POSIX relpath from the soul root
  type: "file" | "dir";
  size?: number;
  children?: TreeNode[];
};

export type SoulFileContent = {
  path: string;
  content: string;
  size: number;
  language: string;
  binary?: boolean;
  tooLarge?: boolean;
};

const EXCLUDE_DIRS = new Set([".git"]);
const MAX_FILE_BYTES = 512 * 1024;
const BINARY_SNIFF_BYTES = 8000;

// Thrown for any rejected/unsafe path — the route maps it to a 400.
export class UnsafePathError extends Error {}

/** Recursively walk a directory into a sorted tree (dirs first, then files, alphabetical). */
export async function walkTree(soulRoot: string, dirAbs: string): Promise<TreeNode[]> {
  const entries = await readdir(dirAbs, { withFileTypes: true });
  const nodes: TreeNode[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // never follow symlinks
    if (entry.isDirectory() && EXCLUDE_DIRS.has(entry.name)) continue;
    const abs = join(dirAbs, entry.name);
    const rel = toPosix(relative(soulRoot, abs));
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: rel,
        type: "dir",
        children: await walkTree(soulRoot, abs),
      });
    } else if (entry.isFile()) {
      const info = await stat(abs);
      nodes.push({ name: entry.name, path: rel, type: "file", size: info.size });
    }
  }
  nodes.sort((a, b) =>
    a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)
  );
  return nodes;
}

/**
 * Resolve a client-supplied relative path to an absolute path that is provably
 * inside the soul root. Layered defenses against traversal/symlink escape.
 * Throws UnsafePathError for rejected paths; lets ENOENT bubble (→ 404 in the route).
 */
export async function resolveSafe(soulRoot: string, rel: string): Promise<string> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    throw new UnsafePathError("invalid path encoding");
  }
  if (decoded.includes("\0")) throw new UnsafePathError("invalid path");
  if (isAbsolute(decoded)) throw new UnsafePathError("absolute path not allowed");

  const rootReal = await realpath(soulRoot);
  const candidate = resolve(rootReal, decoded);
  const candReal = await realpath(candidate); // resolves symlinks; ENOENT bubbles → 404

  const withSep = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  if (candReal !== rootReal && !candReal.startsWith(withSep)) {
    throw new UnsafePathError("path escapes soul root");
  }
  const segments = relative(rootReal, candReal).split(sep);
  if (segments.some((s) => s === ".git")) throw new UnsafePathError("path not allowed");
  return candReal;
}

/** Read a single soul file with size + binary guards. `abs` must be pre-resolved via resolveSafe. */
export async function readSoulFile(abs: string, relPath: string): Promise<SoulFileContent> {
  const info = await stat(abs);
  if (!info.isFile()) throw new UnsafePathError("not a file");
  const language = inferLanguage(relPath);
  if (info.size > MAX_FILE_BYTES) {
    return { path: relPath, content: "", size: info.size, language, tooLarge: true };
  }
  const buf = await readFile(abs);
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return { path: relPath, content: "", size: info.size, language: "plaintext", binary: true };
  }
  return { path: relPath, content: buf.toString("utf8"), size: info.size, language };
}

/** Infer a Shiki language id from a filename. Maps 1:1 onto the langs the client loads. */
export function inferLanguage(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".json")) return "json";
  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".mts") ||
    lower.endsWith(".cts")
  ) {
    return "typescript";
  }
  if (lower.endsWith(".sh") || lower.endsWith(".bash")) return "bash";
  return "plaintext";
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}
