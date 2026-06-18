// Operator CLI for the envelope-encryption key lifecycle. Run as:
//   pnpm --filter @tulipfarm/api keys <command>
// Reuses the same tested key-manager primitives the server boots with. Reads .env.local and
// DATABASE_URL exactly like the server, and runs migrations first so a fresh DB is usable.
import {
  backfillSecretsToDek,
  loadEncryptionKeys,
  loadOrProvisionActiveDek,
  PgDekRepo,
  PgSecretRepo,
  provisionRecoveryKey,
  recoverWithKey,
  rotateEnvKek,
} from "@tulipfarm/secrets";
import { config } from "dotenv";
import { connectPg } from "../db";
import { runPgMigrations } from "../pg-migrate";

config({ path: ".env.local" });

const USAGE = "usage: keys <verify|show-recovery|rotate-kek|recover|backfill>";

async function main(): Promise<void> {
  const command = process.argv[2];
  const pool = await connectPg();
  try {
    await runPgMigrations(pool);
    const dekRepo = new PgDekRepo(pool);
    const secretRepo = new PgSecretRepo(pool);
    const envKek = loadEncryptionKeys();

    switch (command) {
      case "verify":
      case "status": {
        const dek = await loadOrProvisionActiveDek(dekRepo, envKek);
        const labels = (await dekRepo.listActive()).map((w) => w.kekLabel).sort();
        console.log(`✅ active DEK ${dek.dekId} — env wrap unwraps, canary OK`);
        console.log(`   wraps: ${labels.join(", ")}`);
        if (!labels.includes("recovery")) {
          console.log("   ⚠ no recovery key yet — run `keys show-recovery` to create one");
        }
        break;
      }
      case "show-recovery": {
        const dek = await loadOrProvisionActiveDek(dekRepo, envKek);
        const recoveryKek = await provisionRecoveryKey(dekRepo, dek);
        console.log("────────────────────────────────────────────────────────────");
        console.log("  RECOVERY KEY — shown ONCE. Store it offline (password");
        console.log("  manager / sealed vault). It is never displayed again and");
        console.log("  is not stored in the database or environment.");
        console.log("");
        console.log(`    ${recoveryKek.toString("base64")}`);
        console.log("");
        console.log("  If ENCRYPTION_KEY is ever lost: set a fresh ENCRYPTION_KEY,");
        console.log("  then run  RECOVERY_KEY=<this> pnpm --filter @tulipfarm/api keys recover");
        console.log("────────────────────────────────────────────────────────────");
        break;
      }
      case "rotate-kek": {
        // Operator has set the new key as ENCRYPTION_KEY and the old as ENCRYPTION_KEY_PREVIOUS.
        const dek = await rotateEnvKek(dekRepo, envKek);
        console.log(`✅ re-wrapped DEK ${dek.dekId} under the current ENCRYPTION_KEY`);
        console.log("   Verify the new key works BEFORE removing ENCRYPTION_KEY_PREVIOUS:");
        console.log("     pnpm --filter @tulipfarm/api keys verify");
        break;
      }
      case "recover": {
        const raw = process.env.RECOVERY_KEY;
        if (!raw) {
          throw new Error("set RECOVERY_KEY=<base64 recovery key> in the environment");
        }
        const dek = await recoverWithKey(dekRepo, Buffer.from(raw, "base64"), envKek);
        console.log(`✅ recovered DEK ${dek.dekId}, re-wrapped under the current ENCRYPTION_KEY`);
        break;
      }
      case "backfill": {
        const dek = await loadOrProvisionActiveDek(dekRepo, envKek);
        const result = await backfillSecretsToDek(secretRepo, dek, envKek);
        console.log(
          `✅ backfill complete — migrated ${result.migrated}, failed ${result.failed.length}`
        );
        if (result.failed.length > 0) {
          console.log(
            `   ⚠ failed (left legacy under ENCRYPTION_KEY): ${result.failed.join(", ")}`
          );
          console.log("   These rows are still readable ONLY while their original encryption key");
          console.log("   is configured. Do NOT remove ENCRYPTION_KEY / ENCRYPTION_KEY_PREVIOUS");
          console.log("   until every failed row is resolved, or they become unrecoverable.");
          process.exitCode = 1;
        }
        break;
      }
      default:
        console.log(USAGE);
        process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
