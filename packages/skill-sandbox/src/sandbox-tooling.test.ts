import type { ArtifactService } from "@tulipfarm/run-kernel";
import type { SkillDefinition, ToolContractDefinition } from "@tulipfarm/schema";
import type { BundleAsset, BundleDefinition, RuntimeBundle } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import { buildBundleSandboxAdapters, type SandboxToolingRequest } from "./sandbox-tooling";

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

function request(): SandboxToolingRequest {
  return {
    businessId: "business-1",
    runId: "run-1",
    stateKey: "state-1",
    bundle: runtimeBundle(),
  };
}

describe("buildBundleSandboxAdapters", () => {
  it("registers named Tools only from the Run's signed Skill commands", () => {
    const adapters = buildBundleSandboxAdapters(request(), {
      artifacts: {} as ArtifactService,
      runtimeImage: `ghcr.io/tulipfarm/runtime@${DIGEST}`,
    });

    expect([...adapters.keys()]).toEqual(["skill:reporting/generate"]);
  });

  it("fails closed when the development runtime image is absent or mutable", () => {
    expect(buildBundleSandboxAdapters(request(), { artifacts: {} as ArtifactService }).size).toBe(
      0
    );
    expect(
      buildBundleSandboxAdapters(request(), {
        artifacts: {} as ArtifactService,
        runtimeImage: "ghcr.io/tulipfarm/runtime:latest",
      }).size
    ).toBe(0);
  });
});
