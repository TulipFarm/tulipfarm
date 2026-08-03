import { randomUUID } from "node:crypto";
import type { RawPayloadVault } from "@tulipfarm/run-kernel";
import { encryptSecret } from "@tulipfarm/secrets";
import type { Queryable } from "../db";

/**
 * Encrypted store for raw webhook delivery bytes, ahead of any Run — `ArtifactService` requires a
 * `{runId, stateKey, attempt}` producer, which does not exist yet at ingestion time. Encrypted
 * under the same DEK `SecretsService` uses for stored secrets, so no new key material is
 * provisioned. Only `store` is implemented: nothing reads this table back yet.
 */
export class PgRawPayloadVault implements RawPayloadVault {
  constructor(
    private readonly db: Queryable,
    private readonly dekKey: Buffer
  ) {}

  async store(input: {
    businessId: string;
    provider: string;
    triggerSlug: string;
    rawBody: Buffer;
    receivedAt: string;
  }): Promise<{ artifactId: string }> {
    const id = randomUUID();
    const envelope = encryptSecret(input.rawBody.toString("base64"), this.dekKey);

    await this.db.query(
      `INSERT INTO webhook_raw_payloads
         (id, business_id, provider, trigger_slug, encrypted_body, iv, auth_tag, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        input.businessId,
        input.provider,
        input.triggerSlug,
        envelope.encryptedValue,
        envelope.iv,
        envelope.authTag,
        input.receivedAt,
      ]
    );

    return { artifactId: id };
  }
}
