import { describe, expect, it, vi } from "vitest";
import type {
  IsolatedSandboxExecutionRequest,
  IsolatedSandboxExecutionResult,
  ResolvedSkillArtifact,
  SkillArtifactResolver,
  SkillExecutionInput,
  SkillGitLockPort,
  SkillOutputPublisher,
  SkillOutputScanner,
  SkillSandboxExecutor,
} from "./index";
import { SkillExecutionCoordinator, SkillExecutionError } from "./index";

const DIGEST = `sha256:${"a".repeat(64)}`;
const SCRIPT_DIGEST = `sha256:${"b".repeat(64)}`;
const ASSET_DIGEST = `sha256:${"c".repeat(64)}`;
const GIT_REVISION = "d".repeat(40);

function input(overrides: Partial<SkillExecutionInput> = {}): SkillExecutionInput {
  return {
    requestId: "skill-request-1",
    nonce: "skill-nonce-1",
    issuedAtMs: 1_000,
    expiresAtMs: 31_000,
    bundle: {
      skillId: "skill.report",
      version: "1.0.0",
      digest: DIGEST,
      entrypoint: { path: "scripts/report.ts", digest: SCRIPT_DIGEST },
      assets: [{ path: "assets/template.md", digest: ASSET_DIGEST }],
      webDestinationIds: ["docs-read"],
      gitTargets: [{ repositoryId: "reports", revision: GIT_REVISION }],
    },
    requestedAssetPaths: ["assets/template.md"],
    argv: ["--format", "markdown"],
    compute: {
      timeoutMs: 10_000,
      cpuMillis: 5_000,
      memoryBytes: 128_000_000,
      outputBytes: 1_000_000,
    },
    workspaceMaxBytes: 16_000_000,
    web: {
      destinationIds: ["docs-read"],
      maxBytes: 100_000,
    },
    gitTargets: [],
    ...overrides,
  };
}

function result(): IsolatedSandboxExecutionResult {
  return {
    requestId: "skill-request-1",
    nonce: "skill-nonce-1",
    exitCode: 0,
    timedOut: false,
    stdoutArtifactRef: "artifact://raw/stdout",
    stderrArtifactRef: "artifact://raw/stderr",
    usage: {
      cpuMillis: 100,
      maxMemoryBytes: 1_000,
      outputBytes: 100,
      egressBytes: 0,
    },
    workspace: { kind: "ephemeral", destroyed: true },
    startedAtMs: 1_001,
    completedAtMs: 1_002,
  };
}

