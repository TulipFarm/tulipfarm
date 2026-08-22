import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSkillReferenceReader } from "./references";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("Skill reference reader", () => {
  it("lists normalized nested files and reads their content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skill-references-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "z-last.md"), "last", "utf8");
    await writeFile(join(directory, "nested", "first.md"), "first", "utf8");

    const reader = createSkillReferenceReader({ directory });

    await expect(reader.list()).resolves.toEqual(["nested/first.md", "z-last.md"]);
    await expect(reader.read("nested/first.md")).resolves.toBe("first");
  });

  it("uses a normalized advertised inventory and returns typed, redacted failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skill-references-"));
    temporaryDirectories.push(directory);
    const reader = createSkillReferenceReader({
      directory,
      advertisedNames: ["z-last.md", "nested\\first.md"],
    });

    await expect(reader.list()).resolves.toEqual(["nested/first.md", "z-last.md"]);
    await expect(reader.read("../secret.md")).rejects.toMatchObject({
      code: "INVALID_NAME",
    });
    await expect(reader.read("missing.md")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
