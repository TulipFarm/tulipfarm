import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSoulConfig } from "@tulipfarm/schema";
import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { scaffoldSoul } from "./scaffold-soul";

describe("scaffoldSoul", () => {
  let soulPath: string;

  beforeEach(async () => {
    soulPath = mkdtempSync(join(tmpdir(), "soul-scaffold-"));
    await simpleGit(soulPath).init();
  });

  afterEach(() => {
    rmSync(soulPath, { recursive: true, force: true });
  });

  it("creates the stub directory layout and root files", async () => {
    await scaffoldSoul(soulPath);

    for (const dir of ["resources", "routines", "agents", "skills", "integrations", "roles"]) {
      expect(existsSync(join(soulPath, dir))).toBe(true);
    }
    expect(readFileSync(join(soulPath, "soul.yaml"), "utf8")).toContain(
      "TulipFarm Soul Configuration"
    );
    expect(() =>
      validateSoulConfig(parseYaml(readFileSync(join(soulPath, "soul.yaml"), "utf8")) ?? {})
    ).not.toThrow();
    expect(readFileSync(join(soulPath, "skills-lock.json"), "utf8").trim()).toBe("{}");
  });

  it("makes an initial commit so the repo is ready to push", async () => {
    await scaffoldSoul(soulPath);

    const git = simpleGit(soulPath);
    const log = await git.log();
    expect(log.total).toBe(1);
    expect(log.latest?.message).toBe("Initial soul structure");
  });

  it("does not overwrite an existing soul.yaml", async () => {
    const git = simpleGit(soulPath);
    await git.addConfig("user.name", "test");
    await git.addConfig("user.email", "test@example.com");
    mkdirSync(join(soulPath, "resources"), { recursive: true });
    writeFileSync(join(soulPath, "soul.yaml"), "businessName: Acme\n");

    await scaffoldSoul(soulPath);

    expect(readFileSync(join(soulPath, "soul.yaml"), "utf8")).toBe("businessName: Acme\n");
  });
});
