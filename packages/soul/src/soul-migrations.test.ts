import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SoulMigration } from "./migrations/index";
import { runSoulMigrations } from "./soul-migrations";

const TMP = join(import.meta.dirname, "__soul_migrations_test_tmp__");

async function writeSoulYaml(content: string) {
  await writeFile(join(TMP, "soul.yaml"), content, "utf8");
}

async function readSoulYaml(): Promise<string> {
  return readFile(join(TMP, "soul.yaml"), "utf8");
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

vi.mock("./migrations/index", () => ({
  SOUL_MIGRATIONS: [] as SoulMigration[],
}));

import * as migrationsModule from "./migrations/index";

function setMigrations(migrations: SoulMigration[]) {
  // biome-ignore lint/suspicious/noExplicitAny: test setup
  (migrationsModule as any).SOUL_MIGRATIONS = migrations;
}

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
  setMigrations([]);
});

afterEach(() => rm(TMP, { recursive: true, force: true }));

describe("runSoulMigrations", () => {
  describe("no pending migrations", () => {
    it("no-ops when SOUL_MIGRATIONS is empty", async () => {
      await writeSoulYaml("soulFormatVersion: 0\n");
      const logger = makeLogger();
      await runSoulMigrations(TMP, logger);
      expect(logger.info).not.toHaveBeenCalled();
      expect(await readSoulYaml()).toContain("soulFormatVersion: 0");
    });

    it("no-ops when current version matches highest migration", async () => {
      setMigrations([{ version: 1, description: "v1", up: vi.fn().mockResolvedValue(undefined) }]);
      await writeSoulYaml("soulFormatVersion: 1\n");
      const logger = makeLogger();
      await runSoulMigrations(TMP, logger);
      expect(logger.info).not.toHaveBeenCalled();
    });
  });

  describe("soul.yaml absent", () => {
    it("treats missing soul.yaml as version 0, runs pending migrations", async () => {
      const up = vi.fn().mockResolvedValue(undefined);
      setMigrations([{ version: 1, description: "add field", up }]);
      const logger = makeLogger();
      await runSoulMigrations(TMP, logger);
      expect(up).toHaveBeenCalledWith(TMP);
      const yaml = await readSoulYaml();
      expect(yaml).toContain("soulFormatVersion: 1");
    });
  });

  describe("pending migration", () => {
    it("runs migration, bumps soulFormatVersion in soul.yaml", async () => {
      await writeSoulYaml("soulFormatVersion: 0\nname: test\n");
      const up = vi.fn().mockResolvedValue(undefined);
      setMigrations([{ version: 1, description: "add field", up }]);
      const logger = makeLogger();
      await runSoulMigrations(TMP, logger);
      expect(up).toHaveBeenCalledWith(TMP);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("v1"));
      const yaml = await readSoulYaml();
      expect(yaml).toContain("soulFormatVersion: 1");
    });

    it("runs multiple pending migrations in version order", async () => {
      await writeSoulYaml("soulFormatVersion: 0\n");
      const order: number[] = [];
      setMigrations([
        {
          version: 2,
          description: "v2",
          up: async () => {
            order.push(2);
          },
        },
        {
          version: 1,
          description: "v1",
          up: async () => {
            order.push(1);
          },
        },
      ]);
      const logger = makeLogger();
      await runSoulMigrations(TMP, logger);
      expect(order).toEqual([1, 2]);
      const yaml = await readSoulYaml();
      expect(yaml).toContain("soulFormatVersion: 2");
    });

    it("skips already-applied migrations", async () => {
      await writeSoulYaml("soulFormatVersion: 1\n");
      const v1 = vi.fn().mockResolvedValue(undefined);
      const v2 = vi.fn().mockResolvedValue(undefined);
      setMigrations([
        { version: 1, description: "v1", up: v1 },
        { version: 2, description: "v2", up: v2 },
      ]);
      const logger = makeLogger();
      await runSoulMigrations(TMP, logger);
      expect(v1).not.toHaveBeenCalled();
      expect(v2).toHaveBeenCalled();
    });
  });

  describe("failing migration", () => {
    it("logs error, does not bump version, does not throw", async () => {
      await writeSoulYaml("soulFormatVersion: 0\n");
      setMigrations([
        { version: 1, description: "bad", up: vi.fn().mockRejectedValue(new Error("boom")) },
      ]);
      const logger = makeLogger();
      await expect(runSoulMigrations(TMP, logger)).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("boom"));
      const yaml = await readSoulYaml();
      expect(yaml).toContain("soulFormatVersion: 0");
    });

    it("stops after first failure, does not run subsequent migrations", async () => {
      await writeSoulYaml("soulFormatVersion: 0\n");
      const v2 = vi.fn().mockResolvedValue(undefined);
      setMigrations([
        { version: 1, description: "bad", up: vi.fn().mockRejectedValue(new Error("boom")) },
        { version: 2, description: "v2", up: v2 },
      ]);
      const logger = makeLogger();
      await runSoulMigrations(TMP, logger);
      expect(v2).not.toHaveBeenCalled();
      const yaml = await readSoulYaml();
      expect(yaml).toContain("soulFormatVersion: 0");
    });

    it("advances version up to the last successful migration before failure", async () => {
      await writeSoulYaml("soulFormatVersion: 0\n");
      setMigrations([
        { version: 1, description: "ok", up: vi.fn().mockResolvedValue(undefined) },
        { version: 2, description: "bad", up: vi.fn().mockRejectedValue(new Error("boom")) },
        { version: 3, description: "v3", up: vi.fn().mockResolvedValue(undefined) },
      ]);
      const logger = makeLogger();
      await runSoulMigrations(TMP, logger);
      const yaml = await readSoulYaml();
      expect(yaml).toContain("soulFormatVersion: 1");
    });
  });
});
