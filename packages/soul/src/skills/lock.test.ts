import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bumpPatch,
  DEFAULT_SKILL_VERSION,
  installedSourceType,
  readSkillsLock,
  serializeSkillsLock,
  skillVersion,
  skillVersionFromFiles,
} from "./lock";

const directories: string[] = [];

afterEach(async () => {
  delete process.env.MARKETPLACE_SOURCE;
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function soulWith(lock: unknown): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "skills-lock-"));
  directories.push(path);
  await writeFile(join(path, "skills-lock.json"), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  return path;
}

describe("installedSourceType", () => {
  it("calls the configured catalog marketplace however the source is spelled", () => {
    expect(installedSourceType("tulipfarm/skills")).toBe("marketplace");
    expect(installedSourceType("https://github.com/tulipfarm/skills.git")).toBe("marketplace");
    expect(installedSourceType("tulipfarm/skills#main")).toBe("marketplace");
  });

  it("calls every other source public, including other GitHub repos", () => {
    expect(installedSourceType("someone/skills")).toBe("public");
    expect(installedSourceType("https://github.com/someone/skills")).toBe("public");
    expect(installedSourceType("https://git.example.com/team/skills.git")).toBe("public");
  });

  it("follows MARKETPLACE_SOURCE when an operator points at their own catalog", () => {
    process.env.MARKETPLACE_SOURCE = "acme/internal-skills";
    expect(installedSourceType("acme/internal-skills")).toBe("marketplace");
    expect(installedSourceType("tulipfarm/skills")).toBe("public");
  });
});

describe("readSkillsLock", () => {
  it("returns an empty lock when the Soul has none", async () => {
    const path = await mkdtemp(join(tmpdir(), "skills-lock-"));
    directories.push(path);
    expect(await readSkillsLock(path)).toEqual({ version: 1, skills: {} });
  });

  it("reclassifies a legacy git-shape sourceType from the source it recorded", async () => {
    const path = await soulWith({
      version: 1,
      skills: {
        official: { sourceUrl: "tulipfarm/skills", sourceType: "github", hash: "a" },
        elsewhere: { sourceUrl: "someone/skills", sourceType: "github", hash: "b" },
        selfhosted: { sourceUrl: "https://git.example.com/x/y", sourceType: "git", hash: "c" },
      },
    });
    const lock = await readSkillsLock(path);
    expect(lock.skills.official.sourceType).toBe("marketplace");
    expect(lock.skills.elsewhere.sourceType).toBe("public");
    expect(lock.skills.selfhosted.sourceType).toBe("public");
  });

  it("treats a sourceless legacy entry as authored in this business", async () => {
    const path = await soulWith({ version: 1, skills: { mine: { hash: "a" } } });
    expect((await readSkillsLock(path)).skills.mine.sourceType).toBe("curated");
  });

  it("gives every entry a version, defaulting the ones that declare none", async () => {
    const path = await soulWith({
      version: 1,
      skills: {
        old: { sourceType: "bundled" },
        versioned: { sourceType: "bundled", version: "2.3.4" },
        nonsense: { sourceType: "bundled", version: "v2" },
      },
    });
    const lock = await readSkillsLock(path);
    expect(lock.skills.old.version).toBe(DEFAULT_SKILL_VERSION);
    expect(lock.skills.versioned.version).toBe("2.3.4");
    expect(lock.skills.nonsense.version).toBe(DEFAULT_SKILL_VERSION);
  });

  it("keeps an already-current entry byte-identical when re-serialized", async () => {
    const lock = {
      version: 1,
      skills: {
        alpha: { sourceType: "curated", version: "1.0.0" },
        beta: { sourceType: "bundled", version: "1.2.0", skillPath: "beta", hash: "f" },
      },
    };
    const path = await soulWith(lock);
    expect(serializeSkillsLock(await readSkillsLock(path))).toBe(
      `${JSON.stringify(lock, null, 2)}\n`
    );
  });

  it("sorts entries so an unordered lock still round-trips to one stable file", async () => {
    const path = await soulWith({
      version: 1,
      skills: {
        zebra: { sourceType: "curated", version: "1.0.0" },
        alpha: { sourceType: "curated", version: "1.0.0" },
      },
    });
    expect(
      Object.keys(
        (
          JSON.parse(serializeSkillsLock(await readSkillsLock(path))) as {
            skills: Record<string, unknown>;
          }
        ).skills
      )
    ).toEqual(["alpha", "zebra"]);
  });
});

