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
      files: ["references/guide.md", "references/nested/deep.md"],
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
      "document-generation",
      "knowledge-research",
      "onboarding",
      "pdf-generation",
      "presentation-generation",
      "resource-forge",
      "routine-forge",
      "skill-forge",
      "spreadsheet-generation",
      "structured-text-generation",
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

  it("ships Routine Forge with exactly one examples reference", async () => {
    const routineForge = (await loadBundledSkills(makeLogger())).get("routine-forge");
    // A second, byte-identical copy shipped here once. Every advertised file is a read the model
    // may spend a whole invocation on, so a duplicate costs a Turn to learn nothing.
    expect(routineForge?.files).toEqual(["references/canonical-examples.md"]);
  });

  it("keeps Routine Forge inside a length budget, with the bulk in its reference", async () => {
    const routineForge = (await loadBundledSkills(makeLogger())).get("routine-forge");
    // Every Turn that authors a Routine pays for this whole body up front, whether or not it needs
    // the detail. At 495 lines it was the slowest Skill to load in the tree, so the per-State
    // detail lives in the reference and only what every Routine needs stays here.
    const source = await readFile(join(routineForge?.directory ?? "", "SKILL.md"), "utf8");
    expect(source.split("\n").length).toBeLessThanOrEqual(200);

    // The reference has to be worth the redirect: it carries every State type the Worker runs.
    const reference = await readFile(
      join(routineForge?.directory ?? "", "references", "canonical-examples.md"),
      "utf8"
    );
    for (const state of ["action", "script", "compute", "child_routine", "emit", "approval"]) {
      expect(reference).toContain(`### \`${state}\``);
    }

    // Both files must agree on the doctrine, or the reference re-teaches the habit the body just
    // warned against — which is exactly how a deterministic Routine ended up with an Agent in it.
    expect(routineForge?.body).toContain("Reach for a model last.");
    expect(reference).toContain("Reach for a model last.");
    expect(reference).not.toContain("Almost every Routine should use `agent` States");
  });

  it("stops Routine Forge minting a manual Trigger for a button that needs none", async () => {
    // A forged schedule arrived in the Soul beside a second, useless `manual` Trigger, because
    // both files claimed a manual Trigger was how the Routines UI gets a "run now" entry point.
    // It is not: that button posts to /api/v1/routines/<slug>/runs, which reads no Trigger at
    // all. Pin the real endpoints in both files, or the next author re-derives the same litter.
    const routineForge = (await loadBundledSkills(makeLogger())).get("routine-forge");
    const reference = await readFile(
      join(routineForge?.directory ?? "", "references", "canonical-examples.md"),
      "utf8"
    );

    for (const source of [routineForge?.body ?? "", reference]) {
      expect(source).toContain("POST /api/v1/routines/<slug>/runs");
      expect(source).not.toContain("Add a `manual` Trigger when the user needs a Routines UI");
    }
    expect(routineForge?.body).toContain("POST /api/v1/triggers/<slug>/invoke");

    // The scheduler appends each occurrence to the authored key itself, so an interpolated key
    // is cargo cult that ships a literal `${scheduledTime}` into the Soul.
    expect(routineForge?.body).toContain("interpolate `${scheduledTime}`");
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

  it("ships both Forges with the Skill/Agent boundary, so neither can silently misroute", async () => {
    const skills = await loadBundledSkills(makeLogger());
    const agentForge = skills.get("agent-forge")?.body ?? "";
    const skillForge = skills.get("skill-forge")?.body ?? "";

    // The redirect has to be symmetric. A test on one side only lets the other keep building the
    // wrong artifact, and the wrong artifact is silent: an Agent authored for a task still answers.
    expect(agentForge, "agent-forge must send procedure requests to skill-forge").toContain(
      "skill-forge"
    );
    expect(skillForge, "skill-forge must send persona requests to agent-forge").toContain(
      "agent-forge"
    );

    // The one asymmetry that is not a matter of taste: only an Agent's limit is enforced, so a
    // "must never" answered with a Skill is a boundary that does not exist.
    expect(skillForge).toContain("capabilityRestrictions");
    for (const body of [agentForge, skillForge]) {
      expect(body).toMatch(/one Agent uses many Skills/i);
    }
  });

  it("ships Routine Forge with a worked example that round-trips through the canonical schema", async () => {
    const routineForge = (await loadBundledSkills(makeLogger())).get("routine-forge");
    const body = routineForge?.body ?? "";

    const documents = [...body.matchAll(/```yaml\n([\s\S]*?)```/g)].map(
      (match) => parseYaml(match[1] as string) as Record<string, unknown>
    );
    expect(documents.length).toBeGreaterThanOrEqual(1);

    // Every example must be a whole document: a fragment is a shape nothing here can check, and an
    // unchecked shape in an authoring Skill is exactly how an invalid State reaches the Soul.
    const routines = documents
      .filter((document) => document.kind === "Routine")
      .map((document) => definitions.routine.validateRoutineDefinition(document).document);
    expect(routines).toHaveLength(documents.length);

    // A Trigger is authored inside the Routine it starts, so a standalone Trigger document in the
    // Skill would teach the model the shape `routine_forge` no longer takes.
    expect(documents.some((document) => document.kind === "Trigger")).toBe(false);
    const embedded = routines.flatMap((routine) => routine.spec.triggers ?? []);
    expect(embedded.length).toBeGreaterThanOrEqual(1);
    for (const trigger of embedded) {
      expect(trigger).not.toHaveProperty("routineRef");
    }
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
    // The ceiling bounds what every Turn carries. This file holds the rules that bind every job —
    // frontmatter limits, section order, the audit-then-confirm discipline, the search ladder,
    // and the Skill/Agent boundary that decides whether this is the right forge at all — while
    // each job's procedure lives in `references/`, loaded with `skill` + `file` on demand.
    // Raise it only for another rule, never for steps that belong in a reference.
    //
    // 185 -> 200: `## When to Use` gained the classification rule. `## Procedure` step 1 already
    // required "confirm this is a Skill and not an Agent" but stated no test for it, so the
    // judgement was the model's to invent — and it misroutes in one direction far more than the
    // other, because "make the Agent better at X" and "build an Agent for X" read alike. The
    // section names the three facts that settle it (a Skill is unaddressable, holds no authority,
    // and one Agent uses many Skills) and tables the redirect. `agent-forge` carries the mirror.
    expect(source.split("\n").length).toBeLessThanOrEqual(200);
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
