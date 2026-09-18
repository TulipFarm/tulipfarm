export const CONNECTION_AUTH_STEP_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS connection_auth_steps (
    business_id        text NOT NULL,
    connection_id      text NOT NULL,
    step_id            text NOT NULL,
    status             text NOT NULL
      CHECK (status IN ('pending', 'active', 'expired', 'action_required', 'revoked')),
    access_slot        text,
    access_secret_ref  text,
    refresh_slot       text,
    refresh_secret_ref text,
    external_identity  jsonb
      CHECK (external_identity IS NULL OR jsonb_typeof(external_identity) = 'object'),
    expires_at         timestamptz,
    health_checked_at  timestamptz,
    revision           bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, connection_id, step_id),
    FOREIGN KEY (business_id, connection_id)
      REFERENCES connections (business_id, id) ON DELETE CASCADE,
    CHECK (access_secret_ref IS NULL OR access_secret_ref LIKE 'secret://%'),
    CHECK (refresh_secret_ref IS NULL OR refresh_secret_ref LIKE 'secret://%'),
    CHECK (
      (access_slot IS NULL AND access_secret_ref IS NULL)
      OR (access_slot IS NOT NULL AND access_secret_ref IS NOT NULL)
    ),
    CHECK (
      (refresh_slot IS NULL AND refresh_secret_ref IS NULL)
      OR (refresh_slot IS NOT NULL AND refresh_secret_ref IS NOT NULL)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS connection_auth_steps_expiry_idx
     ON connection_auth_steps (business_id, status, expires_at)
     WHERE expires_at IS NOT NULL`,
];

export const CONNECTION_EXTERNAL_IDENTITY_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS connection_external_identities (
    business_id                 text NOT NULL,
    connection_id               text NOT NULL,
    integration_id              text NOT NULL,
    integration_major_version   integer NOT NULL CHECK (integration_major_version >= 0),
    external_tenant_id          text NOT NULL CHECK (length(external_tenant_id) > 0),
    external_account_id         text NOT NULL CHECK (length(external_account_id) > 0),
    proof_kind                  text NOT NULL CHECK (proof_kind IN ('auth', 'health')),
    proof_digest                text NOT NULL CHECK (proof_digest ~ '^[0-9a-f]{64}$'),
    verified_at                 timestamptz NOT NULL,
    verified_by                 text NOT NULL CHECK (length(verified_by) > 0),
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, connection_id),
    FOREIGN KEY (
      business_id, connection_id, integration_id, integration_major_version
    ) REFERENCES connections (
      business_id, id, integration_id, integration_major_version
    ) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS connection_external_identities_provider_idx
     ON connection_external_identities (
       business_id,
       integration_id,
       integration_major_version,
       external_tenant_id,
       external_account_id
     )`,
];

export const CONNECTION_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS connections (
    business_id                 text NOT NULL,
    id                          text NOT NULL,
    integration_id              text NOT NULL,
    integration_major_version   integer NOT NULL CHECK (integration_major_version >= 0),
    label                       text NOT NULL,
    owner_scope                 text NOT NULL
      CONSTRAINT connections_owner_scope_check
      CHECK (owner_scope IN ('personal', 'organization', 'team')),
    owner_principal_id          text,
    owner_team_id               text,
    status                      text NOT NULL CHECK (status IN ('active', 'revoked')),
    is_default                  boolean NOT NULL DEFAULT false,
    configuration               jsonb NOT NULL CHECK (jsonb_typeof(configuration) = 'object'),
    agent_visible_configuration text[] NOT NULL DEFAULT '{}',
    secret_bindings             jsonb NOT NULL CHECK (jsonb_typeof(secret_bindings) = 'object'),
    webhook_registration        jsonb
      CHECK (webhook_registration IS NULL OR jsonb_typeof(webhook_registration) = 'object'),
    health_status               text NOT NULL
      CHECK (health_status IN ('healthy', 'expiring', 'action_required', 'unknown')),
    health_checked_at           timestamptz,
    expires_at                  timestamptz,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, id),
    CONSTRAINT connections_route_identity_key UNIQUE (
      business_id, id, integration_id, integration_major_version
    ),
    CONSTRAINT connections_owner_identity_check CHECK (
      (owner_scope = 'personal' AND owner_principal_id IS NOT NULL AND owner_team_id IS NULL)
      OR (owner_scope = 'organization' AND owner_principal_id IS NULL AND owner_team_id IS NULL)
      OR (owner_scope = 'team' AND owner_principal_id IS NULL AND owner_team_id IS NOT NULL)
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS connections_active_default_idx
     ON connections (
       business_id,
       integration_id,
       integration_major_version,
       owner_scope,
       COALESCE(owner_principal_id, ''),
       COALESCE(owner_team_id, '')
     )
     WHERE is_default = true AND status = 'active'`,
  `CREATE INDEX IF NOT EXISTS connections_owner_lookup_idx
     ON connections (
       business_id,
       integration_id,
       integration_major_version,
       owner_scope,
       owner_principal_id,
       owner_team_id,
       status
     )`,
];

export const CONNECTION_VERIFICATION_EVIDENCE_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS connection_verification_evidence (
    business_id       text NOT NULL,
    connection_id     text NOT NULL,
    proof_digest      text NOT NULL CHECK (proof_digest ~ '^[0-9a-f]{64}$'),
    binding_digest    text NOT NULL CHECK (binding_digest ~ '^[0-9a-f]{64}$'),
    package_digest    text NOT NULL CHECK (package_digest ~ '^[0-9a-f]{64}$'),
    configuration_digest text NOT NULL CHECK (configuration_digest ~ '^[0-9a-f]{64}$'),
    assurance         text NOT NULL CHECK (assurance IN ('validity_only', 'identified')),
    evidence          jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
    verified_at       timestamptz NOT NULL,
    invalidated_at    timestamptz,
    invalidation_reason text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, connection_id, proof_digest),
    FOREIGN KEY (business_id, connection_id)
      REFERENCES connections (business_id, id) ON DELETE CASCADE,
    CHECK (
      (invalidated_at IS NULL AND invalidation_reason IS NULL)
      OR (invalidated_at IS NOT NULL AND length(invalidation_reason) > 0)
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS connection_verification_evidence_active_idx
     ON connection_verification_evidence (business_id, connection_id)
     WHERE invalidated_at IS NULL`,
];

