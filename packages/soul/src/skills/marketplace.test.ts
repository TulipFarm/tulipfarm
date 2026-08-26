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
const actorId = "user:1";

/** Both halves in sequence, which is what a confirmed install actually is. */
async function prepareAndInstall(
  flow: Awaited<ReturnType<typeof makeFlow>>["flow"],
  source: string,
  name?: string
) {
  const prepared = await flow.prepareFromSource({ source, name, actorId });
  const installed = await flow.installPrepared({
    scanId: prepared.scanId,
    source,
    name,
    actor,
  });
  return { prepared, installed };
}

describe("prepareFromSource", () => {
  it("audits the Skill a skills.sh URL names without writing anything", async () => {
    const { flow, applied, audit, cloneSource } = await makeFlow(
      await sourceTree(["grill-me", "triage"])
    );

    const prepared = await flow.prepareFromSource({
      source: "https://www.skills.sh/mattpocock/skills/grill-me",
      actorId,
    });

    expect(cloneSource).toHaveBeenCalledWith(
      "https://github.com/mattpocock/skills.git",
      expect.anything(),
      expect.anything()
    );
    expect(audit).toHaveBeenCalledTimes(1);
    expect(prepared).toMatchObject({
      name: "grill-me",
      skillPath: "skills/grill-me/SKILL.md",
      report: { verdict: "allow" },
      source: "https://github.com/mattpocock/skills.git",
    });
    expect(prepared.scanId).toBeTruthy();
    expect(applied).toHaveLength(0);
  });

  it("audits only the selected package, not every Skill the source happens to carry", async () => {
    const { flow, audit } = await makeFlow(await sourceTree(["a", "b", "c", "d"]));

    await flow.prepareFromSource({
      source: "https://github.com/o/r/tree/main/skills/c",
      actorId,
    });

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]?.[0]).toMatchObject({ name: "c" });
  });

  it("asks which Skill to install rather than guessing when the source holds several", async () => {
    const { flow, applied } = await makeFlow(await sourceTree(["alpha", "beta"]));

    await expect(
      flow.prepareFromSource({ source: "https://github.com/o/r", actorId })
    ).rejects.toThrow(/name the one to install: alpha, beta/);
    expect(applied).toHaveLength(0);
  });

  it("lists what the source does offer when the named Skill is absent", async () => {
    const { flow, applied } = await makeFlow(await sourceTree(["alpha"]));

    await expect(
      flow.prepareFromSource({ source: "https://www.skills.sh/o/r/missing", actorId })
    ).rejects.toThrow(/"missing" is not in .*It offers: alpha/);
    expect(applied).toHaveLength(0);
  });

  it("does not write when the audit is unavailable", async () => {
    const { flow, applied, audit } = await makeFlow(await sourceTree(["risky"]));
    audit.mockRejectedValueOnce(new SkillMarketplaceError(422, "audit unavailable"));

    await expect(flow.prepareFromSource({ source: "o/r", actorId })).rejects.toThrow(
      "audit unavailable"
    );
    expect(applied).toHaveLength(0);
  });
});

describe("package risk", () => {
  it("warns about a binary rather than refusing the whole package", async () => {
    const directory = await sourceTree(["risky"]);
    await writeFile(
      join(directory, "skills", "risky", "helper.so"),
      "not really a library",
      "utf8"
    );
    const { flow, applied } = await makeFlow(directory);

    const { prepared, installed } = await prepareAndInstall(flow, "o/r");

    expect(prepared.warnings).toContainEqual(
      expect.stringContaining("binary or executable file should not be in a Skill")
    );
    expect(installed.installed).toEqual([{ name: "risky", skillPath: "skills/risky/SKILL.md" }]);
    expect(applied).toHaveLength(1);
  });

  it("still refuses a package the Soul cannot address", async () => {
    const directory = await sourceTree(["dotty"]);
    await writeFile(join(directory, "skills", "dotty", ".env"), "TOKEN=secret\n", "utf8");
    const { flow, applied } = await makeFlow(directory);

    await expect(flow.prepareFromSource({ source: "o/r", actorId })).rejects.toThrow(
      /cannot store/
    );
    expect(applied).toHaveLength(0);
  });
});

describe("installPrepared", () => {
  it("installs the package the preparation audited", async () => {
    const { flow, applied } = await makeFlow(await sourceTree(["grill-me", "triage"]));

    const { installed } = await prepareAndInstall(
      flow,
      "https://www.skills.sh/mattpocock/skills/grill-me"
    );

    expect(installed.installed).toEqual([
      { name: "grill-me", skillPath: "skills/grill-me/SKILL.md" },
    ]);
    expect(applied).toHaveLength(1);
  });

  it("installs without a hint when the source holds exactly one Skill", async () => {
    const { flow } = await makeFlow(await sourceTree(["only-one"]));

    const { installed } = await prepareAndInstall(flow, "o/r");

    expect(installed.installed).toEqual([
      { name: "only-one", skillPath: "skills/only-one/SKILL.md" },
    ]);
  });

  it("installs only the named package even though the scan holds the whole source", async () => {
    const { flow, applied } = await makeFlow(await sourceTree(["a", "b", "c"]));

    const { installed } = await prepareAndInstall(flow, "https://github.com/o/r", "b");

    expect(installed.installed).toEqual([{ name: "b", skillPath: "skills/b/SKILL.md" }]);
    expect(applied).toHaveLength(1);
  });

  it("refuses a confirmation whose scan is gone rather than installing blind", async () => {
    const { flow, applied } = await makeFlow(await sourceTree(["alpha"]));

    await expect(
      flow.installPrepared({ scanId: "no-such-scan", source: "o/r", actor })
    ).rejects.toThrow(/confirmation has expired/);
    expect(applied).toHaveLength(0);
  });
});

describe("scan", () => {
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
});
