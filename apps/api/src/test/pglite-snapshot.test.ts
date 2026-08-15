import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Replaying every migration per test cost ~617ms where restoring a snapshot costs ~138ms, and 76
 * files were paying it across 551 tests — roughly half the suite's runtime. Nothing in the type
 * system stops the pair coming back, so this does.
 */

const SOURCE_ROOT = join(__dirname, "..");

/** Tests that own the migration machinery itself, so a migrated snapshot would defeat their point. */
const ALLOWED = new Set(["pg-migrate.test.ts", "backfill.pg.test.ts"]);

function testFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return testFiles(path);
    return entry.endsWith(".test.ts") && path !== __filename ? [path] : [];
  });
}

describe("migrated PGlite snapshot", () => {
  it("is used instead of replaying migrations per test", () => {
    const offenders = testFiles(SOURCE_ROOT)
      .filter((path) => !ALLOWED.has(path.split("/").pop() ?? ""))
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return /makePglite\(\)/.test(source) && /runPgMigrations\(/.test(source);
      })
      .map((path) => path.slice(SOURCE_ROOT.length + 1));

    expect(
      offenders,
      "call makeMigratedPglite() instead of makePglite() + runPgMigrations()"
    ).toEqual([]);
  });

  it("is what the suite actually calls, so this guard cannot pass vacuously", () => {
    const users = testFiles(SOURCE_ROOT).filter((path) =>
      /makeMigratedPglite\(\)/.test(readFileSync(path, "utf8"))
    );
    expect(users.length).toBeGreaterThan(50);
  });
});
