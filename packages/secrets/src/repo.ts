export type SecretType = "user-provided" | "auto-generated";

export interface SecretDoc {
  _id: string;
  key: string;
  encryptedValue: string; // base64
  iv: string; // base64
  authTag: string; // base64
  type: SecretType;
  createdAt: Date;
  updatedAt: Date;
}

// Fields written on every upsert (the encrypted envelope + metadata). No plaintext.
export interface SecretEnvelopeFields {
  encryptedValue: string;
  iv: string;
  authTag: string;
  type: SecretType;
}

export interface SecretMeta {
  key: string;
  type: SecretType;
  createdAt: Date;
  updatedAt: Date;
}

export interface SecretRepo {
  list(): Promise<SecretMeta[]>;
  findByKey(key: string): Promise<SecretDoc | null>;
  upsert(key: string, fields: SecretEnvelopeFields): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Minimal SQL executor — the structural shape of `pg.Pool` (and the PGlite test client).
 * Defined locally so this package depends on neither `pg` nor the app; the caller injects
 * a real pool.
 */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

function rowToSecret(row: Record<string, unknown>): SecretDoc {
  return {
    // `_id` is vestigial under Postgres (key is the identity); surface the key for any caller that reads it.
    _id: row.key as string,
    key: row.key as string,
    encryptedValue: row.encrypted_value as string,
    iv: row.iv as string,
    authTag: row.auth_tag as string,
    type: row.type as SecretType,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

export class PgSecretRepo implements SecretRepo {
  constructor(private readonly q: Queryable) {}

  async list(): Promise<SecretMeta[]> {
    const { rows } = await this.q.query(
      "SELECT key, type, created_at, updated_at FROM secrets ORDER BY key"
    );
    return rows.map((row) => ({
      key: row.key as string,
      type: row.type as SecretType,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    }));
  }

  async findByKey(key: string): Promise<SecretDoc | null> {
    const { rows } = await this.q.query("SELECT * FROM secrets WHERE key = $1", [key]);
    return rows.length > 0 ? rowToSecret(rows[0]) : null;
  }

  async upsert(key: string, fields: SecretEnvelopeFields): Promise<void> {
    await this.q.query(
      `INSERT INTO secrets (key, encrypted_value, iv, auth_tag, type, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())
       ON CONFLICT (key) DO UPDATE SET
         encrypted_value = EXCLUDED.encrypted_value,
         iv = EXCLUDED.iv,
         auth_tag = EXCLUDED.auth_tag,
         type = EXCLUDED.type,
         updated_at = now()`,
      [key, fields.encryptedValue, fields.iv, fields.authTag, fields.type]
    );
  }

  async delete(key: string): Promise<void> {
    await this.q.query("DELETE FROM secrets WHERE key = $1", [key]);
  }
}
