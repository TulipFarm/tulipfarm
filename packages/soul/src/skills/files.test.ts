import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSkillFileReader } from "./files";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function skillDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "skill-files-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("Skill file reader", () => {
  it("lists and reads every companion kind a Skill package may carry", async () => {
    const directory = await skillDirectory();
    await mkdir(join(directory, "references"));
    await mkdir(join(directory, "scripts"));
    await mkdir(join(directory, "schemas"));
    await writeFile(join(directory, "references", "guide.md"), "guide", "utf8");
    await writeFile(join(directory, "scripts", "sync.ts"), "export {};", "utf8");
    await writeFile(join(directory, "schemas", "ticket.json"), "{}", "utf8");
    await writeFile(join(directory, "README.md"), "readme", "utf8");

    const reader = createSkillFileReader({ directory });

    await expect(reader.list()).resolves.toEqual([
      "README.md",
      "references/guide.md",
      "schemas/ticket.json",
      "scripts/sync.ts",
    ]);
    await expect(reader.read("scripts/sync.ts")).resolves.toBe("export {};");
    await expect(reader.read("schemas/ticket.json")).resolves.toBe("{}");
  });

  it("accepts a leading slash as the Skill's own root", async () => {
    const directory = await skillDirectory();
    await mkdir(join(directory, "references"));
    await writeFile(join(directory, "references", "guide.md"), "guide", "utf8");

    const reader = createSkillFileReader({ directory });

    await expect(reader.read("/references/guide.md")).resolves.toBe("guide");
  });

  it("keeps the definition out of the listing but still readable by path", async () => {
    const directory = await skillDirectory();
    await writeFile(join(directory, "SKILL.md"), "body", "utf8");

    const reader = createSkillFileReader({ directory });

    await expect(reader.list()).resolves.toEqual([]);
    await expect(reader.read("SKILL.md")).resolves.toBe("body");
  });

  it("refuses a dotfile, so a stray secret stays unreadable", async () => {
    const directory = await skillDirectory();
    await writeFile(join(directory, ".env"), "TOKEN=secret", "utf8");
    await writeFile(join(directory, "notes.rb"), "puts 1", "utf8");

    const reader = createSkillFileReader({ directory });

    await expect(reader.list()).resolves.toEqual(["notes.rb"]);
    await expect(reader.read(".env")).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(reader.read("notes.rb")).resolves.toBe("puts 1");
  });

  // Containment has to hold on the link's target, not its name: the checks are lexical and
  // `readFile` follows symlinks, so an addressable name is not evidence of an addressable file.
  it("refuses a symlink that leaves the Skill or points at a dotfile", async () => {
    const directory = await skillDirectory();
    const outside = await skillDirectory();
    await writeFile(join(outside, "secret.md"), "outside", "utf8");
    await writeFile(join(directory, ".env"), "TOKEN=secret", "utf8");
    await symlink(join(outside, "secret.md"), join(directory, "escape.md"));
    await symlink(join(directory, ".env"), join(directory, "notes.txt"));
    await writeFile(join(directory, "real.md"), "real", "utf8");

    const reader = createSkillFileReader({ directory });

    await expect(reader.read("escape.md")).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(reader.read("notes.txt")).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(reader.read("real.md")).resolves.toBe("real");
  });

  it("uses a normalized advertised inventory and returns typed, redacted failures", async () => {
    const directory = await skillDirectory();
    const reader = createSkillFileReader({
      directory,
      advertisedPaths: ["z-last.md", "references\\first.md"],
    });

    await expect(reader.list()).resolves.toEqual(["references/first.md", "z-last.md"]);
    await expect(reader.read("../secret.md")).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    await expect(reader.read("missing.md")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
