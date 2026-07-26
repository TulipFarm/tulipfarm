import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { encryptSecret } from "./crypto";
import { SecretsService, SecretUnavailableError } from "./encrypted-store";
import type { ActiveDek } from "./key-manager";
import type { SecretDoc, SecretEnvelopeFields, SecretRepo } from "./repo";

class FakeRepo implements SecretRepo {
  readonly docs = new Map<string, SecretDoc>();
  findCalls = 0;
  throwOnFind = false;

  async list() {
    return [...this.docs.values()].map(({ key, type, createdAt, updatedAt }) => ({
      key,
      type,
      createdAt,
      updatedAt,
    }));
  }

  async findByKey(key: string): Promise<SecretDoc | null> {
    this.findCalls += 1;
    if (this.throwOnFind) {
      throw new Error("datastore unreachable");
    }
    return this.docs.get(key) ?? null;
  }

  async upsert(key: string, fields: SecretEnvelopeFields): Promise<void> {
    const now = new Date();
    const existing = this.docs.get(key);
    this.docs.set(key, {
      _id: existing?._id ?? key,
      key,
      encryptedValue: fields.encryptedValue,
      iv: fields.iv,
      authTag: fields.authTag,
      type: fields.type,
      dekId: fields.dekId ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async delete(key: string): Promise<void> {
    this.docs.delete(key);
  }

  async listLegacyKeys(): Promise<string[]> {
    return [...this.docs.values()].filter((d) => d.dekId === null).map((d) => d.key);
  }
}

function makeDek(): ActiveDek {
  return { dekId: randomUUID(), key: randomBytes(32) };
}

// Seed a legacy row (pre-envelope-encryption): encrypted directly under an env key, dek_id NULL.
function seedLegacy(repo: FakeRepo, key: string, plaintext: string, envKey: Buffer): void {
  const envelope = encryptSecret(plaintext, envKey);
  repo.docs.set(key, {
    _id: key,
    key,
    ...envelope,
    type: "user-provided",
    dekId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe("SecretsService", () => {
  it("set then get returns the original plaintext (round-trip under the DEK)", async () => {
    const repo = new FakeRepo();
    const svc = new SecretsService(repo, makeDek());

    await svc.set("api.key", "super-secret");
    expect(await svc.get("api.key")).toBe("super-secret");
  });

  it("tags the row with the active dekId and stores no plaintext", async () => {
    const repo = new FakeRepo();
    const dek = makeDek();
    const svc = new SecretsService(repo, dek);

    await svc.set("api.key", "super-secret");

    const doc = repo.docs.get("api.key");
    expect(doc).toBeDefined();
    if (!doc) throw new Error("doc missing");
    expect(doc.dekId).toBe(dek.dekId);
    expect(doc.encryptedValue).not.toBe("super-secret");
    for (const value of Object.values(doc)) {
      expect(value).not.toBe("super-secret");
    }
  });

  it("serves a fresh cache hit without re-querying the repo", async () => {
    const repo = new FakeRepo();
    let t = 0;
    const svc = new SecretsService(repo, makeDek(), { now: () => t, ttlMs: 1000 });

    await svc.set("api.key", "v1");
    expect(await svc.get("api.key")).toBe("v1");
    expect(repo.findCalls).toBe(1);

    t = 500; // within ttl
    expect(await svc.get("api.key")).toBe("v1");
    expect(repo.findCalls).toBe(1);
  });

  it("re-queries the repo once the cache entry expires", async () => {
    const repo = new FakeRepo();
    let t = 0;
    const svc = new SecretsService(repo, makeDek(), { now: () => t, ttlMs: 1000 });

    await svc.set("api.key", "v1");
    await svc.get("api.key");
    expect(repo.findCalls).toBe(1);

    t = 1001; // past ttl
    await svc.get("api.key");
    expect(repo.findCalls).toBe(2);
  });

  it("serves stale cached value when the repo throws within the grace window", async () => {
    const repo = new FakeRepo();
    let t = 0;
    const log = { warn: vi.fn() };
    const svc = new SecretsService(repo, makeDek(), {
      now: () => t,
      ttlMs: 1000,
      staleMs: 5000,
      log,
    });

    await svc.set("api.key", "v1");
    await svc.get("api.key"); // primes cache at t=0
    expect(repo.findCalls).toBe(1);

    repo.throwOnFind = true;
    t = 2000; // past ttl, within staleMs

    expect(await svc.get("api.key")).toBe("v1");
    expect(log.warn).toHaveBeenCalledWith({ key: "api.key" }, "secret.served_stale");
  });

  it("throws when the repo throws beyond the grace window", async () => {
    const repo = new FakeRepo();
    let t = 0;
    const log = { warn: vi.fn() };
    const svc = new SecretsService(repo, makeDek(), {
      now: () => t,
      ttlMs: 1000,
      staleMs: 5000,
      log,
    });

    await svc.set("api.key", "v1");
    await svc.get("api.key");

    repo.throwOnFind = true;
    t = 6000; // past staleMs

    await expect(svc.get("api.key")).rejects.toBeInstanceOf(SecretUnavailableError);
  });

  it("throws SecretUnavailableError when the repo returns null (not-found)", async () => {
    const repo = new FakeRepo();
    const log = { warn: vi.fn() };
    const svc = new SecretsService(repo, makeDek(), { log });

    await expect(svc.get("missing")).rejects.toBeInstanceOf(SecretUnavailableError);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("evicts the cache on delete so a later get hits the repo", async () => {
    const repo = new FakeRepo();
    const t = 0;
    const svc = new SecretsService(repo, makeDek(), { now: () => t, ttlMs: 1_000_000 });

    await svc.set("api.key", "v1");
    await svc.get("api.key"); // primes cache
    expect(repo.findCalls).toBe(1);

    await svc.delete("api.key"); // evicts cache + removes from repo
    await expect(svc.get("api.key")).rejects.toBeInstanceOf(SecretUnavailableError);
    expect(repo.findCalls).toBe(2); // cache miss → repo queried
  });

  it("evicts the cache on set so a later get returns the new value", async () => {
    const repo = new FakeRepo();
    const t = 0;
    const svc = new SecretsService(repo, makeDek(), { now: () => t, ttlMs: 1_000_000 });

    await svc.set("api.key", "v1");
    expect(await svc.get("api.key")).toBe("v1"); // caches v1
    expect(repo.findCalls).toBe(1);

    await svc.set("api.key", "v2"); // evicts cache
    expect(await svc.get("api.key")).toBe("v2");
    expect(repo.findCalls).toBe(2);
  });
});

describe("SecretsService — legacy rows (pre-backfill)", () => {
  it("fails closed when a pre-cutover row remains after the required backfill", async () => {
    const repo = new FakeRepo();
    seedLegacy(repo, "legacy.key", "old-secret", randomBytes(32));

    const svc = new SecretsService(repo, makeDek());
    await expect(svc.get("legacy.key")).rejects.toBeInstanceOf(SecretUnavailableError);
  });

  it("a re-set legacy row becomes DEK-tagged and no longer needs the legacy key", async () => {
    const repo = new FakeRepo();
    const envKey = randomBytes(32);
    seedLegacy(repo, "legacy.key", "old-secret", envKey);

    const dek = makeDek();
    const svc = new SecretsService(repo, dek);
    await svc.set("legacy.key", "new-secret"); // re-encrypts under the DEK + tags dekId

    expect(repo.docs.get("legacy.key")?.dekId).toBe(dek.dekId);
    // a DEK-only service (no legacy key) can now read it
    const dekOnly = new SecretsService(repo, dek);
    expect(await dekOnly.get("legacy.key")).toBe("new-secret");
  });
});
