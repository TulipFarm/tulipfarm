import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Logger } from "@tulipfarm/soul";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundledSkillsDir, loadBundledSkills } from "./bundled";

const temporaryDirectories: string[] = [];
const originalOverride = process.env.BUNDLED_SKILLS_DIR;

async function makeTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bundled-skills-"));
  temporaryDirectories.push(root);

  const valid = join(root, "core", "valid-skill");
  const invalid = join(root, "core", "invalid-skill");
  await mkdir(valid, { recursive: true });
  await mkdir(invalid, { recursive: true });
  await writeFile(
    join(valid, "SKILL.md"),
    "---\nname: valid-skill\ndescription: A valid bundled Skill.\n---\nFollow the steps.",
    "utf8"
  );
  await writeFile(
    join(invalid, "SKILL.md"),
    "---\nname: invalid-skill\n---\nMissing a description.",
    "utf8"
  );
  return root;
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

afterEach(async () => {
  if (originalOverride === undefined) {
    delete process.env.BUNDLED_SKILLS_DIR;
  } else {
    process.env.BUNDLED_SKILLS_DIR = originalOverride;
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("bundledSkillsDir", () => {
  it("uses an explicit BUNDLED_SKILLS_DIR override", () => {
    process.env.BUNDLED_SKILLS_DIR = "./test-skills";
    expect(bundledSkillsDir()).toBe(resolve("./test-skills"));
  });
});

describe("loadBundledSkills", () => {
  it("loads valid Skills and skips malformed Skills without throwing", async () => {
    const root = await makeTree();
    const logger = makeLogger();

    const skills = await loadBundledSkills(logger, root);

    expect([...skills.keys()]).toEqual(["valid-skill"]);
    expect(skills.get("valid-skill")).toMatchObject({
      name: "valid-skill",
      frontmatter: {
        name: "valid-skill",
        description: "A valid bundled Skill.",
      },
      body: "Follow the steps.",
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Bundled Skill "invalid-skill" skipped')
    );
  });

  it("returns an empty map when the bundled tree does not exist", async () => {
    const logger = makeLogger();
    const skills = await loadBundledSkills(logger, "/path/that/does/not/exist");
    expect(skills.size).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
