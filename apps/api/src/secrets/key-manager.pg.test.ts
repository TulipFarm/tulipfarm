import { randomBytes } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  backfillSecretsToDek,
  decryptSecret,
  encryptSecret,
  KeyManagerError,
  loadOrProvisionActiveDek,
  PgDekRepo,
  PgSecretRepo,
  provisionRecoveryKey,
  recoverWithKey,
  rotateEnvKek,
} from "@tulipfarm/secrets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";

describe("key-manager over PgDekRepo", () => {
  let db: PGlite;
  let dekRepo: PgDekRepo;
  let secretRepo: PgSecretRepo;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    dekRepo = new PgDekRepo(db);
    secretRepo = new PgSecretRepo(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("auto-provisions a DEK on first load and reloads the same DEK (canary verified)", async () => {
    const envKek = { current: randomBytes(32) };
    const first = await loadOrProvisionActiveDek(dekRepo, envKek);
    const second = await loadOrProvisionActiveDek(dekRepo, envKek);

    expect(second.dekId).toBe(first.dekId);
    expect(second.key.equals(first.key)).toBe(true);

    const active = await dekRepo.listActive();
    expect(active.map((w) => w.kekLabel)).toEqual(["env"]);
  });

  it("rotates the env KEK in place (old key stops loading, new key loads)", async () => {
    const oldKek = randomBytes(32);
    const newKek = randomBytes(32);
    await loadOrProvisionActiveDek(dekRepo, { current: oldKek });

    await rotateEnvKek(dekRepo, { current: newKek, previous: oldKek });

    await expect(loadOrProvisionActiveDek(dekRepo, { current: newKek })).resolves.toBeDefined();
    await expect(loadOrProvisionActiveDek(dekRepo, { current: oldKek })).rejects.toBeInstanceOf(
      KeyManagerError
    );

    // still exactly one active env wrap (upsert in place, no duplicate)
    const active = await dekRepo.listActive();
    expect(active.filter((w) => w.kekLabel === "env")).toHaveLength(1);
  });

  it("recovers via the offline recovery key after the env key is lost", async () => {
    const originalEnvKek = randomBytes(32);
    const dek = await loadOrProvisionActiveDek(dekRepo, { current: originalEnvKek });
    const recoveryKek = await provisionRecoveryKey(dekRepo, dek);

    const freshEnvKek = randomBytes(32);
    await expect(
      loadOrProvisionActiveDek(dekRepo, { current: freshEnvKek })
    ).rejects.toBeInstanceOf(KeyManagerError);

    const recovered = await recoverWithKey(dekRepo, recoveryKek, { current: freshEnvKek });
    expect(recovered.key.equals(dek.key)).toBe(true);

    const reloaded = await loadOrProvisionActiveDek(dekRepo, { current: freshEnvKek });
    expect(reloaded.key.equals(dek.key)).toBe(true);

    // both wraps remain active: env (rebuilt) + recovery
    const labels = (await dekRepo.listActive()).map((w) => w.kekLabel).sort();
    expect(labels).toEqual(["env", "recovery"]);
  });

  it("fail-fasts at load when the stored env wrap is corrupted (boot canary)", async () => {
    const envKek = { current: randomBytes(32) };
    await loadOrProvisionActiveDek(dekRepo, envKek);

    // simulate at-rest corruption / wrong key: clobber the env wrap's auth tag
    await db.query("UPDATE wrapped_deks SET auth_tag = $1 WHERE kek_label = 'env'", [
      randomBytes(16).toString("base64"),
    ]);

    await expect(loadOrProvisionActiveDek(dekRepo, envKek)).rejects.toBeInstanceOf(KeyManagerError);
  });

  it("backfills a legacy secret onto the DEK end-to-end", async () => {
    const envKek = { current: randomBytes(32) };
    // seed a legacy row: encrypted directly under the env key, dek_id NULL
    const legacy = encryptSecret("legacy-value", envKek.current);
    await secretRepo.upsert("legacy.key", { ...legacy, type: "user-provided" });
    expect((await secretRepo.findByKey("legacy.key"))?.dekId).toBeNull();

    const dek = await loadOrProvisionActiveDek(dekRepo, envKek);
    const result = await backfillSecretsToDek(secretRepo, dek, envKek);

    expect(result).toEqual({ migrated: 1, failed: [] });
    const doc = await secretRepo.findByKey("legacy.key");
    if (!doc) throw new Error("missing");
    expect(doc.dekId).toBe(dek.dekId);
    expect(
      decryptSecret(
        { encryptedValue: doc.encryptedValue, iv: doc.iv, authTag: doc.authTag },
        { current: dek.key }
      )
    ).toBe("legacy-value");
    expect(await secretRepo.listLegacyKeys()).toEqual([]);
  });
});
