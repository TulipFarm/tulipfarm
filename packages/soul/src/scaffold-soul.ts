import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BOT_GIT_EMAIL, BOT_GIT_NAME } from "@tulipfarm/constants";
import simpleGit from "simple-git";
import { hermeticGitEnv } from "./git-env";

const SCAFFOLD_DIRS = ["resources", "routines", "agents", "skills", "integrations"];

/**
 * Populate a fresh, commit-less soul checkout with the same stub layout
 * `scripts/setup-dev.sh` creates for local dev, then makes the first local commit. Callers use
 * this for a per-business checkout that starts life empty (no `setup-dev.sh` involved) — e.g. a
 * newly connected/created GitHub repo — so it has something to push and initialize `origin/main`
 * with. No `llm:` key in `soul.yaml`: an empty/comment-only one fails LLM-config validation
 * (requires `tiers`), so LLM features stay disabled until the setup wizard writes one.
 */
export async function scaffoldSoul(soulPath: string): Promise<void> {
  for (const dir of SCAFFOLD_DIRS) {
    mkdirSync(join(soulPath, dir), { recursive: true });
  }

  const soulYamlPath = join(soulPath, "soul.yaml");
  if (!existsSync(soulYamlPath)) {
    writeFileSync(soulYamlPath, "# TulipFarm Soul Configuration\n");
  }

  const skillsLockPath = join(soulPath, "skills-lock.json");
  if (!existsSync(skillsLockPath)) {
    writeFileSync(skillsLockPath, "{}\n");
  }

  const git = simpleGit(soulPath).env(hermeticGitEnv());
  await git.addConfig("user.name", BOT_GIT_NAME);
  await git.addConfig("user.email", BOT_GIT_EMAIL);
  await git.add("-A");
  await git.commit("Initial soul structure");
}
