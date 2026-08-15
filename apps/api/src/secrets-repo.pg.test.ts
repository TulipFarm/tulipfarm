import type { PGlite } from "@electric-sql/pglite";
import { PgSecretRepo } from "@tulipfarm/secrets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "./test/pglite";

describe("PgSecretRepo", () => {
  let db: PGlite;
  let repo: PgSecretRepo;

  beforeEach(async () => {
    db = await makeMigratedPglite();
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

  it("round-trips dek_id when tagged, and leaves it NULL when omitted", async () => {
    await repo.upsert("tagged", {
      encryptedValue: "x",
      iv: "i",
      authTag: "t",
      type: "user-provided",
      dekId: "11111111-1111-1111-1111-111111111111",
    });
    await repo.upsert("legacy", {
      encryptedValue: "y",
      iv: "i",
      authTag: "t",
      type: "user-provided",
    });

    expect((await repo.findByKey("tagged"))?.dekId).toBe("11111111-1111-1111-1111-111111111111");
    expect((await repo.findByKey("legacy"))?.dekId).toBeNull();
  });

  it("listLegacyKeys returns only rows with dek_id IS NULL, sorted", async () => {
    await repo.upsert("z-legacy", {
      encryptedValue: "a",
      iv: "i",
      authTag: "t",
      type: "user-provided",
    });
    await repo.upsert("a-legacy", {
      encryptedValue: "b",
      iv: "i",
      authTag: "t",
      type: "user-provided",
    });
    await repo.upsert("tagged", {
      encryptedValue: "c",
      iv: "i",
      authTag: "t",
      type: "user-provided",
      dekId: "22222222-2222-2222-2222-222222222222",
    });

    expect(await repo.listLegacyKeys()).toEqual(["a-legacy", "z-legacy"]);
  });
});
