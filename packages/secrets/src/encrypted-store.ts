import { decryptSecret, encryptSecret, type SecretEnvelope } from "./crypto";
import { assertValidSecretKey } from "./key-guard";
import type { ActiveDek } from "./key-manager";
import type { SecretMeta, SecretRepo, SecretType } from "./repo";

export class SecretUnavailableError extends Error {}

/**
 * A cached plaintext was withheld because the Secret was rotated or deleted — by this process or
 * another one — since it was cached. Distinct from a plain outage so callers and operators can
 * tell "we could not read it" from "it no longer exists".
 *
 * Extends {@link SecretUnavailableError} so existing failure handling keeps working.
 */
export class SecretRevokedError extends SecretUnavailableError {}

export interface SecretsServiceDeps {
  now?: () => number;
  log?: { warn: (obj: object, msg: string) => void };
  ttlMs?: number;
  staleMs?: number;
}

interface CacheEntry {
  value: string;
  fetchedAt: number;
  /** `updated_at` of the row this plaintext came from; the stale path re-checks it. */
  revision: Date | null;
}

/**
 * Both markers come from the database, so this is an equality check, never an ordering one — no
 * app/database clock comparison is involved. A missing row (`null`) is a deletion, never a match.
 */
function isSameRevision(current: Date | null, cached: Date | null): boolean {
  if (current === null || cached === null) return false;
  return current.getTime() === cached.getTime();
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

  /**
   * Rotates related values together when the storage implementation supports it.
   *
   * OAuth providers may rotate access and refresh tokens in one response. Persisting those values
   * in one statement avoids exposing a durable half-rotation to another process.
   */
  async setMany(
    values: Readonly<Record<string, string>>,
    type: SecretType = "user-provided"
  ): Promise<void> {
    const entries = Object.entries(values);
    for (const [key] of entries) assertValidSecretKey(key);
    const encrypted = entries.map(([key, plaintext]) => ({
      key,
      fields: { ...encryptSecret(plaintext, this.dek.key), type, dekId: this.dek.dekId },
    }));
    if (this.repo.upsertMany !== undefined) {
      await this.repo.upsertMany(encrypted);
    } else {
      await Promise.all(encrypted.map(({ key, fields }) => this.repo.upsert(key, fields)));
    }
    for (const { key } of encrypted) this.cache.delete(key);
  }

  async get(key: string): Promise<string> {
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.fetchedAt < this.ttlMs) {
      return cached.value;
    }

    try {
      return (await this.resolveCurrent(key)).value;
    } catch (error) {
      if (
        error instanceof SecretUnavailableError &&
        !(error instanceof SecretRevokedError) &&
        cached &&
        this.now() - cached.fetchedAt < this.staleMs
      ) {
        return await this.serveStale(key, cached);
      }
      throw error;
    }
  }

  /** Reads and decrypts the current durable revision, bypassing the plaintext cache. */
  async resolveCurrent(key: string): Promise<{ value: string; version: string }> {
    let doc: Awaited<ReturnType<SecretRepo["findByKey"]>>;
    try {
      doc = await this.repo.findByKey(key);
    } catch {
      throw new SecretUnavailableError(`secret unavailable: ${key}`);
    }

    if (!doc) {
      throw new SecretRevokedError(`secret not found: ${key}`);
    }

    const envelope: SecretEnvelope = {
      encryptedValue: doc.encryptedValue,
      iv: doc.iv,
      authTag: doc.authTag,
    };
    const value = this.decrypt(doc.dekId, envelope);
    this.cache.set(key, { value, fetchedAt: this.now(), revision: doc.updatedAt });
    return { value, version: doc.updatedAt.toISOString() };
  }

  /** Current durable revision marker, or `null` after deletion/revocation. */
  async revision(key: string): Promise<string | null> {
    let revision: Date | null;
    try {
      revision = await this.repo.findRevision(key);
    } catch {
      throw new SecretUnavailableError(`secret unavailable: ${key}`);
    }
    return revision?.toISOString() ?? null;
  }

  /**
   * Extends a cached plaintext past its TTL, but only against a revision probe.
   *
   * The TTL window itself is untouched by this: a fresh entry is served with no probe at all. This
   * governs only the grace window, which by definition means nothing has confirmed the value for
   * at least `ttlMs`.
   *
   * @throws {SecretRevokedError} the row was rotated or deleted since it was cached.
   * @throws {SecretUnavailableError} the probe failed, so revocation state is unknown.
   */
  private async serveStale(key: string, cached: CacheEntry): Promise<string> {
    let revision: Date | null;
    try {
      revision = await this.repo.findRevision(key);
    } catch {
      // The probe is the only evidence that another process has not revoked this Secret. Without
      // it a database outage is indistinguishable from a rotation, and a revoked credential still
      // authenticating against a third party is an external, irreversible effect — so the grace
      // window closes rather than guessing. Callers see the same failure as an expired window.
      this.log?.warn({ key, reason: "revocation_unknown" }, "secret.stale_refused");
      throw new SecretUnavailableError(`secret unavailable: ${key}`);
    }

    if (!isSameRevision(revision, cached.revision)) {
      this.cache.delete(key);
      this.log?.warn({ key, reason: "revoked" }, "secret.stale_refused");
      throw new SecretRevokedError(`secret revoked: ${key}`);
    }

    this.log?.warn({ key }, "secret.served_stale");
    return cached.value;
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
