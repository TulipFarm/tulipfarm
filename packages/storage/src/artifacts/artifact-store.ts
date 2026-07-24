import type { BlobRef, TransactionPort } from "../ports";

export type ArtifactContentKind = "inline" | "blob";

/** Principal refs (`kind:id`) allowed to read. An empty list denies everyone (default-deny). */
export interface ArtifactAcl {
  readonly readers: readonly string[];
}

export type ArtifactRetentionPolicy = "ephemeral" | "standard" | "legal_hold";

export interface ArtifactRetention {
  readonly policy: ArtifactRetentionPolicy;
  readonly expiresAt: string | null;
}

/** JSON pointers removed before storage; the stored content must not contain them. */
export interface ArtifactRedaction {
  readonly redactedPaths: readonly string[];
}

export interface ArtifactProducer {
  readonly runId: string;
  readonly stateKey: string;
  readonly attempt: number;
}

export interface PutArtifactInput {
  readonly id: string;
  readonly businessId: string;
  readonly schemaRef: string;
  /** Inline content, or `null` when the payload lives in the blob store. */
  readonly content: Record<string, unknown> | null;
  readonly blob: BlobRef | null;
  readonly contentHash: string;
  readonly classification: readonly string[];
  readonly acl: ArtifactAcl;
  readonly retention: ArtifactRetention;
  readonly redaction: ArtifactRedaction;
  readonly producer: ArtifactProducer;
  readonly createdAt: string;
}

export interface PersistedArtifact {
  readonly id: string;
  readonly businessId: string;
  readonly schemaRef: string;
  readonly contentKind: ArtifactContentKind;
  readonly content: Record<string, unknown> | null;
  readonly blob: BlobRef | null;
  readonly contentHash: string;
  readonly classification: readonly string[];
  readonly acl: ArtifactAcl;
  readonly retention: ArtifactRetention;
  readonly redaction: ArtifactRedaction;
  readonly producer: ArtifactProducer;
  readonly createdAt: string;
}

export interface PutArtifactResult {
  readonly outcome: "created" | "duplicate";
}

export interface BindOutputInput {
  readonly businessId: string;
  readonly runId: string;
  readonly stateKey: string;
  readonly outputName: string;
  readonly artifactId: string;
  readonly createdAt: string;
}

export interface BindOutputResult {
  readonly outcome: "bound" | "duplicate";
}

export interface StateOutputBinding {
  readonly businessId: string;
  readonly runId: string;
  readonly stateKey: string;
  readonly outputName: string;
  readonly artifactId: string;
  readonly createdAt: string;
}

export type ArtifactLineageRelation = "derived_from" | "redacted_from" | "replay_of";

export interface AppendArtifactLineageInput {
  readonly businessId: string;
  readonly artifactId: string;
  readonly sourceArtifactId: string;
  readonly relation: ArtifactLineageRelation;
  readonly createdAt: string;
}

export interface ArtifactLineageEdge extends AppendArtifactLineageInput {}

export type ArtifactPersistenceErrorCode =
  | "artifact_conflict"
  /** Exactly one of inline content or a blob reference is required; PostgreSQL CHECKs the same. */
  | "artifact_content_shape"
  | "output_binding_conflict";

export class ArtifactPersistenceError extends Error {
  readonly name = "ArtifactPersistenceError";

  constructor(readonly code: ArtifactPersistenceErrorCode) {
    super(code);
  }
}

const RETENTION_POLICY_SQL = "'ephemeral', 'standard', 'legal_hold'";
const LINEAGE_RELATION_SQL = "'derived_from', 'redacted_from', 'replay_of'";

