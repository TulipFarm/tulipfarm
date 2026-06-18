import type { SecretEnvelope } from "./crypto";
import type { Queryable } from "./repo";

export type KekLabel = "env" | "recovery";

// One wrap of a DEK under a single KEK. Both wraps of the same DEK share `dekId`. The `canary`
// (a fixed plaintext encrypted under the DEK) lives only on the `env` wrap — the recovery wrap
// stores NULL, since recovery rebuilds the canary under a fresh env wrap.
export interface WrappedDekRow {
  dekId: string;
  kekLabel: KekLabel;
  envelope: SecretEnvelope;
  canary: SecretEnvelope | null;
  createdAt: Date;
  retiredAt: Date | null;
}

export interface InsertWrapInput {
  dekId: string;
  kekLabel: KekLabel;
  envelope: SecretEnvelope;
  canary?: SecretEnvelope | null;
}

export interface DekRepo {
  // Active = retired_at IS NULL. At most one env wrap and one recovery wrap (partial unique idx).
  listActive(): Promise<WrappedDekRow[]>;
  // Upsert by (dek_id, kek_label): provisions a wrap, or re-wraps the existing one in place
  // (KEK rotation / recovery / recovery-key reveal all re-wrap the same DEK under a new KEK).
  insertWrap(input: InsertWrapInput): Promise<void>;
}

function rowToWrappedDek(row: Record<string, unknown>): WrappedDekRow {
  const canaryValue = (row.canary_value as string | null) ?? null;
  return {
    dekId: row.dek_id as string,
    kekLabel: row.kek_label as KekLabel,
    envelope: {
      encryptedValue: row.encrypted_value as string,
      iv: row.iv as string,
      authTag: row.auth_tag as string,
    },
    canary: canaryValue
      ? {
          encryptedValue: canaryValue,
          iv: row.canary_iv as string,
          authTag: row.canary_auth_tag as string,
        }
      : null,
    createdAt: row.created_at as Date,
    retiredAt: (row.retired_at as Date | null) ?? null,
  };
}

export class PgDekRepo implements DekRepo {
  constructor(private readonly q: Queryable) {}

  async listActive(): Promise<WrappedDekRow[]> {
    const { rows } = await this.q.query(
      "SELECT * FROM wrapped_deks WHERE retired_at IS NULL ORDER BY created_at DESC, kek_label"
    );
    return rows.map(rowToWrappedDek);
  }

  async insertWrap(input: InsertWrapInput): Promise<void> {
    const canary = input.canary ?? null;
    await this.q.query(
      `INSERT INTO wrapped_deks
         (dek_id, kek_label, encrypted_value, iv, auth_tag,
          canary_value, canary_iv, canary_auth_tag, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (dek_id, kek_label) DO UPDATE SET
         encrypted_value = EXCLUDED.encrypted_value,
         iv = EXCLUDED.iv,
         auth_tag = EXCLUDED.auth_tag,
         canary_value = EXCLUDED.canary_value,
         canary_iv = EXCLUDED.canary_iv,
         canary_auth_tag = EXCLUDED.canary_auth_tag`,
      [
        input.dekId,
        input.kekLabel,
        input.envelope.encryptedValue,
        input.envelope.iv,
        input.envelope.authTag,
        canary?.encryptedValue ?? null,
        canary?.iv ?? null,
        canary?.authTag ?? null,
      ]
    );
  }
}