export const INGRESS_TEARDOWN_STORAGE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS oim_ingress_teardowns (
    business_id text NOT NULL,
    connection_id text NOT NULL,
    requested_at timestamptz NOT NULL,
    PRIMARY KEY (business_id, connection_id),
    FOREIGN KEY (business_id, connection_id)
      REFERENCES connections(business_id, id) ON DELETE CASCADE
  )`,
] as const;

export const OIM_INGRESS_EMISSION_STORAGE_STATEMENTS = [
  `ALTER TABLE webhook_deliveries
     ADD COLUMN IF NOT EXISTS external_tenant_id text`,
  `ALTER TABLE webhook_deliveries
     ADD COLUMN IF NOT EXISTS external_account_id text`,
  `ALTER TABLE webhook_deliveries
     DROP CONSTRAINT IF EXISTS webhook_deliveries_verified_identity_check`,
  `ALTER TABLE webhook_deliveries
     ADD CONSTRAINT webhook_deliveries_verified_identity_check
     CHECK (
       (external_tenant_id IS NULL AND external_account_id IS NULL)
       OR (external_tenant_id IS NOT NULL AND external_account_id IS NOT NULL)
     )`,
] as const;

export const OIM_KNOWLEDGE_CHECKPOINT_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS oim_knowledge_scan_checkpoints (
    business_id                 text NOT NULL,
    integration_id              text NOT NULL,
    integration_major_version   integer NOT NULL CHECK (integration_major_version >= 0),
    connection_id               text NOT NULL,
    source_kind                 text NOT NULL,
    scope_key                   text NOT NULL,
    baseline_item_ids           jsonb NOT NULL DEFAULT '[]'::jsonb
      CHECK (jsonb_typeof(baseline_item_ids) = 'array'),
    scan_id                     text,
    continuation                text,
    accumulated_seen_item_ids   jsonb NOT NULL DEFAULT '[]'::jsonb
      CHECK (jsonb_typeof(accumulated_seen_item_ids) = 'array'),
    pending_deletion_item_ids   jsonb NOT NULL DEFAULT '[]'::jsonb
      CHECK (jsonb_typeof(pending_deletion_item_ids) = 'array'),
    revision                    bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    lease_token                 text,
    lease_expires_at            timestamptz,
    updated_at                  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (
      business_id,
      integration_id,
      integration_major_version,
      connection_id,
      source_kind,
      scope_key
    ),
    FOREIGN KEY (
      business_id, connection_id, integration_id, integration_major_version
    ) REFERENCES connections (
      business_id, id, integration_id, integration_major_version
    ) ON DELETE CASCADE,
    CHECK (
      (lease_token IS NULL AND lease_expires_at IS NULL)
      OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),
    CHECK (
      scan_id IS NOT NULL
      OR (
        continuation IS NULL
        AND accumulated_seen_item_ids = '[]'::jsonb
        AND pending_deletion_item_ids = '[]'::jsonb
      )
    )
  )`,
  `CREATE INDEX IF NOT EXISTS oim_knowledge_scan_lease_idx
     ON oim_knowledge_scan_checkpoints (lease_expires_at)
     WHERE lease_token IS NOT NULL`,
];

