import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSoulWriterDouble, type SoulWriterDouble } from "../soul-writer-double";
import type { SoulWrite } from "../writer";
import { type BundledSkill, loadBundledSkills } from "./bundled";
import {
  FORGE_EXECUTION_CONTRACT,
  FORGE_EXECUTION_CONTRACT_TOKEN,
} from "./forge-execution-contract";
import { serializeSkillsLock, skillVersionFromFiles } from "./lock";
import { collectSkillFiles, skillDirectoryHash } from "./marketplace-files";
import { syncBundledSkillsIntoSoul } from "./sync-bundled";

const temporaryDirectories: string[] = [];

const ACTOR = { principalId: "service:test", name: "Test", email: "" };

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function temporaryDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

/** A shipped Skill tree: one forge Skill carrying a reference, one plain core Skill. */
async function makeBundledTree(body = `Forge it.\n\n${FORGE_EXECUTION_CONTRACT_TOKEN}\n`) {
  const root = await temporaryDir("sync-bundled-image-");
  const forge = join(root, "forge", "widget-forge");
  await mkdir(join(forge, "references"), { recursive: true });
  await writeFile(
    join(forge, "SKILL.md"),
    `---\nname: widget-forge\ndescription: Forge a Widget.\ncategory: forge\nversion: 2.1.0\ntools: [widget_create]\n---\n${body}`,
    "utf8"
  );
  await writeFile(join(forge, "references", "examples.md"), "An example.", "utf8");

  const core = join(root, "core", "note-taker");
  await mkdir(core, { recursive: true });
  await writeFile(
    join(core, "SKILL.md"),
    "---\nname: note-taker\ndescription: Take notes.\ncategory: core\n---\nTake notes.\n",
    "utf8"
  );
  return root;
}

async function makeSoulDir(lock: unknown = {}): Promise<string> {
  const soulPath = await temporaryDir("sync-bundled-soul-");
  await mkdir(join(soulPath, "skills"), { recursive: true });
  await writeFile(join(soulPath, "skills-lock.json"), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  return soulPath;
}

async function run(input: {
  soulPath: string;
  bundledSkills: ReadonlyMap<string, BundledSkill>;
  writer: SoulWriterDouble;
  disabled?: ReadonlySet<string>;
}) {
  // In production the write gateway reads the same worktree the sync scans for packages, so the
  // double has to model the lock this test seeded on disk rather than an empty tree.
  const onDisk = await readFile(join(input.soulPath, "skills-lock.json"), "utf8").catch(() => null);
  if (onDisk !== null) input.writer.put("SkillsLock", undefined, onDisk);
  return syncBundledSkillsIntoSoul({
    soulPath: input.soulPath,
    bundledSkills: input.bundledSkills,
    disabledBundledSkills: input.disabled ?? new Set(),
    soulWriter: input.writer.writer,
    actor: ACTOR,
    logger: makeLogger(),
  });
}

function lockWrite(changes: readonly SoulWrite[]): string | undefined {
  const change = changes.find((c) => c.op === "put" && c.target.kind === "SkillsLock");
  return change?.op === "put" ? change.content : undefined;
}

/**
 * `SKILL.md` is the definition, so the writer addresses it as the artifact itself with no
 * companion. Mapping the name here keeps call sites reading like the paths they assert, and keeps
 * the negative assertions meaningful — matching on a companion that cannot exist always passes.
 */
function writeFor(changes: readonly SoulWrite[], slug: string, file?: string) {
  const companion = file === "SKILL.md" ? undefined : file;
  return changes.find(
    (change) =>
      change.op === "put" &&
      change.target.kind === "Skill" &&
      change.target.slug === slug &&
      change.target.companion === companion
  );
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true })));
});

