import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { freePort } from "./free-port";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BUNDLE = resolve(APP_ROOT, "dist/integration-worker.cjs");

/**
 * Bundles the integration worker exactly as the Dockerfile does. The subject of these tests is the
 * shipped artifact — a `tsx` run of the sources would not catch a bundling failure, which is
 * precisely the class of break that makes a container refuse to boot.
 */
export async function buildIntegrationWorkerBundle(): Promise<string> {
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

export interface IntegrationWorkerHandle {
  readonly port: number;
  readonly output: () => string;
  /** Resolves with the exit code, or null when a signal killed the process. */
  readonly exited: Promise<number | null>;
  waitForReady(timeoutMs?: number): Promise<void>;
  probe(path: string): Promise<{ status: number; body: string }>;
  signal(name: NodeJS.Signals): void;
  stop(): Promise<void>;
}

export interface StartIntegrationWorkerOptions {
  readonly databaseUrl: string;
  readonly env?: Record<string, string>;
}

export async function startIntegrationWorker(
  options: StartIntegrationWorkerOptions
): Promise<IntegrationWorkerHandle> {
  const port = await freePort();
  const child = spawn(process.execPath, [BUNDLE], {
    cwd: APP_ROOT,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      DATABASE_URL: options.databaseUrl,
      INTEGRATION_WORKER_PORT: String(port),
      // Unreachable on purpose in these process tests — the Slack credential lease is expected to
      // fail closed (`createSlackChannelLoops` catches it and boots with zero Channel loops), so
      // no test here needs a real `apps/api` behind this URL.
      INTERNAL_API_URL: "http://127.0.0.1:1",
      INTEGRATION_WORKER_API_CREDENTIAL: "tfc_test.test",
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
          throw new Error(`integration worker exited before becoming ready:\n${output}`);
        }
        try {
          const result = await probe("/readyz");
          if (result.status === 200) return;
        } catch {
          // Not listening yet — the probe server starts after the preflight check.
        }
        await sleep(100);
      }
      throw new Error(`integration worker did not become ready within ${timeoutMs}ms:\n${output}`);
    },
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGKILL");
      await exited;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
