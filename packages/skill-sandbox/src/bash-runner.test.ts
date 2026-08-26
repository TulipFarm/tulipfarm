import type { ArtifactService } from "@tulipfarm/run-kernel";
import type { BundleAsset, BundleDefinition, RuntimeBundle } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import { type SkillBashRunError, SkillBashRunner } from "./bash-runner";

const IMAGE = `ghcr.io/tulipfarm/runtime@sha256:${"a".repeat(64)}`;

function runtimeBundle(): RuntimeBundle {
  const definitions = [] as unknown as readonly BundleDefinition[];
  const assets: readonly BundleAsset[] = [];
  return {
    digest: "e".repeat(64),
    businessId: "business-1",
    changesetId: "changeset-1",
    commitSha: "f".repeat(40),
    definitions,
    assets,
    get: () => undefined,
    getById: () => undefined,
    asset: () => undefined,
  };
}

function run(request: {
  command: string;
  allowedCommands: readonly string[];
  allowedDestinations?: readonly string[];
  destination?: string;
  bundle?: RuntimeBundle | undefined;
}) {
  const runner = new SkillBashRunner({
    artifacts: {} as ArtifactService,
    bundle: async () => ("bundle" in request ? request.bundle : runtimeBundle()),
    runtimeImage: IMAGE,
  });
  return runner.run({
    businessId: "business-1",
    runId: "run-1",
    stateKey: "state-1",
    skill: "probe",
    command: request.command,
    allowedCommands: request.allowedCommands,
    ...(request.allowedDestinations === undefined
      ? {}
      : { allowedDestinations: request.allowedDestinations }),
    ...(request.destination === undefined ? {} : { destination: request.destination }),
  });
}

async function refusal(promise: Promise<unknown>): Promise<SkillBashRunError> {
  try {
    await promise;
  } catch (error) {
    return error as SkillBashRunError;
  }
  throw new Error("expected a refusal");
}

describe("SkillBashRunner", () => {
  it("refuses a command the Skill never declared", async () => {
    const error = await refusal(
      run({ command: "cat /etc/passwd", allowedCommands: ["node -e:*"] })
    );

    expect(error.code).toBe("command_refused");
    expect(error.reason).toBe("not_allowed");
    expect(error.available).toEqual(["node -e:*"]);
  });

  it("refuses everything when the Skill declares no allowedCommands", async () => {
    const error = await refusal(run({ command: "echo hi", allowedCommands: [] }));

    expect(error.code).toBe("command_refused");
    expect(error.reason).toBe("no_allowlist");
  });

  it("refuses a second command chained onto an allowed one", async () => {
    const error = await refusal(
      run({ command: "node -e 'x' ; cat /etc/passwd", allowedCommands: ["node -e:*"] })
    );

    expect(error.code).toBe("command_refused");
    expect(error.reason).toBe("command_chaining");
  });

  it("refuses a destination the Skill does not already declare", async () => {
    const error = await refusal(
      run({
        command: "curl https://example.com",
        allowedCommands: ["curl:*"],
        allowedDestinations: ["probe-http"],
        destination: "somewhere-else",
      })
    );

    expect(error.code).toBe("destination_denied");
    expect(error.available).toEqual(["probe-http"]);
  });

  it("refuses a destination when the Skill declares none at all", async () => {
    const error = await refusal(
      run({
        command: "curl https://example.com",
        allowedCommands: ["curl:*"],
        destination: "probe-http",
      })
    );

    expect(error.code).toBe("destination_denied");
  });

  it("checks the allowlist before it needs a bundle, so a refusal never depends on deploy state", async () => {
    const error = await refusal(
      run({ command: "cat /etc/passwd", allowedCommands: ["node -e:*"], bundle: undefined })
    );

    expect(error.code).toBe("command_refused");
  });

  it("reports the sandbox as unavailable once an allowed command has nothing to run against", async () => {
    const error = await refusal(
      run({ command: "node -e '1'", allowedCommands: ["node -e:*"], bundle: undefined })
    );

    expect(error.code).toBe("sandbox_unavailable");
  });
});
