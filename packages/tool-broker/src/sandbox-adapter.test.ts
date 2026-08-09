import { SandboxRuntimeProfileRegistry, shellTsPythonV1 } from "@tulipfarm/sandbox";
import { describe, expect, it, vi } from "vitest";
import type { ToolAdapterRequest } from "./effects";
import {
  type PublishedSandboxCommand,
  SandboxToolAdapter,
  type SandboxToolAdapterOptions,
} from "./sandbox-adapter";

const bundleDigest = `sha256:${"a".repeat(64)}`;
const scriptDigest = `sha256:${"b".repeat(64)}`;
const imageDigest = `sha256:${"c".repeat(64)}`;

function command(overrides: Partial<PublishedSandboxCommand> = {}): PublishedSandboxCommand {
  return {
    toolId: "report.generate",
    toolVersion: "1.0.0",
    bundle: {
      skillId: "reporting",
      version: "1",
      digest: bundleDigest,
      entrypoint: { path: "scripts/report.ts", digest: scriptDigest },
      assets: [],
      webDestinationIds: ["reports-api"],
      gitTargets: [],
    },
    requestedAssetPaths: [],
    runtimeProfile: "shell-ts-python-v1",
    requiredCommands: ["tsx", "curl"],
    staticArgs: [],
    compute: {
      timeoutMs: 10_000,
      cpuMillis: 5_000,
      memoryBytes: 128_000_000,
      outputBytes: 1_000_000,
    },
    workspaceMaxBytes: 16_000_000,
    maxEgressBytes: 100_000,
    jsonOutputPath: "outputs/result.json",
    fileOutputs: [],
    gitTargets: [],
    ...overrides,
  };
}

function request(): ToolAdapterRequest {
  return {
    intent: {
      intentId: "effect-1",
      businessId: "business-1",
      runId: "run-1",
      stateId: "state-1",
      toolId: "report.generate",
      toolVersion: "1.0.0",
      action: "generate",
      targetRefs: [],
      arguments: { period: "weekly" },
      destination: "reports-api",
      credentialRef: "integration:reports",
      idempotencyKey: "idem-1",
    },
    idempotencyKey: "idem-1",
    attempt: 1,
  };
}

function setup(binding = true) {
  const selected = command(
    binding
      ? {
          integrationBinding: {
            slot: "reports",
            injectAs: { kind: "environment", name: "REPORTS_TOKEN" },
          },
        }
      : {}
  );
  const revoke = vi.fn(async () => undefined);
  const execute = vi.fn(async () => ({
    sandboxResult: {
      requestId: "effect-1",
      nonce: "nonce-1",
      exitCode: 0,
      timedOut: false,
      stdoutArtifactRef: "artifact://raw/stdout",
      stderrArtifactRef: "artifact://raw/stderr",
      outputs: { jsonArtifactRef: "artifact://output/json", files: [] },
      usage: { cpuMillis: 1, maxMemoryBytes: 1, outputBytes: 1, egressBytes: 1 },
      workspace: { kind: "ephemeral" as const, destroyed: true },
      startedAtMs: 1_001,
      completedAtMs: 1_002,
    },
    outputArtifact: {
      artifactId: "output-1",
      artifactRef: "artifact://published/output",
    },
  }));
  const options: SandboxToolAdapterOptions = {
    commands: { resolve: () => selected },
    runtimes: new SandboxRuntimeProfileRegistry([shellTsPythonV1(imageDigest)]),
    inputs: { publish: vi.fn(async () => "artifact://input/arguments") },
    credentials: {
      issue: vi.fn(async () => ({ leaseRef: "lease:one-use", revoke })),
    },
    outputs: { readJson: vi.fn(async () => ({ reportId: "report-1" })) },
    executor: { execute },
    now: () => 1_000,
    nonce: () => "nonce-1",
  };
  return { adapter: new SandboxToolAdapter(options), execute, options, revoke };
}

describe("SandboxToolAdapter", () => {
  it("materializes JSON input, scopes a credential lease, and returns JSON output", async () => {
    const { adapter, execute, options, revoke } = setup();

    await expect(adapter.dispatch(request(), "secret-value")).resolves.toEqual({
      reportId: "report-1",
    });
    expect(options.inputs.publish).toHaveBeenCalledWith({
      businessId: "business-1",
      runId: "run-1",
      stateId: "state-1",
      arguments: { period: "weekly" },
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeProfile: { id: "shell-ts-python-v1", imageDigest },
        inputArtifactRefs: ["artifact://input/arguments"],
        credentialBindings: [
          {
            slot: "reports",
            leaseRef: "lease:one-use",
            injectAs: { kind: "environment", name: "REPORTS_TOKEN" },
          },
        ],
      })
    );
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("fails before dispatch when a required CLI is absent", async () => {
    const { adapter, execute, options } = setup(false);
    vi.spyOn(options.commands, "resolve").mockReturnValue(command({ requiredCommands: ["gws"] }));

    await expect(adapter.dispatch(request())).rejects.toMatchObject({
      phase: "before_dispatch",
      code: "sandbox_runtime_unavailable",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails before dispatch when a declared Integration binding has no credential", async () => {
    const { adapter, execute } = setup();

    await expect(adapter.dispatch(request())).rejects.toMatchObject({
      phase: "before_dispatch",
      code: "sandbox_credential_required",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("marks a started command failure as ambiguous instead of retryable", async () => {
    const { adapter, execute } = setup(false);
    const failed = await execute();
    execute.mockResolvedValueOnce({
      ...failed,
      sandboxResult: { ...failed.sandboxResult, exitCode: 1 },
    });

    await expect(adapter.dispatch(request())).rejects.toMatchObject({
      phase: "after_dispatch",
      code: "sandbox_command_failed",
      retryable: false,
    });
  });
});
