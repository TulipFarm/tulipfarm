/**
 * Development egress for sandbox Skill commands.
 *
 * The executor hands a workload a Docker network and an `HTTPS_PROXY`, and expects the port owner
 * to guarantee the workload can reach *only* the declared destinations. This implementation does
 * that with two Docker networks and a forward proxy:
 *
 * ```
 *   workload ──> tulip-egress-<key>  (--internal: no default route, no peers but the proxy)
 *                      │
 *                   proxy container ──> bridge ──> internet
 *                      └── allowlist: exactly the destination hosts, ports 80/443
 * ```
 *
 * The workload therefore has no route of its own; every packet is a CONNECT the proxy either
 * allows or refuses. This is a development backend: production egress is enforced by the deployed
 * environment, not by Docker.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DevelopmentContainerCommandRunner,
  DevelopmentSandboxEgress,
  DevelopmentSandboxEgressPort,
} from "./development-container";
import { EGRESS_PROXY_SOURCE } from "./egress-proxy-source";

/** Alias the workload resolves on the internal network. Never a host the destination controls. */
const PROXY_ALIAS = "tulip-egress-proxy";
const PROXY_PORT = 8888;
const DOCKER_TIMEOUT_MS = 60_000;

export interface DockerNetworkEgressOptions {
  /** Immutable `repository@sha256:...` reference; the proxy only needs a `node` binary. */
  readonly image: string;
  readonly dockerBinary?: string;
  readonly run?: DevelopmentContainerCommandRunner;
  /** Seconds a prepared proxy stays alive with no run. Bounds leakage if cleanup never happens. */
  readonly idleTimeoutSeconds?: number;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).trim();
}

/** Stable, filesystem-safe name for a destination set, so concurrent Runs share one proxy. */
function keyFor(destinationIds: readonly string[]): string {
  const canonical = [...new Set(destinationIds.map((id) => id.toLowerCase()))].sort().join(",");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

export class DockerNetworkEgressPort implements DevelopmentSandboxEgressPort {
  private readonly dockerBinary: string;
  private readonly run: DevelopmentContainerCommandRunner;
  private readonly idleTimeoutSeconds: number;
  private readonly prepared = new Map<string, Promise<DevelopmentSandboxEgress>>();

  constructor(private readonly options: DockerNetworkEgressOptions) {
    this.dockerBinary = options.dockerBinary ?? "docker";
    this.idleTimeoutSeconds = options.idleTimeoutSeconds ?? 900;
    this.run =
      options.run ??
      (async (input) => {
        const { spawn } = await import("node:child_process");
        return await new Promise((resolve, reject) => {
          const child = spawn(input.binary, input.args, { stdio: ["ignore", "pipe", "pipe"] });
          const stdout: Buffer[] = [];
          const stderr: Buffer[] = [];
          const timer = setTimeout(() => child.kill("SIGKILL"), input.timeoutMs);
          child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
          child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
          child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            resolve({
              exitCode: code ?? 1,
              timedOut: false,
              stdout: Buffer.concat(stdout),
              stderr: Buffer.concat(stderr),
            });
          });
        });
      });
  }

  private async docker(
    args: readonly string[]
  ): Promise<{ code: number; out: string; err: string }> {
    const result = await this.run({
      binary: this.dockerBinary,
      args: [...args],
      timeoutMs: DOCKER_TIMEOUT_MS,
      outputBytes: 1_000_000,
    });
    return { code: result.exitCode, out: decode(result.stdout), err: decode(result.stderr) };
  }

  async prepare(destinationIds: readonly string[]): Promise<DevelopmentSandboxEgress> {
    if (destinationIds.length === 0) throw new Error("egress_no_destinations");
    const key = keyFor(destinationIds);
    const existing = this.prepared.get(key);
    if (existing !== undefined) return await existing;
    const started = this.start(key, destinationIds).catch((error: unknown) => {
      this.prepared.delete(key);
      throw error;
    });
    this.prepared.set(key, started);
    return await started;
  }

  private async start(
    key: string,
    destinationIds: readonly string[]
  ): Promise<DevelopmentSandboxEgress> {
    const networkName = `tulip-egress-${key}`;
    const containerName = `tulip-egress-proxy-${key}`;
    const egress: DevelopmentSandboxEgress = {
      networkName,
      httpsProxy: `http://${PROXY_ALIAS}:${PROXY_PORT}`,
    };

    const running = await this.docker(["inspect", "--format", "{{.State.Running}}", containerName]);
    if (running.code === 0 && running.out === "true") return egress;

    // An internal network has no default route, so a workload attached only to it cannot bypass
    // the proxy even if it resolves an address by other means.
    const network = await this.docker(["network", "create", "--internal", networkName]);
    if (network.code !== 0 && !network.err.includes("already exists")) {
      throw new Error(`egress_network_failed:${network.err}`);
    }

    const staging = await mkdtemp(join(tmpdir(), "tulip-egress-"));
    try {
      const proxyPath = join(staging, "proxy.mjs");
      await writeFile(proxyPath, EGRESS_PROXY_SOURCE, { mode: 0o444 });

      await this.docker(["rm", "--force", containerName]);
      const create = await this.docker([
        "run",
        "--detach",
        `--name=${containerName}`,
        "--network=bridge",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=64",
        "--memory=134217728",
        `--env=TULIP_ALLOWED_HOSTS=${destinationIds.join(",")}`,
        `--env=TULIP_PROXY_PORT=${PROXY_PORT}`,
        `--env=TULIP_IDLE_TIMEOUT_SECONDS=${this.idleTimeoutSeconds}`,
        `--mount=type=bind,source=${proxyPath},target=/tulip-proxy.mjs,readonly`,
        this.options.image,
        "node",
        "/tulip-proxy.mjs",
      ]);
      if (create.code !== 0) throw new Error(`egress_proxy_failed:${create.err}`);

      const attach = await this.docker([
        "network",
        "connect",
        `--alias=${PROXY_ALIAS}`,
        networkName,
        containerName,
      ]);
      if (attach.code !== 0 && !attach.err.includes("already exists")) {
        throw new Error(`egress_attach_failed:${attach.err}`);
      }
      return egress;
    } finally {
      // The bind mount keeps its own reference to the inode, so the staging directory is
      // removable as soon as the container exists.
      await rm(staging, { recursive: true, force: true });
    }
  }

  /** Removes every proxy and network this port created. Safe to call more than once. */
  async close(): Promise<void> {
    const keys = [...this.prepared.keys()];
    this.prepared.clear();
    for (const key of keys) {
      await this.docker(["rm", "--force", `tulip-egress-proxy-${key}`]);
      await this.docker(["network", "rm", `tulip-egress-${key}`]);
    }
  }
}
