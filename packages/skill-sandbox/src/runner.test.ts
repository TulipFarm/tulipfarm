import type { ArtifactService } from "@tulipfarm/run-kernel";
import type { SkillDefinition, ToolContractDefinition } from "@tulipfarm/schema";
import type { BundleAsset, BundleDefinition, RuntimeBundle } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import { SkillCommandRunError, SkillCommandRunner } from "./runner";

const DIGEST = `sha256:${"a".repeat(64)}`;

const skill = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Skill",
  metadata: {
    id: "skill-1",
    slug: "reporting",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "published",
  },
  spec: {
    instructions: { path: "SKILL.md" },
    trustTier: "first_party",
    scripts: ["scripts/report.ts"],
    commands: [
      {
        name: "generate",
        toolRef: "report-generate",
        runtimeProfile: "shell-ts-python-v1",
        entrypoint: "scripts/report.ts",
        requiredCommands: ["tsx"],
      },
    ],
  },
} as SkillDefinition;

const tool = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "ToolContract",
  metadata: {
    id: "tool-1",
    slug: "report-generate",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "published",
  },
  spec: {
    toolId: "report.generate",
    toolVersion: "1.0.0",
    action: "report.generate",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    riskClass: "low",
    mutating: false,
    idempotency: { strategy: "none" },
    dryRun: false,
    adapter: { kind: "sandbox", ref: "skill:reporting/generate" },
  },
} as ToolContractDefinition;

function runtimeBundle(): RuntimeBundle {
  const definitions = [
    {
      kind: "Skill",
      id: skill.metadata.id,
      slug: skill.metadata.slug,
      authoredVersion: 1,
      hash: "b".repeat(64),
      document: skill,
      references: [],
    },
    {
      kind: "ToolContract",
      id: tool.metadata.id,
      slug: tool.metadata.slug,
      authoredVersion: 1,
      hash: "c".repeat(64),
      document: tool,
      references: [],
    },
  ] as unknown as readonly BundleDefinition[];
  const assets: readonly BundleAsset[] = [
    {
      ownerDefinitionId: skill.metadata.id,
      path: "scripts/report.ts",
      digest: "d".repeat(64),
      content: "await Bun.write('/tulip/output/result.json', '{}');",
    },
  ];
  return {
    digest: "e".repeat(64),
    businessId: "business-1",
    changesetId: "changeset-1",
    commitSha: "f".repeat(40),
    definitions,
    assets,
    get: (kind, slug) => definitions.find((item) => item.kind === kind && item.slug === slug),
    getById: (id) => definitions.find((item) => item.id === id),
    asset: (owner, path) =>
      assets.find((item) => item.ownerDefinitionId === owner && item.path === path),
  };
}

const IMAGE = `ghcr.io/tulipfarm/runtime@${DIGEST}`;

function runner(options?: {
  readonly image?: string;
  readonly bundle?: RuntimeBundle | undefined;
}): SkillCommandRunner {
  const bundle = options && "bundle" in options ? options.bundle : runtimeBundle();
  return new SkillCommandRunner({
    artifacts: {} as ArtifactService,
    bundle: async () => bundle,
    ...(options?.image === undefined ? { runtimeImage: IMAGE } : { runtimeImage: options.image }),
  });
}

function run(target: { skill: string; command: string; destination?: string }) {
  return runner().run({
    businessId: "business-1",
    runId: "run-1",
    stateKey: "state-1",
    ...target,
  });
}

describe("SkillCommandRunner", () => {
  it("lists every command a Chat Agent may run, so the model names one rather than guessing", async () => {
    expect(await runner().list()).toEqual([
      {
        skill: "reporting",
        command: "generate",
        runtimeProfile: "shell-ts-python-v1",
        entrypoint: "scripts/report.ts",
        allowedDestinations: [],
      },
    ]);
  });

  it("reports no commands when nothing is published yet", async () => {
    expect(await runner({ bundle: undefined }).list()).toEqual([]);
  });

  it("refuses a Skill the bundle does not declare, naming the ones it does", async () => {
    await expect(run({ skill: "absent", command: "generate" })).rejects.toMatchObject({
      code: "skill_not_found",
      available: ["reporting"],
    });
  });

  it("refuses a command the Skill does not declare, naming the ones it does", async () => {
    await expect(run({ skill: "reporting", command: "absent" })).rejects.toMatchObject({
      code: "command_not_found",
      available: ["generate"],
    });
  });

  it("refuses a destination the command's ToolContract does not allow", async () => {
    await expect(
      run({ skill: "reporting", command: "generate", destination: "example.com" })
    ).rejects.toBeInstanceOf(SkillCommandRunError);
    await expect(
      run({ skill: "reporting", command: "generate", destination: "example.com" })
    ).rejects.toMatchObject({ code: "destination_denied" });
  });

  it("refuses to execute at all when no runtime image is configured", async () => {
    const bare = new SkillCommandRunner({
      artifacts: {} as ArtifactService,
      bundle: async () => runtimeBundle(),
    });
    await expect(
      bare.run({
        businessId: "business-1",
        runId: "run-1",
        stateKey: "state-1",
        skill: "reporting",
        command: "generate",
      })
    ).rejects.toMatchObject({ code: "sandbox_unavailable" });
    expect(await bare.list()).toEqual([]);
  });
});
