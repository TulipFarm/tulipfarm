import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const CLONE_TIMEOUT_MS = 60_000;

// pre-merge branches can be scanned and tested: "owner/repo#my-branch". No "#" ⇒ default branch.
export function splitSourceRef(source: string): { base: string; ref?: string } {
  const idx = source.indexOf("#");
  return idx === -1 ? { base: source } : { base: source.slice(0, idx), ref: source.slice(idx + 1) };
}

// Leading dash forbidden so a ref can never be mistaken for a git flag.
const REF_RE = /^[\w][\w./-]*$/;

/**
 * Only allow sources we are willing to hand to `git clone`: a bare "owner/repo" slug, or an
 * http(s)/file URL, each with an optional "#<ref>" suffix. ssh:// and scp-style (git@host:path)
 * sources are rejected to avoid the operator's clone reaching internal hosts (SSRF). Single-trust
 * V1; a tighter allowlist is a post-V1 hardening.
 */
export function isAllowedSource(source: string): boolean {
  const { base, ref } = splitSourceRef(source);
  if (ref !== undefined && !REF_RE.test(ref)) return false;
  return /^[\w.-]+\/[\w.-]+$/.test(base) || /^(https?|file):\/\//.test(base);
}

export const ALLOWED_SOURCE_HINT =
  "source must be a github owner/repo slug or an http(s)/file URL, with an optional #branch suffix";

// "owner/repo" becomes a GitHub https URL; an http(s)/file URL is used as-is.
export function normalizeGitUrl(base: string): string {
  if (/^[\w.-]+\/[\w.-]+$/.test(base)) return `https://github.com/${base}.git`;
  return base;
}

export function sourceType(source: string): "github" | "git" {
  const { base } = splitSourceRef(source);
  return /github\.com|^[\w.-]+\/[\w.-]+$/.test(base) ? "github" : "git";
}

/**
 * Shallow-clone an allowed source into a temp dir and report the exact commit fetched. Callers own
 * the returned directory and must remove it.
 */
export async function cloneToTemp(
  source: string,
  prefix: string
): Promise<{ dir: string; ref: string }> {
  const { base, ref } = splitSourceRef(source);
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await execFileP(
    "git",
    ["clone", "--depth", "1", ...(ref ? ["--branch", ref] : []), normalizeGitUrl(base), dir],
    {
      timeout: CLONE_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }
  );
  const { stdout } = await execFileP("git", ["rev-parse", "HEAD"], { cwd: dir });
  return { dir, ref: stdout.trim() };
}
