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

  async get(key: string): Promise<string> {
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.fetchedAt < this.ttlMs) {
      return cached.value;
    }

    let doc: Awaited<ReturnType<SecretRepo["findByKey"]>>;
    try {
      doc = await this.repo.findByKey(key);
    } catch {
      // Serving a cached plaintext past its TTL is a deliberate availability tradeoff for a
      // transient read failure. It must not outlive a rotation or deletion, so the extension is
      // gated on positive proof that the row is still the revision we cached.
      if (cached && this.now() - cached.fetchedAt < this.staleMs) {
        return await this.serveStale(key, cached);
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
    this.cache.set(key, { value, fetchedAt: this.now(), revision: doc.updatedAt });
    return value;
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
