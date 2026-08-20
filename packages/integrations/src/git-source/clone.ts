import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  assertClonableGitSource,
  type ClonableGitSource,
  type GitHostResolver,
  GitSourceError,
} from "./policy";

const execFileP = promisify(execFile);

export interface GitCloneLimits {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  /** Ceiling across the whole process, so one caller cannot starve every other. */
  readonly maxConcurrent: number;
  readonly maxPerActor: number;
}

export const DEFAULT_GIT_CLONE_LIMITS: GitCloneLimits = {
  timeoutMs: 60_000,
  maxBytes: 256 * 1024 * 1024,
  maxConcurrent: 4,
  maxPerActor: 1,
};

const SIZE_POLL_MS = 500;

/**
 * A deliberately small environment. `process.env` carries `GIT_CONFIG_*`, `GIT_SSH_COMMAND`,
 * `GIT_PROXY_COMMAND` and askpass hooks that turn a clone into arbitrary execution or a redirect
 * to another repository, and it carries the deployment's own secrets. Proxy variables survive
 * because an operator behind an egress proxy has no other way to reach the allowed host.
 */
const PASSED_THROUGH = ["PATH", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];

function cloneEnv(): Record<string, string> {
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_ALLOW_PROTOCOL: "https:file",
    LC_ALL: "C",
  };
  for (const key of PASSED_THROUGH) {
    const value = process.env[key] ?? process.env[key.toLowerCase()];
    if (value !== undefined) env[key] = value;
  }
  env.PATH ??= "/usr/bin:/bin";
  return env;
}

export type GitRunner = (
  args: readonly string[],
  options: { cwd?: string; timeoutMs: number; signal: AbortSignal }
) => Promise<string>;

const spawnGit: GitRunner = async (args, options) => {
  const { stdout } = await execFileP("git", [...args], {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    signal: options.signal,
    env: cloneEnv(),
  });
  return stdout;
};

async function directoryBytes(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true }).catch(
    () => []
  );
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const info = await stat(join(entry.parentPath, entry.name)).catch(() => undefined);
    total += info?.size ?? 0;
  }
  return total;
}

/**
 * Bounds how many clones can be in flight at once, globally and per caller. Without it every
 * authenticated request is a free process, socket and disk allocation.
 */
class CloneGate {
  private inFlight = 0;
  private readonly perActor = new Map<string, number>();

  acquire(actorId: string, limits: GitCloneLimits): () => void {
    const held = this.perActor.get(actorId) ?? 0;
    if (this.inFlight >= limits.maxConcurrent || held >= limits.maxPerActor) {
      throw new GitSourceError("too_many_clones");
    }
    this.inFlight += 1;
    this.perActor.set(actorId, held + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
      const remaining = (this.perActor.get(actorId) ?? 1) - 1;
      if (remaining <= 0) this.perActor.delete(actorId);
      else this.perActor.set(actorId, remaining);
    };
  }
}

const gate = new CloneGate();

function timedOut(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "killed" in error &&
    (error as { killed?: boolean }).killed === true
  );
}

async function cloneInto(
  directory: string,
  target: ClonableGitSource,
  limits: GitCloneLimits,
  run: GitRunner
): Promise<string> {
  const controller = new AbortController();
  let overSize = false;
  const watch = setInterval(() => {
    void directoryBytes(directory).then((bytes) => {
      if (bytes <= limits.maxBytes || overSize) return;
      overSize = true;
      controller.abort();
    });
  }, SIZE_POLL_MS);
  try {
    const branch = target.ref ? ["--branch", target.ref] : [];
    await run(["clone", "--depth", "1", ...branch, "--", target.url, directory], {
      timeoutMs: limits.timeoutMs,
      signal: controller.signal,
    });
  } catch (error) {
    if (overSize) throw new GitSourceError("repository_too_large");
    throw new GitSourceError(timedOut(error) ? "clone_timeout" : "clone_failed");
  } finally {
    clearInterval(watch);
  }
  try {
    const head = await run(["rev-parse", "HEAD"], {
      cwd: directory,
      timeoutMs: limits.timeoutMs,
      signal: controller.signal,
    });
    return head.trim();
  } catch {
    throw new GitSourceError("clone_failed");
  }
}

export interface GitClone {
  readonly dir: string;
  readonly ref: string;
}

export interface GitCloneOptions {
  readonly prefix: string;
  /** Whoever asked for the clone; the per-actor bound is meaningless without it. */
  readonly actorId: string;
  readonly limits?: Partial<GitCloneLimits>;
  /** Injected so tests never touch DNS or spawn git. */
  readonly resolve?: GitHostResolver;
  readonly runGit?: GitRunner;
}

/**
 * Clone an allowed source into a temp directory, hand it to `use`, and remove it however `use`
 * ends. Nothing reaches git until the source has passed `assertClonableGitSource`.
 *
 * @throws GitSourceError for any refusal or clone failure, with no git output attached.
 */
export async function withGitSourceClone<T>(
  source: string,
  options: GitCloneOptions,
  use: (clone: GitClone) => Promise<T>
): Promise<T> {
  const limits = { ...DEFAULT_GIT_CLONE_LIMITS, ...options.limits };
  const target = await assertClonableGitSource(source, { resolve: options.resolve });
  const release = gate.acquire(options.actorId, limits);
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), options.prefix));
    const ref = await cloneInto(directory, target, limits, options.runGit ?? spawnGit);
    return await use({ dir: directory, ref });
  } finally {
    release();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