describe("versions", () => {
  it("defaults a Skill that declares no usable version", () => {
    expect(skillVersion(undefined)).toBe(DEFAULT_SKILL_VERSION);
    expect(skillVersion({ version: "" })).toBe(DEFAULT_SKILL_VERSION);
    expect(skillVersion({ version: "1.2" })).toBe(DEFAULT_SKILL_VERSION);
    expect(skillVersion({ version: "1.2.3" })).toBe("1.2.3");
  });

  it("reads the declared version out of a package's SKILL.md", () => {
    const files = [
      { path: "SKILL.md", content: "---\nname: a\nversion: 3.1.4\n---\nbody", size: 0 },
      { path: "references/x.md", content: "ignored", size: 0 },
    ];
    expect(skillVersionFromFiles(files)).toBe("3.1.4");
    expect(skillVersionFromFiles([files[1]])).toBe(DEFAULT_SKILL_VERSION);
  });

  it("bumps the patch and refuses to invent one from nonsense", () => {
    expect(bumpPatch("1.2.3")).toBe("1.2.4");
    expect(bumpPatch("1.2.9")).toBe("1.2.10");
    expect(bumpPatch("not-a-version")).toBe(DEFAULT_SKILL_VERSION);
  });
});

describe("source canonicalization hazards", () => {
  it("treats a trailing slash after .git as the same remote", () => {
    process.env.MARKETPLACE_SOURCE = "https://git.example.com/team/catalog";
    expect(installedSourceType("https://git.example.com/team/catalog.git/")).toBe("marketplace");
    expect(installedSourceType("https://git.example.com/team/catalog.git")).toBe("marketplace");
  });

  it("does not hand one repository another's provenance on a case-sensitive host", () => {
    process.env.MARKETPLACE_SOURCE = "https://git.example.com/Trusted/Catalog";
    expect(installedSourceType("https://git.example.com/Trusted/Catalog")).toBe("marketplace");
    expect(installedSourceType("https://git.example.com/trusted/catalog")).toBe("public");
    expect(installedSourceType("HTTPS://GIT.EXAMPLE.COM/Trusted/Catalog")).toBe("marketplace");
  });

  it("still folds case for GitHub, which is case-insensitive", () => {
    process.env.MARKETPLACE_SOURCE = "tulipfarm/skills";
    expect(installedSourceType("TulipFarm/Skills")).toBe("marketplace");
    expect(installedSourceType("https://github.com/TulipFarm/skills.git")).toBe("marketplace");
    expect(installedSourceType("tulipfarm/other")).toBe("public");
  });
});

describe("Object.prototype key collisions", () => {
  it("does not report an absent Skill named for a prototype member as locked", async () => {
    const lock = await readSkillsLock(await soulWith({ version: 1, skills: {} }));
    expect(lock.skills.constructor).toBeUndefined();
    expect(lock.skills.toString).toBeUndefined();
  });

  it("stores a Skill named __proto__ instead of reassigning the record", async () => {
    const path = await mkdtemp(join(tmpdir(), "skills-lock-"));
    directories.push(path);
    await writeFile(
      join(path, "skills-lock.json"),
      '{"version":1,"skills":{"__proto__":{"sourceType":"curated","version":"1.0.0"}}}',
      "utf8"
    );
    const lock = await readSkillsLock(path);
    expect(Object.keys(lock.skills)).toEqual(["__proto__"]);
    expect(serializeSkillsLock(lock)).toContain('"__proto__"');
  });
});

describe("semver validation", () => {
  it("rejects versions semver does not permit", () => {
    expect(skillVersion({ version: "01.2.3" })).toBe(DEFAULT_SKILL_VERSION);
    expect(skillVersion({ version: "1.2.3-alpha..1" })).toBe(DEFAULT_SKILL_VERSION);
    expect(skillVersion({ version: "1.2.3-alpha.1" })).toBe("1.2.3-alpha.1");
    expect(skillVersion({ version: "1.2.3+build.5" })).toBe("1.2.3+build.5");
  });

  it("drops prerelease and build metadata when bumping", () => {
    expect(bumpPatch("1.2.3-alpha.1")).toBe("1.2.4");
    expect(bumpPatch("1.2.3+build.5")).toBe("1.2.4");
  });
});
