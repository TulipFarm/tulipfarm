import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { SOUL_MIGRATIONS } from "./migrations/index";

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export async function runSoulMigrations(soulPath: string, logger: Logger): Promise<void> {
  const soulYamlPath = join(soulPath, "soul.yaml");

  let manifest: Record<string, unknown> = {};
  try {
    const content = await readFile(soulYamlPath, "utf8");
    manifest = (parseYaml(content) ?? {}) as Record<string, unknown>;
  } catch {
    // soul.yaml absent or unreadable — treat version as 0
  }

  const currentVersion =
    typeof manifest.soulFormatVersion === "number" ? manifest.soulFormatVersion : 0;

  const pending = SOUL_MIGRATIONS.filter((m) => m.version > currentVersion).sort(
    (a, b) => a.version - b.version
  );

  if (pending.length === 0) {
    return;
  }

  for (const migration of pending) {
    logger.info(`Soul: running format migration v${migration.version}: ${migration.description}`);
    try {
      await migration.up(soulPath);
      manifest = { ...manifest, soulFormatVersion: migration.version };
      await writeFile(soulYamlPath, stringifyYaml(manifest), "utf8");
      logger.info(`Soul: format migration v${migration.version} applied`);
    } catch (err) {
      logger.error(
        `Soul: format migration v${migration.version} failed — ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
  }
}
