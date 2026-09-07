import type { TransactionPort } from "../ports";

export type ProviderFileUploadPhase = "url_requested" | "bytes_uploaded" | "completed";

export interface ProviderFileUploadRecord {
  readonly businessId: string;
  readonly integrationId: string;
  readonly provider: string;
  readonly creationIntentId: string;
  readonly creationRunId: string;
  readonly channelId: string;
  readonly sourceFileId: string;
  readonly sourceSha256: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly providerFileId: string;
  readonly phase: ProviderFileUploadPhase;
}

export const PROVIDER_FILE_UPLOAD_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS integration_provider_file_uploads (
    business_id         text NOT NULL,
    integration_id      text NOT NULL,
    provider            text NOT NULL,
    creation_intent_id  text NOT NULL,
    creation_run_id     text NOT NULL,
    channel_id          text NOT NULL,
    source_file_id      text NOT NULL,
    source_sha256       text NOT NULL,
    filename            text NOT NULL,
    media_type          text NOT NULL,
    size_bytes          bigint NOT NULL CHECK (size_bytes >= 0),
    provider_file_id    text NOT NULL,
    phase               text NOT NULL CHECK (
      phase IN ('url_requested', 'bytes_uploaded', 'completed')
    ),
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL,
    PRIMARY KEY (business_id, integration_id, provider, creation_intent_id),
    FOREIGN KEY (business_id, integration_id)
      REFERENCES integrations(business_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS integration_provider_file_uploads_provider_file_idx
    ON integration_provider_file_uploads (
      business_id, integration_id, provider, provider_file_id
    )`,
];

interface ProviderFileUploadRow {
  business_id: string;
  integration_id: string;
  provider: string;
  creation_intent_id: string;
  creation_run_id: string;
  channel_id: string;
  source_file_id: string;
  source_sha256: string;
  filename: string;
  media_type: string;
  size_bytes: string | number;
  provider_file_id: string;
  phase: ProviderFileUploadPhase;
}

function persisted(row: ProviderFileUploadRow): ProviderFileUploadRecord {
  return {
    businessId: row.business_id,
    integrationId: row.integration_id,
    provider: row.provider,
    creationIntentId: row.creation_intent_id,
    creationRunId: row.creation_run_id,
    channelId: row.channel_id,
    sourceFileId: row.source_file_id,
    sourceSha256: row.source_sha256,
    filename: row.filename,
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
    providerFileId: row.provider_file_id,
    phase: row.phase,
  };
}

export class ProviderFileUploadStore {
  constructor(
    private readonly transactions: TransactionPort,
    private readonly now: () => string
  ) {}

  async find(input: {
    businessId: string;
    integrationId: string;
    provider: string;
    creationIntentId: string;
  }): Promise<ProviderFileUploadRecord | undefined> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<ProviderFileUploadRow>(
        `SELECT business_id, integration_id, provider, creation_intent_id, creation_run_id,
                channel_id, source_file_id, source_sha256, filename, media_type, size_bytes,
                provider_file_id, phase
           FROM integration_provider_file_uploads
          WHERE business_id = $1
            AND integration_id = $2
            AND provider = $3
            AND creation_intent_id = $4`,
        [input.businessId, input.integrationId, input.provider, input.creationIntentId]
      );
      const row = result.rows[0];
      return row === undefined ? undefined : persisted(row);
    });
  }

  async urlRequested(input: Omit<ProviderFileUploadRecord, "phase">): Promise<void> {
    const now = this.now();
    await this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `INSERT INTO integration_provider_file_uploads (
           business_id, integration_id, provider, creation_intent_id, creation_run_id, channel_id,
           source_file_id, source_sha256, filename, media_type, size_bytes, provider_file_id,
           phase, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
           'url_requested', $13::timestamptz, $13::timestamptz
         )
         ON CONFLICT (business_id, integration_id, provider, creation_intent_id)
         DO UPDATE SET
           provider_file_id = EXCLUDED.provider_file_id,
           phase = 'url_requested',
           updated_at = EXCLUDED.updated_at
         WHERE integration_provider_file_uploads.phase = 'url_requested'
         RETURNING provider_file_id`,
        [
          input.businessId,
          input.integrationId,
          input.provider,
          input.creationIntentId,
          input.creationRunId,
          input.channelId,
          input.sourceFileId,
          input.sourceSha256,
          input.filename,
          input.mediaType,
          input.sizeBytes,
          input.providerFileId,
          now,
        ]
      );
      if (result.rows.length !== 1) throw new Error("provider_file_upload_phase_conflict");
    });
  }

  async advance(input: {
    businessId: string;
    integrationId: string;
    provider: string;
    creationIntentId: string;
    providerFileId: string;
    from: Exclude<ProviderFileUploadPhase, "completed">;
    to: Exclude<ProviderFileUploadPhase, "url_requested">;
  }): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE integration_provider_file_uploads
            SET phase = $7,
                updated_at = $8::timestamptz
          WHERE business_id = $1
            AND integration_id = $2
            AND provider = $3
            AND creation_intent_id = $4
            AND provider_file_id = $5
            AND phase = $6
          RETURNING 1`,
        [
          input.businessId,
          input.integrationId,
          input.provider,
          input.creationIntentId,
          input.providerFileId,
          input.from,
          input.to,
          this.now(),
        ]
      );
      if (result.rows.length !== 1) throw new Error("provider_file_upload_phase_conflict");
    });
  }
}
