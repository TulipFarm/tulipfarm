import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitSyncService } from "../git-sync";
import type { SoulLoader } from "../published-loader";
import { makeSoulWriterDouble } from "../soul-writer-double";
import {
  createSkillMarketplaceFlow,
  type DiscoveredSkill,
  type SkillMarketplaceDeps,
  SkillMarketplaceError,
} from "./marketplace";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function sourceTree(skills: readonly string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "skill-source-"));
  temporaryDirectories.push(directory);
  for (const skill of skills) {
    await mkdir(join(directory, "skills", skill), { recursive: true });
    await writeFile(
      join(directory, "skills", skill, "SKILL.md"),
      `---\nname: ${skill}\ndescription: The ${skill} Skill.\n---\n\nDo the ${skill} work.\n`,
      "utf8"
    );
  }
  return directory;
}

async function makeFlow(cloneDirectory: string) {
  const soulPath = await mkdtemp(join(tmpdir(), "skill-soul-"));
  temporaryDirectories.push(soulPath);

  const soulWriter = makeSoulWriterDouble();
  const reload = vi.fn(async () => {});
  const audit = vi.fn(async (_skill: DiscoveredSkill, _scan: unknown) => ({ verdict: "allow" }));
  const cloneSource: SkillMarketplaceDeps["cloneSource"] = vi.fn((_source, _options, action) =>
    action({ dir: cloneDirectory, ref: "main" })
  );

  const flow = createSkillMarketplaceFlow({
    gitSync: { path: soulPath } as unknown as GitSyncService,
    soulLoader: { skills: new Map(), reload } as unknown as SoulLoader,
    soulWriter: soulWriter.writer,
    cloneSource,
    audit,
    executablePackageBlocker: () => undefined,
  });

  return { flow, applied: soulWriter.applied, reload, audit, cloneSource };
}

const actor = { principalId: "user:1", name: "Ada", email: "ada@example.com" };
const install = { actor, actorId: "user:1" };

describe("installFromSource", () => {
  it("installs the Skill a skills.sh URL names, auditing it on the way", async () => {
    const { flow, applied, audit, cloneSource } = await makeFlow(
      await sourceTree(["grill-me", "triage"])
    );

    const result = await flow.installFromSource({
      source: "https://www.skills.sh/mattpocock/skills/grill-me",
      ...install,
    });

    expect(cloneSource).toHaveBeenCalledWith(
      "https://github.com/mattpocock/skills.git",
      expect.anything(),
      expect.anything()
    );
    expect(audit).toHaveBeenCalledTimes(1);
    expect(result.installed).toEqual([{ name: "grill-me", skillPath: "skills/grill-me/SKILL.md" }]);
    expect(result.report).toEqual({ verdict: "allow" });
    expect(applied).toHaveLength(1);
  });

  it("audits only the selected package, not every Skill the source happens to carry", async () => {
    const { flow, audit } = await makeFlow(await sourceTree(["a", "b", "c", "d"]));

    await flow.installFromSource({
      source: "https://github.com/o/r/tree/main/skills/c",
      ...install,
    });

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]?.[0]).toMatchObject({ name: "c" });
  });

  it("installs without a hint when the source holds exactly one Skill", async () => {
    const { flow } = await makeFlow(await sourceTree(["only-one"]));

    const result = await flow.installFromSource({ source: "o/r", ...install });

    expect(result.installed).toEqual([{ name: "only-one", skillPath: "skills/only-one/SKILL.md" }]);
  });

  it("asks which Skill to install rather than guessing when the source holds several", async () => {
    const { flow, applied } = await makeFlow(await sourceTree(["alpha", "beta"]));

    await expect(
      flow.installFromSource({ source: "https://github.com/o/r", ...install })
    ).rejects.toThrow(/name the one to install: alpha, beta/);
    expect(applied).toHaveLength(0);
  });

  it("lists what the source does offer when the named Skill is absent", async () => {
    const { flow, applied } = await makeFlow(await sourceTree(["alpha"]));

    await expect(
      flow.installFromSource({ source: "https://www.skills.sh/o/r/missing", ...install })
    ).rejects.toThrow(/"missing" is not in .*It offers: alpha/);
    expect(applied).toHaveLength(0);
  });

  it("resolves a catalogue URL pasted straight into scan, and records the real remote", async () => {
    const { flow, cloneSource } = await makeFlow(await sourceTree(["alpha"]));

    const scanned = await flow.scan({
      source: "https://www.skills.sh/mattpocock/skills/alpha",
      actorId: "user:1",
    });

    expect(cloneSource).toHaveBeenCalledWith(
      "https://github.com/mattpocock/skills.git",
      expect.anything(),
      expect.anything()
    );
    expect(scanned.source).toBe("https://github.com/mattpocock/skills.git");
  });

  it("does not write when the audit refuses", async () => {
    const { flow, applied, audit } = await makeFlow(await sourceTree(["risky"]));
    audit.mockRejectedValueOnce(new SkillMarketplaceError(422, "audit unavailable"));

    await expect(flow.installFromSource({ source: "o/r", ...install })).rejects.toThrow(
      "audit unavailable"
    );
    expect(applied).toHaveLength(0);
  });
});
