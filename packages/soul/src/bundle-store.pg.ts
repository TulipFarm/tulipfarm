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
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT soul_execution_bundles_business_digest_key UNIQUE (business_id, digest)
  )`,
  `CREATE INDEX IF NOT EXISTS soul_execution_bundles_business_idx
    ON soul_execution_bundles (business_id, created_at DESC)`,
];

export interface BundleRetentionInput {
  readonly businessId: string;
  /** Only bundles older than this instant are candidates, so in-flight publications get time to finish. */
  readonly olderThan: string;
  readonly limit: number;
}

interface BundleRow {
  readonly digest: string;
  readonly bundle: SignedExecutionBundle["bundle"];
  readonly signature: SignedExecutionBundle["signature"];
}

function recordOf(row: BundleRow): SignedExecutionBundle {
  return { digest: row.digest, bundle: row.bundle, signature: row.signature };
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function assertJsonbSafe(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (value.includes("\u0000")) {
      throw new BundleError(
        "INVALID_DEFINITION",
        `Bundle store: PostgreSQL jsonb cannot store NUL bytes at ${path}`,
        { field: path }
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      assertJsonbSafe(child, `${path}/${index}`);
    });
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assertJsonbSafe(child, `${path}/${pointerSegment(key)}`);
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
    assertJsonbSafe(record.bundle, "");

    await this.transactions.withTransaction(async (transaction) => {
      // ON CONFLICT DO NOTHING gives content-addressed first-wins: a same-digest republish under a
      // new commit/signature is legitimate and dedupes to the authoritative stored bundle.
      await transaction.query(
        `INSERT INTO soul_execution_bundles (
           digest, business_id, changeset_id, commit_sha, bundle, signature
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
         ON CONFLICT (digest) DO NOTHING`,
        [
          record.digest,
          record.bundle.businessId,
          record.bundle.changesetId,
          record.bundle.commitSha,
          JSON.stringify(record.bundle),
          JSON.stringify(record.signature),
        ]
      );
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

  /** Retain bundles any active, pinned, audited, or live publication path can still need. */
  async deleteUnreferencedBundles(input: BundleRetentionInput): Promise<number> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{ digest: string }>(
        `WITH candidates AS (
           SELECT b.digest
             FROM soul_execution_bundles b
            WHERE b.business_id = $1
              AND b.created_at < $2::timestamptz
              AND NOT EXISTS (
                SELECT 1 FROM soul_active_bundles a
                 WHERE a.business_id = b.business_id AND a.digest = b.digest
              )
              AND NOT EXISTS (
                SELECT 1 FROM soul_bundle_activations h
                 WHERE h.business_id = b.business_id AND h.digest = b.digest
              )
              AND NOT EXISTS (
                SELECT 1 FROM runs r
                 WHERE r.business_id = b.business_id AND r.bundle->>'digest' = b.digest
              )
              AND NOT EXISTS (
                SELECT 1 FROM audit_events e
                 WHERE e.business_id = b.business_id AND e.bundle_digest = b.digest
              )
              AND NOT EXISTS (
                SELECT 1 FROM soul_publications p
                 WHERE p.business_id = b.business_id
                   AND p.digest = b.digest
                   AND p.dead_lettered_at IS NULL
              )
            ORDER BY b.created_at, b.digest
            LIMIT $3
         )
         DELETE FROM soul_execution_bundles b
          USING candidates
          WHERE b.digest = candidates.digest
          RETURNING b.digest`,
        [input.businessId, input.olderThan, Math.max(0, Math.trunc(input.limit))]
      );
      return result.rows.length;
    });
  }
}
