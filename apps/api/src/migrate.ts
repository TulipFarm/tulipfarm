import type { Db } from "mongodb";
import { DATA_MIGRATIONS } from "./migrations/index";

const META_COLLECTION = "_meta";
const VERSION_DOC_ID = "schema_version";

export async function runDataMigrations(db: Db): Promise<void> {
  const meta = db.collection<{ _id: string; version: number }>(META_COLLECTION);

  const versionDoc = await meta.findOne({ _id: VERSION_DOC_ID });
  const currentVersion = versionDoc?.version ?? 0;

  const pending = DATA_MIGRATIONS.filter((m) => m.version > currentVersion).sort(
    (a, b) => a.version - b.version
  );

  if (pending.length === 0) {
    return;
  }

  for (const migration of pending) {
    console.log(`🚀 Running data migration v${migration.version}: ${migration.description}`);
    try {
      await migration.up(db);
      await meta.updateOne(
        { _id: VERSION_DOC_ID },
        { $set: { version: migration.version } },
        { upsert: true }
      );
      console.log(`✅ Data migration v${migration.version} applied`);
    } catch (error) {
      console.error(
        `❌ Data migration v${migration.version} failed: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exit(1);
    }
  }
}
