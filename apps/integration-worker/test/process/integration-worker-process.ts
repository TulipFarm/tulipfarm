import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { freePort } from "./free-port";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BUNDLE = resolve(APP_ROOT, "dist/integration-worker.cjs");

/** Bundles like Docker so tests catch shipped-artifact boot failures. */
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
  readonly internalApiMode?: "ready" | "missing-oim-contract";
}

export async function startIntegrationWorker(
  options: StartIntegrationWorkerOptions
): Promise<IntegrationWorkerHandle> {
  const port = await freePort();
  const internalApi = await startInternalApi(options.internalApiMode ?? "ready");
  const child = spawn(process.execPath, [BUNDLE], {
    cwd: APP_ROOT,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      DATABASE_URL: options.databaseUrl,
      INTEGRATION_WORKER_PORT: String(port),
      INTERNAL_API_URL: internalApi.url,
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
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
      await closeServer(internalApi.server);
    },
  };
}

async function startInternalApi(
  mode: "ready" | "missing-oim-contract"
): Promise<{ readonly server: Server; readonly url: string }> {
  const server = createServer((request, response) => {
    if (request.url === "/api/v1/internal/oim/worker-contract") {
      if (mode === "missing-oim-contract") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          version: 1,
          capabilities: [
            "connection-bound-operations",
            "exact-manifest-resolution",
            "hooks",
            "knowledge-registrations",
            "payload-crypto",
            "verified-provider-identity",
            "webhook-registration",
          ],
        })
      );
      return;
    }
    if (
      request.url === "/api/v1/internal/oim/polling-registrations" ||
      request.url === "/api/v1/internal/oim/knowledge-registrations"
    ) {
      response.writeHead(200, { "content-type": "application/json" }).end("[]");
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (typeof address === "string" || address === null) {
    await closeServer(server);
    throw new Error("Internal API test server did not bind a TCP port");
  }
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
