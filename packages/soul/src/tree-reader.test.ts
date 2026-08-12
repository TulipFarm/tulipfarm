import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ARTIFACT_LAYOUTS,
  definitionPath,
  isLiveKind,
  type VersionedSchemaDocument,
} from "@tulipfarm/schema";
import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { GitSoulTreeReader, isBundledDefinitionPath } from "./tree-reader";

const TMP = join(import.meta.dirname, "__tree_reader_tmp__");

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
  const git = simpleGit(TMP);
  await git.init();
  await git.addConfig("user.email", "test@tulipfarm.dev");
  await git.addConfig("user.name", "TulipFarm Test");
});

afterEach(() => rm(TMP, { recursive: true, force: true }));

async function writeFixture(path: string, content: string): Promise<void> {
  const fullPath = join(TMP, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

function documentSubject(document: VersionedSchemaDocument): string {
  const metadata = document.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new Error("expected document metadata");
  }
  const slug = (metadata as Record<string, unknown>).slug;
  if (typeof slug !== "string") throw new Error("expected document metadata slug");
  return `${document.kind}:${slug}`;
}

describe("GitSoulTreeReader", () => {
  // API wiring constructs the reader before GitSyncService.bootSync() has created the Soul working
  // copy, so a fresh deployment has no directory yet. simple-git throws from its own constructor
  // in that case, which made this an unconditional boot crash rather than a latent ordering bug.
  it("constructs against a soul path that does not exist yet", () => {
    const missing = join(TMP, "not-created-until-boot-sync");

    expect(() => new GitSoulTreeReader(missing)).not.toThrow();
  });

  it("keeps definition path admission aligned with the artifact registry", () => {
    const excludedKinds: string[] = [];
    for (const layout of ARTIFACT_LAYOUTS) {
      const path = definitionPath(layout.kind, layout.scope === "collection" ? "demo" : undefined);
      const expected = !layout.definitionModes.includes("managed");
      if (!expected) excludedKinds.push(layout.kind);

      expect(isBundledDefinitionPath(path), `${layout.kind} at ${path}`).toBe(expected);
    }
    expect(excludedKinds.sort()).toEqual(["IntegrationsLock", "SkillsLock"]);
    expect(isBundledDefinitionPath(definitionPath("SkillsLock"))).toBe(false);
    expect(isBundledDefinitionPath(definitionPath("IntegrationsLock"))).toBe(false);
  });

  it("reads registry-layout authored definitions from git", async () => {
    const accessGrantPath = definitionPath("AccessGrant", "github-support");
    const rolePath = definitionPath("Role", "ops-reviewer");
    const routinePath = definitionPath("Routine", "daily-briefing");
    const triggerPath = definitionPath("Trigger", "daily-briefing-manual");
    await writeFixture(
      accessGrantPath,
      stringifyYaml({
        apiVersion: "tulipfarm.ai/v1",
        kind: "AccessGrant",
        metadata: {
          id: "33333333-3333-3333-3333-333333333333",
          slug: "github-support",
          schemaVersion: 1,
          authoredVersion: 1,
          lifecycle: "published",
        },
        spec: {
          integrationId: "44444444-4444-4444-4444-444444444444",
          principals: [{ kind: "user", id: "55555555-5555-5555-5555-555555555555" }],
          actions: ["github.read"],
          externalTargets: [{ type: "github.repository", ids: ["maddhruv/tulipfarm"] }],
          delegable: false,
        },
      })
    );
    await writeFixture(
      rolePath,
      stringifyYaml({
        apiVersion: "tulipfarm.ai/v1",
        kind: "Role",
        metadata: {
          id: "66666666-6666-6666-6666-666666666666",
          slug: "ops-reviewer",
          schemaVersion: 1,
          authoredVersion: 1,
          lifecycle: "published",
        },
        spec: {
          principalTypes: ["user"],
          grants: [],
        },
      })
    );
    await writeFixture(
      routinePath,
      stringifyYaml({
        apiVersion: "tulipfarm.ai/v1",
        kind: "Routine",
        metadata: {
          id: "11111111-1111-1111-1111-111111111111",
          slug: "daily-briefing",
          schemaVersion: 1,
          authoredVersion: 1,
          lifecycle: "published",
        },
        spec: {
          owner: "ops",
          start: "waitForTimer",
          states: [
            {
              name: "waitForTimer",
              type: "wait",
              waitFor: { kind: "timer", durationMs: 1 },
              end: true,
            },
          ],
        },
      })
    );
    await writeFixture(
      triggerPath,
      stringifyYaml({
        apiVersion: "tulipfarm.ai/v1",
        kind: "Trigger",
        metadata: {
          id: "22222222-2222-2222-2222-222222222222",
          slug: "daily-briefing-manual",
          schemaVersion: 1,
          authoredVersion: 1,
          lifecycle: "published",
        },
        spec: {
          type: "manual",
          routineRef: { name: "daily-briefing", version: "latest" },
          eventType: "routine.manual",
          eventVersion: 1,
          backgroundIdentity: {
            principalKind: "agent",
            principalId: "11111111-1111-1111-1111-111111111111",
          },
          deduplication: { key: "manual" },
        },
      })
    );
    const git = simpleGit(TMP);
    await git.add("-A");
    await git.commit("test fixture");
    const sha = await git.revparse(["HEAD"]);

    const documents = await new GitSoulTreeReader(TMP).readDefinitions(sha.trim());

    expect(documents.map(documentSubject)).toEqual([
      "AccessGrant:github-support",
      "Role:ops-reviewer",
      "Routine:daily-briefing",
      "Trigger:daily-briefing-manual",
    ]);
  });

  it("bundles live authority definitions but marks them for live resolution", () => {
    expect(isBundledDefinitionPath(definitionPath("Role", "ops-reviewer"))).toBe(true);
    expect(isBundledDefinitionPath(definitionPath("AccessGrant", "github-support"))).toBe(true);
    expect(isLiveKind("Role")).toBe(true);
    expect(isLiveKind("AccessGrant")).toBe(true);
  });

  it("fails closed when a bundled definition path does not parse", async () => {
    const triggerPath = definitionPath("Trigger", "daily-briefing-manual");
    await writeFixture(
      triggerPath,
      stringifyYaml({
        apiVersion: "tulipfarm.ai/v1",
        kind: "Trigger",
        metadata: {
          id: "22222222-2222-2222-2222-222222222222",
          slug: "daily-briefing-manual",
          schemaVersion: 1,
          authoredVersion: 1,
          lifecycle: "published",
        },
      })
    );
    const git = simpleGit(TMP);
    await git.add("-A");
    await git.commit("test fixture");
    const sha = await git.revparse(["HEAD"]);

    await expect(new GitSoulTreeReader(TMP).readDefinitions(sha.trim())).rejects.toThrow(
      "SOUL_DEFINITION_INVALID: SCHEMA_VALIDATION_FAILED in triggers/daily-briefing-manual/trigger.yaml"
    );
  });

  it("admits valid delegated pinned artifacts without requiring schema definitions", async () => {
    await writeFixture(
      "guardrails.yaml",
      stringifyYaml({
        input: [{ guard: "prompt_injection", sensitivity: "medium" }],
        output: [{ guard: "content_filter", patterns: ["ssn"] }],
      })
    );
    await writeFixture(
      "surface-components/summary-card/component.yaml",
      stringifyYaml({ name: "summary-card", component: "card" })
    );
    await writeFixture(
      "surface-components/summary-card/views/default.yaml",
      stringifyYaml({ body: "Ready" })
    );
    const git = simpleGit(TMP);
    await git.add("-A");
    await git.commit("test fixture");
    const sha = await git.revparse(["HEAD"]);

    const documents = await new GitSoulTreeReader(TMP).readDefinitions(sha.trim());
    const files = await new GitSoulTreeReader(TMP).readFiles(sha.trim());

    expect(documents).toEqual([]);
    expect(files.map((file) => file.path)).toEqual([
      "guardrails.yaml",
      "surface-components/summary-card/component.yaml",
      "surface-components/summary-card/views/default.yaml",
    ]);
  });

  it("reads registry-declared companion files for all bundled definition kinds", async () => {
    await writeFixture("agents/ada/instructions.md", "Help the operator.\n");
    await writeFixture("resources/customer/hooks.ts", "export const hooks = {};\n");
    await writeFixture("skills/triage/SKILL.md", "Classify support issues.\n");
    const git = simpleGit(TMP);
    await git.add("-A");
    await git.commit("test fixture");
    const sha = await git.revparse(["HEAD"]);

    const files = await new GitSoulTreeReader(TMP).readFiles(sha.trim());

    expect(files.map((file) => file.path)).toEqual([
      "agents/ada/instructions.md",
      "resources/customer/hooks.ts",
      "skills/triage/SKILL.md",
    ]);
  });

  it("derives published ModelProfiles from soul.yaml and ignores the retired models directory", async () => {
    await writeFile(
      join(TMP, "soul.yaml"),
      stringifyYaml({
        llm: {
          tiers: {
            quick: { providers: [{ provider: "openai", model: "gpt-fast" }] },
            standard: { providers: [{ provider: "openai", model: "gpt-balanced" }] },
            complex: { providers: [{ provider: "openai", model: "gpt-thorough" }] },
          },
          presets: {
            default: "balanced",
            fast: "fast",
            balanced: "balanced",
            thorough: "thorough",
          },
        },
      }),
      "utf8"
    );
    await mkdir(join(TMP, "models"));
    await writeFile(join(TMP, "models", "stale.yaml"), "not: a definition\n", "utf8");
    const git = simpleGit(TMP);
    await git.add("-A");
    await git.commit("test fixture");
    const sha = await git.revparse(["HEAD"]);

    const documents = await new GitSoulTreeReader(TMP).readDefinitions(sha.trim());

    expect(documents.filter((document) => document.kind === "ModelProfile")).toHaveLength(3);
    expect(
      documents.map((document) => (document.metadata as Record<string, unknown>)?.slug)
    ).toEqual(["fast", "balanced", "thorough"]);
    expect(JSON.stringify(documents)).not.toContain("stale");
  });
});
