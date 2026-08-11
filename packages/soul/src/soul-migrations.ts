import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TulipFarmValidationError, validateSoulConfig } from "@tulipfarm/schema";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { SOUL_MIGRATIONS } from "./migrations/index";
import type { Logger } from "./types";

export async function runSoulMigrations(soulPath: string, logger: Logger): Promise<boolean> {
  const soulYamlPath = join(soulPath, "soul.yaml");

  let manifest: Record<string, unknown> = {};
  try {
    const content = await readFile(soulYamlPath, "utf8");
    manifest = (parseYaml(content) ?? {}) as Record<string, unknown>;
    validateSoulConfig(manifest);
  } catch (err) {
    if (err instanceof TulipFarmValidationError) {
      logger.warn(
        `Soul: skipped format migrations — invalid soul.yaml ${err.path}: ${err.message}`
      );
      return false;
    }
    // soul.yaml absent or unreadable — treat version as 0
  }

  const currentVersion =
    typeof manifest.soulFormatVersion === "number" ? manifest.soulFormatVersion : 0;

  const pending = SOUL_MIGRATIONS.filter((m) => m.version > currentVersion).sort(
    (a, b) => a.version - b.version
  );

  if (pending.length === 0) {
    return false;
  }

  let changed = false;
  for (const migration of pending) {
    logger.info(`Soul: running format migration v${migration.version}: ${migration.description}`);
    try {
      await migration.up(soulPath);
      try {
        manifest = (parseYaml(await readFile(soulYamlPath, "utf8")) ?? {}) as Record<
          string,
          unknown
        >;
      } catch {
        manifest = {};
      }
      manifest = { ...manifest, soulFormatVersion: migration.version };
      validateSoulConfig(manifest);
      await writeFile(soulYamlPath, stringifyYaml(manifest), "utf8");
      changed = true;
      logger.info(`Soul: format migration v${migration.version} applied`);
    } catch (err) {
      logger.error(
        `Soul: format migration v${migration.version} failed — ${err instanceof Error ? err.message : String(err)}`
      );
      return changed;
    }
  }
  return changed;
}
