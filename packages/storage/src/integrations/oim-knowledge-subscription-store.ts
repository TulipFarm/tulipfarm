import type { Queryable } from "../ports";

export interface OimKnowledgeSubscription {
  readonly businessId: string;
  readonly integrationSlug: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
  readonly connectionId: string;
  readonly sourceKindId: string;
  readonly scopes: readonly string[];
  readonly classification: readonly string[];
  readonly aclMaximumAgeSeconds: number;
  readonly liveMaximumAgeSeconds: number;
  readonly enabled: boolean;
  readonly revision: number;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastErrorCodes: readonly string[];
}

export type OimKnowledgeSubscriptionInput = Omit<
  OimKnowledgeSubscription,
  "revision" | "lastAttemptAt" | "lastSuccessAt" | "lastErrorCodes"
>;

export const OIM_KNOWLEDGE_SUBSCRIPTION_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE oim_knowledge_subscriptions (
    business_id text NOT NULL,
    integration_slug text NOT NULL,
    integration_id text NOT NULL,
    integration_major_version integer NOT NULL,
    connection_id text NOT NULL,
    source_kind_id text NOT NULL,
    scopes text[] NOT NULL CHECK (cardinality(scopes) >= 1),
    classification text[] NOT NULL DEFAULT '{}',
    acl_maximum_age_seconds integer NOT NULL CHECK (acl_maximum_age_seconds > 0),
    live_maximum_age_seconds integer NOT NULL CHECK (live_maximum_age_seconds > 0),
    enabled boolean NOT NULL DEFAULT true,
    revision integer NOT NULL DEFAULT 1,
    last_attempt_at timestamptz,
    last_success_at timestamptz,
    last_error_codes text[] NOT NULL DEFAULT '{}',
    PRIMARY KEY (business_id, connection_id, source_kind_id),
    FOREIGN KEY (business_id, connection_id, integration_id, integration_major_version)
      REFERENCES connections (business_id, id, integration_id, integration_major_version)
      ON DELETE CASCADE
  )`,
  `INSERT INTO oim_knowledge_subscriptions (
     business_id, integration_slug, integration_id, integration_major_version,
     connection_id, source_kind_id, scopes, classification,
     acl_maximum_age_seconds, live_maximum_age_seconds
   )
   WITH selections AS (
   SELECT s.business_id, min(s.source_locator->>'integrationSlug') AS integration_slug, s.integration_id,
          c.integration_major_version, c.id AS connection_id, s.source_locator->>'sourceKindId' AS source_kind_id,
          array_agg(DISTINCT s.source_locator->>'scope') AS scopes,
          coalesce(min(s.access_control_max_age_seconds)
            FILTER (WHERE s.access_control_mode = 'snapshot'), 300) AS acl_age,
          coalesce(min(s.access_control_max_age_seconds)
            FILTER (WHERE s.access_control_mode = 'live'), 60) AS live_age
     FROM knowledge_source_records s
     JOIN connections c ON c.business_id = s.business_id
       AND c.id = s.source_locator->>'connectionId'
       AND c.integration_id = s.integration_id
       AND c.integration_major_version::text = s.source_locator->>'integrationMajorVersion'
    WHERE s.source_locator->>'kind' = 'oim'
      AND s.source_locator->>'integrationSlug' IS NOT NULL
      AND s.source_locator->>'sourceKindId' IS NOT NULL
      AND s.source_locator->>'scope' IS NOT NULL
    GROUP BY s.business_id, s.integration_id, c.integration_major_version,
             c.id, s.source_locator->>'sourceKindId'
   )
   SELECT business_id, integration_slug, integration_id, integration_major_version,
          connection_id, source_kind_id, scopes,
          ARRAY(SELECT DISTINCT label
                  FROM knowledge_source_records labels, unnest(labels.classification) label
                 WHERE labels.business_id = selections.business_id
                   AND labels.integration_id = selections.integration_id
                   AND labels.source_locator->>'connectionId' = selections.connection_id
                   AND labels.source_locator->>'sourceKindId' = selections.source_kind_id),
          acl_age, live_age FROM selections`,
];

interface Row {
  business_id: string;
  integration_slug: string;
  integration_id: string;
  integration_major_version: number;
  connection_id: string;
  source_kind_id: string;
  scopes: string[];
  classification: string[];
  acl_maximum_age_seconds: number;
  live_maximum_age_seconds: number;
  enabled: boolean;
  revision: number;
  last_attempt_at: string | Date | null;
  last_success_at: string | Date | null;
  last_error_codes: string[];
}

const timestamp = (value: string | Date | null) =>
  value === null ? null : new Date(value).toISOString();

function fromRow(row: Row): OimKnowledgeSubscription {
  return {
    businessId: row.business_id,
    integrationSlug: row.integration_slug,
    integrationId: row.integration_id,
    integrationMajorVersion: row.integration_major_version,
    connectionId: row.connection_id,
    sourceKindId: row.source_kind_id,
    scopes: row.scopes,
    classification: row.classification,
    aclMaximumAgeSeconds: row.acl_maximum_age_seconds,
    liveMaximumAgeSeconds: row.live_maximum_age_seconds,
    enabled: row.enabled,
    revision: row.revision,
    lastAttemptAt: timestamp(row.last_attempt_at),
    lastSuccessAt: timestamp(row.last_success_at),
    lastErrorCodes: row.last_error_codes,
  };
}

export class OimKnowledgeSubscriptionStore {
  constructor(private readonly queryable: Queryable) {}

  async listEnabled(): Promise<readonly OimKnowledgeSubscription[]> {
    const rows = await this.queryable.query<Row>(
      "SELECT * FROM oim_knowledge_subscriptions WHERE enabled ORDER BY business_id, connection_id, source_kind_id"
    );
    return rows.rows.map(fromRow);
  }

  async list(
    businessId: string,
    connectionId: string
  ): Promise<readonly OimKnowledgeSubscription[]> {
    const rows = await this.queryable.query<Row>(
      "SELECT * FROM oim_knowledge_subscriptions WHERE business_id = $1 AND connection_id = $2 ORDER BY source_kind_id",
      [businessId, connectionId]
    );
    return rows.rows.map(fromRow);
  }

  async save(input: OimKnowledgeSubscriptionInput): Promise<OimKnowledgeSubscription> {
    const result = await this.queryable.query<Row>(
      `INSERT INTO oim_knowledge_subscriptions (
         business_id, integration_slug, integration_id, integration_major_version, connection_id,
         source_kind_id, scopes, classification, acl_maximum_age_seconds,
         live_maximum_age_seconds, enabled
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (business_id, connection_id, source_kind_id) DO UPDATE SET
         scopes = EXCLUDED.scopes, classification = EXCLUDED.classification,
         acl_maximum_age_seconds = EXCLUDED.acl_maximum_age_seconds,
         live_maximum_age_seconds = EXCLUDED.live_maximum_age_seconds,
         enabled = EXCLUDED.enabled, revision = oim_knowledge_subscriptions.revision + 1
       RETURNING *`,
      [
        input.businessId,
        input.integrationSlug,
        input.integrationId,
        input.integrationMajorVersion,
        input.connectionId,
        input.sourceKindId,
        [...new Set(input.scopes)].sort(),
        [...new Set(input.classification)].sort(),
        input.aclMaximumAgeSeconds,
        input.liveMaximumAgeSeconds,
        input.enabled,
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error("knowledge_subscription_not_saved");
    return fromRow(row);
  }

  async recordAttempt(
    subscription: OimKnowledgeSubscription,
    errors: readonly string[],
    completed: boolean,
    now = new Date()
  ): Promise<void> {
    await this.queryable.query(
      `UPDATE oim_knowledge_subscriptions
          SET last_attempt_at = $5, last_error_codes = $6,
              last_success_at = CASE WHEN $7 THEN $5 ELSE last_success_at END
        WHERE business_id = $1 AND connection_id = $2 AND source_kind_id = $3
          AND revision = $4 AND enabled`,
      [
        subscription.businessId,
        subscription.connectionId,
        subscription.sourceKindId,
        subscription.revision,
        now,
        [...new Set(errors)],
        completed && errors.length === 0,
      ]
    );
  }
}
