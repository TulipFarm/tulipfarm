/**
 * Compiles the installed development Soul exactly as publication does, then reports the runnable
 * Skill commands the `skill` Tool would see. Catches a Skill whose commands never reach the
 * bundle — the failure mode that surfaces in chat as "No Skill declares runnable commands".
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { createRuntimeBundle } from "../../../packages/soul/src/bundle";
import { compileExecutionBundle } from "../../../packages/soul/src/compiler";
import { resolveRuntimeSkillCommands } from "../../../packages/soul/src/skill-commands";
import { GitSoulTreeReader } from "../../../packages/soul/src/tree-reader";

const soulPath = process.env.SOUL_PATH ?? `${homedir()}/.tulipfarm/soul`;
const commitSha = execFileSync("git", ["-C", soulPath, "rev-parse", process.argv[2] ?? "HEAD"], {
  encoding: "utf8",
}).trim();

const reader = new GitSoulTreeReader(soulPath);
const documents = await reader.readDefinitions(commitSha);
const files = await reader.readFiles?.(commitSha);

const bundle = compileExecutionBundle({
  businessId: "00000000-0000-4000-8000-000000000000",
  changesetId: "00000000-0000-4000-8000-000000000001",
  commitSha,
  documents,
  ...(files === undefined ? {} : { files }),
});

const commands = resolveRuntimeSkillCommands(createRuntimeBundle(bundle, "sha256:local-check"));
console.log(`soul   ${soulPath} @ ${commitSha.slice(0, 8)}`);
console.log(`skills ${documents.filter((doc) => doc.kind === "Skill").length}`);
console.log(`runnable commands ${commands.length}`);
for (const command of commands) {
  console.log(`  ${command.skillSlug}/${command.command.name} -> ${command.entrypoint.path}`);
}
if (commands.length === 0) {
  console.error("no runnable commands: `skill` in run mode will report skill_not_found");
  process.exit(1);
}
