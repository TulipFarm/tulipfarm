import { createServer, type Server } from "node:http";
import type { Queryable } from "./db";
import { assertSchemaFloor } from "./preflight";

export interface ReadinessResult {
  readonly status: "ok" | "down";
  readonly detail?: string;
}

export interface ProbeServerOptions {
  readonly port: number;
  readonly database: Queryable;
  readonly requiredSchemaVersion: number;
  /** False once shutdown begins, so the orchestrator stops routing before the drain finishes. */
  readonly isServing: () => boolean;
  /** True once every consumer required by this replica is attached. */
  readonly areConsumersReady: () => boolean;
}

/** Readiness checks datastore/schema/drain; liveness must not fail on recoverable outages. */
export async function probeReadiness(options: ProbeServerOptions): Promise<ReadinessResult> {
  if (!options.isServing()) return { status: "down", detail: "draining" };
  if (!options.areConsumersReady()) {
    return { status: "down", detail: "required consumers are not attached" };
  }
  try {
    await assertSchemaFloor(options.database, options.requiredSchemaVersion);
    return { status: "ok" };
  } catch (error) {
    return { status: "down", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Dependency-free `/livez` and `/readyz`, matching the API probe names. */
export function startProbeServer(options: ProbeServerOptions): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const send = (code: number, body: Record<string, unknown>): void => {
      const payload = JSON.stringify(body);
      res.writeHead(code, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      });
      res.end(payload);
    };

    if (path === "/livez") {
      send(200, { status: "ok" });
      return;
    }
    if (path === "/readyz") {
      probeReadiness(options)
        .then((result) =>
          result.status === "ok"
            ? send(200, { status: "ok" })
            : send(503, { status: result.status, detail: result.detail })
        )
        .catch((error) => send(503, { status: "down", detail: String(error) }));
      return;
    }
    send(404, { error: "not_found" });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}
