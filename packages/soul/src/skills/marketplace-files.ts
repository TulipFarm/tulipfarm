import { readdir, readFile, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { parseFrontmatter } from "../published-loader";
import type { SkillScanFile } from "./guard";
import type { DiscoveredSkill } from "./marketplace";

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export async function collectSkillFiles(skillDirectory: string): Promise<SkillScanFile[]> {
  const files: SkillScanFile[] = [];
  const root = await realpath(skillDirectory);
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 6) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = join(directory, entry.name);
      const path = relative(skillDirectory, full);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const symlinkTarget = await readlink(full);
        let symlinkEscapes = true;
        try {
          const resolved = await realpath(full);
          const fromRoot = relative(root, resolved);
          symlinkEscapes = fromRoot.startsWith("..") || isAbsolute(fromRoot);
        } catch {
          // Fail closed: an unresolvable symlink stays flagged as escaping the root.
        }
        files.push({
          path,
          content: symlinkTarget,
          size: Buffer.byteLength(symlinkTarget),
          symlinkTarget,
          symlinkEscapes,
        });
        continue;
      }
      if (entry.isFile()) {
        const content = await readFile(full);
        files.push({ path, content: content.toString("utf8"), size: content.byteLength });
      }
    }
  }
  await walk(skillDirectory, 0);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function discoverSkills(root: string): Promise<DiscoveredSkill[]> {
  const discovered: DiscoveredSkill[] = [];
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 6) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (entry.name !== "SKILL.md") continue;
      const content = await readFile(full, "utf8");
      const { frontmatter } = parseFrontmatter(content);
      const name = basename(dirname(full));
      if (!NAME_RE.test(name)) continue;
      discovered.push({
        name,
        description: asString(frontmatter.description),
        category: categoryFromSkillPath(relative(root, full)),
        skillPath: relative(root, full),
        content,
        files: await collectSkillFiles(dirname(full)),
      });
    }
  }
  await walk(root, 0);
  return discovered;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function categoryFromSkillPath(skillPath: string): string | undefined {
  const parts = skillPath.split(/[\\/]/).slice(0, -2);
  if (parts[0] === "skills") parts.shift();
  return parts[0];
}
