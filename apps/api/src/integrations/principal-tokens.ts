import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { Queryable } from "../db";

/**
 * Per-principal provider credentials — authority layer L5's *credential* half (D7).
 *
 * A Tool declaring `credentialMode: "user"` or `"user_preferred"` must spend the calling human's
 * own token, not the deployment's service credential. That is not a convenience: the provider's
 * ACLs are the only thing that can decide whether *this person* may touch *that repository*, and a
 * bot token makes every caller look identical to the provider, so those ACLs stop protecting
 * anything. Acting as the human is what puts them back in the path.
 *
 * No credential material is stored here. Values are sealed into the encrypted secrets store and
 * the row carries only the key — the same split `connection.yaml` makes with `secret://` refs, for
 * the same reason: a database dump taken without the DEK must be inert.
 */

/** Where a principal's sealed provider credential lives in the secrets store. */
export function principalSecretKey(
  principal: { readonly kind: string; readonly id: string },
  provider: string,
  envName: string
): string {
  return `principal.${principal.kind}.${principal.id}.${provider}.${envName}`;
}

export interface PrincipalProviderTokenDoc {
  readonly principalKind: string;
  readonly principalId: string;
  readonly provider: string;
  /** Secrets-store key holding the access token. Never the token itself. */
  readonly secretKey: string;
  readonly refreshSecretKey: string | null;
  /** The provider-side subject this credential acts as, when the flow reported one. */
  readonly externalSubject: string | null;
  readonly scopes: readonly string[];
  readonly connectedAt: Date;
  readonly updatedAt: Date;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface PrincipalProviderTokenRepo {
  /**
   * The principal's live credential for a provider, or `null`. Revoked rows resolve to `null` —
   * revocation must take effect on the next call, not on the next cleanup.
   */
  find(
    principal: { readonly kind: string; readonly id: string },
    provider: string
  ): Promise<PrincipalProviderTokenDoc | null>;
  /** Providers this principal currently holds a live credential for. */
  listProviders(principal: { readonly kind: string; readonly id: string }): Promise<string[]>;
  upsert(doc: PrincipalProviderTokenDoc): Promise<void>;
  /** Marks the credential withdrawn. Returns false when there was nothing live to revoke. */
  revoke(
    principal: { readonly kind: string; readonly id: string },
    provider: string
  ): Promise<boolean>;
}

function rowToDoc(row: Record<string, unknown>): PrincipalProviderTokenDoc {
  return {
    principalKind: row.principal_kind as string,
    principalId: row.principal_id as string,
    provider: row.provider as string,
    secretKey: row.secret_key as string,
    refreshSecretKey: (row.refresh_secret_key as string | null) ?? null,
    externalSubject: (row.external_subject as string | null) ?? null,
    scopes: (row.scopes as string[] | null) ?? [],
    connectedAt: row.connected_at as Date,
    updatedAt: row.updated_at as Date,
    expiresAt: (row.expires_at as Date | null) ?? null,
    revokedAt: (row.revoked_at as Date | null) ?? null,
  };
}

export class PgPrincipalProviderTokenRepo implements PrincipalProviderTokenRepo {
  constructor(
    private readonly q: Queryable,
    private readonly businessId: string = DEPLOYMENT_BUSINESS_ID
  ) {}

  /**
   * A row is only a credential while it is *usable*. Both a tombstone and a lapsed expiry make it
   * unusable, and nothing in the platform refreshes a principal token — there is no refresh path
   * from `refresh_secret_key` today, so an expired row is dead, not merely stale.
   *
   * Filtering expiry here rather than at the caller is what keeps the answer honest: this method is
   * how the resolver decides "has this person connected?", and an expired row read as connected
   * turns an actionable "connect your GitHub" prompt into an opaque provider 401 mid-call, after
   * the gate has already allowed the effect.
   */
  async find(
    principal: { readonly kind: string; readonly id: string },
    provider: string
  ): Promise<PrincipalProviderTokenDoc | null> {
    const { rows } = await this.q.query(
      `SELECT * FROM principal_provider_tokens
        WHERE business_id = $1 AND principal_kind = $2 AND principal_id = $3 AND provider = $4
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())`,
      [this.businessId, principal.kind, principal.id, provider]
    );
    return rows.length > 0 ? rowToDoc(rows[0] as Record<string, unknown>) : null;
  }

