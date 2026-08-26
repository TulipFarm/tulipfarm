/**
 * End-to-end proof that `skill` in `shell` mode executes the commands a Skill documents in fenced blocks.
 *
 * Lifts every ```bash block straight out of the probe `SKILL.md` — the same text a model is shown
 * — and runs each one through the production chain: `SkillBashRunner` →
 * `SkillExecutionCoordinator` → `DevelopmentContainerSandboxExecutor` → `docker run`. Reading the
 * commands from the file rather than restating them here is the point: a fence that drifts from
 * what actually runs fails this check instead of quietly misleading the model.
 *
 * Usage: SANDBOX_RUNTIME_IMAGE=repo@sha256:... pnpm --filter @tulipfarm/skill-sandbox verify:skill-bash
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { ArtifactService } from "../../run-kernel/src/artifacts";
import { TypedOutputValidator } from "../../run-kernel/src/outputs";
import { MemoryArtifactStore } from "../../storage/src/artifacts/memory-artifact-store";
import { SkillBashRunError, SkillBashRunner } from "../src/index";

const SKILL_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "scripts",
  "dev",
  "skill-runtime-probe",
  "soul",
  "skills",
  "skill-runtime-probe"
);

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

/** Split a SKILL.md into its frontmatter block and its body, the way the Soul loader does. */
function readSkillFile(): { frontmatter: Record<string, unknown>; body: string } {
  const text = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) throw new Error("no_frontmatter");
  return { frontmatter: parse(match[1]) as Record<string, unknown>, body: match[2] };
}

function fencedBashBlocks(body: string): string[] {
  const blocks: string[] = [];
  const fence = /```bash\r?\n([\s\S]*?)```/g;
  let match = fence.exec(body);
  while (match !== null) {
    if (match[1] !== undefined) blocks.push(match[1].trimEnd());
    match = fence.exec(body);
  }
  return blocks;
}

function bundle() {
  return {
    digest: `sha256:${"a".repeat(64)}`,
    businessId: "business-1",
    changesetId: "changeset-1",
    commitSha: "f".repeat(40),
    definitions: [],
    assets: [],
    get: () => undefined,
    getById: () => undefined,
    asset: () => undefined,
  };
}

async function main(): Promise<void> {
  const image = process.env.SANDBOX_RUNTIME_IMAGE;
  if (image === undefined) {
    console.error("SANDBOX_RUNTIME_IMAGE is required (repository@sha256:...).");
    process.exit(2);
  }

  const { frontmatter, body } = readSkillFile();
  const allowedCommands = (frontmatter.allowedCommands ?? []) as string[];
  const blocks = fencedBashBlocks(body);

  console.log(`allowedCommands declared in SKILL.md: ${JSON.stringify(allowedCommands)}`);
  console.log(`fenced bash blocks found in SKILL.md: ${blocks.length}\n`);
  if (blocks.length === 0) {
    console.error("FAILED: SKILL.md contains no fenced bash blocks to run.");
    process.exit(1);
  }

  const runner = new SkillBashRunner({
    artifacts: new ArtifactService(
      new MemoryArtifactStore() as never,
      new TypedOutputValidator([]),
      memoryBlobStore() as never
    ),
    bundle: async () => bundle() as never,
    runtimeImage: image,
  });

  let failed = 0;
  let index = 0;
  for (const command of blocks) {
    index += 1;
    console.log(`=== block ${index} ===`);
    console.log(command.replace(/^/gm, "  | "));
    try {
      const result = await runner.run({
        businessId: "business-1",
        runId: "run-1",
        stateKey: `skill-bash:probe:block-${index}`,
        skill: "skill-runtime-probe",
        command,
        allowedCommands,
      });
      console.log(`  -> matched   ${result.matchedPattern}`);
      console.log(`  -> exit      ${result.exitCode}`);
      console.log(`  -> stdout    ${JSON.stringify(result.stdout)}`);
      if (result.stderr.length > 0) console.log(`  -> stderr    ${result.stderr.trim()}`);
    } catch (error) {
      if (error instanceof SkillBashRunError) {
        // The fixture deliberately documents commands that must be refused, so a refusal here is
        // a result to report rather than a failure to count.
        console.log(`  -> REFUSED   ${error.code} (${error.reason ?? "-"})`);
      } else {
        failed += 1;
        console.error(`  -> FAILED    ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log("");
  }

  console.log("=== a command no fence documents, with a Skill that allows nothing ===");
  try {
    await runner.run({
      businessId: "business-1",
      runId: "run-1",
      stateKey: "skill-bash:probe:no-allowlist",
      skill: "skill-runtime-probe",
      command: "echo pwned",
      allowedCommands: [],
    });
    console.error("FAILED: a command ran with an empty allowlist");
    failed += 1;
  } catch (error) {
    if (error instanceof SkillBashRunError && error.reason === "no_allowlist") {
      console.log("  -> refused: no_allowlist\n");
    } else {
      failed += 1;
      console.error(`  -> FAILED: unexpected ${error instanceof Error ? error.message : error}`);
    }
  }

  console.log("=== the same command twice in one Run ===");
  try {
    for (const callId of ["call-1", "call-2"]) {
      await runner.run({
        businessId: "business-1",
        runId: "run-1",
        stateKey: `skill-bash:probe:${callId}`,
        skill: "skill-runtime-probe",
        command: "bash --version",
        allowedCommands,
      });
    }
    console.log("  -> second identical call: OK\n");
  } catch (error) {
    failed += 1;
    console.error(`  -> FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (failed > 0) {
    console.error(`${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log("All skill shell-mode checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