describe("syncBundledSkillsIntoSoul", () => {
  it("seeds every shipped Skill into an empty Soul with an expanded forge contract", async () => {
    const bundledSkills = await loadBundledSkills(makeLogger(), await makeBundledTree());
    const soulPath = await makeSoulDir();
    const writer = makeSoulWriterDouble();

    const result = await run({ soulPath, bundledSkills, writer });

    expect(result.installed).toEqual(["note-taker", "widget-forge"]);
    expect(result.updated).toEqual([]);
    expect(result.customized).toEqual([]);
    expect(writer.applied).toHaveLength(1);

    const { changes } = writer.applied[0];
    const skillMd = writeFor(changes, "widget-forge", "SKILL.md");
    expect(skillMd?.op === "put" && skillMd.content).toContain(FORGE_EXECUTION_CONTRACT);
    expect(skillMd?.op === "put" && skillMd.content).not.toContain(FORGE_EXECUTION_CONTRACT_TOKEN);
    // Frontmatter the canonical Skill spec cannot carry must survive the copy verbatim.
    expect(skillMd?.op === "put" && skillMd.content).toContain("tools: [widget_create]");
    expect(writeFor(changes, "widget-forge", "references/examples.md")).toBeDefined();
    expect(writeFor(changes, "note-taker", "SKILL.md")).toBeDefined();
  });

  it("records each seeded Skill in skills-lock.json as bundled", async () => {
    const bundledSkills = await loadBundledSkills(makeLogger(), await makeBundledTree());
    const soulPath = await makeSoulDir();
    const writer = makeSoulWriterDouble();

    await run({ soulPath, bundledSkills, writer });

    const lockWrite = writer.applied[0].changes.find(
      (change) => change.op === "put" && change.target.kind === "SkillsLock"
    );
    const lock = JSON.parse(lockWrite?.op === "put" ? lockWrite.content : "{}");
    expect(lock.skills["widget-forge"]).toMatchObject({
      sourceType: "bundled",
      version: "2.1.0",
      skillPath: "widget-forge",
    });
    expect(lock.skills["widget-forge"].hash).toMatch(/^[0-9a-f]{64}$/);
    // A shipped Skill that declares no version still gets one, so every entry is comparable.
    expect(lock.skills["note-taker"].version).toBe("1.0.0");
  });

  it("records a Soul Skill nobody installed as curated, so the lock is a full inventory", async () => {
    const bundledSkills = await loadBundledSkills(makeLogger(), await makeBundledTree());
    const soulPath = await makeSoulDir();
    const mine = join(soulPath, "skills", "poke-api-fetcher");
    await mkdir(mine, { recursive: true });
    await writeFile(
      join(mine, "SKILL.md"),
      "---\nname: poke-api-fetcher\ndescription: Fetch a Pokemon.\nversion: 0.4.0\n---\nFetch it.\n",
      "utf8"
    );
    const writer = makeSoulWriterDouble();

    const result = await run({ soulPath, bundledSkills, writer });

    expect(result.recorded).toEqual(["poke-api-fetcher"]);
    const lockWrite = writer.applied[0].changes.find(
      (change) => change.op === "put" && change.target.kind === "SkillsLock"
    );
    const lock = JSON.parse(lockWrite?.op === "put" ? lockWrite.content : "{}");
    // No hash and no source: there is no upstream to drift from, so recording one would be a lie.
    expect(lock.skills["poke-api-fetcher"]).toEqual({
      sourceType: "curated",
      version: "0.4.0",
    });
  });

  it("persists a legacy git-shape sourceType in the current vocabulary", async () => {
    const soulPath = await makeSoulDir({
      version: 1,
      skills: {
        installed: { sourceUrl: "someone/skills", sourceType: "github", hash: "a".repeat(64) },
      },
    });
    const writer = makeSoulWriterDouble();

    await run({ soulPath, bundledSkills: new Map(), writer });

    const lockWrite = writer.applied[0].changes.find(
      (change) => change.op === "put" && change.target.kind === "SkillsLock"
    );
    const lock = JSON.parse(lockWrite?.op === "put" ? lockWrite.content : "{}");
    expect(lock.skills.installed).toMatchObject({ sourceType: "public", version: "1.0.0" });
  });

  it("leaves an already-current lock alone rather than committing a no-op", async () => {
    const soulPath = await makeSoulDir({
      version: 1,
      skills: { installed: { sourceType: "public", version: "1.0.0", hash: "a".repeat(64) } },
    });
    const writer = makeSoulWriterDouble();

    await run({ soulPath, bundledSkills: new Map(), writer });

    expect(writer.applied).toHaveLength(0);
  });

  it("never re-seeds a Skill the operator switched off", async () => {
    const bundledSkills = await loadBundledSkills(makeLogger(), await makeBundledTree());
    const soulPath = await makeSoulDir();
    const writer = makeSoulWriterDouble();

    const result = await run({
      soulPath,
      bundledSkills,
      writer,
      disabled: new Set(["widget-forge"]),
    });

    expect(result.skipped).toEqual(["widget-forge"]);
    expect(result.installed).toEqual(["note-taker"]);
    expect(writeFor(writer.applied[0].changes, "widget-forge", "SKILL.md")).toBeUndefined();
  });

  it("refreshes an untouched Soul copy when the image ships a newer Skill", async () => {
    const soulPath = await makeSoulDir();
    const previousImage = await loadBundledSkills(
      makeLogger(),
      await makeBundledTree("Old body.\n")
    );
    const installed = join(soulPath, "skills", "widget-forge");
    await mkdir(join(installed, "references"), { recursive: true });
    const previous = previousImage.get("widget-forge");
    if (previous === undefined) throw new Error("fixture did not load");
    for (const file of await collectSkillFiles(previous.directory)) {
      await writeFile(join(installed, file.path), file.content, "utf8");
    }
    await writeFile(
      join(soulPath, "skills-lock.json"),
      `${JSON.stringify({
        version: 1,
        skills: {
          "widget-forge": {
            sourceType: "bundled",
            hash: skillDirectoryHash(await collectSkillFiles(installed)),
          },
        },
      })}\n`,
      "utf8"
    );

    const bundledSkills = await loadBundledSkills(
      makeLogger(),
      await makeBundledTree("New body.\n")
    );
    const writer = makeSoulWriterDouble();
    const result = await run({ soulPath, bundledSkills, writer });

    expect(result.updated).toEqual(["widget-forge"]);
    expect(result.customized).toEqual([]);
    const skillMd = writeFor(writer.applied[0].changes, "widget-forge", "SKILL.md");
    expect(skillMd?.op === "put" && skillMd.content).toContain("New body.");
  });

  it("leaves a locally edited Soul copy alone", async () => {
    const soulPath = await makeSoulDir({
      version: 1,
      skills: {
        "widget-forge": { sourceType: "bundled", hash: "0".repeat(64) },
      },
    });
    await mkdir(join(soulPath, "skills", "widget-forge"), { recursive: true });
    await writeFile(
      join(soulPath, "skills", "widget-forge", "SKILL.md"),
      "---\nname: widget-forge\ndescription: My edit.\n---\nMine.\n",
      "utf8"
    );

    const bundledSkills = await loadBundledSkills(makeLogger(), await makeBundledTree());
    const writer = makeSoulWriterDouble();
    const result = await run({ soulPath, bundledSkills, writer });

    expect(result.customized).toEqual(["widget-forge"]);
    expect(writeFor(writer.applied[0].changes, "widget-forge", "SKILL.md")).toBeUndefined();
  });

  it("disowns a Soul copy edited outside the tooling, and stays settled after", async () => {
    const soulPath = await makeSoulDir({
      version: 1,
      skills: {
        "widget-forge": { sourceType: "bundled", version: "2.1.0", hash: "0".repeat(64) },
      },
    });
    await mkdir(join(soulPath, "skills", "widget-forge"), { recursive: true });
    await writeFile(
      join(soulPath, "skills", "widget-forge", "SKILL.md"),
      "---\nname: widget-forge\ndescription: My edit.\nversion: 9.9.9\n---\nMine.\n",
      "utf8"
    );

    const bundledSkills = await loadBundledSkills(makeLogger(), await makeBundledTree());
    const writer = makeSoulWriterDouble();
    const result = await run({ soulPath, bundledSkills, writer });

    expect(result.customized).toEqual(["widget-forge"]);
    const lock = JSON.parse(lockWrite(writer.applied[0].changes) ?? "{}");
    expect(lock.skills["widget-forge"]).toEqual({ sourceType: "curated", version: "9.9.9" });

    // The recorded edit is the resting state: a later boot must not reclaim or rewrite it.
    await writeFile(join(soulPath, "skills-lock.json"), lockWrite(writer.applied[0].changes) ?? "");
    const second = makeSoulWriterDouble();
    const settled = await run({ soulPath, bundledSkills, writer: second });
    expect(settled.customized).toEqual(["widget-forge"]);
    expect(settled.recorded).toEqual([]);
    expect(writeFor(second.applied[0].changes, "widget-forge", "SKILL.md")).toBeUndefined();
    const secondLock = JSON.parse(lockWrite(second.applied[0].changes) ?? "{}");
    expect(secondLock.skills["widget-forge"]).toEqual({
      sourceType: "curated",
      version: "9.9.9",
    });
  });

  it("does not take over a Soul Skill it never seeded", async () => {
    const soulPath = await makeSoulDir();
    await mkdir(join(soulPath, "skills", "note-taker"), { recursive: true });
    await writeFile(
      join(soulPath, "skills", "note-taker", "SKILL.md"),
      "---\nname: note-taker\ndescription: Authored here.\n---\nMine.\n",
      "utf8"
    );

    const bundledSkills = await loadBundledSkills(makeLogger(), await makeBundledTree());
    const writer = makeSoulWriterDouble();
    const result = await run({ soulPath, bundledSkills, writer });

    expect(result.customized).toEqual(["note-taker"]);
    expect(result.installed).toEqual(["widget-forge"]);
  });

  it("commits nothing when every Soul copy is already current", async () => {
    const soulPath = await makeSoulDir();
    const bundledSkills = await loadBundledSkills(makeLogger(), await makeBundledTree());
    const lock: Record<string, unknown> = {};
    for (const [name, skill] of bundledSkills) {
      const directory = join(soulPath, "skills", name);
      await mkdir(join(directory, "references"), { recursive: true });
      for (const file of await collectSkillFiles(skill.directory)) {
        const content = file.path === "SKILL.md" ? expandedBody(file.content) : file.content;
        await writeFile(join(directory, file.path), content, "utf8");
      }
      lock[name] = {
        sourceType: "bundled",
        version: skillVersionFromFiles(await collectSkillFiles(directory)),
        skillPath: name,
        hash: skillDirectoryHash(await collectSkillFiles(directory)),
      };
    }
    await writeFile(
      join(soulPath, "skills-lock.json"),
      serializeSkillsLock({ version: 1, skills: lock as never }),
      "utf8"
    );

    const writer = makeSoulWriterDouble();
    const result = await run({ soulPath, bundledSkills, writer });

    expect(result).toEqual({
      installed: [],
      updated: [],
      removed: [],
      customized: [],
      skipped: [],
      recorded: [],
    });
    expect(writer.applied).toHaveLength(0);
  });

  it("refreshes a stale lock entry without touching an unchanged package", async () => {
    const soulPath = await makeSoulDir();
    const bundledSkills = await loadBundledSkills(makeLogger(), await makeBundledTree());
    const skill = bundledSkills.get("note-taker");
    if (skill === undefined) throw new Error("fixture did not load");
    const directory = join(soulPath, "skills", "note-taker");
    await mkdir(directory, { recursive: true });
    for (const file of await collectSkillFiles(skill.directory)) {
      await writeFile(join(directory, file.path), file.content, "utf8");
    }
    await writeFile(
      join(soulPath, "skills-lock.json"),
      `${JSON.stringify({
        version: 1,
        skills: {
          "note-taker": {
            sourceType: "bundled",
            skillPath: "core/note-taker",
            hash: skillDirectoryHash(await collectSkillFiles(directory)),
          },
        },
      })}\n`,
      "utf8"
    );

    const writer = makeSoulWriterDouble();
    const result = await run({ soulPath, bundledSkills, writer });

    expect(result.updated).toEqual([]);
    expect(writeFor(writer.applied[0].changes, "note-taker", "SKILL.md")).toBeUndefined();
    const lockWrite = writer.applied[0].changes.find(
      (change) => change.op === "put" && change.target.kind === "SkillsLock"
    );
    const lock = JSON.parse(lockWrite?.op === "put" ? lockWrite.content : "{}");
    expect(lock.skills["note-taker"].skillPath).toBe("note-taker");
  });

  it("reaps an untouched Soul copy of a Skill the image no longer ships", async () => {
    const soulPath = await makeSoulDir();
    const retired = join(soulPath, "skills", "retired-skill");
    await mkdir(retired, { recursive: true });
    await writeFile(
      join(retired, "SKILL.md"),
      "---\nname: retired-skill\ndescription: Gone.\n---\nGone.\n",
      "utf8"
    );
    await writeFile(
      join(soulPath, "skills-lock.json"),
      `${JSON.stringify({
        version: 1,
        skills: {
          "retired-skill": {
            sourceType: "bundled",
            hash: skillDirectoryHash(await collectSkillFiles(retired)),
          },
        },
      })}\n`,
      "utf8"
    );

    const bundledSkills = await loadBundledSkills(makeLogger(), await makeBundledTree());
    const writer = makeSoulWriterDouble();
    const result = await run({ soulPath, bundledSkills, writer });

    expect(result.removed).toEqual(["retired-skill"]);
    expect(writer.applied[0].changes).toContainEqual({
      op: "deleteArtifact",
      kind: "Skill",
      slug: "retired-skill",
    });
    const lockWrite = writer.applied[0].changes.find(
      (change) => change.op === "put" && change.target.kind === "SkillsLock"
    );
    const lock = JSON.parse(lockWrite?.op === "put" ? lockWrite.content : "{}");
    expect(lock.skills["retired-skill"]).toBeUndefined();
  });

  it("disowns rather than deletes an edited copy of a retired Skill", async () => {
    const soulPath = await makeSoulDir({
      version: 1,
      skills: {
        "retired-skill": { sourceType: "bundled", hash: "0".repeat(64) },
      },
    });
    const retired = join(soulPath, "skills", "retired-skill");
    await mkdir(retired, { recursive: true });
    await writeFile(
      join(retired, "SKILL.md"),
      "---\nname: retired-skill\ndescription: My edit.\n---\nMine.\n",
      "utf8"
    );

    const bundledSkills = await loadBundledSkills(makeLogger(), await makeBundledTree());
    const writer = makeSoulWriterDouble();
    const result = await run({ soulPath, bundledSkills, writer });

    expect(result.removed).toEqual([]);
    expect(result.customized).toEqual(["retired-skill"]);
    expect(writer.applied[0].changes).not.toContainEqual(
      expect.objectContaining({ op: "deleteArtifact" })
    );
    // Disowned means it belongs to the business now, so it is re-recorded on its own terms.
    expect(result.recorded).toEqual(["retired-skill"]);
  });
});

function expandedBody(content: string): string {
  return content.replaceAll(FORGE_EXECUTION_CONTRACT_TOKEN, FORGE_EXECUTION_CONTRACT);
}
