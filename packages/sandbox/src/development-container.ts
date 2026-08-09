import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { authorizeSandboxExecutionRequest, type SandboxGuardrail } from "./guardrail";
import {
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
  SandboxProtocolError,
} from "./request";

const execFileP = promisify(execFile);

export interface DevelopmentSandboxArtifact {
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

export interface DevelopmentSandboxArtifactReader {
  read(artifactRef: string): Promise<DevelopmentSandboxArtifact>;
}

export interface DevelopmentSandboxCredentialReader {
  read(leaseRef: string): Promise<string>;
}

export interface DevelopmentSandboxOutputPublisher {
  publish(input: {
    readonly requestId: string;
    readonly name: string;
    readonly bytes: Uint8Array;
    readonly mediaType: string;
  }): Promise<string>;
}

/**
 * A Docker network prepared so the workload can reach only the enforcement proxy. The port owner
 * is responsible for an internal network with no other peers or default route.
 */
export interface DevelopmentSandboxEgress {
  readonly networkName: string;
  readonly httpsProxy: string;
}

export interface DevelopmentSandboxEgressPort {
  prepare(destinationIds: readonly string[]): Promise<DevelopmentSandboxEgress>;
}

export interface DevelopmentContainerSandboxOptions {
  readonly guardrail: SandboxGuardrail;
  /** Exact OCI digest -> immutable `repository@sha256:...` reference. */
  readonly images: Readonly<Record<string, string>>;
  readonly artifacts: DevelopmentSandboxArtifactReader;
  readonly credentials: DevelopmentSandboxCredentialReader;
  readonly outputs: DevelopmentSandboxOutputPublisher;
  readonly egress?: DevelopmentSandboxEgressPort;
  readonly dockerBinary?: string;
  readonly run?: DevelopmentContainerCommandRunner;
  readonly now?: () => number;
}

export interface DevelopmentContainerCommandResult {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export type DevelopmentContainerCommandRunner = (input: {
  readonly binary: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly outputBytes: number;
}) => Promise<DevelopmentContainerCommandResult>;

function safeFileName(value: string, fallback: string): string {
  const name = basename(value);
  if (name.length === 0 || name === "." || name === ".." || name.includes("\\")) return fallback;
  return name.slice(0, 255);
}

function commandFor(fileName: string): string {
  switch (extname(fileName).toLowerCase()) {
    case ".sh":
      return "bash";
    case ".ts":
    case ".tsx":
      return "tsx";
    case ".py":
      return "python3";
    default:
      throw new SandboxProtocolError("unsafe_request_shape");
  }
}

function environmentLine(name: string, value: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name) || value.includes("\n") || value.includes("\0")) {
    throw new SandboxProtocolError("unsafe_request_shape");
  }
  return `${name}=${value}`;
}

function executionError(error: unknown): DevelopmentContainerCommandResult {
  if (typeof error !== "object" || error === null) {
    throw new SandboxProtocolError("backend_failure");
  }
  const record = error as Record<string, unknown>;
  const stdout = typeof record.stdout === "string" ? record.stdout : "";
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const timedOut = record.killed === true || record.code === "ETIMEDOUT";
  const exitCode = typeof record.code === "number" ? record.code : timedOut ? 124 : 1;
  return {
    exitCode,
    timedOut,
    stdout: new TextEncoder().encode(stdout),
    stderr: new TextEncoder().encode(stderr),
  };
}

async function runDocker(
  input: Parameters<DevelopmentContainerCommandRunner>[0]
): Promise<DevelopmentContainerCommandResult> {
  try {
    const result = await execFileP(input.binary, [...input.args], {
      timeout: input.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: input.outputBytes,
      encoding: "utf8",
    });
    return {
      exitCode: 0,
      timedOut: false,
      stdout: new TextEncoder().encode(result.stdout),
      stderr: new TextEncoder().encode(result.stderr),
    };
  } catch (error) {
    return executionError(error);
  }
}

async function regularFile(path: string, maxBytes: number): Promise<Uint8Array> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new SandboxProtocolError("invalid_result_shape");
  }
  return readFile(path);
}

