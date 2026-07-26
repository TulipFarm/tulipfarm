import { decryptSecret, encryptSecret, type SecretEnvelope } from "./crypto";
import { assertValidSecretKey } from "./key-guard";
import type { ActiveDek } from "./key-manager";
import type { SecretMeta, SecretRepo, SecretType } from "./repo";

export class SecretUnavailableError extends Error {}

export interface SecretsServiceDeps {
  now?: () => number;
  log?: { warn: (obj: object, msg: string) => void };
  ttlMs?: number;
  staleMs?: number;
}

interface CacheEntry {
  value: string;
  fetchedAt: number;
}

export class SecretsService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private readonly log?: { warn: (obj: object, msg: string) => void };
  private readonly ttlMs: number;
  private readonly staleMs: number;

  constructor(
    private readonly repo: SecretRepo,
    private readonly dek: ActiveDek,
    deps: SecretsServiceDeps = {}
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log;
    this.ttlMs = deps.ttlMs ?? 300_000;
    this.staleMs = deps.staleMs ?? 900_000;
  }

  async list(): Promise<SecretMeta[]> {
    return this.repo.list();
  }

  async delete(key: string): Promise<void> {
    await this.repo.delete(key);
    this.cache.delete(key);
  }

  async set(key: string, plaintext: string, type: SecretType = "user-provided"): Promise<void> {
    assertValidSecretKey(key);
    const envelope = encryptSecret(plaintext, this.dek.key);
    await this.repo.upsert(key, { ...envelope, type, dekId: this.dek.dekId });
    this.cache.delete(key);
  }

  async get(key: string): Promise<string> {
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.fetchedAt < this.ttlMs) {
      return cached.value;
    }

    let doc: Awaited<ReturnType<SecretRepo["findByKey"]>>;
    try {
      doc = await this.repo.findByKey(key);
    } catch {
      if (cached && this.now() - cached.fetchedAt < this.staleMs) {
        this.log?.warn({ key }, "secret.served_stale");
        return cached.value;
      }
      throw new SecretUnavailableError(`secret unavailable: ${key}`);
    }

    if (!doc) {
      throw new SecretUnavailableError(`secret not found: ${key}`);
    }

    const envelope: SecretEnvelope = {
      encryptedValue: doc.encryptedValue,
      iv: doc.iv,
      authTag: doc.authTag,
    };
    const value = this.decrypt(doc.dekId, envelope);
    this.cache.set(key, { value, fetchedAt: this.now() });
    return value;
  }

  private decrypt(dekId: string | null, envelope: SecretEnvelope): string {
    if (!dekId) {
      throw new SecretUnavailableError(
        "pre-cutover secret row remains after the required backfill"
      );
    }
    return decryptSecret(envelope, { current: this.dek.key });
  }
}
