import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BOT_GIT_EMAIL, BOT_GIT_NAME } from "@tulipfarm/constants";
import simpleGit from "simple-git";
import { hermeticGitEnv } from "./git-env";

const SCAFFOLD_DIRS = ["resources", "routines", "agents", "skills", "integrations", "roles"];

/** Populate a fresh checkout with stub layout plus `.gitkeep` files so Git tracks directories. */
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