  async listProviders(principal: {
    readonly kind: string;
    readonly id: string;
  }): Promise<string[]> {
    const { rows } = await this.q.query(
      `SELECT provider FROM principal_provider_tokens
        WHERE business_id = $1 AND principal_kind = $2 AND principal_id = $3
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY provider`,
      [this.businessId, principal.kind, principal.id]
    );
    return rows.map((row) => (row as Record<string, unknown>).provider as string);
  }

  /**
   * Reconnecting clears `revoked_at`: the same person completing the flow again is granting the
   * access back, and leaving the tombstone would make the new credential unresolvable.
   */
  async upsert(doc: PrincipalProviderTokenDoc): Promise<void> {
    await this.q.query(
      `INSERT INTO principal_provider_tokens (
         business_id, principal_kind, principal_id, provider, secret_key, refresh_secret_key,
         external_subject, scopes, connected_at, updated_at, expires_at, revoked_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL)
       ON CONFLICT (business_id, principal_kind, principal_id, provider) DO UPDATE SET
         secret_key = EXCLUDED.secret_key,
         refresh_secret_key = EXCLUDED.refresh_secret_key,
         external_subject = EXCLUDED.external_subject,
         scopes = EXCLUDED.scopes,
         updated_at = EXCLUDED.updated_at,
         expires_at = EXCLUDED.expires_at,
         revoked_at = NULL`,
      [
        this.businessId,
        doc.principalKind,
        doc.principalId,
        doc.provider,
        doc.secretKey,
        doc.refreshSecretKey,
        doc.externalSubject,
        [...doc.scopes],
        doc.connectedAt,
        doc.updatedAt,
        doc.expiresAt,
      ]
    );
  }

  async revoke(
    principal: { readonly kind: string; readonly id: string },
    provider: string
  ): Promise<boolean> {
    const { rows } = await this.q.query(
      `UPDATE principal_provider_tokens SET revoked_at = now(), updated_at = now()
        WHERE business_id = $1 AND principal_kind = $2 AND principal_id = $3 AND provider = $4
          AND revoked_at IS NULL
        RETURNING provider`,
      [this.businessId, principal.kind, principal.id, provider]
    );
    return rows.length > 0;
  }
}

/** Test/dev double with the same revocation and reconnect semantics as the Postgres adapter. */
/**
 * The double must answer "is this a credential?" exactly as the SQL does, or a test proves a
 * property the deployment does not have. Mirrors `revoked_at IS NULL AND (expires_at IS NULL OR
 * expires_at > now())`.
 */
function usable(row: PrincipalProviderTokenDoc): boolean {
  return row.revokedAt === null && (row.expiresAt === null || row.expiresAt.getTime() > Date.now());
}

export class InMemoryPrincipalProviderTokenRepo implements PrincipalProviderTokenRepo {
  private readonly rows = new Map<string, PrincipalProviderTokenDoc>();

  private key(principal: { readonly kind: string; readonly id: string }, provider: string): string {
    return `${principal.kind}\u0000${principal.id}\u0000${provider}`;
  }

  async find(
    principal: { readonly kind: string; readonly id: string },
    provider: string
  ): Promise<PrincipalProviderTokenDoc | null> {
    const row = this.rows.get(this.key(principal, provider));
    if (row === undefined || !usable(row)) return null;
    return row;
  }

  async listProviders(principal: {
    readonly kind: string;
    readonly id: string;
  }): Promise<string[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.principalKind === principal.kind && row.principalId === principal.id && usable(row)
      )
      .map((row) => row.provider)
      .sort();
  }

  async upsert(doc: PrincipalProviderTokenDoc): Promise<void> {
    const key = this.key({ kind: doc.principalKind, id: doc.principalId }, doc.provider);
    const existing = this.rows.get(key);
    this.rows.set(key, {
      ...doc,
      connectedAt: existing?.connectedAt ?? doc.connectedAt,
      revokedAt: null,
    });
  }

  async revoke(
    principal: { readonly kind: string; readonly id: string },
    provider: string
  ): Promise<boolean> {
    const key = this.key(principal, provider);
    const row = this.rows.get(key);
    if (row === undefined || row.revokedAt !== null) return false;
    this.rows.set(key, { ...row, revokedAt: new Date(), updatedAt: new Date() });
    return true;
  }
}