/**
 * Development-only ephemeral Docker executor. Production composition must use the signed protocol
 * executor with an attested microVM or managed remote backend.
 */
export class DevelopmentContainerSandboxExecutor {
  private readonly dockerBinary: string;
  private readonly now: () => number;
  private readonly run: DevelopmentContainerCommandRunner;

  constructor(private readonly options: DevelopmentContainerSandboxOptions) {
    this.dockerBinary = options.dockerBinary ?? "docker";
    this.now = options.now ?? (() => Date.now());
    this.run = options.run ?? runDocker;
  }

  async execute(input: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    const request = authorizeSandboxExecutionRequest(input, this.options.guardrail, this.now());
    if (request.operation !== "tool" || request.runtimeProfile === undefined) {
      throw new SandboxProtocolError("unsafe_request_shape");
    }
    const image = this.options.images[request.runtimeProfile.imageDigest];
    if (image === undefined || !image.endsWith(`@${request.runtimeProfile.imageDigest}`)) {
      throw new SandboxProtocolError("weak_backend_isolation");
    }

    const workspace = await mkdtemp(join(tmpdir(), "tulip-sandbox-"));
    const inputRoot = join(workspace, "input");
    const entrypointRoot = join(inputRoot, "entrypoint");
    const artifactRoot = join(inputRoot, "artifacts");
    const credentialRoot = join(workspace, "credentials");
    const outputRoot = join(workspace, "output");
    const environmentPath = join(workspace, "environment");
    const startedAtMs = this.now();
    let execution: DevelopmentContainerCommandResult | undefined;
    let stdoutArtifactRef: string | undefined;
    let stderrArtifactRef: string | undefined;
    let jsonArtifactRef: string | undefined;
    let jsonOutputBytes = 0;
    const fileOutputs: Array<{
      name: string;
      artifactRef: string;
      mediaType: string;
      bytes: number;
    }> = [];
    const egressBytes = 0;

    try {
      await Promise.all([
        mkdir(entrypointRoot, { recursive: true }),
        mkdir(artifactRoot, { recursive: true }),
        mkdir(credentialRoot, { recursive: true }),
        mkdir(outputRoot, { recursive: true }),
      ]);
      const entrypoint = await this.options.artifacts.read(request.entrypoint.artifactRef);
      const entrypointName = safeFileName(entrypoint.fileName, "entrypoint");
      await writeFile(join(entrypointRoot, entrypointName), entrypoint.bytes, { mode: 0o500 });

      for (const [index, artifactRef] of request.inputArtifactRefs.entries()) {
        const artifact = await this.options.artifacts.read(artifactRef);
        const name = safeFileName(artifact.fileName, `input-${index}`);
        await writeFile(join(artifactRoot, `${index}-${name}`), artifact.bytes, { mode: 0o400 });
      }

      const environment = [
        environmentLine("TULIP_INPUT_DIR", "/tulip/input/artifacts"),
        environmentLine("TULIP_OUTPUT_DIR", "/tulip/output"),
      ];
      for (const binding of request.credentialBindings ?? []) {
        const credential = await this.options.credentials.read(binding.leaseRef);
        if (binding.injectAs.kind === "file") {
          const fileName = safeFileName(binding.injectAs.name, binding.slot);
          await writeFile(join(credentialRoot, fileName), credential, { mode: 0o400 });
          environment.push(
            environmentLine(binding.injectAs.name, `/tulip/credentials/${fileName}`)
          );
        } else {
          environment.push(environmentLine(binding.injectAs.name, credential));
        }
      }

      const dockerArgs = [
        "run",
        "--rm",
        `--user=${process.getuid?.() ?? 65_534}:${process.getgid?.() ?? 65_534}`,
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=128",
        `--memory=${request.compute.memoryBytes}`,
        `--env-file=${environmentPath}`,
        `--mount=type=bind,source=${inputRoot},target=/tulip/input,readonly`,
        `--mount=type=bind,source=${credentialRoot},target=/tulip/credentials,readonly`,
        `--mount=type=bind,source=${outputRoot},target=/tulip/output`,
        `--tmpfs=/tmp:rw,noexec,nosuid,size=${Math.min(request.workspace.maxBytes, 64_000_000)}`,
      ];
      if (request.egress.destinationIds.length === 0) {
        dockerArgs.push("--network=none");
      } else {
        if (this.options.egress === undefined) throw new SandboxProtocolError("egress_denied");
        const egress = await this.options.egress.prepare(request.egress.destinationIds);
        dockerArgs.push(`--network=${egress.networkName}`);
        environment.push(environmentLine("HTTPS_PROXY", egress.httpsProxy));
        environment.push(environmentLine("HTTP_PROXY", egress.httpsProxy));
      }
      await writeFile(environmentPath, `${environment.join("\n")}\n`, { mode: 0o600 });
      await chmod(outputRoot, 0o700);
      dockerArgs.push(
        image,
        commandFor(entrypointName),
        `/tulip/input/entrypoint/${entrypointName}`,
        ...request.entrypoint.argv
      );
      execution = await this.run({
        binary: this.dockerBinary,
        args: dockerArgs,
        timeoutMs: request.compute.timeoutMs,
        outputBytes: request.compute.outputBytes,
      });
      let outputBytes = execution.stdout.byteLength + execution.stderr.byteLength;
      if (outputBytes > request.compute.outputBytes) {
        throw new SandboxProtocolError("result_limit_exceeded");
      }
      stdoutArtifactRef = await this.options.outputs.publish({
        requestId: request.requestId,
        name: "stdout",
        bytes: execution.stdout,
        mediaType: "text/plain",
      });
      stderrArtifactRef = await this.options.outputs.publish({
        requestId: request.requestId,
        name: "stderr",
        bytes: execution.stderr,
        mediaType: "text/plain",
      });
      if (request.outputs === undefined) throw new SandboxProtocolError("invalid_result_shape");
      const jsonBytes = await regularFile(
        join(outputRoot, request.outputs.jsonPath),
        request.compute.outputBytes - outputBytes
      );
      jsonOutputBytes = jsonBytes.byteLength;
      outputBytes += jsonBytes.byteLength;
      jsonArtifactRef = await this.options.outputs.publish({
        requestId: request.requestId,
        name: "result",
        bytes: jsonBytes,
        mediaType: "application/json",
      });
      for (const declaration of request.outputs.files) {
        const bytes = await regularFile(
          join(outputRoot, declaration.path),
          Math.min(declaration.maxBytes, request.compute.outputBytes - outputBytes)
        );
        if (bytes.byteLength > declaration.maxBytes) {
          throw new SandboxProtocolError("result_limit_exceeded");
        }
        outputBytes += bytes.byteLength;
        const mediaType = declaration.mediaTypes[0];
        if (mediaType === undefined) throw new SandboxProtocolError("invalid_result_shape");
        fileOutputs.push({
          name: declaration.name,
          artifactRef: await this.options.outputs.publish({
            requestId: request.requestId,
            name: declaration.name,
            bytes,
            mediaType,
          }),
          mediaType,
          bytes: bytes.byteLength,
        });
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }

    if (
      execution === undefined ||
      stdoutArtifactRef === undefined ||
      stderrArtifactRef === undefined ||
      jsonArtifactRef === undefined
    ) {
      throw new SandboxProtocolError("backend_failure");
    }
    const outputBytes =
      execution.stdout.byteLength +
      execution.stderr.byteLength +
      jsonOutputBytes +
      fileOutputs.reduce((total, file) => total + file.bytes, 0);
    if (outputBytes > request.compute.outputBytes) {
      throw new SandboxProtocolError("result_limit_exceeded");
    }
    return {
      requestId: request.requestId,
      nonce: request.nonce,
      exitCode: execution.exitCode,
      timedOut: execution.timedOut,
      stdoutArtifactRef,
      stderrArtifactRef,
      outputs: { jsonArtifactRef, files: fileOutputs },
      usage: {
        cpuMillis: 0,
        maxMemoryBytes: 0,
        outputBytes,
        egressBytes,
      },
      workspace: { kind: "ephemeral", destroyed: true },
      startedAtMs,
      completedAtMs: this.now(),
    };
  }
}
