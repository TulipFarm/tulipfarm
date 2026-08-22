import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { definitions } from "@tulipfarm/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import type { Logger } from "../types";
import {
  bundledSkillsDir,
  loadBundledSkills,
  loadDisabledBundledSkills,
  persistDisabledBundledSkills,
} from "./bundled";

const temporaryDirectories: string[] = [];
const originalOverride = process.env.BUNDLED_SKILLS_DIR;

async function makeTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bundled-skills-"));
  temporaryDirectories.push(root);

  const valid = join(root, "core", "valid-skill");
  const invalid = join(root, "core", "invalid-skill");
  await mkdir(valid, { recursive: true });
  await mkdir(invalid, { recursive: true });
  await mkdir(join(valid, "references", "nested"), { recursive: true });
  await writeFile(
    join(root, "core", "DESCRIPTION.md"),
    "---\ndescription: Essential bundled workflows.\n---\n",
    "utf8"
  );
  await writeFile(
    join(valid, "SKILL.md"),
    "---\nname: valid-skill\ndescription: A valid bundled Skill.\n---\nFollow the steps.",
    "utf8"
  );
  await writeFile(join(valid, "references", "guide.md"), "Guide.", "utf8");
  await writeFile(join(valid, "references", "nested", "deep.md"), "Deep.", "utf8");
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
      category: "core",
      categoryDescription: "Essential bundled workflows.",
      directory: join(root, "core", "valid-skill"),
      references: ["guide.md", "nested/deep.md"],
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Bundled Skill "invalid-skill" skipped')
    );
  });

  it("loads the repository tree and expands the shared forge execution contract", async () => {
    const logger = makeLogger();
    const skills = await loadBundledSkills(logger);

    expect([...skills.keys()].sort()).toEqual([
      "agent-forge",
      "business-records",
      "github",
      "knowledge-research",
      "onboarding",
      "resource-forge",
      "routine-forge",
      "skill-forge",
      "structured-results",
      "surface-component-forge",
    ]);
    for (const name of [
      "agent-forge",
      "onboarding",
      "resource-forge",
      "routine-forge",
      "skill-forge",
      "surface-component-forge",
    ]) {
      const skill = skills.get(name);
      expect(skill?.body).toContain("## Execution Contract");
      expect(skill?.body).not.toContain("{{FORGE_EXECUTION_CONTRACT}}");
      expect(skill?.body).toContain("Do not stop at a plan, draft, or preview.");
    }
  });

  it("ships Routine Forge with canonical examples references", async () => {
    const routineForge = (await loadBundledSkills(makeLogger())).get("routine-forge");
    expect(routineForge?.references).toEqual(["canonical-examples.md", "examples.md"]);
  });

  it("ships Resource Forge with an exact canonical x-links.target example", async () => {
    const resourceForge = (await loadBundledSkills(makeLogger())).get("resource-forge");
    expect(resourceForge?.body).toContain('x-links: { target: "customer" }');
  });

  it("ships Agent Forge with the guidance that makes capability restrictions reachable", async () => {
    const agentForge = (await loadBundledSkills(makeLogger())).get("agent-forge");
    const body = agentForge?.body ?? "";

    expect(body).toContain("capabilityRestrictions");
    for (const key of ["allowMutating", "deny", "resourceTypes"]) {
      expect(body, `agent-forge must teach ${key}`).toContain(key);
    }
    expect(body).toMatch(/never|must not|read-only/i);
  });

  it("ships Routine Forge with a worked example that round-trips through the canonical schema", async () => {
    const routineForge = (await loadBundledSkills(makeLogger())).get("routine-forge");
    const body = routineForge?.body ?? "";

    const yamlBlocks = [...body.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1]);
    expect(yamlBlocks).toHaveLength(2);

    const [routineDoc, triggerDoc] = yamlBlocks.map((block) => parseYaml(block));

    const routine = definitions.routine.validateRoutineDefinition(routineDoc).document;
    const trigger = definitions.trigger.validateTriggerDefinition(triggerDoc).document;

    // Mirrors the cross-document checks `routine_forge` enforces in
    // apps/api/src/platform/tools.ts beyond per-document schema validation.
    expect(trigger.metadata.lifecycle).toBe("published");
    expect(trigger.spec.routineRef.name).toBe(routine.metadata.slug);
    expect(trigger.spec.routineRef.version).toBe(String(routine.metadata.authoredVersion));
  });

  it("ships Skill Forge with the compact description and mandatory authoring section order", async () => {
    const skills = await loadBundledSkills(makeLogger());
    const skillForge = skills.get("skill-forge");
    const description = skillForge?.frontmatter.description;
    expect(typeof description).toBe("string");
    if (typeof description !== "string" || !skillForge) return;

    expect(description.length).toBeLessThanOrEqual(60);
    expect(description.endsWith(".")).toBe(true);
    const headings = [
      "# Skill Forge Skill",
      "## When to Use",
      "## Prerequisites",
      "## How to Run",
      "## Quick Reference",
      "## Procedure",
      "## Pitfalls",
      "## Verification",
    ];
    const positions = headings.map((heading) => skillForge.body.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));

    const source = await readFile(join(skillForge.directory, "SKILL.md"), "utf8");
    expect(source.split("\n").length).toBeGreaterThanOrEqual(90);
    expect(source.split("\n").length).toBeLessThanOrEqual(150);
  });

  it("returns an empty map when the bundled tree does not exist", async () => {
    const logger = makeLogger();
    const skills = await loadBundledSkills(logger, "/path/that/does/not/exist");
    expect(skills.size).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe("disabled bundled Skills", () => {
  it("persists sorted names and loads them back", async () => {
    const root = await mkdtemp(join(tmpdir(), "bundled-disabled-"));
    temporaryDirectories.push(root);

    await persistDisabledBundledSkills(root, new Set(["zebra", "alpha"]));

    expect(await loadDisabledBundledSkills(root, makeLogger())).toEqual(
      new Set(["alpha", "zebra"])
    );
    expect(await readFile(join(root, "skills", ".bundled-disabled.json"), "utf8")).toBe(
      '[\n  "alpha",\n  "zebra"\n]\n'
    );
  });
});