export const OIM_KNOWLEDGE_CHECKPOINT_WATERMARK_STORAGE_STATEMENTS: readonly string[] = [
  `ALTER TABLE oim_knowledge_scan_checkpoints
     ADD COLUMN cursor_watermark text,
     ADD COLUMN pending_cursor_watermark text,
     ADD COLUMN requires_full_rebuild boolean NOT NULL DEFAULT false,
     ADD CONSTRAINT oim_knowledge_scan_pending_watermark_check
       CHECK (pending_cursor_watermark IS NULL OR scan_id IS NOT NULL)`,
];

export const OIM_KNOWLEDGE_PUBLICATION_FENCE_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE oim_knowledge_connection_fences (
     business_id                 text NOT NULL,
     integration_id              text NOT NULL,
     integration_major_version   integer NOT NULL CHECK (integration_major_version >= 0),
     connection_id               text NOT NULL,
     generation                  bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
     status                      text NOT NULL CHECK (status IN ('active', 'blocked')),
     external_tenant_id          text,
     external_account_id         text,
     updated_at                  timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (
       business_id, integration_id, integration_major_version, connection_id
     ),
     CHECK (
       status = 'blocked'
       OR (
         external_tenant_id IS NOT NULL
         AND length(external_tenant_id) > 0
         AND external_account_id IS NOT NULL
         AND length(external_account_id) > 0
       )
     )
   )`,
  `CREATE OR REPLACE FUNCTION oim_knowledge_fence_connection_lifecycle()
   RETURNS trigger
   LANGUAGE plpgsql
   AS $$
   DECLARE
     fenced_generation bigint;
   BEGIN
     IF NEW.status = 'revoked' AND OLD.status IS DISTINCT FROM 'revoked' THEN
       INSERT INTO oim_knowledge_connection_fences (
         business_id, integration_id, integration_major_version, connection_id,
         generation, status, updated_at
       ) VALUES (
         NEW.business_id, NEW.integration_id, NEW.integration_major_version, NEW.id,
         1, 'blocked', now()
       )
       ON CONFLICT (
         business_id, integration_id, integration_major_version, connection_id
       ) DO UPDATE SET
         generation = oim_knowledge_connection_fences.generation + 1,
         status = 'blocked',
         updated_at = now()
       RETURNING generation INTO fenced_generation;

       UPDATE oim_knowledge_scan_checkpoints
          SET baseline_item_ids = '[]'::jsonb,
              scan_id = NULL,
              continuation = NULL,
              accumulated_seen_item_ids = '[]'::jsonb,
              pending_deletion_item_ids = '[]'::jsonb,
              cursor_watermark = NULL,
              pending_cursor_watermark = NULL,
              requires_full_rebuild = false,
              lease_token = NULL,
              lease_expires_at = NULL,
              revision = revision + 1,
              updated_at = now()
        WHERE business_id = NEW.business_id
          AND integration_id = NEW.integration_id
          AND integration_major_version = NEW.integration_major_version
          AND connection_id = NEW.id;

       UPDATE knowledge_source_records
          SET status = 'deleted',
              verification = 'unverifiable',
              revision = 'connection-revoked:' || fenced_generation || ':' || source_id,
              acl_revision = NULL,
              acl_captured_at = NULL,
              acl_principals = NULL,
              last_synced_at = now(),
              provenance_captured_at = now(),
              updated_at = now()
        WHERE business_id = NEW.business_id
          AND integration_id = NEW.integration_id
          AND provenance_integration_major_version = NEW.integration_major_version
          AND provenance_connection_id = NEW.id
          AND source_locator ->> 'kind' = 'oim';

       DELETE FROM knowledge_source_chunks chunk
        USING knowledge_source_records source
        WHERE chunk.business_id = source.business_id
          AND chunk.source_id = source.source_id
          AND source.business_id = NEW.business_id
          AND source.integration_id = NEW.integration_id
          AND source.provenance_integration_major_version = NEW.integration_major_version
          AND source.provenance_connection_id = NEW.id
          AND source.source_locator ->> 'kind' = 'oim';
     ELSIF NEW.status = 'active'
       AND OLD.status = 'active'
       AND (
         NEW.health_status IS DISTINCT FROM OLD.health_status
         OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       )
     THEN
       UPDATE oim_knowledge_connection_fences
          SET generation = generation + 1,
              updated_at = now()
        WHERE business_id = NEW.business_id
          AND integration_id = NEW.integration_id
          AND integration_major_version = NEW.integration_major_version
          AND connection_id = NEW.id
          AND status = 'active';
     END IF;
     RETURN NEW;
   END;
   $$`,
  `CREATE TRIGGER oim_knowledge_connection_lifecycle_fence
     AFTER UPDATE OF status, health_status, expires_at ON connections
     FOR EACH ROW
     EXECUTE FUNCTION oim_knowledge_fence_connection_lifecycle()`,
];

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

export const OIM_RATE_LIMIT_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS oim_rate_limits (
    business_id                text NOT NULL,
    integration_id             text NOT NULL,
    integration_major_version  integer NOT NULL CHECK (integration_major_version >= 0),
    connection_id              text NOT NULL,
    scope                      text NOT NULL CHECK (scope IN ('connection', 'operation')),
    operation_id               text NOT NULL,
    window_started_at          timestamptz NOT NULL,
    admitted_requests          bigint NOT NULL DEFAULT 0 CHECK (admitted_requests >= 0),
    cooldown_until             timestamptz,
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (
      business_id,
      integration_id,
      integration_major_version,
      connection_id,
      scope,
      operation_id
    ),
    CHECK (
      (scope = 'connection' AND length(connection_id) > 0 AND operation_id = '')
      OR (scope = 'operation' AND length(operation_id) > 0)
    )
  )`,
];