export const ARTIFACT_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS artifacts (
    business_id           text NOT NULL,
    id                    text NOT NULL CHECK (length(id) > 0),
    schema_ref            text NOT NULL CHECK (length(schema_ref) > 0),
    content_kind          text NOT NULL CHECK (content_kind IN ('inline', 'blob')),
    content               jsonb CHECK (content IS NULL OR jsonb_typeof(content) = 'object'),
    blob_key              text,
    blob_hash             text,
    content_hash          text NOT NULL CHECK (length(content_hash) > 0),
    classification        text[] NOT NULL,
    acl                   jsonb NOT NULL CHECK (jsonb_typeof(acl->'readers') = 'array'),
    retention             jsonb NOT NULL CHECK (
      jsonb_typeof(retention) = 'object'
      AND retention->>'policy' IN (${RETENTION_POLICY_SQL})
    ),
    redaction             jsonb NOT NULL CHECK (jsonb_typeof(redaction->'redactedPaths') = 'array'),
    producer              jsonb NOT NULL CHECK (
      jsonb_typeof(producer) = 'object'
      AND producer ?& ARRAY['runId', 'stateKey', 'attempt']
    ),
    created_at            timestamptz NOT NULL,
    PRIMARY KEY (business_id, id),
    CHECK (
      (content_kind = 'inline'
        AND content IS NOT NULL AND blob_key IS NULL AND blob_hash IS NULL)
      OR (content_kind = 'blob'
        AND content IS NULL AND blob_key IS NOT NULL AND blob_hash IS NOT NULL)
    )
  )`,
  `CREATE TABLE IF NOT EXISTS state_output_bindings (
    business_id           text NOT NULL,
    run_id                text NOT NULL CHECK (length(run_id) > 0),
    state_key             text NOT NULL CHECK (length(state_key) > 0),
    output_name           text NOT NULL CHECK (length(output_name) > 0),
    artifact_id           text NOT NULL,
    created_at            timestamptz NOT NULL,
    PRIMARY KEY (business_id, run_id, state_key, output_name),
    FOREIGN KEY (business_id, artifact_id) REFERENCES artifacts(business_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS artifact_lineage (
    business_id           text NOT NULL,
    artifact_id           text NOT NULL,
    source_artifact_id    text NOT NULL,
    relation              text NOT NULL CHECK (relation IN (${LINEAGE_RELATION_SQL})),
    created_at            timestamptz NOT NULL,
    PRIMARY KEY (business_id, artifact_id, source_artifact_id, relation),
    FOREIGN KEY (business_id, artifact_id) REFERENCES artifacts(business_id, id),
    FOREIGN KEY (business_id, source_artifact_id) REFERENCES artifacts(business_id, id),
    CHECK (artifact_id <> source_artifact_id)
  )`,
  `CREATE OR REPLACE FUNCTION reject_artifact_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'artifact_immutable';
    END;
    $$`,
  "DROP TRIGGER IF EXISTS artifacts_immutable ON artifacts",
  `CREATE TRIGGER artifacts_immutable
    BEFORE UPDATE OR DELETE ON artifacts
    FOR EACH ROW EXECUTE FUNCTION reject_artifact_mutation()`,
  "DROP TRIGGER IF EXISTS state_output_bindings_immutable ON state_output_bindings",
  `CREATE TRIGGER state_output_bindings_immutable
    BEFORE UPDATE OR DELETE ON state_output_bindings
    FOR EACH ROW EXECUTE FUNCTION reject_artifact_mutation()`,
  "DROP TRIGGER IF EXISTS artifact_lineage_immutable ON artifact_lineage",
  `CREATE TRIGGER artifact_lineage_immutable
    BEFORE UPDATE OR DELETE ON artifact_lineage
    FOR EACH ROW EXECUTE FUNCTION reject_artifact_mutation()`,
  `CREATE INDEX IF NOT EXISTS artifacts_producer_idx
    ON artifacts (business_id, (producer->>'runId'), created_at)`,
  `CREATE INDEX IF NOT EXISTS state_output_bindings_run_idx
    ON state_output_bindings (business_id, run_id, state_key)`,
  `CREATE INDEX IF NOT EXISTS artifact_lineage_source_idx
    ON artifact_lineage (business_id, source_artifact_id, created_at)`,
];

interface ArtifactRow {
  business_id: string;
  id: string;
  schema_ref: string;
  content_kind: ArtifactContentKind;
  content: Record<string, unknown> | null;
  blob_key: string | null;
  blob_hash: string | null;
  content_hash: string;
  classification: string[];
  acl: ArtifactAcl;
  retention: ArtifactRetention;
  redaction: ArtifactRedaction;
  producer: ArtifactProducer;
  created_at: string | Date;
}

interface BindingRow {
  business_id: string;
  run_id: string;
  state_key: string;
  output_name: string;
  artifact_id: string;
  created_at: string | Date;
}

interface LineageRow {
  business_id: string;
  artifact_id: string;
  source_artifact_id: string;
  relation: ArtifactLineageRelation;
  created_at: string | Date;
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function persistedArtifact(row: ArtifactRow): PersistedArtifact {
  return {
    id: row.id,
    businessId: row.business_id,
    schemaRef: row.schema_ref,
    contentKind: row.content_kind,
    content: row.content,
    blob:
      row.blob_key === null || row.blob_hash === null
        ? null
        : { key: row.blob_key, hash: row.blob_hash },
    contentHash: row.content_hash,
    classification: row.classification,
    acl: row.acl,
    retention: row.retention,
    redaction: row.redaction,
    producer: row.producer,
    createdAt: timestamp(row.created_at),
  };
}

function binding(row: BindingRow): StateOutputBinding {
  return {
    businessId: row.business_id,
    runId: row.run_id,
    stateKey: row.state_key,
    outputName: row.output_name,
    artifactId: row.artifact_id,
    createdAt: timestamp(row.created_at),
  };
}

const ARTIFACT_COLUMNS = `business_id, id, schema_ref, content_kind, content, blob_key, blob_hash,
  content_hash, classification, acl, retention, redaction, producer, created_at`;
const JOINED_ARTIFACT_COLUMNS = `a.business_id, a.id, a.schema_ref, a.content_kind, a.content,
  a.blob_key, a.blob_hash, a.content_hash, a.classification, a.acl, a.retention, a.redaction,
  a.producer, a.created_at`;
const BINDING_COLUMNS = "business_id, run_id, state_key, output_name, artifact_id, created_at";

/**
 * PostgreSQL persistence for immutable Artifacts, their named State-output mappings, and their
 * lineage edges. Rows are append-only (triggers reject UPDATE/DELETE), so a stored Artifact keeps
 * the hash, classification, ACL, and retention it was published with.
 */
export class ArtifactStore {
  constructor(private readonly transactions: TransactionPort) {}

  /**
   * Inserts an Artifact once. A replay of the same identity and hash is a `duplicate`; the same
   * identity with a different hash is an `artifact_conflict` rather than a silent overwrite.
   */
  async put(input: PutArtifactInput): Promise<PutArtifactResult> {
    return this.transactions.withTransaction(async (transaction) => {
      const inserted = await transaction.query<{ id: string }>(
        `INSERT INTO artifacts (
           business_id, id, schema_ref, content_kind, content, blob_key, blob_hash, content_hash,
           classification, acl, retention, redaction, producer, created_at
         ) VALUES (
           $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::text[], $10::jsonb, $11::jsonb, $12::jsonb,
           $13::jsonb, $14::timestamptz
         )
         ON CONFLICT (business_id, id) DO NOTHING
         RETURNING id`,
        [
          input.businessId,
          input.id,
          input.schemaRef,
          input.blob === null ? "inline" : "blob",
          input.content === null ? null : JSON.stringify(input.content),
          input.blob?.key ?? null,
          input.blob?.hash ?? null,
          input.contentHash,
          input.classification,
          JSON.stringify(input.acl),
          JSON.stringify(input.retention),
          JSON.stringify(input.redaction),
          JSON.stringify(input.producer),
          input.createdAt,
        ]
      );
      if (inserted.rows.length === 1) return { outcome: "created" };

      const existing = await transaction.query<{ content_hash: string }>(
        "SELECT content_hash FROM artifacts WHERE business_id = $1 AND id = $2",
        [input.businessId, input.id]
      );
      if (existing.rows[0]?.content_hash !== input.contentHash) {
        throw new ArtifactPersistenceError("artifact_conflict");
      }
      return { outcome: "duplicate" };
    });
  }

  async find(businessId: string, artifactId: string): Promise<PersistedArtifact | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<ArtifactRow>(
        `SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE business_id = $1 AND id = $2`,
        [businessId, artifactId]
      );
      const row = result.rows[0];
      return row ? persistedArtifact(row) : null;
    });
  }

  /** Maps a State output name to one Artifact. The mapping is immutable once bound. */
  async bindOutput(input: BindOutputInput): Promise<BindOutputResult> {
    return this.transactions.withTransaction(async (transaction) => {
      const inserted = await transaction.query<{ artifact_id: string }>(
        `INSERT INTO state_output_bindings (
           business_id, run_id, state_key, output_name, artifact_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
         ON CONFLICT (business_id, run_id, state_key, output_name) DO NOTHING
         RETURNING artifact_id`,
        [
          input.businessId,
          input.runId,
          input.stateKey,
          input.outputName,
          input.artifactId,
          input.createdAt,
        ]
      );
      if (inserted.rows.length === 1) return { outcome: "bound" };

      const existing = await transaction.query<{ artifact_id: string }>(
        `SELECT artifact_id
           FROM state_output_bindings
          WHERE business_id = $1 AND run_id = $2 AND state_key = $3 AND output_name = $4`,
        [input.businessId, input.runId, input.stateKey, input.outputName]
      );
      if (existing.rows[0]?.artifact_id !== input.artifactId) {
        throw new ArtifactPersistenceError("output_binding_conflict");
      }
      return { outcome: "duplicate" };
    });
  }

  async resolveOutput(
    businessId: string,
    runId: string,
    stateKey: string,
    outputName: string
  ): Promise<PersistedArtifact | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<ArtifactRow>(
        `SELECT ${JOINED_ARTIFACT_COLUMNS}
           FROM state_output_bindings b
           JOIN artifacts a ON a.business_id = b.business_id AND a.id = b.artifact_id
          WHERE b.business_id = $1 AND b.run_id = $2 AND b.state_key = $3 AND b.output_name = $4`,
        [businessId, runId, stateKey, outputName]
      );
      const row = result.rows[0];
      return row ? persistedArtifact(row) : null;
    });
  }

  async listOutputs(businessId: string, runId: string): Promise<readonly StateOutputBinding[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<BindingRow>(
        `SELECT ${BINDING_COLUMNS}
           FROM state_output_bindings
          WHERE business_id = $1 AND run_id = $2
          ORDER BY state_key, output_name`,
        [businessId, runId]
      );
      return result.rows.map(binding);
    });
  }

  async appendLineage(input: AppendArtifactLineageInput): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO artifact_lineage (
           business_id, artifact_id, source_artifact_id, relation, created_at
         ) VALUES ($1, $2, $3, $4, $5::timestamptz)
         ON CONFLICT (business_id, artifact_id, source_artifact_id, relation) DO NOTHING`,
        [
          input.businessId,
          input.artifactId,
          input.sourceArtifactId,
          input.relation,
          input.createdAt,
        ]
      );
    });
  }

  async listLineage(
    businessId: string,
    artifactId: string
  ): Promise<readonly ArtifactLineageEdge[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<LineageRow>(
        `SELECT business_id, artifact_id, source_artifact_id, relation, created_at
           FROM artifact_lineage
          WHERE business_id = $1 AND artifact_id = $2
          ORDER BY created_at, source_artifact_id, relation`,
        [businessId, artifactId]
      );
      return result.rows.map((row) => ({
        businessId: row.business_id,
        artifactId: row.artifact_id,
        sourceArtifactId: row.source_artifact_id,
        relation: row.relation,
        createdAt: timestamp(row.created_at),
      }));
    });
  }
}
