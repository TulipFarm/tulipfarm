import type { PGlite } from "@electric-sql/pglite";
import { PgSecretRepo } from "@tulipfarm/secrets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "./pg-migrate";
import { makePglite } from "./test/pglite";

describe("PgSecretRepo", () => {
  let db: PGlite;
  let repo: PgSecretRepo;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    repo = new PgSecretRepo(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("upserts then reads back the encrypted envelope", async () => {
    await repo.upsert("openai", {
      encryptedValue: "ct",
      iv: "iv0",
      authTag: "tag0",
      type: "user-provided",
    });
    const doc = await repo.findByKey("openai");
    expect(doc?.encryptedValue).toBe("ct");
    expect(doc?.iv).toBe("iv0");
    expect(doc?.authTag).toBe("tag0");
    expect(doc?.type).toBe("user-provided");
    expect(doc?.createdAt).toBeInstanceOf(Date);
    expect(doc?.updatedAt).toBeInstanceOf(Date);
  });

  it("upsert updates the envelope but preserves created_at", async () => {
    await repo.upsert("k", { encryptedValue: "a", iv: "i", authTag: "t", type: "auto-generated" });
    const first = await repo.findByKey("k");
    await repo.upsert("k", { encryptedValue: "b", iv: "i2", authTag: "t2", type: "user-provided" });
    const second = await repo.findByKey("k");
    expect(second?.encryptedValue).toBe("b");
    expect(second?.type).toBe("user-provided");
    expect(second?.createdAt.toISOString()).toBe(first?.createdAt.toISOString());
  });

  it("lists metadata only (no secret material), sorted by key", async () => {
    await repo.upsert("b-key", {
      encryptedValue: "x",
      iv: "i",
      authTag: "t",
      type: "user-provided",
    });
    await repo.upsert("a-key", {
      encryptedValue: "y",
      iv: "i",
      authTag: "t",
      type: "auto-generated",
    });
    const metas = await repo.list();
    expect(metas.map((m) => m.key)).toEqual(["a-key", "b-key"]);
    expect(metas[0]).not.toHaveProperty("encryptedValue");
  });

  it("deletes a secret", async () => {
    await repo.upsert("gone", {
      encryptedValue: "x",
      iv: "i",
      authTag: "t",
      type: "user-provided",
    });
    await repo.delete("gone");
    expect(await repo.findByKey("gone")).toBeNull();
  });
});
