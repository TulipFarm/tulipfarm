import type { TransactionPort } from "@tulipfarm/storage";
import {
  BundleError,
  type BundleStore,
  computeBundleDigest,
  type SignedExecutionBundle,
} from "./bundle";

export const SOUL_BUNDLE_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS soul_execution_bundles (
    digest       text PRIMARY KEY CHECK (length(digest) > 0),
    business_id  text NOT NULL CHECK (length(business_id) > 0),
    changeset_id text NOT NULL CHECK (length(changeset_id) > 0),
    commit_sha   text NOT NULL CHECK (length(commit_sha) > 0),
    bundle       jsonb NOT NULL CHECK (jsonb_typeof(bundle) = 'object'),
    signature    jsonb NOT NULL CHECK (
      jsonb_typeof(signature) = 'object'
      AND signature ?& ARRAY['keyId', 'value']
    ),
    created_at   timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS soul_execution_bundles_business_idx
    ON soul_execution_bundles (business_id, created_at DESC)`,
];

interface BundleRow {
  readonly digest: string;
  readonly bundle: SignedExecutionBundle["bundle"];
  readonly signature: SignedExecutionBundle["signature"];
}

function recordOf(row: BundleRow): SignedExecutionBundle {
  return { digest: row.digest, bundle: row.bundle, signature: row.signature };
}

function assertSameSignature(stored: SignedExecutionBundle, incoming: SignedExecutionBundle): void {
  if (
    stored.signature.keyId !== incoming.signature.keyId ||
    stored.signature.value !== incoming.signature.value
  ) {
    throw new BundleError(
      "DIGEST_CONFLICT",
      `Bundle store: digest ${incoming.digest} is already stored with a different signature`
    );
  }
}

/** Durable, append-only PostgreSQL storage for signed execution bundles. */
export class PgBundleStore implements BundleStore {
  constructor(private readonly transactions: TransactionPort) {}

  async put(record: SignedExecutionBundle): Promise<void> {
    const digest = computeBundleDigest(record.bundle);
    if (digest !== record.digest) {
      throw new BundleError(
        "DIGEST_MISMATCH",
        "Bundle store: record digest does not cover its bundle"
      );
    }

    await this.transactions.withTransaction(async (transaction) => {
      const inserted = await transaction.query<{ digest: string }>(
        `INSERT INTO soul_execution_bundles (
           digest, business_id, changeset_id, commit_sha, bundle, signature
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
         ON CONFLICT (digest) DO NOTHING
         RETURNING digest`,
        [
          record.digest,
          record.bundle.businessId,
          record.bundle.changesetId,
          record.bundle.commitSha,
          JSON.stringify(record.bundle),
          JSON.stringify(record.signature),
        ]
      );
      if (inserted.rows.length === 1) return;

      const existing = await transaction.query<BundleRow>(
        "SELECT digest, bundle, signature FROM soul_execution_bundles WHERE digest = $1",
        [record.digest]
      );
      const row = existing.rows[0];
      if (!row) throw new Error("bundle_conflict_without_row");
      assertSameSignature(recordOf(row), record);
    });
  }

  async get(digest: string): Promise<SignedExecutionBundle | undefined> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<BundleRow>(
        "SELECT digest, bundle, signature FROM soul_execution_bundles WHERE digest = $1",
        [digest]
      );
      const row = result.rows[0];
      return row ? recordOf(row) : undefined;
    });
  }
}
