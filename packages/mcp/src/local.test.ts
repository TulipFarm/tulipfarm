import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { assertProductionSandbox } from "@tulipfarm/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevelopmentContainerMcpBackend, KataContainerMcpBackend } from "./local";
import type { IsolatedMcpStdioBackend } from "./types";

const launch = vi.hoisted(() => ({
  failRun: false,
  calls: [] as {
    binary: string;
    args: string[];
    environment: Record<string, string>;
    file?: string;
    shell: boolean;
  }[],
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: (
    binary: string,
    args: string[],
    options: { env: Record<string, string>; shell: boolean }
  ) => {
    const fileArg = args.find((arg) => arg.startsWith("--env-file="));
    const file = fileArg ? readFileSync(fileArg.slice("--env-file=".length), "utf8") : undefined;
    launch.calls.push({ binary, args, environment: options.env, file, shell: options.shell });
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      if (launch.failRun && args[0] === "run") {
        child.emit("error", new Error("Runtime unavailable"));
        return;
      }
      child.emit("spawn");
      if (args[0] === "rm") child.emit("close", 0);
    });
    return child;
  },
}));

const input: Parameters<IsolatedMcpStdioBackend["open"]>[0] = {
  identity: {
    serverId: "fixture",
    accountId: "account-a",
    subjectId: "user-a",
    configurationRevision: "r1",
  },
  transport: {
    type: "stdio",
    image: `fixture@sha256:${"a".repeat(64)}`,
    command: "/server",
    args: ["stdio"],
    allowedEgress: [],
  },
  signal: new AbortController().signal,
  maxResponseBytes: 1024,
  environment: {},
};

afterEach(() => {
  launch.calls.length = 0;
  launch.failRun = false;
});

describe("development isolated stdio backend", () => {
  it("runs only inside a pinned hardened container with no host environment inheritance", async () => {
    const backend = new DevelopmentContainerMcpBackend({
      dockerBinary: "/usr/bin/docker",
    });
    const process = await backend.open({
      ...input,
      environment: { PROVIDER_TOKEN: "explicit-secret" },
    });
    const run = launch.calls[0];
    expect(run?.binary).toBe("/usr/bin/docker");
    expect(run?.environment).toEqual({});
    expect(run?.shell).toBe(false);
    expect(run?.args).toEqual(
      expect.arrayContaining([
        "run",
        "--pull=never",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--network=none",
        "--user=65534:65534",
        "--entrypoint=/server",
        input.transport.image,
        "stdio",
      ])
    );
    expect(run?.args.join(" ")).not.toContain("explicit-secret");
    expect(run?.args.join(" ")).not.toContain("--mount");
    expect(run?.file).toBe("PROVIDER_TOKEN=explicit-secret\n");
    await process.close();
    expect(launch.calls[1]?.args.slice(0, 2)).toEqual(["rm", "--force"]);
    await process.close();
    expect(launch.calls).toHaveLength(2);
  });

  it("uses only the sandbox's default-deny egress network and explicit proxies", async () => {
    const prepare = vi.fn(async () => ({
      networkName: "isolated-network",
      httpsProxy: "http://proxy:3128",
    }));
    const backend = new DevelopmentContainerMcpBackend({
      dockerBinary: "/usr/bin/docker",
      egress: { prepare },
    });
    const process = await backend.open({
      ...input,
      transport: { ...input.transport, allowedEgress: ["api.github.com"] },
    });
    expect(prepare).toHaveBeenCalledWith(["api.github.com"]);
    expect(launch.calls[0]?.args).toContain("--network=isolated-network");
    expect(launch.calls[0]?.file).toContain("https_proxy=http://proxy:3128");
    expect(launch.calls[0]?.file).toContain("HTTPS_PROXY=http://proxy:3128");
    await process.close();
  });

  it("fails closed for unavailable egress, mutable images, and unsafe environment entries", async () => {
    const backend = new DevelopmentContainerMcpBackend({ dockerBinary: "/usr/bin/docker" });
    await expect(
      backend.open({ ...input, transport: { ...input.transport, image: "image:latest" } })
    ).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(
      backend.open({
        ...input,
        transport: { ...input.transport, allowedEgress: ["api.github.com"] },
      })
    ).rejects.toMatchObject({ code: "unsupported_backend" });
    const unsafe = new DevelopmentContainerMcpBackend({
      dockerBinary: "/usr/bin/docker",
    });
    await expect(
      unsafe.open({ ...input, environment: { TOKEN: "secret\nINJECTED=value" } })
    ).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(launch.calls).toHaveLength(0);
  });

  it("never claims production isolation", () => {
    expect(
      new DevelopmentContainerMcpBackend({ dockerBinary: "/usr/bin/docker" }).attestation()
    ).toMatchObject({ developmentOnly: true, strongIsolation: false, isolation: "container" });
  });

  it("uses the actual Kata shim for production instead of promoting a development container", async () => {
    const backend = new KataContainerMcpBackend({ dockerBinary: "/usr/bin/docker" });
    expect(() => assertProductionSandbox(backend.attestation())).not.toThrow();
    const process = await backend.open(input);
    expect(launch.calls[0]?.args).toEqual(
      expect.arrayContaining([
        "--runtime=io.containerd.kata.v2",
        "--read-only",
        "--network=none",
        "--cap-drop=ALL",
        "--user=65534:65534",
        "--pull=never",
      ])
    );
    await process.close();
    expect(launch.calls.filter((call) => call.args[0] === "run")).toHaveLength(1);
    expect(() =>
      assertProductionSandbox(
        new DevelopmentContainerMcpBackend({ dockerBinary: "/usr/bin/docker" }).attestation()
      )
    ).toThrow();
  });

  it("requires the default-deny egress proxy for production too", async () => {
    const backend = new KataContainerMcpBackend({ dockerBinary: "/usr/bin/docker" });
    await expect(
      backend.open({
        ...input,
        transport: { ...input.transport, allowedEgress: ["api.github.com"] },
      })
    ).rejects.toMatchObject({ code: "unsupported_backend" });
    expect(launch.calls).toHaveLength(0);
  });

  it("never retries with an ordinary container if the Kata launch fails", async () => {
    launch.failRun = true;
    const backend = new KataContainerMcpBackend({ dockerBinary: "/usr/bin/docker" });
    await expect(backend.open(input)).rejects.toMatchObject({ code: "unsupported_backend" });
    const runs = launch.calls.filter((call) => call.args[0] === "run");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.args).toContain("--runtime=io.containerd.kata.v2");
  });
});
