import { type Dirent, existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { validateSkill } from "@tulipfarm/schema";
import { type Logger, parseFrontmatter, type SoulSkill } from "@tulipfarm/soul";

const IMAGE_SKILLS_DIR = "/app/skills";
const REPO_SKILLS_DIR = resolve(__dirname, "../../../../../skills");

export function bundledSkillsDir(): string {
  const override = process.env.BUNDLED_SKILLS_DIR?.trim();
  if (override) return resolve(override);
  if (existsSync(IMAGE_SKILLS_DIR)) return IMAGE_SKILLS_DIR;
  return REPO_SKILLS_DIR;
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Load and validate the future bundled Skill tree without activating it.
 *
 * Step 1 will consume the returned map as an overlay. Step 4 calls this at boot only to ensure
 * malformed bundled Skills are logged and skipped rather than taking down the server.
 */
export async function loadBundledSkills(
  logger: Logger,
  root = bundledSkillsDir()
): Promise<Map<string, SoulSkill>> {
  const skills = new Map<string, SoulSkill>();

  async function walk(directory: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (!isNotFound(error)) {
        logger.error(
          `Bundled Skills: cannot read "${directory}": ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile() || entry.name !== "SKILL.md") continue;

      const name = basename(directory);
      try {
        const content = await readFile(path, "utf8");
        const { frontmatter, body } = parseFrontmatter(content);
        const validation = validateSkill({ name, frontmatter, body, content });
        if (!validation.valid) {
          logger.error(`Bundled Skill "${name}" skipped: ${validation.error}`);
          continue;
        }
        if (skills.has(name)) {
          logger.error(`Bundled Skill "${name}" skipped: duplicate Skill name`);
          continue;
        }
        skills.set(name, { name, frontmatter: validation.frontmatter, body });
      } catch (error) {
        logger.error(
          `Bundled Skill "${name}" skipped: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  await walk(root);
  return skills;
}
