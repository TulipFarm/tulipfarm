import { describe, expect, it } from "vitest";
import type { DevelopmentContainerCommandRunner } from "./development-container";
import { DockerNetworkEgressPort } from "./development-egress";

const IMAGE = `ghcr.io/tulipfarm/skill-runtime@sha256:${"a".repeat(64)}`;

function recordingRunner(overrides: Record<string, string> = {}): {
  runner: DevelopmentContainerCommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: DevelopmentContainerCommandRunner = async (input) => {
    calls.push([...input.args]);
    const key = input.args.slice(0, 2).join(" ");
    const stdout = overrides[key] ?? "";
    return {
      exitCode: 0,
      timedOut: false,
      stdout: new TextEncoder().encode(stdout),
      stderr: new Uint8Array(),
    };
  };
  return { runner, calls };
}

describe("DockerNetworkEgressPort", () => {
  it("refuses to prepare egress with no destination", async () => {
    const { runner, calls } = recordingRunner();
    const port = new DockerNetworkEgressPort({ image: IMAGE, run: runner });
    await expect(port.prepare([])).rejects.toThrow("egress_no_destinations");
    expect(calls).toHaveLength(0);
  });

  it("isolates the workload on an internal network reachable only through the proxy", async () => {
    const { runner, calls } = recordingRunner();
    const port = new DockerNetworkEgressPort({ image: IMAGE, run: runner });

    const egress = await port.prepare(["example.com"]);

    const create = calls.find((args) => args[0] === "network" && args[1] === "create");
    expect(create).toContain("--internal");
    expect(create).toContain(egress.networkName);
    expect(egress.httpsProxy).toBe("http://tulip-egress-proxy:8888");

    const connect = calls.find((args) => args[0] === "network" && args[1] === "connect");
    expect(connect).toContain("--alias=tulip-egress-proxy");
    expect(connect).toContain(egress.networkName);
  });

  it("passes only the declared destinations to the proxy, and locks it down", async () => {
    const { runner, calls } = recordingRunner();
    const port = new DockerNetworkEgressPort({ image: IMAGE, run: runner });

    await port.prepare(["example.com", "api.github.com"]);

    const run = calls.find((args) => args[0] === "run");
    expect(run).toBeDefined();
    const allowed = run?.find((arg) => arg.startsWith("--env=TULIP_ALLOWED_HOSTS="));
    expect(allowed).toBe("--env=TULIP_ALLOWED_HOSTS=example.com,api.github.com");
    // The proxy is the only route out, so a compromise of it must not become a host compromise.
    expect(run).toContain("--read-only");
    expect(run).toContain("--cap-drop=ALL");
    expect(run).toContain("--security-opt=no-new-privileges");
    // It needs the default bridge for its own upstream calls; the workload never joins it.
    expect(run).toContain("--network=bridge");
  });

  it("reuses one proxy per destination set regardless of order or case", async () => {
    const { runner, calls } = recordingRunner();
    const port = new DockerNetworkEgressPort({ image: IMAGE, run: runner });

    const first = await port.prepare(["example.com", "api.github.com"]);
    const runsAfterFirst = calls.filter((args) => args[0] === "run").length;
    const second = await port.prepare(["API.github.com", "example.com"]);

    expect(second.networkName).toBe(first.networkName);
    expect(calls.filter((args) => args[0] === "run")).toHaveLength(runsAfterFirst);
  });

  it("gives different destination sets different networks", async () => {
    const { runner } = recordingRunner();
    const port = new DockerNetworkEgressPort({ image: IMAGE, run: runner });

    const a = await port.prepare(["example.com"]);
    const b = await port.prepare(["example.org"]);

    expect(a.networkName).not.toBe(b.networkName);
  });

  it("reuses an already-running proxy without recreating it", async () => {
    const { runner, calls } = recordingRunner({ "inspect --format": "true" });
    const port = new DockerNetworkEgressPort({ image: IMAGE, run: runner });

    await port.prepare(["example.com"]);

    expect(calls.filter((args) => args[0] === "run")).toHaveLength(0);
    expect(calls.filter((args) => args[0] === "network")).toHaveLength(0);
  });

  it("removes both the proxy and its network on close", async () => {
    const { runner, calls } = recordingRunner();
    const port = new DockerNetworkEgressPort({ image: IMAGE, run: runner });
    const egress = await port.prepare(["example.com"]);

    await port.close();

    expect(calls).toContainEqual(["network", "rm", egress.networkName]);
    expect(calls.some((args) => args[0] === "rm" && args[1] === "--force")).toBe(true);
  });

  it("does not cache a failed preparation", async () => {
    let attempts = 0;
    const runner: DevelopmentContainerCommandRunner = async (input) => {
      if (input.args[0] === "run") {
        attempts++;
        return {
          exitCode: 1,
          timedOut: false,
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode("boom"),
        };
      }
      return {
        exitCode: 0,
        timedOut: false,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      };
    };
    const port = new DockerNetworkEgressPort({ image: IMAGE, run: runner });

    await expect(port.prepare(["example.com"])).rejects.toThrow("egress_proxy_failed");
    await expect(port.prepare(["example.com"])).rejects.toThrow("egress_proxy_failed");
    expect(attempts).toBe(2);
  });
});
