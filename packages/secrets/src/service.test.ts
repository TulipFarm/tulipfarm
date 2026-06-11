import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DecryptError } from "./crypto";
import type { EncryptionKeys } from "./keys";
import type { SecretDoc, SecretEnvelopeFields, SecretRepo } from "./repo";
import { SecretsService, SecretUnavailableError } from "./service";

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
      ...fields,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async delete(key: string): Promise<void> {
    this.docs.delete(key);
  }
}

function makeKeys(): EncryptionKeys {
  return { current: randomBytes(32) };
}

describe("SecretsService", () => {
  it("set then get returns the original plaintext (round-trip)", async () => {
    const repo = new FakeRepo();
    const svc = new SecretsService(repo, makeKeys());

    await svc.set("api.key", "super-secret");
    expect(await svc.get("api.key")).toBe("super-secret");
  });

  it("stores no plaintext in the repo doc", async () => {
    const repo = new FakeRepo();
    const svc = new SecretsService(repo, makeKeys());

    await svc.set("api.key", "super-secret");

    const doc = repo.docs.get("api.key");
    expect(doc).toBeDefined();
    if (!doc) throw new Error("doc missing");
    expect(doc.encryptedValue).not.toBe("super-secret");
    for (const value of Object.values(doc)) {
      expect(value).not.toBe("super-secret");
    }
  });

  it("serves a fresh cache hit without re-querying the repo", async () => {
    const repo = new FakeRepo();
    let t = 0;
    const svc = new SecretsService(repo, makeKeys(), { now: () => t, ttlMs: 1000 });

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
    const svc = new SecretsService(repo, makeKeys(), { now: () => t, ttlMs: 1000 });

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
    const svc = new SecretsService(repo, makeKeys(), {
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
    const svc = new SecretsService(repo, makeKeys(), {
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
    const svc = new SecretsService(repo, makeKeys(), { log });

    await expect(svc.get("missing")).rejects.toBeInstanceOf(SecretUnavailableError);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("evicts the cache on delete so a later get hits the repo", async () => {
    const repo = new FakeRepo();
    const t = 0;
    const svc = new SecretsService(repo, makeKeys(), { now: () => t, ttlMs: 1_000_000 });

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
    const svc = new SecretsService(repo, makeKeys(), { now: () => t, ttlMs: 1_000_000 });

    await svc.set("api.key", "v1");
    expect(await svc.get("api.key")).toBe("v1"); // caches v1
    expect(repo.findCalls).toBe(1);

    await svc.set("api.key", "v2"); // evicts cache
    expect(await svc.get("api.key")).toBe("v2");
    expect(repo.findCalls).toBe(2);
  });
});

describe("SecretsService — key rotation", () => {
  it("decrypts secret written under old key when previous key is set", async () => {
    const repo = new FakeRepo();
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);

    const oldSvc = new SecretsService(repo, { current: oldKey });
    await oldSvc.set("api.key", "rotate-me");

    const newSvc = new SecretsService(repo, { current: newKey, previous: oldKey });
    expect(await newSvc.get("api.key")).toBe("rotate-me");
  });

  it("re-encrypts under current key on next write after rotation", async () => {
    const repo = new FakeRepo();
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);

    const oldSvc = new SecretsService(repo, { current: oldKey });
    await oldSvc.set("api.key", "rotate-me");

    const rotationSvc = new SecretsService(repo, { current: newKey, previous: oldKey });
    await rotationSvc.set("api.key", "rotate-me"); // re-encrypts under newKey

    // new-key-only service can decrypt — confirms re-encrypted under current key
    const newOnlySvc = new SecretsService(repo, { current: newKey });
    expect(await newOnlySvc.get("api.key")).toBe("rotate-me");
  });

  it("throws DecryptError when both current and previous keys cannot decrypt", async () => {
    const repo = new FakeRepo();
    const writeKey = randomBytes(32);

    const writeSvc = new SecretsService(repo, { current: writeKey });
    await writeSvc.set("api.key", "secret");

    const wrongKeys: EncryptionKeys = { current: randomBytes(32), previous: randomBytes(32) };
    const wrongSvc = new SecretsService(repo, wrongKeys);
    await expect(wrongSvc.get("api.key")).rejects.toBeInstanceOf(DecryptError);
  });
});
