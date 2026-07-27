import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { validateSkill } from "../packages/schema/src/skill-frontmatter";
import { parseFrontmatter } from "../packages/soul/src/published-loader";

async function skillFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        await walk(path);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        files.push(path);
      }
    }
  }

  await walk(root);
  return files.sort();
}

export async function validateSkillCatalog(root: string): Promise<string[]> {
  const errors: string[] = [];
  for (const path of await skillFiles(root)) {
    const location = relative(root, path);
    try {
      const content = await readFile(path, "utf8");
      const { frontmatter, body } = parseFrontmatter(content);
      const result = validateSkill({
        name: basename(dirname(path)),
        frontmatter,
        body,
        content,
      });
      if (!result.valid) errors.push(`${location}: ${result.error}`);
    } catch (error) {
      errors.push(`${location}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

const catalogRoot = process.argv[2];
if (!catalogRoot) {
  console.error("Usage: pnpm exec tsx scripts/validate-skill-catalog.ts <catalog-root>");
  process.exitCode = 2;
} else {
  const root = resolve(catalogRoot);
  const files = await skillFiles(root);
  const errors = await validateSkillCatalog(root);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log(`Validated ${files.length} Skills with @tulipfarm/schema.`);
  }
}
