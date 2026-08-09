import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DevelopmentContainerSandboxExecutor, type IsolatedSandboxExecutionRequest } from "./index";

const NOW = 1_000_000;
const DIGEST = `sha256:${"a".repeat(64)}`;

function outputMount(args: readonly string[]): string {
  const option = args.find((value) => value.includes("target=/tulip/output"));
  if (option === undefined) throw new Error("output mount missing");
  const source = option
    .split(",")
    .find((value) => value.startsWith("source="))
    ?.slice("source=".length);
  if (source === undefined) throw new Error("output source missing");
  return source;
}

function request(): IsolatedSandboxExecutionRequest {
  return {
    requestId: "request-1",
    nonce: "nonce-1",
    issuedAtMs: NOW,
    expiresAtMs: NOW + 30_000,
    operation: "tool",
    workspace: { kind: "ephemeral", maxBytes: 8_000_000 },
    entrypoint: { artifactRef: "artifact://entrypoint/v1", argv: ["--json"] },
    inputArtifactRefs: ["artifact://input/v1"],
    compute: {
      timeoutMs: 5_000,
      cpuMillis: 2_000,
      memoryBytes: 64_000_000,
      outputBytes: 10_000,
    },
    egress: { destinationIds: [], maxBytes: 0 },
    runtimeProfile: { id: "shell-ts-python-v1", imageDigest: DIGEST },
    credentialBindings: [],
    outputs: {
      jsonPath: "result.json",
      files: [
        {
          name: "report",
          path: "files/report.txt",
          mediaTypes: ["text/plain"],
          maxBytes: 1_000,
        },
      ],
    },
  };
}

describe("DevelopmentContainerSandboxExecutor", () => {
  it("runs a digest-pinned image with an ephemeral read-only workspace", async () => {
    const published = new Map<string, Uint8Array>();
    let workspace: string | undefined;
    const run = vi.fn(async ({ args }: { readonly args: readonly string[] }) => {
      const output = outputMount(args);
      workspace = join(output, "..");
      await mkdir(join(output, "files"), { recursive: true });
      await writeFile(join(output, "result.json"), '{"ok":true}');
      await writeFile(join(output, "files/report.txt"), "ready");
      return {
        exitCode: 0,
        timedOut: false,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      };
    });
    const executor = new DevelopmentContainerSandboxExecutor({
      guardrail: {
        maxRequestLifetimeMs: 60_000,
        maxWorkspaceBytes: 10_000_000,
        maxCompute: {
          timeoutMs: 10_000,
          cpuMillis: 5_000,
          memoryBytes: 128_000_000,
          outputBytes: 20_000,
        },
        allowedRuntimeProfiles: { "shell-ts-python-v1": DIGEST },
        maxCredentialBindings: 1,
        maxFileOutputs: 4,
      },
      images: { [DIGEST]: `ghcr.io/tulipfarm/sandbox@${DIGEST}` },
      artifacts: {
        async read(ref) {
          if (ref === "artifact://entrypoint/v1") {
            return { fileName: "run.ts", bytes: new TextEncoder().encode("export {};") };
          }
          return { fileName: "input.json", bytes: new TextEncoder().encode("{}") };
        },
      },
      credentials: {
        async read() {
          return "unused";
        },
      },
      outputs: {
        async publish(input) {
          published.set(input.name, input.bytes);
          return `artifact://${input.name}/v1`;
        },
      },
      run,
      now: () => NOW,
    });

    const result = await executor.execute(request());

    expect(result.outputs?.files).toEqual([
      {
        name: "report",
        artifactRef: "artifact://report/v1",
        mediaType: "text/plain",
        bytes: 5,
      },
    ]);
    expect(new TextDecoder().decode(published.get("result"))).toBe('{"ok":true}');
    expect(published.get("stdout")).toEqual(new Uint8Array());
    const args = run.mock.calls[0]?.[0].args ?? [];
    expect(args).toContain("--read-only");
    expect(args).toContain("--network=none");
    expect(args.some((value) => value.startsWith("--user="))).toBe(true);
    expect(args).toContain(`ghcr.io/tulipfarm/sandbox@${DIGEST}`);
    expect(workspace).toBeDefined();
    await expect(lstat(workspace ?? "")).rejects.toThrow();
  });
});