function setup(
  options: {
    readonly finding?: "direct_network_mutation";
    readonly outputVerdict?: "clean" | "rejected";
    readonly sandboxError?: Error;
    readonly gitGranted?: boolean;
  } = {}
) {
  const sandbox: SkillSandboxExecutor = {
    execute: vi.fn(async (_request: IsolatedSandboxExecutionRequest) => {
      if (options.sandboxError) {
        throw options.sandboxError;
      }
      return result();
    }),
  };
  const assets: SkillArtifactResolver = {
    resolve: vi.fn(
      async ({
        path,
        expectedDigest,
      }: Parameters<SkillArtifactResolver["resolve"]>[0]): Promise<ResolvedSkillArtifact> => ({
        artifactRef: `artifact://skill/${path}`,
        digest: expectedDigest,
        scan:
          options.finding && path === "scripts/report.ts"
            ? { verdict: "clean", findings: [options.finding] }
            : { verdict: "clean", findings: [] },
      })
    ),
  };
  const outputScanner: SkillOutputScanner = {
    scan: vi.fn(async () => ({
      verdict: options.outputVerdict ?? "clean",
      scanId: "scan-1",
    })),
  };
  const outputPublisher: SkillOutputPublisher = {
    publish: vi.fn(async () => ({
      artifactId: "artifact-output-1",
      artifactRef: "artifact://published/output-1",
    })),
  };
  const gitLocks: SkillGitLockPort = {
    lockGrantedTarget: vi.fn(async ({ repositoryId }) =>
      options.gitGranted === false
        ? { granted: false as const }
        : {
            granted: true as const,
            lockId: `lock:${repositoryId}`,
            workspaceArtifactRef: `artifact://git/${repositoryId}`,
          }
    ),
    release: vi.fn(async () => undefined),
  };
  return {
    assets,
    gitLocks,
    outputPublisher,
    outputScanner,
    sandbox,
    coordinator: new SkillExecutionCoordinator({
      assets,
      gitLocks,
      outputPublisher,
      outputScanner,
      sandbox,
    }),
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(SkillExecutionError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe("SkillExecutionCoordinator", () => {
  it("materializes only pinned, scanned Artifact inputs through the isolated executor", async () => {
    const { assets, coordinator, outputPublisher, sandbox } = setup();

    await expect(coordinator.execute(input())).resolves.toMatchObject({
      outputArtifact: {
        artifactId: "artifact-output-1",
        artifactRef: "artifact://published/output-1",
      },
    });

    expect(assets.resolve).toHaveBeenCalledTimes(2);
    expect(sandbox.execute).toHaveBeenCalledWith({
      requestId: "skill-request-1",
      nonce: "skill-nonce-1",
      issuedAtMs: 1_000,
      expiresAtMs: 31_000,
      operation: "compute",
      workspace: { kind: "ephemeral", maxBytes: 16_000_000 },
      entrypoint: {
        artifactRef: "artifact://skill/scripts/report.ts",
        argv: ["--format", "markdown"],
      },
      inputArtifactRefs: ["artifact://skill/assets/template.md"],
      compute: input().compute,
      egress: {
        destinationIds: ["docs-read"],
        maxBytes: 100_000,
      },
    });
    expect(outputPublisher.publish).toHaveBeenCalledOnce();
  });

  it.each([
    "../secret",
    "/host/secret",
    "assets/../../secret",
  ])("rejects traversal path %s before resolving an Artifact", async (path) => {
    const { assets, coordinator, sandbox } = setup();

    await expectCode(
      coordinator.execute(input({ requestedAssetPaths: [path] })),
      "unsafe_asset_path"
    );
    expect(assets.resolve).not.toHaveBeenCalled();
    expect(sandbox.execute).not.toHaveBeenCalled();
  });

  it("rejects undeclared assets and unmediated web destinations", async () => {
    const undeclared = setup();
    await expectCode(
      undeclared.coordinator.execute(input({ requestedAssetPaths: ["assets/not-declared.md"] })),
      "undeclared_asset"
    );
    expect(undeclared.sandbox.execute).not.toHaveBeenCalled();

    const web = setup();
    await expectCode(
      web.coordinator.execute(
        input({ web: { destinationIds: ["https://internal.example"], maxBytes: 10 } })
      ),
      "web_destination_denied"
    );
    expect(web.sandbox.execute).not.toHaveBeenCalled();
  });

  it("rejects a scanned direct curl mutation before sandbox dispatch", async () => {
    const { coordinator, sandbox } = setup({ finding: "direct_network_mutation" });

    await expectCode(
      coordinator.execute(input({ web: { destinationIds: [], maxBytes: 0 } })),
      "direct_network_forbidden"
    );
    expect(sandbox.execute).not.toHaveBeenCalled();
  });

  it("dispatches credentialed network work only as a pinned sandbox Tool operation", async () => {
    const { coordinator, sandbox } = setup({ finding: "direct_network_mutation" });
    const runtimeProfile = {
      id: "shell-ts-python-v1",
      imageDigest: `sha256:${"e".repeat(64)}`,
    };
    await coordinator.execute(
      input({
        runtimeProfile,
        credentialBindings: [
          {
            slot: "github",
            leaseRef: "lease:one-use",
            injectAs: { kind: "environment", name: "GITHUB_TOKEN" },
          },
        ],
        outputs: { jsonPath: "outputs/result.json", files: [] },
      })
    );

    expect(sandbox.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "tool",
        runtimeProfile,
        credentialBindings: [
          {
            slot: "github",
            leaseRef: "lease:one-use",
            injectAs: { kind: "environment", name: "GITHUB_TOKEN" },
          },
        ],
      })
    );
  });

  it("scans persistent output and never publishes malicious output", async () => {
    const { coordinator, outputPublisher } = setup({ outputVerdict: "rejected" });

    await expectCode(coordinator.execute(input()), "output_rejected");
    expect(outputPublisher.publish).not.toHaveBeenCalled();
  });

  it("locks granted pinned Git targets and releases the lock after success", async () => {
    const { coordinator, gitLocks, sandbox } = setup();

    await coordinator.execute(
      input({
        gitTargets: [{ repositoryId: "reports", revision: GIT_REVISION }],
      })
    );

    expect(gitLocks.lockGrantedTarget).toHaveBeenCalledWith({
      requestId: "skill-request-1",
      repositoryId: "reports",
      revision: GIT_REVISION,
    });
    expect(sandbox.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        inputArtifactRefs: ["artifact://skill/assets/template.md", "artifact://git/reports"],
      })
    );
    expect(gitLocks.release).toHaveBeenCalledWith("lock:reports");
  });

  it("denies ungranted or mutable Git targets and cleans up acquired locks on failure", async () => {
    const denied = setup({ gitGranted: false });
    await expectCode(
      denied.coordinator.execute(
        input({ gitTargets: [{ repositoryId: "reports", revision: GIT_REVISION }] })
      ),
      "git_grant_denied"
    );
    expect(denied.sandbox.execute).not.toHaveBeenCalled();

    const mutable = setup();
    await expectCode(
      mutable.coordinator.execute(
        input({ gitTargets: [{ repositoryId: "reports", revision: "main" }] })
      ),
      "git_revision_not_pinned"
    );

    const crashed = setup({ sandboxError: new Error("backend exploded") });
    await expectCode(
      crashed.coordinator.execute(
        input({ gitTargets: [{ repositoryId: "reports", revision: GIT_REVISION }] })
      ),
      "sandbox_execution_failed"
    );
    expect(crashed.gitLocks.release).toHaveBeenCalledWith("lock:reports");
  });
});
