/**
 * End-to-end proof that a Chat Agent's `skill` Tool in `run` mode really executes a Skill's code.
 *
 * Drives the exact production chain — `SkillCommandRunner` → `SandboxToolAdapter` →
 * `SkillExecutionCoordinator` → `DevelopmentContainerSandboxExecutor` → `docker run` — over a
 * `RuntimeBundle` built from the probe fixture. Artifact storage is in-memory so the check needs
 * no Postgres; everything past it is the real code path.
 *
 * Usage: SANDBOX_RUNTIME_IMAGE=repo@sha256:... pnpm --filter @tulipfarm/skill-sandbox verify:skill-command-run
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { ArtifactService } from "../../run-kernel/src/artifacts";
import { TypedOutputValidator } from "../../run-kernel/src/outputs";
import { MemoryArtifactStore } from "../../storage/src/artifacts/memory-artifact-store";
import { SkillCommandRunner } from "../src/index";

const FIXTURE = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "scripts",
  "dev",
  "skill-runtime-probe",
  "soul"
);
const SKILL_DIR = join(FIXTURE, "skills", "skill-runtime-probe");

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

function memoryBlobStore() {
  const bytes = new Map<string, Uint8Array>();
  return {
    async put(body: Uint8Array) {
      const hash = createHash("sha256").update(body).digest("hex");
      bytes.set(hash, body);
      return { key: hash, hash };
    },
    async get(ref: { key: string }) {
      const found = bytes.get(ref.key);
      if (!found) throw new Error(`blob_missing:${ref.key}`);
      return oneChunk(found);
    },
    async head(ref: { key: string }) {
      const found = bytes.get(ref.key);
      return found === undefined ? null : { size: found.byteLength };
    },
    async delete(ref: { key: string }) {
      bytes.delete(ref.key);
    },
  };
}

function loadBundle() {
  const skill = parse(readFileSync(join(SKILL_DIR, "skill.yaml"), "utf8"));
  const toolsDir = join(FIXTURE, "tools");
  const tools = readdirSync(toolsDir).map((slug) =>
    parse(readFileSync(join(toolsDir, slug, "tool.yaml"), "utf8"))
  );

  const definitions = [
    {
      kind: "Skill",
      id: skill.metadata.id,
      slug: skill.metadata.slug,
      authoredVersion: skill.metadata.authoredVersion,
      hash: sha256(skill.metadata.id),
      document: skill,
      references: [],
    },
    ...tools.map((tool) => ({
      kind: "ToolContract",
      id: tool.metadata.id,
      slug: tool.metadata.slug,
      authoredVersion: tool.metadata.authoredVersion,
      hash: sha256(tool.metadata.id),
      document: tool,
      references: [],
    })),
  ];

  const assets = (skill.spec.scripts as string[]).map((path) => {
    const content = readFileSync(join(SKILL_DIR, path), "utf8");
    return {
      ownerDefinitionId: skill.metadata.id,
      path,
      digest: sha256(content),
      content,
    };
  });

  return {
    digest: `sha256:${"a".repeat(64)}`,
    businessId: "business-1",
    changesetId: "changeset-1",
    commitSha: "f".repeat(40),
    definitions,
    assets,
    get: (kind: string, slug: string) =>
      definitions.find((item) => item.kind === kind && item.slug === slug),
    getById: (id: string) => definitions.find((item) => item.id === id),
    asset: (owner: string, path: string) =>
      assets.find((item) => item.ownerDefinitionId === owner && item.path === path),
  };
}

async function main(): Promise<void> {
  const image = process.env.SANDBOX_RUNTIME_IMAGE;
  if (image === undefined) {
    console.error("SANDBOX_RUNTIME_IMAGE is required (repository@sha256:...).");
    process.exit(2);
  }

  const bundle = loadBundle();
  const artifacts = new ArtifactService(
    new MemoryArtifactStore() as never,
    new TypedOutputValidator([]),
    memoryBlobStore() as never
  );
  const runner = new SkillCommandRunner({
    artifacts,
    bundle: async () => bundle as never,
    runtimeImage: image,
  });

  console.log("commands the model can see:");
  for (const command of await runner.list()) {
    console.log(`  ${command.skill}/${command.command}  <- ${command.entrypoint}`);
  }

  const cases: { command: string; destination?: string }[] = [
    { command: "probe_shell" },
    { command: "probe_python" },
    { command: "probe_typescript" },
    { command: "probe_inline" },
    { command: "probe_network", destination: "example.com" },
  ];

  let failed = 0;
  for (const testCase of cases) {
    process.stdout.write(`\n=== ${testCase.command} ===\n`);
    try {
      const result = await runner.run({
        businessId: "business-1",
        runId: "run-1",
        stateKey: `state-${testCase.command}`,
        skill: "skill-runtime-probe",
        command: testCase.command,
        arguments: { value: 7 },
        ...(testCase.destination === undefined ? {} : { destination: testCase.destination }),
      });

      console.log(JSON.stringify(result.output, null, 2));
    } catch (error) {
      failed += 1;
      console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log("\n=== running the SAME command twice in one Run ===");
  try {
    // Mirrors skillCommandRunTool, which appends the per-call id to the stateKey so two
    // occurrences of one command never share an input Artifact identity.
    for (const callId of ["call-1", "call-2"]) {
      await runner.run({
        businessId: "business-1",
        runId: "run-1",
        stateKey: `skill-command:skill-runtime-probe:probe_shell:${callId}`,
        skill: "skill-runtime-probe",
        command: "probe_shell",
        arguments: { value: 7 },
      });
    }
    console.log("second identical call: OK");
  } catch (error) {
    console.log(`second identical call FAILED: ${error instanceof Error ? error.message : error}`);
    failed += 1;
  }

  process.stdout.write("\n=== refusing an undeclared destination ===\n");
  try {
    await runner.run({
      businessId: "business-1",
      runId: "run-1",
      stateKey: "state-denied",
      skill: "skill-runtime-probe",
      command: "probe_typescript",
      destination: "example.org",
    });
    console.error("FAILED: an undeclared destination was accepted");
    failed += 1;
  } catch (error) {
    console.log(`refused as expected: ${error instanceof Error ? error.message : String(error)}`);
  }

  process.exit(failed === 0 ? 0 : 1);
}

await main();
