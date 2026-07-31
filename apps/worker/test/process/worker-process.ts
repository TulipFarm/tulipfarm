import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { freePort } from "./free-port";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BUNDLE = resolve(APP_ROOT, "dist/worker.cjs");

/**
 * Bundles the worker exactly as the Dockerfile does. The subject of these tests is the shipped
 * artifact — a `tsx` run of the sources would not catch a bundling failure, which is precisely the
 * class of break that makes a container refuse to boot.
 */
export async function buildWorkerBundle(): Promise<string> {
  await build({
    entryPoints: [resolve(APP_ROOT, "src/main.ts")],
    bundle: true,
    platform: "node",
    target: "node26",
    format: "cjs",
    outfile: BUNDLE,
    external: ["pg"],
    logLevel: "silent",
  });
  return BUNDLE;
}

export interface WorkerHandle {
  readonly port: number;
  readonly output: () => string;
  /** Resolves with the exit code, or null when a signal killed the process. */
  readonly exited: Promise<number | null>;
  waitForReady(timeoutMs?: number): Promise<void>;
  probe(path: string): Promise<{ status: number; body: string }>;
  signal(name: NodeJS.Signals): void;
  stop(): Promise<void>;
}

export interface StartWorkerOptions {
  readonly databaseUrl: string;
  readonly owner: string;
  /** Extra `WORKER_*` overrides, e.g. a short lease for the reclaim test. */
  readonly env?: Record<string, string>;
}

export async function startWorker(options: StartWorkerOptions): Promise<WorkerHandle> {
  const port = await freePort();
  const child = spawn(process.execPath, [BUNDLE], {
    cwd: APP_ROOT,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      DATABASE_URL: options.databaseUrl,
      // The turn host is never reached in these tests — no Chat Run is enqueued — but the worker
      // refuses to boot without knowing where it is, so the harness has to say.
      INTERNAL_API_URL: "http://127.0.0.1:1",
      WORKER_API_CREDENTIAL: "tfc_test.secret",
      WORKER_OWNER: options.owner,
      WORKER_PORT: String(port),
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  const exited = new Promise<number | null>((resolveExit) => {
    child.once("exit", (code) => resolveExit(code));
  });

  const probe = async (path: string): Promise<{ status: number; body: string }> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, body: await response.text() };
  };

  return {
    port,
    output: () => output,
    exited,
    probe,
    signal: (name) => {
      child.kill(name);
    },
    waitForReady: async (timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`worker exited before becoming ready:\n${output}`);
        }
        try {
          const result = await probe("/readyz");
          if (result.status === 200) return;
        } catch {
          // Not listening yet — the probe server starts after the preflight check.
        }
        await sleep(100);
      }
      throw new Error(`worker did not become ready within ${timeoutMs}ms:\n${output}`);
    },
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGKILL");
      await exited;
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: { timeoutMs?: number; describe: string }
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${options.describe}; last value: ${JSON.stringify(last)}`);
}
