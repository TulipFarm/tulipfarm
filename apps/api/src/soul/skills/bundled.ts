import { type Dirent, existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { validateSkill } from "@tulipfarm/schema";
import { type Logger, parseFrontmatter, type SoulSkill } from "@tulipfarm/soul";
import { expandForgeExecutionContract } from "./forge-execution-contract";

const IMAGE_SKILLS_DIR = "/app/skills";
const REPO_SKILLS_DIR = resolve(__dirname, "../../../../../skills");
const DISABLED_BUNDLED_SKILLS_FILE = ".bundled-disabled.json";

export interface BundledSkill extends SoulSkill {
  category: string;
  categoryDescription: string;
  directory: string;
  references: readonly string[];
}

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
 * Load and validate the bundled Skill tree once at boot. The returned map is the process-local
 * read-only overlay cache; callers merge Soul Skills over it by name.
 */
export async function loadBundledSkills(
  logger: Logger,
  root = bundledSkillsDir()
): Promise<Map<string, BundledSkill>> {
  const skills = new Map<string, BundledSkill>();
  const categoryDescriptions = new Map<string, string>();

  async function listReferences(skillDirectory: string): Promise<string[]> {
    const referencesRoot = join(skillDirectory, "references");
    const references: string[] = [];

    async function walkReferences(directory: string): Promise<void> {
      let entries: Dirent[];
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (!isNotFound(error)) throw error;
        return;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walkReferences(path);
        } else if (entry.isFile()) {
          references.push(relative(referencesRoot, path).split(sep).join("/"));
        }
      }
    }

    await walkReferences(referencesRoot);
    return references;
  }

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
      if (!entry.isFile()) continue;

      if (entry.name === "DESCRIPTION.md") {
        try {
          const content = await readFile(path, "utf8");
          const { frontmatter } = parseFrontmatter(content);
          const description = frontmatter.description;
          if (typeof description === "string" && description.trim()) {
            const category = relative(root, directory).split(sep).join("/");
            categoryDescriptions.set(category, description.trim());
          }
        } catch (error) {
          logger.error(
            `Bundled Skill category "${relative(root, directory)}" has an invalid DESCRIPTION.md: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        continue;
      }
      if (entry.name !== "SKILL.md") continue;

      const name = basename(directory);
      try {
        const content = expandForgeExecutionContract(await readFile(path, "utf8"));
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
        const categoryPath = relative(root, dirname(directory));
        const category = categoryPath ? categoryPath.split(sep).join("/") : "general";
        skills.set(name, {
          name,
          frontmatter: validation.frontmatter,
          body,
          category,
          categoryDescription: "",
          directory,
          references: await listReferences(directory),
        });
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
  for (const skill of skills.values()) {
    skill.categoryDescription = categoryDescriptions.get(skill.category) ?? "";
  }
  return skills;
}

function disabledSkillsPath(soulPath: string): string {
  return join(soulPath, "skills", DISABLED_BUNDLED_SKILLS_FILE);
}

export async function loadDisabledBundledSkills(
  soulPath: string,
  logger: Logger
): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await readFile(disabledSkillsPath(soulPath), "utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.some((name) => typeof name !== "string")) {
      logger.error("Bundled Skills: disabled-name file is invalid; ignoring it");
      return new Set();
    }
    return new Set(parsed);
  } catch (error) {
    if (!isNotFound(error)) {
      logger.error(
        `Bundled Skills: cannot read disabled-name file: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    return new Set();
  }
}

export async function persistDisabledBundledSkills(
  soulPath: string,
  disabled: ReadonlySet<string>
): Promise<void> {
  const skillsDirectory = join(soulPath, "skills");
  await mkdir(skillsDirectory, { recursive: true });
  const names = [...disabled].sort((left, right) => left.localeCompare(right));
  await writeFile(disabledSkillsPath(soulPath), `${JSON.stringify(names, null, 2)}\n`, "utf8");
}