export const OIM_RELEASE_LIFECYCLE_STORAGE_STATEMENTS: readonly string[] = [
  `ALTER TABLE oim_installed_release_provenance
     ADD COLUMN IF NOT EXISTS installation_id uuid`,
  `ALTER TABLE oim_installed_release_provenance
     ADD COLUMN IF NOT EXISTS slug text`,
  `ALTER TABLE oim_installed_release_provenance
     ADD COLUMN IF NOT EXISTS source_ref text`,
  `ALTER TABLE oim_installed_release_provenance
     ADD COLUMN IF NOT EXISTS candidate_path text`,
  `ALTER TABLE oim_installed_release_provenance
     ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'git'
       CHECK (source_kind IN ('git', 'authored_draft'))`,
  `ALTER TABLE oim_installed_release_provenance
     ADD COLUMN IF NOT EXISTS authored_draft jsonb`,
  `ALTER TABLE oim_installed_release_provenance
     ALTER COLUMN source DROP NOT NULL`,
  `ALTER TABLE oim_installed_release_provenance
     ADD COLUMN IF NOT EXISTS soul_revision text`,
  `ALTER TABLE oim_installed_release_provenance
     ADD COLUMN IF NOT EXISTS recovery_state text NOT NULL DEFAULT 'quarantined'
       CHECK (recovery_state IN ('verified', 'quarantined'))`,
  `UPDATE oim_installed_release_provenance
      SET auto_patch_opt_in = false
    WHERE recovery_state = 'quarantined'`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1
         FROM pg_constraint
        WHERE conname = 'oim_installed_release_verified_location'
          AND conrelid = 'oim_installed_release_provenance'::regclass
     ) THEN
       ALTER TABLE oim_installed_release_provenance
         ADD CONSTRAINT oim_installed_release_verified_location CHECK (
           (
             recovery_state = 'verified'
             AND installation_id IS NOT NULL
             AND slug IS NOT NULL
             AND soul_revision IS NOT NULL
             AND (
               (
                 source_kind = 'git'
                 AND source IS NOT NULL
                 AND source_ref IS NOT NULL
                 AND candidate_path IS NOT NULL
                 AND authored_draft IS NULL
               )
               OR (
                 source_kind = 'authored_draft'
                 AND source IS NULL
                 AND source_ref IS NULL
                 AND candidate_path IS NULL
                 AND jsonb_typeof(authored_draft) = 'object'
               )
             )
           )
           OR (
             recovery_state = 'quarantined'
             AND installation_id IS NULL
             AND slug IS NULL
             AND source_ref IS NULL
             AND candidate_path IS NULL
             AND soul_revision IS NULL
             AND auto_patch_opt_in = false
           )
         );
     END IF;
   END
   $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS oim_installed_release_installation_idx
     ON oim_installed_release_provenance (
       business_id, integration_id, major_version, installation_id
     ) WHERE recovery_state = 'verified'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS oim_installed_release_slug_idx
     ON oim_installed_release_provenance (business_id, slug)
     WHERE recovery_state = 'verified'`,
  `CREATE TABLE IF NOT EXISTS oim_release_lifecycle_state (
    business_id     text NOT NULL,
    integration_id  text NOT NULL,
    major_version   integer NOT NULL CHECK (major_version >= 0),
    installation_id uuid NOT NULL,
    slug            text NOT NULL,
    phase           text NOT NULL CHECK (phase IN ('installed', 'uninstall_pending', 'uninstalled')),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, integration_id, major_version)
  )`,
  `INSERT INTO oim_release_lifecycle_state (
     business_id, integration_id, major_version, installation_id, slug, phase
   )
   SELECT business_id, integration_id, major_version, installation_id, slug, 'installed'
     FROM oim_installed_release_provenance
    WHERE recovery_state = 'verified'
   ON CONFLICT (business_id, integration_id, major_version) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS oim_release_slug_reservations (
    business_id     text NOT NULL,
    slug            text NOT NULL,
    integration_id  text NOT NULL,
    major_version   integer NOT NULL CHECK (major_version >= 0),
    installation_id uuid NOT NULL,
    operation_id    uuid,
    state           text NOT NULL CHECK (
      state IN ('install_pending', 'installed', 'uninstall_pending')
    ),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, slug)
  )`,
  `INSERT INTO oim_release_slug_reservations (
     business_id, slug, integration_id, major_version, installation_id, state
   )
   SELECT business_id, slug, integration_id, major_version, installation_id, 'installed'
     FROM oim_installed_release_provenance
    WHERE recovery_state = 'verified'
   ON CONFLICT (business_id, slug) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS oim_release_install_operations (
    operation_id             uuid PRIMARY KEY,
    business_id              text NOT NULL,
    integration_id           text NOT NULL,
    major_version            integer NOT NULL CHECK (major_version >= 0),
    installation_id          uuid NOT NULL,
    kind                     text NOT NULL CHECK (kind IN ('install', 'patch', 'replace')),
    slug                     text NOT NULL,
    phase                    text NOT NULL CHECK (
      phase IN (
        'prepared',
        'plan_recorded',
        'soul_written',
        'provenance_committed',
        'completed',
        'rolled_back',
        'reconciliation_required'
      )
    ),
    expected_installation_id uuid,
    expected_version         text,
    expected_package_digest  text CHECK (
      expected_package_digest IS NULL OR expected_package_digest ~ '^[0-9a-f]{64}$'
    ),
    expected_source_kind     text CHECK (
      expected_source_kind IS NULL OR expected_source_kind IN ('git', 'authored_draft')
    ),
    expected_source          text,
    expected_source_ref      text,
    expected_candidate_path  text,
    expected_authored_draft  jsonb,
    expected_slug            text,
    expected_soul_revision   text,
    expected_updated_at      timestamptz,
    next_version             text NOT NULL,
    next_package_digest      text NOT NULL CHECK (next_package_digest ~ '^[0-9a-f]{64}$'),
    package_snapshot         jsonb NOT NULL CHECK (jsonb_typeof(package_snapshot) = 'object'),
    source_kind              text NOT NULL CHECK (source_kind IN ('git', 'authored_draft')),
    source                   text,
    source_ref               text,
    candidate_path           text,
    authored_draft           jsonb,
    trust_class              text NOT NULL CHECK (trust_class IN ('official', 'community')),
    signed_release           jsonb,
    approved_community_digest text CHECK (
      approved_community_digest IS NULL
      OR approved_community_digest ~ '^[0-9a-f]{64}$'
    ),
    original_requirements    jsonb NOT NULL CHECK (jsonb_typeof(original_requirements) = 'object'),
    auto_patch_opt_in        boolean NOT NULL,
    write_plan               jsonb,
    write_receipt            jsonb,
    soul_revision            text,
    reconciliation_reason    text,
    started_at               timestamptz NOT NULL,
    updated_at               timestamptz NOT NULL,
    completed_at             timestamptz,
    CHECK (
      (
        kind = 'install'
        AND expected_installation_id IS NULL
        AND expected_source_kind IS NULL
        AND expected_version IS NULL
        AND expected_package_digest IS NULL
        AND expected_source IS NULL
        AND expected_source_ref IS NULL
        AND expected_candidate_path IS NULL
        AND expected_authored_draft IS NULL
        AND expected_slug IS NULL
        AND expected_soul_revision IS NULL
        AND expected_updated_at IS NULL
      )
      OR (
        kind IN ('patch', 'replace')
        AND (
          (kind = 'patch' AND expected_installation_id = installation_id)
          OR (kind = 'replace' AND expected_installation_id <> installation_id)
        )
        AND expected_version IS NOT NULL
        AND expected_package_digest IS NOT NULL
        AND expected_source_kind IS NOT NULL
        AND expected_slug IS NOT NULL
        AND expected_soul_revision IS NOT NULL
        AND expected_updated_at IS NOT NULL
        AND (
          (
            expected_source_kind = 'git'
            AND expected_source IS NOT NULL
            AND expected_source_ref IS NOT NULL
            AND expected_candidate_path IS NOT NULL
            AND expected_authored_draft IS NULL
          )
          OR (
            expected_source_kind = 'authored_draft'
            AND expected_source IS NULL
            AND expected_source_ref IS NULL
            AND expected_candidate_path IS NULL
            AND jsonb_typeof(expected_authored_draft) = 'object'
          )
        )
      )
    ),
    CHECK (
      (
        source_kind = 'git'
        AND source IS NOT NULL
        AND source_ref IS NOT NULL
        AND candidate_path IS NOT NULL
        AND authored_draft IS NULL
      )
      OR (
        source_kind = 'authored_draft'
        AND source IS NULL
        AND source_ref IS NULL
        AND candidate_path IS NULL
        AND jsonb_typeof(authored_draft) = 'object'
      )
    ),
    CHECK (
      (phase IN ('prepared', 'plan_recorded', 'soul_written', 'reconciliation_required')
       AND completed_at IS NULL)
      OR
      (phase IN ('provenance_committed', 'completed', 'rolled_back'))
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS oim_release_install_operation_pending_idx
     ON oim_release_install_operations (business_id, integration_id, major_version)
     WHERE phase NOT IN ('completed', 'rolled_back')`,
  `CREATE TABLE IF NOT EXISTS oim_release_uninstall_journals (
    business_id            text NOT NULL,
    integration_id         text NOT NULL,
    major_version          integer NOT NULL CHECK (major_version >= 0),
    installation_id        uuid NOT NULL,
    slug                   text NOT NULL,
    package_digest         text NOT NULL CHECK (package_digest ~ '^[0-9a-f]{64}$'),
    soul_revision          text NOT NULL,
    status                 text NOT NULL CHECK (status IN ('pending', 'complete')),
    completed_steps        text[] NOT NULL DEFAULT '{}',
    revoked_connection_ids text[] NOT NULL DEFAULT '{}',
    in_flight_work_ids     text[] NOT NULL DEFAULT '{}',
    retry                  jsonb,
    started_at             timestamptz NOT NULL,
    updated_at             timestamptz NOT NULL,
    completed_at           timestamptz,
    PRIMARY KEY (business_id, integration_id, major_version, installation_id),
    CHECK (
      completed_steps <@ ARRAY[
        'traffic_fenced_and_drained',
        'remote_unsubscribed',
        'connections_revoked',
        'owned_state_removed',
        'release_provenance_removed',
        'soul_package_removed'
      ]::text[]
    ),
    CHECK (
      (status = 'pending' AND completed_at IS NULL)
      OR (status = 'complete' AND completed_at IS NOT NULL)
    ),
    CHECK (retry IS NULL OR jsonb_typeof(retry) = 'object')
  )`,
  `CREATE TABLE IF NOT EXISTS oim_release_dispatch_leases (
    lease_id           uuid PRIMARY KEY,
    business_id        text NOT NULL,
    integration_id     text NOT NULL,
    major_version      integer NOT NULL CHECK (major_version >= 0),
    installation_id    uuid NOT NULL,
    package_digest     text NOT NULL CHECK (package_digest ~ '^[0-9a-f]{64}$'),
    status             text NOT NULL CHECK (
      status IN ('active', 'reconciliation_required', 'released')
    ),
    outcome            text CHECK (outcome IN ('completed', 'not_dispatched')),
    reconciliation_reason text,
    acquired_at        timestamptz NOT NULL,
    expires_at         timestamptz NOT NULL,
    updated_at         timestamptz NOT NULL,
    released_at        timestamptz,
    CHECK (expires_at > acquired_at),
    CHECK (
      (status = 'released' AND outcome IS NOT NULL AND released_at IS NOT NULL)
      OR (status <> 'released' AND outcome IS NULL AND released_at IS NULL)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS oim_release_dispatch_unresolved_idx
     ON oim_release_dispatch_leases (business_id, integration_id, major_version, status)
     WHERE status <> 'released'`,
  `CREATE TABLE IF NOT EXISTS oim_known_signed_releases (
    integration_id text NOT NULL,
    version         text NOT NULL,
    package_digest  text NOT NULL CHECK (package_digest ~ '^[0-9a-f]{64}$'),
    key_id          text NOT NULL,
    recorded_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (integration_id, version, package_digest)
  )`,
];

export const OIM_RELEASE_TRUST_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS oim_release_trust_roots (
    purpose        text NOT NULL CHECK (purpose IN ('release', 'revocation')),
    key_id         text NOT NULL,
    public_key_pem text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     text NOT NULL,
    disabled_at    timestamptz,
    disabled_by    text,
    PRIMARY KEY (purpose, key_id),
    CHECK (
      (disabled_at IS NULL AND disabled_by IS NULL)
      OR (disabled_at IS NOT NULL AND disabled_by IS NOT NULL)
    )
  )`,
  `CREATE TABLE IF NOT EXISTS oim_release_revocation_state (
    singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    sequence   bigint NOT NULL CHECK (sequence >= 1),
    envelope   jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS oim_installed_release_provenance (
    business_id              text NOT NULL,
    integration_id           text NOT NULL,
    major_version            integer NOT NULL CHECK (major_version >= 0),
    version                  text NOT NULL,
    package_digest           text NOT NULL CHECK (package_digest ~ '^[0-9a-f]{64}$'),
    source                   text NOT NULL,
    trust_class              text NOT NULL CHECK (trust_class IN ('official', 'community')),
    signed_release           jsonb,
    approved_community_digest text CHECK (
      approved_community_digest IS NULL
      OR approved_community_digest ~ '^[0-9a-f]{64}$'
    ),
    original_requirements    jsonb NOT NULL CHECK (jsonb_typeof(original_requirements) = 'object'),
    auto_patch_opt_in        boolean NOT NULL DEFAULT false,
    installed_at             timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, integration_id, major_version),
    CHECK (
      (
        trust_class = 'official'
        AND signed_release IS NOT NULL
        AND approved_community_digest IS NULL
      )
      OR (
        trust_class = 'community'
        AND signed_release IS NULL
        AND approved_community_digest = package_digest
        AND auto_patch_opt_in = false
      )
    )
  )`,
];

export const OIM_RELEASE_MAINTENANCE_STORAGE_STATEMENTS: readonly string[] = [
  `ALTER TABLE oim_installed_release_provenance
     ALTER COLUMN auto_patch_opt_in SET DEFAULT true`,
  `CREATE TABLE IF NOT EXISTS oim_release_maintenance_config (
    singleton            boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    revocation_feed_url  text NOT NULL,
    updated_at           timestamptz NOT NULL DEFAULT now(),
    updated_by           text NOT NULL,
    disabled_at          timestamptz,
    disabled_by          text,
    CHECK (
      (disabled_at IS NULL AND disabled_by IS NULL)
      OR (disabled_at IS NOT NULL AND disabled_by IS NOT NULL)
    )
  )`,
];

export const POLLING_INGRESS_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS polling_ingress_state (
    business_id       text NOT NULL,
    connection_id     text NOT NULL,
    cursor            text,
    next_poll_at      timestamptz NOT NULL DEFAULT now(),
    lease_token       text,
    lease_expires_at  timestamptz,
    PRIMARY KEY (business_id, connection_id),
    FOREIGN KEY (business_id, connection_id)
      REFERENCES connections (business_id, id) ON DELETE CASCADE,
    CHECK (
      (lease_token IS NULL AND lease_expires_at IS NULL)
      OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS polling_ingress_due_idx
     ON polling_ingress_state (next_poll_at, lease_expires_at)`,
];

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

export const WEBHOOK_INBOX_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
    business_id                text NOT NULL,
    id                         text NOT NULL,
    integration_id             text NOT NULL,
    integration_major_version  integer NOT NULL CHECK (integration_major_version >= 0),
    connection_id              text,
    deduplication_key          text,
    body_sha256                text NOT NULL,
    safe_headers               jsonb NOT NULL CHECK (jsonb_typeof(safe_headers) = 'object'),
    encrypted_body             text,
    event_type                 text,
    verification               text NOT NULL,
    authenticated_evidence_digest text CHECK (
      authenticated_evidence_digest IS NULL
      OR authenticated_evidence_digest ~ '^[0-9a-f]{64}$'
    ),
    state                      text NOT NULL
      CONSTRAINT webhook_deliveries_state_check
      CHECK (state IN ('accepted', 'normalized', 'dispatched', 'dead_letter')),
    attempts                   integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error                 text,
    normalized_payload         jsonb,
    replay_of_id               text,
    received_at                timestamptz NOT NULL DEFAULT now(),
    next_attempt_at            timestamptz NOT NULL DEFAULT now(),
    lease_expires_at           timestamptz,
    raw_deleted_at             timestamptz,
    PRIMARY KEY (business_id, id),
    FOREIGN KEY (
      business_id, connection_id, integration_id, integration_major_version
    ) REFERENCES connections (
      business_id, id, integration_id, integration_major_version
    ) ON DELETE CASCADE,
    CHECK (encrypted_body IS NOT NULL OR raw_deleted_at IS NOT NULL)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_dedup_idx
     ON webhook_deliveries (
       business_id,
       integration_id,
       integration_major_version,
       COALESCE(connection_id, ''),
       deduplication_key
     )
     WHERE deduplication_key IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_verified_evidence_idx
     ON webhook_deliveries (
       business_id,
       integration_id,
       integration_major_version,
       COALESCE(connection_id, ''),
       authenticated_evidence_digest
     )
     WHERE authenticated_evidence_digest IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS webhook_deliveries_claim_idx
     ON webhook_deliveries (state, next_attempt_at)
     WHERE state IN ('accepted', 'normalized')`,
  `CREATE INDEX IF NOT EXISTS webhook_deliveries_retention_idx
     ON webhook_deliveries (received_at)
     WHERE encrypted_body IS NOT NULL`,
];

export const WEBHOOK_REGISTRATION_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS oim_webhook_registrations (
    business_id                  text NOT NULL,
    connection_id                text NOT NULL,
    integration_id               text NOT NULL,
    integration_major_version    integer NOT NULL CHECK (integration_major_version >= 0),
    desired_state                text NOT NULL CHECK (desired_state IN ('active', 'removed')),
    state                        text NOT NULL CHECK (
      state IN (
        'pending_registration', 'registering', 'registration_uncertain', 'active', 'pending_removal',
        'removing', 'cleanup_failed', 'removed'
      )
    ),
    target                       jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object'),
    active_registration          jsonb
      CHECK (active_registration IS NULL OR jsonb_typeof(active_registration) = 'object'),
    staged_secret_ref            text CHECK (
      staged_secret_ref IS NULL OR staged_secret_ref LIKE 'secret://%'
    ),
    attempts                     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    consecutive_failures         integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    renewal_cycle                bigint NOT NULL DEFAULT 0 CHECK (renewal_cycle >= 0),
    renewal_cycle_complete       boolean NOT NULL DEFAULT true,
    next_attempt_at              timestamptz NOT NULL DEFAULT now(),
    lease_token                  text,
    lease_expires_at             timestamptz,
    last_error                   text,
    generation                   bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
    revision                     bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at                   timestamptz NOT NULL DEFAULT now(),
    updated_at                   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, connection_id),
    FOREIGN KEY (
      business_id, connection_id, integration_id, integration_major_version
    ) REFERENCES connections (
      business_id, id, integration_id, integration_major_version
    ) ON DELETE CASCADE,
    CHECK (
      (lease_token IS NULL AND lease_expires_at IS NULL)
      OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS oim_webhook_registrations_due_idx
     ON oim_webhook_registrations (state, next_attempt_at, lease_expires_at)
     WHERE state IN (
       'pending_registration', 'pending_removal', 'cleanup_failed',
       'registering', 'registration_uncertain', 'removing'
     )`,
  `CREATE TABLE IF NOT EXISTS oim_webhook_registration_attempts (
    attempt_id                    text PRIMARY KEY,
    business_id                   text NOT NULL,
    connection_id                 text NOT NULL,
    integration_id                text NOT NULL,
    integration_major_version     integer NOT NULL CHECK (integration_major_version >= 0),
    generation                    bigint NOT NULL CHECK (generation > 0),
    target                        jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object'),
    idempotency_key               text NOT NULL,
    state                         text NOT NULL CHECK (
      state IN (
        'unresolved', 'cleanup_pending', 'cleanup_failed', 'adopted', 'absent', 'removed'
      )
    ),
    secret_ref                    text NOT NULL CHECK (secret_ref LIKE 'secret://%'),
    subscription_id               text,
    verified_identity             jsonb
      CHECK (verified_identity IS NULL OR jsonb_typeof(verified_identity) = 'object'),
    settled_absence_evidence      jsonb
      CHECK (
        settled_absence_evidence IS NULL
        OR jsonb_typeof(settled_absence_evidence) = 'object'
      ),
    attempts                      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at               timestamptz NOT NULL DEFAULT now(),
    lease_token                   text,
    lease_expires_at              timestamptz,
    last_error                    text,
    created_at                    timestamptz NOT NULL DEFAULT now(),
    updated_at                    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, connection_id, generation),
    UNIQUE (business_id, connection_id, idempotency_key),
    FOREIGN KEY (business_id, connection_id)
      REFERENCES oim_webhook_registrations(business_id, connection_id) ON DELETE CASCADE,
    CHECK (
      (lease_token IS NULL AND lease_expires_at IS NULL)
      OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),
    CHECK (
      (subscription_id IS NULL AND verified_identity IS NULL)
      OR (subscription_id IS NOT NULL AND verified_identity IS NOT NULL)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS oim_webhook_registration_attempts_due_idx
     ON oim_webhook_registration_attempts (state, next_attempt_at, lease_expires_at)
     WHERE state IN ('unresolved', 'cleanup_pending', 'cleanup_failed')`,
];

export const WEBSOCKET_INGRESS_SUPERVISOR_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS websocket_ingress_supervisor (
    business_id       text NOT NULL,
    connection_id     text NOT NULL,
    holder_token      text NOT NULL,
    lease_expires_at  timestamptz NOT NULL,
    PRIMARY KEY (business_id, connection_id),
    FOREIGN KEY (business_id, connection_id)
      REFERENCES connections (business_id, id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS websocket_ingress_supervisor_expiry_idx
     ON websocket_ingress_supervisor (lease_expires_at)`,
];
