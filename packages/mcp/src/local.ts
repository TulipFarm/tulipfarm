import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { DevelopmentSandboxEgressPort, SandboxIsolationAttestation } from "@tulipfarm/sandbox";
import { McpError } from "./errors";
import type { IsolatedMcpStdioBackend, McpStdioProcess } from "./types";

export interface ContainerMcpOptions {
  /** Trusted host configuration, never an MCP server's launch command. */
  readonly dockerBinary: string;
  readonly dockerEnvironment?: Readonly<Record<string, string>>;
  readonly egress?: DevelopmentSandboxEgressPort;
}
export type DevelopmentContainerMcpOptions = ContainerMcpOptions;

function environmentLine(key: string, value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || /[\r\n\0]/.test(value)) {
    throw new McpError("invalid_configuration");
  }
  return `${key}=${value}`;
}

async function spawned(process: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    process.once("spawn", resolve);
    process.once("error", () => reject(new McpError("unsupported_backend")));
  });
}

abstract class ContainerMcpBackend implements IsolatedMcpStdioBackend {
  private readonly dockerBinary: string;
  private readonly dockerEnvironment: Readonly<Record<string, string>>;

  protected constructor(
    private readonly options: ContainerMcpOptions,
    private readonly runtime?: "io.containerd.kata.v2"
  ) {
    if (!isAbsolute(options.dockerBinary)) throw new McpError("invalid_configuration");
    this.dockerBinary = options.dockerBinary;
    this.dockerEnvironment = Object.freeze({ ...options.dockerEnvironment });
  }

  abstract attestation(): SandboxIsolationAttestation;

  async open(input: Parameters<IsolatedMcpStdioBackend["open"]>[0]): Promise<McpStdioProcess> {
    input.signal.throwIfAborted();
    const { transport } = input;
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(transport.image) ||
      !transport.command.startsWith("/") ||
      transport.command.includes("\0") ||
      transport.args.length > 64 ||
      transport.args.some((arg) => arg.includes("\0"))
    ) {
      throw new McpError("invalid_configuration");
    }
    const environment = { ...input.environment };
    let network = "none";
    if (transport.allowedEgress.length > 0) {
      if (!this.options.egress) throw new McpError("unsupported_backend");
      const egress = await this.options.egress.prepare(transport.allowedEgress);
      network = egress.networkName;
      Object.assign(environment, {
        HTTPS_PROXY: egress.httpsProxy,
        HTTP_PROXY: egress.httpsProxy,
        https_proxy: egress.httpsProxy,
        http_proxy: egress.httpsProxy,
      });
    }
    const directory = await mkdtemp(join(tmpdir(), "tulip-mcp-"));
    const environmentPath = join(directory, "environment");
    const name = `tulip-mcp-${randomUUID()}`;
    let child: ChildProcessWithoutNullStreams | undefined;
    let closing: Promise<void> | undefined;
    let cleanupFailed = false;
    const close = (): Promise<void> => {
      if (closing) return closing;
      closing = (async () => {
        input.signal.removeEventListener("abort", aborted);
        if (child) {
          const remove = spawn(this.dockerBinary, ["rm", "--force", name], {
            env: this.dockerEnvironment,
            stdio: "pipe",
            shell: false,
          });
          remove.stdout.resume();
          remove.stderr.resume();
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              remove.kill("SIGKILL");
              cleanupFailed = true;
              resolve();
            }, 5000);
            remove.once("error", () => {
              clearTimeout(timer);
              cleanupFailed = true;
              resolve();
            });
            remove.once("close", (code) => {
              clearTimeout(timer);
              if (code !== 0 && child?.exitCode === null) cleanupFailed = true;
              resolve();
            });
          });
          child.kill("SIGKILL");
        }
        await rm(environmentPath, { force: true });
        await rmdir(directory);
      })();
      return closing;
    };
    const aborted = () => {
      void close();
    };
    try {
      await writeFile(
        environmentPath,
        `${Object.entries(environment)
          .map(([key, value]) => environmentLine(key, value))
          .join("\n")}\n`,
        { mode: 0o600 }
      );
      input.signal.throwIfAborted();
      child = spawn(
        this.dockerBinary,
        [
          "run",
          ...(this.runtime ? [`--runtime=${this.runtime}`] : []),
          "--rm",
          "--interactive",
          "--pull=never",
          `--name=${name}`,
          "--user=65534:65534",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--pids-limit=64",
          "--memory=268435456",
          "--cpus=1",
          "--tmpfs=/tmp:rw,noexec,nosuid,size=67108864",
          `--network=${network}`,
          `--env-file=${environmentPath}`,
          `--entrypoint=${transport.command}`,
          transport.image,
          ...transport.args,
        ],
        { env: this.dockerEnvironment, stdio: "pipe", shell: false }
      );
      child.stderr.resume();
      // A server may echo credentials to stderr; consume without retaining or logging it.
      child.stdin.on("error", () => {
        void close();
      });
      input.signal.addEventListener("abort", aborted, { once: true });
      await spawned(child);
      const running = child;
      if (input.signal.aborted) {
        await close();
        throw new McpError("cancelled");
      }

      return {
        stdout: running.stdout,
        write: (bytes) =>
          new Promise<void>((resolve, reject) => {
            running.stdin.write(bytes, (error) =>
              error ? reject(new McpError("transport_failure")) : resolve()
            );
          }),
        close: async () => {
          await close();
          if (cleanupFailed) throw new McpError("transport_failure");
        },
      };
    } catch (error) {
      await close();
      throw error instanceof McpError ? error : new McpError("unsupported_backend");
    }
  }
}

export class DevelopmentContainerMcpBackend extends ContainerMcpBackend {
  constructor(options: ContainerMcpOptions) {
    super(options, undefined);
  }

  attestation(): SandboxIsolationAttestation {
    return {
      isolation: "container",
      strongIsolation: false,
      developmentOnly: true,
      provider: "mcp-development-docker",
    };
  }
}

export class KataContainerMcpBackend extends ContainerMcpBackend {
  constructor(options: ContainerMcpOptions) {
    super(options, "io.containerd.kata.v2");
  }

  attestation(): SandboxIsolationAttestation {
    return {
      isolation: "microvm",
      strongIsolation: true,
      developmentOnly: false,
      provider: "kata-containers",
    };
  }
}
