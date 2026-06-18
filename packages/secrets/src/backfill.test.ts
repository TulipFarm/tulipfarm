import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { backfillSecretsToDek } from "./backfill";
import { decryptSecret, encryptSecret } from "./crypto";
import type { ActiveDek } from "./key-manager";
import type { SecretDoc, SecretEnvelopeFields, SecretRepo } from "./repo";

class FakeRepo implements SecretRepo {
  readonly docs = new Map<string, SecretDoc>();

  async list() {
    return [...this.docs.values()].map(({ key, type, createdAt, updatedAt }) => ({
      key,
      type,
      createdAt,
      updatedAt,
    }));
  }
  async findByKey(key: string): Promise<SecretDoc | null> {
    return this.docs.get(key) ?? null;
  }
  async upsert(key: string, fields: SecretEnvelopeFields): Promise<void> {
    const existing = this.docs.get(key);
    this.docs.set(key, {
      _id: existing?._id ?? key,
      key,
      encryptedValue: fields.encryptedValue,
      iv: fields.iv,
      authTag: fields.authTag,
      type: fields.type,
      dekId: fields.dekId ?? null,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    });
  }
  async delete(key: string): Promise<void> {
    this.docs.delete(key);
  }
  async listLegacyKeys(): Promise<string[]> {
    return [...this.docs.values()].filter((d) => d.dekId === null).map((d) => d.key);
  }

  seedLegacy(key: string, plaintext: string, envKey: Buffer): void {
    this.docs.set(key, {
      _id: key,
      key,
      ...encryptSecret(plaintext, envKey),
      type: "user-provided",
      dekId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

function makeDek(): ActiveDek {
  return { dekId: randomUUID(), key: randomBytes(32) };
}

describe("backfillSecretsToDek", () => {
  it("re-encrypts every legacy row under the DEK and tags it", async () => {
    const repo = new FakeRepo();
    const envKey = randomBytes(32);
    repo.seedLegacy("a", "secret-a", envKey);
    repo.seedLegacy("b", "secret-b", envKey);
    const dek = makeDek();

    const result = await backfillSecretsToDek(repo, dek, { current: envKey });

    expect(result).toEqual({ migrated: 2, failed: [] });
    for (const [key, plaintext] of [
      ["a", "secret-a"],
      ["b", "secret-b"],
    ] as const) {
      const doc = repo.docs.get(key);
      if (!doc) throw new Error(`missing ${key}`);
      expect(doc.dekId).toBe(dek.dekId);
      // decrypts cleanly under the DEK now
      expect(
        decryptSecret(
          { encryptedValue: doc.encryptedValue, iv: doc.iv, authTag: doc.authTag },
          { current: dek.key }
        )
      ).toBe(plaintext);
    }
  });

  it("is idempotent — a second run migrates nothing", async () => {
    const repo = new FakeRepo();
    const envKey = randomBytes(32);
    repo.seedLegacy("a", "secret-a", envKey);
    const dek = makeDek();

    expect((await backfillSecretsToDek(repo, dek, { current: envKey })).migrated).toBe(1);
    expect((await backfillSecretsToDek(repo, dek, { current: envKey })).migrated).toBe(0);
  });

  it("only touches untagged rows (leaves DEK-tagged rows alone)", async () => {
    const repo = new FakeRepo();
    const envKey = randomBytes(32);
    const dek = makeDek();
    repo.seedLegacy("legacy", "old", envKey);
    // a pre-tagged row encrypted under the DEK already
    await repo.upsert("tagged", {
      ...encryptSecret("keep", dek.key),
      type: "user-provided",
      dekId: dek.dekId,
    });
    const taggedBefore = repo.docs.get("tagged")?.encryptedValue;

    const result = await backfillSecretsToDek(repo, dek, { current: envKey });

    expect(result.migrated).toBe(1);
    expect(repo.docs.get("tagged")?.encryptedValue).toBe(taggedBefore); // untouched
  });

  it("decrypts legacy rows under the previous env key (rotation window)", async () => {
    const repo = new FakeRepo();
    const oldEnvKey = randomBytes(32);
    repo.seedLegacy("a", "secret-a", oldEnvKey);
    const dek = makeDek();

    const result = await backfillSecretsToDek(repo, dek, {
      current: randomBytes(32),
      previous: oldEnvKey,
    });

    expect(result.migrated).toBe(1);
  });

  it("reports rows it cannot decrypt as failed and leaves them legacy", async () => {
    const repo = new FakeRepo();
    repo.seedLegacy("good", "ok", randomBytes(32)); // encrypted under a key we will not supply
    const dek = makeDek();

    const result = await backfillSecretsToDek(repo, dek, { current: randomBytes(32) });

    expect(result.migrated).toBe(0);
    expect(result.failed).toEqual(["good"]);
    expect(repo.docs.get("good")?.dekId).toBeNull(); // untouched, still recoverable
  });
});
