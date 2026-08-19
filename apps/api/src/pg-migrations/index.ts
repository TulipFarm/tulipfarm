import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { MEMORY_DOCUMENT_STORAGE_STATEMENTS } from "@tulipfarm/memory";
import { INVOCATION_STORAGE_STATEMENTS } from "@tulipfarm/run-kernel";
import { MEMORY_SECTION_HEADINGS, MEMORY_SECTION_KEYS } from "@tulipfarm/schema";
import { SOUL_BUNDLE_STORAGE_STATEMENTS } from "@tulipfarm/soul";
import {
  ARTIFACT_STORAGE_STATEMENTS,
  AUTHORIZATION_STORAGE_STATEMENTS,
  BUDGET_STORAGE_STATEMENTS,
  CHANNEL_DELIVERY_STORAGE_STATEMENTS,
  CHANNEL_INBOUND_STORAGE_STATEMENTS,
  CHANNEL_MENTIONED_THREAD_STORAGE_STATEMENTS,
  CHANNEL_RUN_DELIVERY_APPROVAL_COLUMNS_STATEMENTS,
  CHANNEL_RUN_DELIVERY_STORAGE_STATEMENTS,
  CHILD_STORAGE_STATEMENTS,
  CONCURRENCY_STORAGE_STATEMENTS,
  CURATOR_ADMISSION_STATEMENTS,
  CURATOR_STORAGE_STATEMENTS,
  CURATOR_WORK_STORAGE_STATEMENTS,
  dropInvalidEmbeddingIndexes,
  EMBEDDING_COLUMNS,
  EVENT_STORAGE_STATEMENTS,
  embeddingIndexStatements,
  INTEGRATION_STORAGE_STATEMENTS,
  KILL_SWITCH_STORAGE_STATEMENTS,
  LOOP_CHECKPOINT_STORAGE_STATEMENTS,
  PUBLIC_ORIGIN_STORAGE_STATEMENTS,
  RUN_BOUNDS_REMOVAL_STATEMENTS,
  RUN_BROWSE_STORAGE_STATEMENTS,
  RUN_EVENT_NOTIFY_STATEMENTS,
  RUN_EVENT_STORAGE_STATEMENTS,
  RUN_STORAGE_STATEMENTS,
  SOUL_PUBLICATION_STORAGE_STATEMENTS,
  SOUL_REPOSITORY_STORAGE_STATEMENTS,
  STATE_CONCURRENCY_STORAGE_STATEMENTS,
  STATE_CONTENTION_STORAGE_STATEMENTS,
  STATE_RETRY_STORAGE_STATEMENTS,
  TASK_STORAGE_STATEMENTS,
  WAIT_STORAGE_STATEMENTS,
} from "@tulipfarm/storage";
import { EFFECT_STORAGE_STATEMENTS } from "@tulipfarm/tool-broker";
import { APPROVAL_EVIDENCE_STORAGE_STATEMENTS } from "@tulipfarm/tool-host";
import type { Queryable } from "../db";

export interface PgMigration {
  version: number;
  description: string;
  up: (q: Queryable) => Promise<void>;
  /** Run outside a transaction only for statements Postgres forbids inside one. */
  concurrent?: boolean;
}

/** Failure-only log spine, separate from AI-shaped `obs_event` aggregates. */
const LOG_EVENT_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS log_event (
    id              uuid PRIMARY KEY,
    ts              timestamptz NOT NULL,
    level           text NOT NULL,
    service         text NOT NULL,
    message         text NOT NULL,
    stack           text,
    request_id      text,
    run_id          text,
    conversation_id text,
    attributes      jsonb NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL
  )`,
  // Cursor order matches the index, avoiding a window sort.
  "CREATE INDEX IF NOT EXISTS log_event_ts_idx ON log_event (ts DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS log_event_level_ts_idx ON log_event (level, ts DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS log_event_service_ts_idx ON log_event (service, ts DESC, id DESC)",
  // No trigram index: error-path writes stay cheap; time/level indexes narrow admin search.
];

/** Fixed-cadence resource gauges; instance is retained so replicas aggregate honestly. */
const RESOURCE_SAMPLE_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS resource_sample (
    id         uuid PRIMARY KEY,
    ts         timestamptz NOT NULL,
    service    text NOT NULL,
    instance   text NOT NULL,
    cpu_pct    real NOT NULL,
    rss_bytes  bigint NOT NULL
  )`,
  // Service-leading index serves grouped reads; ts-only index serves retention.
  "CREATE INDEX IF NOT EXISTS resource_sample_ts_idx ON resource_sample (ts DESC)",
  "CREATE INDEX IF NOT EXISTS resource_sample_service_ts_idx ON resource_sample (service, ts DESC)",
];

/** Greenfield baseline; idempotent statements allow safe replay after interruption. */
const BASELINE_STATEMENTS: string[] = [
  "CREATE EXTENSION IF NOT EXISTS vector",
  "CREATE EXTENSION IF NOT EXISTS citext",
  "CREATE EXTENSION IF NOT EXISTS pg_trgm",
  "CREATE SCHEMA IF NOT EXISTS resources",
  `CREATE TABLE IF NOT EXISTS users (
    id            uuid PRIMARY KEY,
    email         citext NOT NULL UNIQUE,
    password_hash text NOT NULL,
    role          text NOT NULL,
    created_at    timestamptz NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS users_single_admin_idx ON users (role) WHERE role = 'admin'",
  `CREATE TABLE IF NOT EXISTS api_tokens (
    id         uuid PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users(id),
    name       text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    prefix     text NOT NULL,
    created_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS secrets (
    key             text PRIMARY KEY,
    type            text NOT NULL,
    encrypted_value text NOT NULL,
    iv              text NOT NULL,
    auth_tag        text NOT NULL,
    dek_id          uuid,
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    sid        text PRIMARY KEY,
    user_id    uuid NOT NULL,
    expires_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id         uuid PRIMARY KEY,
    user_id    uuid,
    agent_id   text,
    model      text,
    title      text,
    starred    boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT conversations_owner_check CHECK (user_id IS NOT NULL OR agent_id IS NOT NULL)
  )`,
  "CREATE INDEX IF NOT EXISTS conversations_user_updated_idx ON conversations (user_id, updated_at)",
  `CREATE TABLE IF NOT EXISTS messages (
    id              uuid PRIMARY KEY,
    conversation_id uuid NOT NULL REFERENCES conversations(id),
    role            text NOT NULL,
    content         jsonb NOT NULL,
    metadata        jsonb,
    created_at      timestamptz NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS messages_conversation_created_idx ON messages (conversation_id, created_at, id)",
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key          text NOT NULL,
    window_start timestamptz NOT NULL,
    count        integer NOT NULL,
    PRIMARY KEY (key, window_start)
  )`,
  `CREATE TABLE IF NOT EXISTS counters (
    type text PRIMARY KEY,
    seq  bigint NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge_spaces (
    id          uuid PRIMARY KEY,
    name        text NOT NULL UNIQUE,
    description text,
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge_pages (
    id                     uuid PRIMARY KEY,
    title                  text NOT NULL,
    content                text NOT NULL,
    plain_text             text NOT NULL,
    source                 text NOT NULL,
    source_id              text NOT NULL,
    domain                 text,
    tags                   text[] NOT NULL DEFAULT '{}',
    active                 boolean NOT NULL DEFAULT true,
    always_load_for_agents boolean NOT NULL DEFAULT false,
    version                integer NOT NULL DEFAULT 1,
    space_id               uuid REFERENCES knowledge_spaces(id),
    path                   text,
    resource               text,
    frontmatter_extra      jsonb NOT NULL DEFAULT '{}',
    title_tsv              tsvector GENERATED ALWAYS AS
                             (setweight(to_tsvector('english', coalesce(title, '')), 'A')) STORED,
    type                   text,
    created_at             timestamptz NOT NULL,
    updated_at             timestamptz NOT NULL,
    UNIQUE (source, source_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS knowledge_pages_space_path_idx
    ON knowledge_pages (space_id, path) WHERE space_id IS NOT NULL AND path IS NOT NULL`,
  "CREATE INDEX IF NOT EXISTS knowledge_pages_title_tsv_gin ON knowledge_pages USING gin (title_tsv)",
  "CREATE INDEX IF NOT EXISTS knowledge_pages_type_idx ON knowledge_pages (type)",
  "CREATE INDEX IF NOT EXISTS knowledge_pages_title_trgm ON knowledge_pages USING gin (title gin_trgm_ops)",
  `CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id           uuid PRIMARY KEY,
    page_id      uuid NOT NULL REFERENCES knowledge_pages(id) ON DELETE CASCADE,
    chunk_index  integer NOT NULL,
    content      text NOT NULL,
    content_hash text,
    embedding    vector,
    tsv          tsvector NOT NULL,
    model        text,
    dim          integer,
    created_at   timestamptz NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS knowledge_chunks_tsv_gin ON knowledge_chunks USING gin (tsv)",
  "CREATE INDEX IF NOT EXISTS knowledge_chunks_page_idx ON knowledge_chunks (page_id)",
  "CREATE INDEX IF NOT EXISTS knowledge_chunks_dim_idx ON knowledge_chunks (dim)",
  "CREATE UNIQUE INDEX IF NOT EXISTS knowledge_chunks_page_chunk_idx ON knowledge_chunks (page_id, chunk_index)",
  `CREATE TABLE IF NOT EXISTS knowledge_revisions (
    id              uuid PRIMARY KEY,
    page_id         uuid NOT NULL REFERENCES knowledge_pages(id) ON DELETE CASCADE,
    revision_number integer NOT NULL,
    content         text NOT NULL,
    plain_text      text NOT NULL,
    reason          text,
    created_at      timestamptz NOT NULL,
    UNIQUE (page_id, revision_number)
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge_links (
    id                uuid PRIMARY KEY,
    space_id          uuid NOT NULL REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
    source_id         uuid NOT NULL REFERENCES knowledge_pages(id) ON DELETE CASCADE,
    target_path       text NOT NULL,
    target_id         uuid REFERENCES knowledge_pages(id) ON DELETE SET NULL,
    target_space_id   uuid REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
    target_space_name text,
    created_at        timestamptz NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS knowledge_links_source_idx ON knowledge_links (source_id)",
  "CREATE INDEX IF NOT EXISTS knowledge_links_target_idx ON knowledge_links (target_id)",
  "CREATE INDEX IF NOT EXISTS knowledge_links_space_idx ON knowledge_links (space_id)",
  `CREATE UNIQUE INDEX IF NOT EXISTS knowledge_links_source_target_uidx
    ON knowledge_links (source_id, COALESCE(target_space_name, ''), target_path)`,
  "CREATE INDEX IF NOT EXISTS knowledge_links_target_space_idx ON knowledge_links (target_space_id)",
  `CREATE INDEX IF NOT EXISTS knowledge_links_target_space_name_idx
    ON knowledge_links (target_space_name) WHERE target_space_name IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS knowledge_space_overrides (
    space_id   uuid NOT NULL REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
    dir_path   text NOT NULL,
    file       text NOT NULL CHECK (file IN ('index.md', 'log.md')),
    content    text NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (space_id, dir_path, file)
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge_connectors (
    name        text PRIMARY KEY,
    enabled     boolean NOT NULL DEFAULT false,
    cursor      text,
    last_run_at timestamptz,
    last_error  text,
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS stream_resume (
    stream_id  uuid NOT NULL,
    seq        integer NOT NULL,
    event_type text NOT NULL,
    data       jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (stream_id, seq)
  )`,
  "CREATE INDEX IF NOT EXISTS stream_resume_gc_idx ON stream_resume (created_at)",
  `CREATE TABLE IF NOT EXISTS approvals (
    id          uuid PRIMARY KEY,
    kind        text NOT NULL,
    status      text NOT NULL DEFAULT 'pending',
    payload     jsonb NOT NULL,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL,
    resolved_at timestamptz
  )`,
  "CREATE INDEX IF NOT EXISTS approvals_status_expires_idx ON approvals (status, expires_at)",
  `CREATE TABLE IF NOT EXISTS message_feedback (
    id              uuid PRIMARY KEY,
    message_id      uuid NOT NULL REFERENCES messages(id),
    conversation_id uuid NOT NULL REFERENCES conversations(id),
    user_id         uuid NOT NULL,
    rating          smallint NOT NULL CHECK (rating IN (1, -1)),
    note            text,
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL,
    UNIQUE (message_id, user_id)
  )`,
  "CREATE INDEX IF NOT EXISTS message_feedback_convo_idx ON message_feedback (conversation_id)",
  `CREATE TABLE IF NOT EXISTS pending_interactions (
    id              uuid PRIMARY KEY,
    conversation_id uuid NOT NULL REFERENCES conversations(id),
    tool_call_id    text NOT NULL,
    tool_name       text NOT NULL,
    awaited_schema  jsonb NOT NULL,
    surface_id      text,
    created_at      timestamptz NOT NULL,
    resolved_at     timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS pending_interactions_open_idx
    ON pending_interactions (conversation_id) WHERE resolved_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS kv_store (
    scope      text NOT NULL,
    owner_id   text NOT NULL DEFAULT '',
    namespace  text NOT NULL,
    key        text NOT NULL,
    value      jsonb NOT NULL,
    expires_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (scope, owner_id, namespace, key),
    CONSTRAINT kv_store_scope_check CHECK (scope IN ('system', 'user', 'agent')),
    CONSTRAINT kv_store_owner_check CHECK ((scope = 'system') = (owner_id = ''))
  )`,
  "CREATE INDEX IF NOT EXISTS kv_store_owner_ns_idx ON kv_store (scope, owner_id, namespace)",
  `CREATE TABLE IF NOT EXISTS wrapped_deks (
    dek_id          uuid NOT NULL,
    kek_label       text NOT NULL,
    encrypted_value text NOT NULL,
    iv              text NOT NULL,
    auth_tag        text NOT NULL,
    canary_value    text,
    canary_iv       text,
    canary_auth_tag text,
    created_at      timestamptz NOT NULL,
    retired_at      timestamptz,
    PRIMARY KEY (dek_id, kek_label),
    CONSTRAINT wrapped_deks_kek_label_check CHECK (kek_label IN ('env', 'recovery'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS wrapped_deks_active_label_idx
    ON wrapped_deks (kek_label) WHERE retired_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS activity_log (
    id          uuid PRIMARY KEY,
    category    text NOT NULL,
    action      text NOT NULL,
    actor_type  text NOT NULL,
    actor_id    uuid,
    target_type text,
    target_id   text,
    summary     text NOT NULL,
    status      text NOT NULL DEFAULT 'ok',
    metadata    jsonb NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS activity_log_created_idx ON activity_log (created_at DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS activity_log_category_created_idx ON activity_log (category, created_at DESC, id DESC)",
  `CREATE TABLE IF NOT EXISTS obs_event (
    id              uuid PRIMARY KEY,
    ts              timestamptz NOT NULL,
    type            text NOT NULL,
    agent_id        text,
    conversation_id text,
    model           text,
    provider        text,
    tier            text,
    tokens_in       integer,
    tokens_out      integer,
    cost_usd        numeric,
    duration_ms     integer,
    status          text,
    tool_name       text,
    attributes      jsonb NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS obs_event_ts_idx ON obs_event (ts DESC)",
  "CREATE INDEX IF NOT EXISTS obs_event_type_ts_idx ON obs_event (type, ts DESC)",
  "CREATE INDEX IF NOT EXISTS obs_event_agent_ts_idx ON obs_event (agent_id, ts DESC)",
  "CREATE INDEX IF NOT EXISTS obs_event_model_ts_idx ON obs_event (model, ts DESC)",
  ...LOG_EVENT_STATEMENTS,
  ...RESOURCE_SAMPLE_STATEMENTS,
  `CREATE TABLE IF NOT EXISTS routine_runs (
    id                  uuid PRIMARY KEY,
    routine_slug        text NOT NULL,
    definition_snapshot jsonb NOT NULL,
    definition_hash     text NOT NULL,
    status              text NOT NULL,
    current_state       text,
    context             jsonb NOT NULL DEFAULT '{}',
    trigger             jsonb NOT NULL,
    attempt_counts      jsonb NOT NULL DEFAULT '{}',
    wake_at             timestamptz,
    state_deadline      timestamptz,
    approval_id         uuid,
    output              jsonb,
    error               jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    finished_at         timestamptz
  )`,
  "CREATE INDEX IF NOT EXISTS routine_runs_slug_idx ON routine_runs (routine_slug, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS routine_runs_wake_idx ON routine_runs (wake_at) WHERE wake_at IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS routine_runs_deadline_idx ON routine_runs (state_deadline) WHERE state_deadline IS NOT NULL",
  `CREATE TABLE IF NOT EXISTS routine_run_events (
    run_id     uuid NOT NULL,
    seq        integer NOT NULL,
    type       text NOT NULL,
    payload    jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS integration_conversations (
    integration_slug text NOT NULL,
    external_key     text NOT NULL,
    conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (integration_slug, external_key)
  )`,
  "CREATE INDEX IF NOT EXISTS integration_conversations_convo_idx ON integration_conversations (conversation_id)",
  `CREATE TABLE IF NOT EXISTS integration_events (
    id               uuid PRIMARY KEY,
    integration_slug text NOT NULL,
    protocol         text NOT NULL,
    event_type       text NOT NULL,
    external_id      text,
    payload          jsonb NOT NULL DEFAULT '{}',
    created_at       timestamptz NOT NULL DEFAULT now()
  )`,
  "CREATE INDEX IF NOT EXISTS integration_events_slug_created_idx ON integration_events (integration_slug, created_at DESC)",
  `CREATE TABLE IF NOT EXISTS ingress_deliveries (
    integration_slug text NOT NULL,
    dedup_key        text NOT NULL,
    received_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (integration_slug, dedup_key)
  )`,
  "CREATE INDEX IF NOT EXISTS ingress_deliveries_received_idx ON ingress_deliveries (received_at)",
];

/** Adds hardened auth/identity: statuses, evidence, API clients, OIDC, mappings, links. */
const IDENTITY_STATEMENTS: string[] = [
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'",
  "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()",
  "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS auth_methods text[] NOT NULL DEFAULT '{}'",
  "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mfa_verified_at timestamptz",
  "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS csrf_token text",
  `CREATE TABLE IF NOT EXISTS api_clients (
    id            uuid PRIMARY KEY,
    client_id     text NOT NULL UNIQUE,
    name          text NOT NULL,
    secret_hash   text NOT NULL,
    owner_user_id uuid NOT NULL REFERENCES users(id),
    status        text NOT NULL DEFAULT 'active',
    expires_at    timestamptz,
    created_at    timestamptz NOT NULL,
    rotated_at    timestamptz
  )`,
  "CREATE INDEX IF NOT EXISTS api_clients_owner_idx ON api_clients (owner_user_id)",
  `CREATE TABLE IF NOT EXISTS oidc_auth_requests (
    state         text PRIMARY KEY,
    nonce         text NOT NULL,
    code_verifier text NOT NULL,
    redirect_to   text,
    created_at    timestamptz NOT NULL,
    expires_at    timestamptz NOT NULL,
    consumed_at   timestamptz
  )`,
  "CREATE INDEX IF NOT EXISTS oidc_auth_requests_expires_idx ON oidc_auth_requests (expires_at)",
  `CREATE TABLE IF NOT EXISTS external_identity_mappings (
    provider        text NOT NULL,
    external_subject text NOT NULL,
    user_id         uuid NOT NULL REFERENCES users(id),
    verified_at     timestamptz NOT NULL,
    expires_at      timestamptz,
    PRIMARY KEY (provider, external_subject)
  )`,
  "CREATE INDEX IF NOT EXISTS external_identity_mappings_user_idx ON external_identity_mappings (user_id)",
  `CREATE TABLE IF NOT EXISTS external_link_tokens (
    token_hash  text PRIMARY KEY,
    provider    text NOT NULL,
    user_id     uuid NOT NULL REFERENCES users(id),
    created_at  timestamptz NOT NULL,
    expires_at  timestamptz NOT NULL,
    consumed_at timestamptz
  )`,
];

/** Raw encrypted webhook bytes predate any Run, so they cannot be Artifacts. */
const WEBHOOK_VAULT_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS webhook_raw_payloads (
    id             uuid PRIMARY KEY,
    business_id    text NOT NULL,
    provider       text NOT NULL,
    trigger_slug   text NOT NULL,
    encrypted_body text NOT NULL,
    iv             text NOT NULL,
    auth_tag       text NOT NULL,
    received_at    timestamptz NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS webhook_raw_payloads_business_idx ON webhook_raw_payloads (business_id)",
];

/** ACL-first source/chunk storage; chunks cascade so revoked text cannot outlive authority. */
const KNOWLEDGE_SOURCES_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS knowledge_source_records (
    source_id                      text NOT NULL,
    business_id                    text NOT NULL,
    integration_id                 text NOT NULL,
    provider                       text NOT NULL,
    external_id                    text NOT NULL,
    external_tenant_id             text NOT NULL,
    owner_external_id              text NOT NULL,
    revision                       text NOT NULL,
    classification                 text[] NOT NULL DEFAULT '{}',
    status                         text NOT NULL,
    verification                   text NOT NULL,
    access_control_mode            text NOT NULL,
    access_control_max_age_seconds integer NOT NULL,
    acl_revision                   text,
    acl_captured_at                timestamptz,
    acl_principals                 jsonb,
    provenance_captured_at         timestamptz NOT NULL,
    provenance_content_hash        text NOT NULL,
    provenance_checkpoint          text,
    last_synced_at                 timestamptz NOT NULL,
    created_at                     timestamptz NOT NULL,
    updated_at                     timestamptz NOT NULL,
    PRIMARY KEY (business_id, source_id)
  )`,
  "CREATE INDEX IF NOT EXISTS knowledge_source_records_business_idx ON knowledge_source_records (business_id)",
  `CREATE TABLE IF NOT EXISTS knowledge_source_chunks (
    business_id  text NOT NULL,
    source_id    text NOT NULL,
    chunk_id     text NOT NULL,
    revision     text NOT NULL,
    classification text[] NOT NULL DEFAULT '{}',
    digest       text NOT NULL,
    content      text NOT NULL,
    embedding    vector,
    tsv          tsvector NOT NULL,
    model        text,
    dim          integer,
    created_at   timestamptz NOT NULL,
    updated_at   timestamptz NOT NULL,
    PRIMARY KEY (business_id, chunk_id),
    FOREIGN KEY (business_id, source_id)
      REFERENCES knowledge_source_records (business_id, source_id) ON DELETE CASCADE
  )`,
  "CREATE INDEX IF NOT EXISTS knowledge_source_chunks_tsv_gin ON knowledge_source_chunks USING gin (tsv)",
  "CREATE INDEX IF NOT EXISTS knowledge_source_chunks_source_idx ON knowledge_source_chunks (business_id, source_id)",
  "CREATE INDEX IF NOT EXISTS knowledge_source_chunks_dim_idx ON knowledge_source_chunks (dim)",
];

/** Slack sync checkpoint keyed by business-unique integrationId. */
const SLACK_KNOWLEDGE_CHECKPOINT_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS slack_knowledge_checkpoints (
    integration_id text NOT NULL,
    channel_id     text NOT NULL,
    cursor         text,
    updated_at     timestamptz NOT NULL,
    PRIMARY KEY (integration_id, channel_id)
  )`,
];

/** Durable fire-state for Routine `x-triggers`, created lazily and dropped when removed. */
const ROUTINE_SCHEDULE_STATE_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS routine_schedule_state (
    business_id            text NOT NULL,
    routine_slug           text NOT NULL,
    trigger_index          integer NOT NULL,
    dedup_key              text NOT NULL,
    last_scheduled_for_ms  bigint,
    next_due_at_ms         bigint,
    updated_at             timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, routine_slug, trigger_index)
  )`,
  `CREATE INDEX IF NOT EXISTS routine_schedule_state_due_idx
    ON routine_schedule_state (business_id, next_due_at_ms)`,
];

/** Durable per-Confluence-tenant resume position for `syncConfluenceKnowledge`. */
const CONFLUENCE_KNOWLEDGE_CHECKPOINT_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS confluence_knowledge_checkpoints (
    integration_id text PRIMARY KEY,
    cursor         text,
    updated_at     timestamptz NOT NULL
  )`,
];

/** Durable resume positions for K3 Knowledge sync providers. */
const KNOWLEDGE_SYNC_CHECKPOINT_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS knowledge_sync_checkpoints (
    provider       text NOT NULL,
    integration_id text NOT NULL,
    cursor         text,
    updated_at     timestamptz NOT NULL,
    PRIMARY KEY (provider, integration_id)
  )`,
];

/** One-use auth requests hold PKCE verifier server-side to prevent replay and browser swapping. */
const INTEGRATION_AUTH_REQUEST_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS integration_auth_requests (
    state             text PRIMARY KEY,
    integration_slug  text NOT NULL,
    step_index        integer NOT NULL,
    code_verifier     text,
    created_at        timestamptz NOT NULL,
    expires_at        timestamptz NOT NULL,
    consumed_at       timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS integration_auth_requests_expires_idx
    ON integration_auth_requests (expires_at)`,
];

/**
 * Per-principal provider credentials store no secrets, only encrypted secret keys.
 * `revoked_at` preserves evidence while resolution treats revoked credentials as absent.
 */
const PRINCIPAL_PROVIDER_TOKEN_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS principal_provider_tokens (
    business_id        text NOT NULL,
    principal_kind     text NOT NULL,
    principal_id       text NOT NULL,
    provider           text NOT NULL,
    secret_key         text NOT NULL,
    refresh_secret_key text,
    external_subject   text,
    scopes             text[] NOT NULL DEFAULT '{}',
    connected_at       timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    expires_at         timestamptz,
    revoked_at         timestamptz,
    PRIMARY KEY (business_id, principal_kind, principal_id, provider)
  )`,
  `CREATE INDEX IF NOT EXISTS principal_provider_tokens_provider_idx
    ON principal_provider_tokens (business_id, provider)`,
  // Re-asserts the one-use request table so cross-migration dependency failures are loud.
  ...INTEGRATION_AUTH_REQUEST_STATEMENTS,
  "ALTER TABLE integration_auth_requests ADD COLUMN IF NOT EXISTS principal_kind text",
  "ALTER TABLE integration_auth_requests ADD COLUMN IF NOT EXISTS principal_id text",
];

/* Moves GitHub App credentials to the declarative integration secret namespace idempotently. */
const GITHUB_APP_SECRET_KEY_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ["github-app-id", "integration.github.GITHUB_APP_ID"],
  ["github-app-slug", "integration.github.GITHUB_APP_SLUG"],
  ["github-app-private-key", "integration.github.GITHUB_APP_PRIVATE_KEY"],
  ["github-app-webhook-secret", "integration.github.GITHUB_WEBHOOK_SECRET"],
];

async function renameGitHubAppSecretKeys(q: Queryable): Promise<void> {
  // Restores without `secrets` have no App credentials to carry over.
  const present = await q.query("SELECT to_regclass('public.secrets') IS NOT NULL AS exists");
  if (present.rows[0]?.exists !== true) return;

  for (const [from, to] of GITHUB_APP_SECRET_KEY_RENAMES) {
    await q.query(
      `UPDATE secrets SET key = $2 WHERE key = $1
         AND NOT EXISTS (SELECT 1 FROM secrets existing WHERE existing.key = $2)`,
      [from, to]
    );
    await q.query("DELETE FROM secrets WHERE key = $1", [from]);
  }
}

async function ensureSurfaceStorage(q: Queryable): Promise<void> {
  await q.query(`CREATE TABLE IF NOT EXISTS surface_actions (
    handle              text PRIMARY KEY,
    artifact_id         text NOT NULL,
    revision            integer NOT NULL CHECK (revision > 0),
    event               text NOT NULL,
    payload             jsonb NOT NULL,
    input_schema        jsonb NOT NULL,
    audience            text[] NOT NULL,
    target              jsonb NOT NULL,
    destination         text NOT NULL,
    conversation_id     uuid REFERENCES conversations(id),
    run_id              text,
    wait_id             text,
    guardrail_revision  text NOT NULL,
    expires_at          timestamptz NOT NULL,
    consumed_at         timestamptz,
    step_up             boolean NOT NULL DEFAULT false
  )`);
  await q.query(
    "CREATE INDEX IF NOT EXISTS surface_actions_expiry_idx ON surface_actions (expires_at)"
  );
  await q.query(`CREATE TABLE IF NOT EXISTS surface_deliveries (
    artifact_id         text NOT NULL,
    revision            integer NOT NULL CHECK (revision > 0),
    channel             text NOT NULL,
    surface             text NOT NULL,
    destination         text NOT NULL,
    provider_message_id text,
    status              text NOT NULL,
    attempts            integer NOT NULL DEFAULT 0,
    last_error          text,
    updated_at          timestamptz NOT NULL,
    PRIMARY KEY (artifact_id, revision, channel, surface, destination)
  )`);
  const retiredPrefix = ["a", "2", "u", "i"].join("");
  await q.query(`DROP TABLE IF EXISTS ${retiredPrefix}_surfaces`);
  await q.query(`DROP TABLE IF EXISTS ${retiredPrefix}_action_nonces`);
}

async function hasTableColumns(
  q: Queryable,
  table: string,
  columns: readonly string[]
): Promise<boolean> {
  const present = await q.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2)`,
    [table, columns]
  );
  return present.rows.length === columns.length;
}

async function seedBootstrapRole(
  q: Queryable,
  roleId: string,
  grants: ReadonlyArray<{
    readonly action: string;
    readonly resourceType: string;
    readonly domain?: string;
    readonly effect: "allow" | "deny";
  }>
): Promise<void> {
  await q.query(
    `INSERT INTO roles (business_id, id, assignable_to)
     VALUES ($1, $2, $3)
     ON CONFLICT (business_id, id) DO UPDATE SET
       assignable_to = EXCLUDED.assignable_to,
       updated_at = now()`,
    [DEPLOYMENT_BUSINESS_ID, roleId, ["user"]]
  );
  for (const [index, grant] of grants.entries()) {
    await q.query(
      `INSERT INTO role_grants (
         business_id, role_id, grant_index, action, resource_type, domain, effect
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (business_id, role_id, grant_index) DO UPDATE SET
         action = EXCLUDED.action,
         resource_type = EXCLUDED.resource_type,
         domain = EXCLUDED.domain,
         effect = EXCLUDED.effect`,
      [
        DEPLOYMENT_BUSINESS_ID,
        roleId,
        index,
        grant.action,
        grant.resourceType,
        grant.domain ?? null,
        grant.effect,
      ]
    );
  }
}

async function seedAuthorizationBootstrap(q: Queryable): Promise<void> {
  for (const sql of AUTHORIZATION_STORAGE_STATEMENTS) {
    await q.query(sql);
  }

  await q.query("DROP INDEX IF EXISTS users_single_admin_idx");

  const hasUsersForSeed = await hasTableColumns(q, "users", ["id", "role", "status", "created_at"]);
  if (hasUsersForSeed) {
    await q.query(
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS setup_bootstrap boolean NOT NULL DEFAULT false"
    );
    await q.query(`WITH owner_user AS (
      SELECT id
        FROM users
       WHERE role = 'admin' AND status = 'active'
         AND NOT EXISTS (SELECT 1 FROM users WHERE setup_bootstrap)
       ORDER BY created_at, id
       LIMIT 1
    )
    UPDATE users
       SET setup_bootstrap = true
     WHERE id IN (SELECT id FROM owner_user)`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_setup_bootstrap_admin_idx
      ON users (setup_bootstrap) WHERE setup_bootstrap AND role = 'admin'`);
  }

  // Kept in step with `DEPLOYMENT_ROLES`: the boot sync rewrites both rows anyway, but a seed that
  // disagrees with the catalog is how `owner` came to grant nothing at all (#408).
  await seedBootstrapRole(q, "owner", [
    { action: "*", resourceType: "*", effect: "allow" },
    { action: "*", resourceType: "*", domain: "*", effect: "allow" },
  ]);
  await seedBootstrapRole(q, "admin", [
    { action: "*", resourceType: "*", effect: "allow" },
    { action: "*", resourceType: "*", domain: "*", effect: "allow" },
  ]);
  await seedBootstrapRole(q, "member", []);
  await q.query(
    `INSERT INTO principal_groups (business_id, id)
     VALUES ($1, 'owners')
     ON CONFLICT (business_id, id) DO NOTHING`,
    [DEPLOYMENT_BUSINESS_ID]
  );

  if (!hasUsersForSeed) return;

  await q.query(
    `INSERT INTO principals (business_id, id, kind, status)
     SELECT $1, id::text, 'user',
            CASE WHEN status = 'active' THEN 'active' ELSE 'disabled' END
       FROM users
     ON CONFLICT (business_id, id) DO UPDATE SET
       kind = EXCLUDED.kind,
       status = EXCLUDED.status,
       updated_at = now()`,
    [DEPLOYMENT_BUSINESS_ID]
  );
  await q.query(
    `INSERT INTO role_assignments (business_id, principal_id, role_id)
     SELECT $1, id::text, role
       FROM users
      WHERE role IN ('admin', 'member')
     ON CONFLICT (business_id, principal_id, role_id) DO UPDATE SET
       expires_at = NULL,
       assigned_at = now()`,
    [DEPLOYMENT_BUSINESS_ID]
  );
  await q.query(
    `WITH owner_user AS (
       SELECT id::text AS principal_id
         FROM users
        WHERE role = 'admin' AND status = 'active'
        ORDER BY created_at, id
        LIMIT 1
     )
     INSERT INTO role_assignments (business_id, principal_id, role_id)
     SELECT $1, principal_id, 'owner' FROM owner_user
     ON CONFLICT (business_id, principal_id, role_id) DO UPDATE SET
       expires_at = NULL,
       assigned_at = now()`,
    [DEPLOYMENT_BUSINESS_ID]
  );
  await q.query(
    `WITH owner_user AS (
       SELECT id::text AS principal_id
         FROM users
        WHERE role = 'admin' AND status = 'active'
        ORDER BY created_at, id
        LIMIT 1
     )
     INSERT INTO principal_group_members (business_id, group_id, principal_id)
     SELECT $1, 'owners', principal_id FROM owner_user
     ON CONFLICT (business_id, group_id, principal_id) DO UPDATE SET
       expires_at = NULL,
       assigned_at = now()`,
    [DEPLOYMENT_BUSINESS_ID]
  );

  const businessIdLiteral = DEPLOYMENT_BUSINESS_ID.replaceAll("'", "''");
  await q.query(`
    CREATE OR REPLACE FUNCTION sync_user_authorization()
      RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      deployment_business_id text := '${businessIdLiteral}';
      principal_status text;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        DELETE FROM principals
         WHERE business_id = deployment_business_id AND id = OLD.id::text;
        RETURN OLD;
      END IF;

      principal_status := CASE WHEN NEW.status = 'active' THEN 'active' ELSE 'disabled' END;

      INSERT INTO principals (business_id, id, kind, status)
      VALUES (deployment_business_id, NEW.id::text, 'user', principal_status)
      ON CONFLICT (business_id, id) DO UPDATE SET
        kind = EXCLUDED.kind,
        status = EXCLUDED.status,
        updated_at = now();

      IF TG_OP = 'UPDATE' AND OLD.role IS DISTINCT FROM NEW.role THEN
        DELETE FROM role_assignments
         WHERE business_id = deployment_business_id
           AND principal_id = NEW.id::text
           AND role_id = OLD.role;

        IF OLD.role = 'admin' AND NEW.role IS DISTINCT FROM 'admin' THEN
          DELETE FROM role_assignments
           WHERE business_id = deployment_business_id
             AND principal_id = NEW.id::text
             AND role_id = 'owner';

          DELETE FROM principal_group_members
           WHERE business_id = deployment_business_id
             AND group_id = 'owners'
             AND principal_id = NEW.id::text;
        END IF;
      END IF;

      IF NEW.role IN ('admin', 'member') THEN
        INSERT INTO role_assignments (business_id, principal_id, role_id)
        VALUES (deployment_business_id, NEW.id::text, NEW.role)
        ON CONFLICT (business_id, principal_id, role_id) DO UPDATE SET
          expires_at = NULL,
          assigned_at = now();
      END IF;

      RETURN NEW;
    END;
    $$`);
  await q.query("DROP TRIGGER IF EXISTS users_sync_authorization ON users");
  await q.query(`
    CREATE TRIGGER users_sync_authorization
    AFTER INSERT OR DELETE OR UPDATE OF role, status ON users
    FOR EACH ROW EXECUTE FUNCTION sync_user_authorization()
  `);
}

/**
 * Most migrations do nothing but run a package's `*_STORAGE_STATEMENTS` in order. Spelling that
 * loop out per migration hid the ones that do something else among 37 identical copies.
 */
function applyStatements(...groups: readonly (readonly string[])[]): PgMigration["up"] {
  return async (q) => {
    for (const group of groups) {
      for (const sql of group) {
        await q.query(sql);
      }
    }
  };
}

/**
 * Renders the retired six-key section projection as the Markdown page that replaced it. Local to
 * migration 65 because no live code reads that shape any more; importing a renderer for it would
 * keep a dead structure alive in `@tulipfarm/memory` to serve one already-executed migration.
 */
function renderProjectionRow(value: unknown): string {
  const source = (value ?? {}) as Record<string, unknown>;
  return MEMORY_SECTION_KEYS.map((key) => {
    const raw = source[key];
    const content = typeof raw === "string" ? raw.trim() : "";
    return content ? `## ${MEMORY_SECTION_HEADINGS[key]}\n\n${content}` : "";
  })
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export const PG_MIGRATIONS: PgMigration[] = [
  {
    version: 1,
    description: "greenfield baseline",
    up: applyStatements(BASELINE_STATEMENTS),
  },
  {
    version: 2,
    description: "hardened authentication and identity",
    up: applyStatements(IDENTITY_STATEMENTS),
  },
  {
    version: 3,
    description: "transactional event inbox and outbox",
    up: applyStatements(EVENT_STORAGE_STATEMENTS),
  },
  {
    version: 4,
    description: "durable Runs, States, attempts, and lineage",
    up: applyStatements(RUN_STORAGE_STATEMENTS),
  },
  {
    version: 5,
    description: "immutable typed outputs and Artifacts",
    up: applyStatements(ARTIFACT_STORAGE_STATEMENTS),
  },
  {
    version: 6,
    description: "durable waits, timers, and resume tokens",
    up: applyStatements(WAIT_STORAGE_STATEMENTS),
  },
  {
    version: 7,
    description: "budgets, limits, and target concurrency",
    up: applyStatements(BUDGET_STORAGE_STATEMENTS, CONCURRENCY_STORAGE_STATEMENTS),
  },
  {
    version: 8,
    description: "child Run links",
    up: applyStatements(CHILD_STORAGE_STATEMENTS),
  },
  {
    version: 9,
    description: "persisted Run event stream",
    up: applyStatements(RUN_EVENT_STORAGE_STATEMENTS),
  },
  {
    version: 10,
    description: "durable Tool intents and effect ledger",
    up: applyStatements(EFFECT_STORAGE_STATEMENTS),
  },
  {
    version: 11,
    description: "Integration Apps, installations, AccessGrants, and channel routing",
    up: applyStatements(INTEGRATION_STORAGE_STATEMENTS, CHANNEL_DELIVERY_STORAGE_STATEMENTS),
  },
  {
    version: 12,
    description: "unified durable invocation cutover",
    up: applyStatements(INVOCATION_STORAGE_STATEMENTS),
  },
  {
    version: 13,
    description: "operational Run browser page order",
    up: applyStatements(RUN_BROWSE_STORAGE_STATEMENTS),
  },
  {
    version: 14,
    description: "Tulip Surface Protocol actions, deliveries, and legacy cleanup",
    up: ensureSurfaceStorage,
  },
  {
    version: 15,
    description: "repair Tulip Surface Protocol storage on existing databases",
    up: ensureSurfaceStorage,
  },
  {
    version: 16,
    description: "durable Conversation Turns",
    up: async (q) => {
      // Existing messages predate Turns; NULL `turn_id` avoids inventing ownership.
      await q.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS turn_id uuid");
      await q.query(`CREATE TABLE IF NOT EXISTS conversation_turns (
        id                  uuid PRIMARY KEY,
        conversation_id     uuid NOT NULL REFERENCES conversations(id),
        idempotency_key     text NOT NULL UNIQUE,
        request_message_id  uuid NOT NULL,
        status              text NOT NULL,
        attempt             integer NOT NULL,
        run_id              uuid,
        cursor              bigint NOT NULL DEFAULT 0,
        superseded_run_ids  uuid[] NOT NULL DEFAULT '{}',
        created_at          timestamptz NOT NULL,
        updated_at          timestamptz NOT NULL
      )`);
      await q.query(`CREATE INDEX IF NOT EXISTS conversation_turns_conversation_idx
        ON conversation_turns (conversation_id, created_at)`);
    },
  },
  {
    version: 17,
    description: "worker-owned turn execution: attempt bookkeeping and channel identity binding",
    up: async (q) => {
      // Attempt is part of the key so retries cannot collide with dead attempts.
      await q.query(`CREATE TABLE IF NOT EXISTS turn_completions (
        turn_id    uuid NOT NULL REFERENCES conversation_turns(id),
        attempt    integer NOT NULL CHECK (attempt >= 0),
        status     text NOT NULL,
        message_id uuid,
        cursor     bigint NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL,
        PRIMARY KEY (turn_id, attempt)
      )`);
      // NULL attempt on existing messages marks output that predates Worker attempts.
      await q.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS attempt integer");
      await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_run_idx
        ON conversation_turns (run_id) WHERE run_id IS NOT NULL`);

      // Channel bindings reuse external identity mappings; `verified_via` keeps evidence strength.
      await q.query(
        "ALTER TABLE external_identity_mappings ADD COLUMN IF NOT EXISTS verified_via text"
      );
      // Bind offers persist a consumable nonce; signatures alone cannot be spent or revoked.
      await q.query(`CREATE TABLE IF NOT EXISTS channel_bind_tokens (
        nonce_hash         text PRIMARY KEY,
        integration_slug   text NOT NULL,
        external_sender_id text NOT NULL,
        issued_at          timestamptz NOT NULL,
        expires_at         timestamptz NOT NULL,
        consumed_at        timestamptz,
        consumed_by        uuid REFERENCES users(id)
      )`);
      await q.query(
        "CREATE INDEX IF NOT EXISTS channel_bind_tokens_expiry_idx ON channel_bind_tokens (expires_at)"
      );

      for (const sql of RUN_EVENT_NOTIFY_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 18,
    description: "retire the in-process chat stream buffer",
    up: async (q) => {
      // `stream_resume` is removed; Worker-backed `run_events` are durable and instance-agnostic.
      await q.query("DROP TABLE IF EXISTS stream_resume");
    },
  },
  {
    version: 19,
    description: "allow a deployment-owned service client",
    up: async (q) => {
      // NULL owner means deployment-owned API client; authority still derives from the client.
      await q.query("ALTER TABLE api_clients ALTER COLUMN owner_user_id DROP NOT NULL");
    },
  },
  {
    version: 20,
    description: "durable Soul publication and immutable execution bundles",
    up: applyStatements(SOUL_PUBLICATION_STORAGE_STATEMENTS, SOUL_BUNDLE_STORAGE_STATEMENTS),
  },
  {
    version: 21,
    description: "separate Run source from pinned Routine identity",
    up: async (q) => {
      await q.query("ALTER TABLE runs ADD COLUMN IF NOT EXISTS source text");
      // Copy overloaded `bundle.routineId` once so in-flight Runs keep their executor.
      await q.query("UPDATE runs SET source = bundle->>'routineId' WHERE source IS NULL");
      await q.query("ALTER TABLE runs ALTER COLUMN source SET NOT NULL");
      await q.query(
        "ALTER TABLE runs ADD CONSTRAINT runs_source_nonempty CHECK (length(source) > 0)"
      );
    },
  },
  {
    version: 22,
    description: "encrypted raw webhook payload vault",
    up: applyStatements(WEBHOOK_VAULT_STATEMENTS),
  },
  {
    version: 23,
    description: "Channel inbound dedup, run-delivery correlation, and mention-thread tracking",
    up: applyStatements(
      CHANNEL_INBOUND_STORAGE_STATEMENTS,
      CHANNEL_RUN_DELIVERY_STORAGE_STATEMENTS,
      CHANNEL_MENTIONED_THREAD_STORAGE_STATEMENTS
    ),
  },
  {
    version: 24,
    description: "channel_run_deliveries: track the posted approval prompt",
    up: applyStatements(CHANNEL_RUN_DELIVERY_APPROVAL_COLUMNS_STATEMENTS),
  },
  {
    version: 25,
    description: "forced password reset on admin-created accounts",
    up: async (q) => {
      await q.query(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS must_reset_password boolean NOT NULL DEFAULT false"
      );
    },
  },
  {
    version: 26,
    description: "retire the legacy Routine engine's run tables",
    up: async (q) => {
      // Drops deleted in-API Routine engine tables; Worker Runs replaced them.
      await q.query("DROP TABLE IF EXISTS routine_run_events");
      await q.query("DROP TABLE IF EXISTS routine_runs");
    },
  },
  {
    version: 27,
    description: "invite links replace admin-minted temporary passwords",
    up: async (q) => {
      await q.query(`CREATE TABLE IF NOT EXISTS user_invites (
        token_hash  text PRIMARY KEY,
        user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_by  uuid NOT NULL REFERENCES users(id),
        created_at  timestamptz NOT NULL,
        expires_at  timestamptz NOT NULL,
        consumed_at timestamptz
      )`);
      await q.query(
        "CREATE INDEX IF NOT EXISTS user_invites_user_idx ON user_invites (user_id, consumed_at)"
      );
      // Invited accounts have no password until redemption.
      // Forced reset only served temporary passwords, which invites no longer mint.
      await q.query("ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL");
      await q.query("ALTER TABLE users DROP COLUMN IF EXISTS must_reset_password");
    },
  },
  {
    version: 28,
    description: "soul_repositories: one business's Soul repo mapping (Phase 10)",
    up: applyStatements(SOUL_REPOSITORY_STORAGE_STATEMENTS),
  },
  {
    version: 29,
    description: "knowledge_source_records / knowledge_source_chunks: ACL-first Knowledge storage",
    up: applyStatements(KNOWLEDGE_SOURCES_STATEMENTS),
  },
  {
    version: 30,
    description: "slack_knowledge_checkpoints: durable per-channel Slack Knowledge sync cursor",
    up: applyStatements(SLACK_KNOWLEDGE_CHECKPOINT_STATEMENTS),
  },
  {
    version: 31,
    description: "routine_schedule_state: cron/interval/datetime Routine trigger fire-state",
    up: applyStatements(ROUTINE_SCHEDULE_STATE_STATEMENTS),
  },
  {
    // Leave version 32 unused; renumbering would make upgraded deployments skip migrations.
    // 33-36 built the memory assertion engine — assertions, evidence, pending confirmations,
    // episodes, chunks and their recall indexes. That engine was replaced by the Memory Document
    // and deleted, so these slots create nothing: a database made today never gets the tables, and
    // migration 66 drops them from any database that already did. The versions stay because
    // renumbering would make an upgraded deployment skip whatever took their place.
    version: 33,
    description: "retired: memory assertion engine tables (see migration 66)",
    up: applyStatements([]),
  },
  {
    version: 34,
    description: "retired: memory assertion recall index",
    up: applyStatements([]),
  },
  {
    version: 35,
    description: "retired: memory episode tables",
    up: applyStatements([]),
  },
  {
    version: 36,
    description: "retired: memory erasure helper indexes",
    up: applyStatements([]),
  },
  {
    version: 37,
    description: "confluence_knowledge_checkpoints: durable Confluence Knowledge sync cursor",
    up: applyStatements(CONFLUENCE_KNOWLEDGE_CHECKPOINT_STATEMENTS),
  },
  {
    version: 38,
    description: "knowledge_sync_checkpoints: durable K3 Knowledge sync cursors",
    up: applyStatements(KNOWLEDGE_SYNC_CHECKPOINT_STATEMENTS),
  },
  {
    // Renumbered from 31; main had already shipped 31-38.
    version: 39,
    description: "integration_auth_requests: one-use state + PKCE verifier for the auth broker",
    up: applyStatements(INTEGRATION_AUTH_REQUEST_STATEMENTS),
  },
  {
    // Renumbered from 32 for the same skip-avoidance reason as 39.
    version: 40,
    description: "secrets: move GitHub App credentials onto integration.github.* keys",
    up: renameGitHubAppSecretKeys,
  },
  {
    version: 41,
    description: "conversation deletion cascades through owned Chat data",
    up: async (q) => {
      const foreignKeys = [
        ["messages", "messages_conversation_id_fkey", "conversation_id", "conversations", "id"],
        ["message_feedback", "message_feedback_message_id_fkey", "message_id", "messages", "id"],
        [
          "message_feedback",
          "message_feedback_conversation_id_fkey",
          "conversation_id",
          "conversations",
          "id",
        ],
        [
          "pending_interactions",
          "pending_interactions_conversation_id_fkey",
          "conversation_id",
          "conversations",
          "id",
        ],
        [
          "conversation_turns",
          "conversation_turns_conversation_id_fkey",
          "conversation_id",
          "conversations",
          "id",
        ],
        [
          "turn_completions",
          "turn_completions_turn_id_fkey",
          "turn_id",
          "conversation_turns",
          "id",
        ],
        [
          "surface_actions",
          "surface_actions_conversation_id_fkey",
          "conversation_id",
          "conversations",
          "id",
        ],
      ] as const;
      for (const [table, constraint, column, target, targetColumn] of foreignKeys) {
        const present = await q.query(
          `SELECT table_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
          [table, column]
        );
        if (present.rows.length === 0) continue;
        await q.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${constraint}`);
        await q.query(
          `ALTER TABLE ${table} ADD CONSTRAINT ${constraint} FOREIGN KEY (${column}) ` +
            `REFERENCES ${target}(${targetColumn}) ON DELETE CASCADE`
        );
      }
    },
  },
  {
    version: 42,
    description: "users carry a display name",
    up: async (q) => {
      // NULL display name means unset; do not guess from email.
      await q.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS name text");
    },
  },
  {
    version: 43,
    description: "log_event: durable error/fatal log spine for the observability UI",
    up: applyStatements(LOG_EVENT_STATEMENTS),
  },
  {
    version: 44,
    description: "resource_sample: per-process CPU and memory samples",
    up: applyStatements(RESOURCE_SAMPLE_STATEMENTS),
  },
  {
    version: 45,
    description: "embeddings: partial HNSW indexes so vector recall stops scanning",
    // Concurrent index avoids corpus write locks; sweep invalid interrupted builds first.
    concurrent: true,
    up: async (q) => {
      await dropInvalidEmbeddingIndexes(q);
      for (const { table, column, dimColumn } of EMBEDDING_COLUMNS) {
        for (const sql of embeddingIndexStatements(table, column, dimColumn)) {
          await q.query(sql);
        }
      }
    },
  },
  {
    version: 46,
    description: "audit: append-only hash-linked event ledger",
    up: async (q) => {
      await q.query(`
        CREATE TABLE IF NOT EXISTS audit_events (
          id uuid PRIMARY KEY,
          business_id text NOT NULL,
          chain_index bigint NOT NULL,
          previous_hash text,
          hash text NOT NULL,
          actor_principal_id text NOT NULL,
          effective_principal_id text NOT NULL,
          agent_id text,
          run_id text,
          state_id text,
          action text NOT NULL,
          target text NOT NULL,
          decision text NOT NULL,
          reason_codes text[] NOT NULL,
          guardrail_digest text,
          bundle_digest text,
          source_classification text,
          destination_classification text,
          request_hash text,
          result_hash text,
          correlation_id text NOT NULL,
          causation_id text,
          occurred_at timestamptz NOT NULL,
          safe_metadata jsonb,
          safe_refs jsonb,
          recorded_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      // Unique tail guard makes concurrent audit appends lose instead of forking the chain.
      await q.query(
        "CREATE UNIQUE INDEX IF NOT EXISTS audit_events_chain_idx ON audit_events (business_id, chain_index)"
      );
      await q.query(
        "CREATE INDEX IF NOT EXISTS audit_events_correlation_idx ON audit_events (correlation_id)"
      );
      await q.query(
        "CREATE INDEX IF NOT EXISTS audit_events_occurred_idx ON audit_events (business_id, occurred_at DESC)"
      );

      // Trigger-enforced immutability binds even superusers unless deliberately disabled.
      await q.query(`
        CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
          RAISE EXCEPTION 'audit_events is append-only; % is not permitted', TG_OP
            USING ERRCODE = 'insufficient_privilege';
        END
        $fn$
      `);
      await q.query("DROP TRIGGER IF EXISTS audit_events_no_mutate ON audit_events");
      await q.query(`
        CREATE TRIGGER audit_events_no_mutate
        BEFORE UPDATE OR DELETE ON audit_events
        FOR EACH ROW EXECUTE FUNCTION audit_events_append_only()
      `);
      // TRUNCATE bypasses row triggers entirely, so it needs its own statement-level trigger.
      await q.query("DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events");
      await q.query(`
        CREATE TRIGGER audit_events_no_truncate
        BEFORE TRUNCATE ON audit_events
        FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only()
      `);
    },
  },
  {
    version: 47,
    description: "ops: enable pg_stat_statements where the server allows it",
    up: async (q) => {
      // Best-effort pg_stat_statements uses a savepoint so failure does not abort migration.
      await q.query("SAVEPOINT try_pg_stat_statements");
      try {
        await q.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
        await q.query("RELEASE SAVEPOINT try_pg_stat_statements");
      } catch {
        // Absent, not preloaded, or insufficient privilege. All three are survivable.
        await q.query("ROLLBACK TO SAVEPOINT try_pg_stat_statements");
      }
    },
  },
  {
    version: 48,
    description:
      "Soul publication safety: provenance, leases, activation history, and retention FKs",
    up: async (q) => {
      const addConstraint = async (table: string, constraint: string, sql: string) => {
        const present = await q.query(
          `SELECT constraint_name FROM information_schema.table_constraints
           WHERE table_schema = 'public' AND table_name = $1 AND constraint_name = $2`,
          [table, constraint]
        );
        if (present.rows.length === 0) await q.query(sql);
      };
      const hasColumns = async (table: string, columns: readonly string[]) => {
        const present = await q.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2)`,
          [table, columns]
        );
        return present.rows.length === columns.length;
      };

      await q.query("CREATE SEQUENCE IF NOT EXISTS soul_publication_sequence");
      await q.query(`CREATE TABLE IF NOT EXISTS soul_publications (
        changeset_id text PRIMARY KEY CHECK (length(changeset_id) > 0),
        business_id  text NOT NULL CHECK (length(business_id) > 0),
        commit_sha   text NOT NULL CHECK (length(commit_sha) > 0),
        digest       text NOT NULL CHECK (length(digest) > 0),
        stage        text NOT NULL CHECK (stage IN ('committed', 'projected', 'stored', 'active')),
        attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        failure_code text,
        UNIQUE (business_id, digest)
      )`);
      await q.query(`CREATE TABLE IF NOT EXISTS soul_publication_outbox (
        id           text PRIMARY KEY CHECK (length(id) > 0),
        business_id  text NOT NULL CHECK (length(business_id) > 0),
        changeset_id text NOT NULL REFERENCES soul_publications(changeset_id),
        topic        text NOT NULL CHECK (length(topic) > 0),
        consumed_by  text,
        created_at   timestamptz NOT NULL DEFAULT now()
      )`);
      await q.query(`CREATE TABLE IF NOT EXISTS soul_definition_projections (
        business_id      text NOT NULL CHECK (length(business_id) > 0),
        digest           text NOT NULL CHECK (length(digest) > 0),
        kind             text NOT NULL CHECK (length(kind) > 0),
        definition_id    text NOT NULL CHECK (length(definition_id) > 0),
        slug             text NOT NULL CHECK (length(slug) > 0),
        authored_version integer NOT NULL CHECK (authored_version > 0),
        hash             text NOT NULL CHECK (length(hash) > 0),
        PRIMARY KEY (business_id, kind, definition_id),
        UNIQUE (business_id, kind, slug)
      )`);
      await q.query(`CREATE TABLE IF NOT EXISTS soul_active_bundles (
        business_id text PRIMARY KEY CHECK (length(business_id) > 0),
        digest      text NOT NULL CHECK (length(digest) > 0)
      )`);
      await q.query(`CREATE TABLE IF NOT EXISTS soul_execution_bundles (
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
      )`);
      await q.query(`CREATE INDEX IF NOT EXISTS soul_publication_outbox_pending_idx
        ON soul_publication_outbox (created_at, id) WHERE consumed_by IS NULL`);
      await q.query(`CREATE INDEX IF NOT EXISTS soul_execution_bundles_business_idx
        ON soul_execution_bundles (business_id, created_at DESC)`);
      if (await hasColumns("runs", ["business_id", "bundle"])) {
        await q.query(`CREATE INDEX IF NOT EXISTS runs_bundle_digest_idx
          ON runs (business_id, (bundle->>'digest'))`);
      }
      if (await hasColumns("audit_events", ["business_id", "bundle_digest"])) {
        await q.query(`CREATE INDEX IF NOT EXISTS audit_events_bundle_digest_idx
          ON audit_events (business_id, bundle_digest) WHERE bundle_digest IS NOT NULL`);
      }

      await q.query(
        "ALTER TABLE soul_publications ADD COLUMN IF NOT EXISTS publication_sequence bigint"
      );
      await q.query(
        "ALTER TABLE soul_publications ALTER COLUMN publication_sequence SET DEFAULT nextval('soul_publication_sequence')"
      );
      await q.query(
        "UPDATE soul_publications SET publication_sequence = nextval('soul_publication_sequence') WHERE publication_sequence IS NULL"
      );
      await q.query("ALTER TABLE soul_publications ALTER COLUMN publication_sequence SET NOT NULL");
      await addConstraint(
        "soul_publications",
        "soul_publications_publication_sequence_check",
        "ALTER TABLE soul_publications ADD CONSTRAINT soul_publications_publication_sequence_check CHECK (publication_sequence > 0)"
      );
      await addConstraint(
        "soul_publications",
        "soul_publications_business_publication_sequence_key",
        "ALTER TABLE soul_publications ADD CONSTRAINT soul_publications_business_publication_sequence_key UNIQUE (business_id, publication_sequence)"
      );

      await q.query(
        "ALTER TABLE soul_publications ADD COLUMN IF NOT EXISTS actor_principal_id text"
      );
      // Fallback only migrates old local development rows; new writes require a real actor.
      await q.query(
        "UPDATE soul_publications SET actor_principal_id = 'legacy:unknown' WHERE actor_principal_id IS NULL"
      );
      await q.query("ALTER TABLE soul_publications ALTER COLUMN actor_principal_id SET NOT NULL");
      await addConstraint(
        "soul_publications",
        "soul_publications_actor_principal_id_check",
        "ALTER TABLE soul_publications ADD CONSTRAINT soul_publications_actor_principal_id_check CHECK (length(actor_principal_id) > 0)"
      );

      await q.query(
        "ALTER TABLE soul_publications ADD COLUMN IF NOT EXISTS created_at timestamptz"
      );
      await q.query("UPDATE soul_publications SET created_at = now() WHERE created_at IS NULL");
      await q.query("ALTER TABLE soul_publications ALTER COLUMN created_at SET DEFAULT now()");
      await q.query("ALTER TABLE soul_publications ALTER COLUMN created_at SET NOT NULL");

      await q.query(
        "ALTER TABLE soul_publications ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz"
      );
      await q.query(
        "UPDATE soul_publications SET next_attempt_at = now() WHERE next_attempt_at IS NULL"
      );
      await q.query("ALTER TABLE soul_publications ALTER COLUMN next_attempt_at SET DEFAULT now()");
      await q.query("ALTER TABLE soul_publications ALTER COLUMN next_attempt_at SET NOT NULL");
      await q.query(
        "ALTER TABLE soul_publications ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz"
      );
      await q.query(
        "ALTER TABLE soul_publications ADD COLUMN IF NOT EXISTS dead_letter_reason text"
      );
      await addConstraint(
        "soul_publications",
        "soul_publications_dead_letter_reason_check",
        "ALTER TABLE soul_publications ADD CONSTRAINT soul_publications_dead_letter_reason_check CHECK (dead_lettered_at IS NULL OR dead_letter_reason IS NOT NULL)"
      );
      await q.query(`CREATE INDEX IF NOT EXISTS soul_publications_retry_idx
        ON soul_publications (next_attempt_at, changeset_id) WHERE dead_lettered_at IS NULL`);

      await q.query(
        "ALTER TABLE soul_publication_outbox ADD COLUMN IF NOT EXISTS consumed_at timestamptz"
      );
      await q.query("ALTER TABLE soul_publication_outbox ADD COLUMN IF NOT EXISTS claimed_by text");
      await q.query(
        "ALTER TABLE soul_publication_outbox ADD COLUMN IF NOT EXISTS claimed_at timestamptz"
      );
      await q.query(
        "ALTER TABLE soul_publication_outbox ADD COLUMN IF NOT EXISTS claim_lease_expires_at timestamptz"
      );
      await addConstraint(
        "soul_publication_outbox",
        "soul_publication_outbox_claim_check",
        `ALTER TABLE soul_publication_outbox ADD CONSTRAINT soul_publication_outbox_claim_check CHECK (
          (claimed_by IS NULL AND claimed_at IS NULL AND claim_lease_expires_at IS NULL)
          OR (claimed_by IS NOT NULL AND claimed_at IS NOT NULL AND claim_lease_expires_at IS NOT NULL)
        )`
      );
      await addConstraint(
        "soul_publication_outbox",
        "soul_publication_outbox_consumed_check",
        `ALTER TABLE soul_publication_outbox ADD CONSTRAINT soul_publication_outbox_consumed_check CHECK (
          (consumed_by IS NULL AND consumed_at IS NULL)
          OR (consumed_by IS NOT NULL AND consumed_at IS NOT NULL)
        )`
      );
      await q.query(`CREATE INDEX IF NOT EXISTS soul_publication_outbox_claim_idx
        ON soul_publication_outbox (claim_lease_expires_at, created_at, id) WHERE consumed_by IS NULL`);

      await q.query(
        "ALTER TABLE soul_active_bundles ADD COLUMN IF NOT EXISTS activation_sequence bigint"
      );
      await q.query(
        "ALTER TABLE soul_active_bundles ADD COLUMN IF NOT EXISTS activated_at timestamptz"
      );
      await q.query(
        "ALTER TABLE soul_active_bundles ADD COLUMN IF NOT EXISTS activated_by_principal_id text"
      );
      await q.query(`UPDATE soul_active_bundles a
        SET activation_sequence = p.publication_sequence,
            activated_at = COALESCE(a.activated_at, now()),
            activated_by_principal_id = p.actor_principal_id
        FROM soul_publications p
        WHERE a.business_id = p.business_id
          AND a.digest = p.digest
          AND (a.activation_sequence IS NULL OR a.activated_by_principal_id IS NULL)`);
      await q.query(
        "ALTER TABLE soul_active_bundles ALTER COLUMN activation_sequence SET NOT NULL"
      );
      await q.query("ALTER TABLE soul_active_bundles ALTER COLUMN activated_at SET DEFAULT now()");
      await q.query("ALTER TABLE soul_active_bundles ALTER COLUMN activated_at SET NOT NULL");
      await q.query(
        "ALTER TABLE soul_active_bundles ALTER COLUMN activated_by_principal_id SET NOT NULL"
      );
      await addConstraint(
        "soul_active_bundles",
        "soul_active_bundles_activation_sequence_check",
        "ALTER TABLE soul_active_bundles ADD CONSTRAINT soul_active_bundles_activation_sequence_check CHECK (activation_sequence > 0)"
      );
      await addConstraint(
        "soul_active_bundles",
        "soul_active_bundles_activated_by_principal_id_check",
        "ALTER TABLE soul_active_bundles ADD CONSTRAINT soul_active_bundles_activated_by_principal_id_check CHECK (length(activated_by_principal_id) > 0)"
      );

      await q.query(`CREATE TABLE IF NOT EXISTS soul_bundle_activations (
        business_id                  text NOT NULL CHECK (length(business_id) > 0),
        activation_sequence          bigint NOT NULL CHECK (activation_sequence > 0),
        digest                       text NOT NULL CHECK (length(digest) > 0),
        changeset_id                 text NOT NULL REFERENCES soul_publications(changeset_id),
        activated_at                 timestamptz NOT NULL DEFAULT now(),
        activated_by_principal_id    text NOT NULL CHECK (length(activated_by_principal_id) > 0),
        PRIMARY KEY (business_id, activation_sequence),
        UNIQUE (business_id, digest)
      )`);
      await q.query(`INSERT INTO soul_bundle_activations (
        business_id, activation_sequence, digest, changeset_id, activated_at,
        activated_by_principal_id
      )
      SELECT a.business_id, a.activation_sequence, a.digest, p.changeset_id, a.activated_at,
             a.activated_by_principal_id
        FROM soul_active_bundles a
        JOIN soul_publications p ON p.business_id = a.business_id AND p.digest = a.digest
      ON CONFLICT (business_id, activation_sequence) DO NOTHING`);
      await q.query(`CREATE INDEX IF NOT EXISTS soul_bundle_activations_time_idx
        ON soul_bundle_activations (business_id, activated_at DESC, activation_sequence DESC)`);

      await addConstraint(
        "soul_execution_bundles",
        "soul_execution_bundles_business_digest_key",
        "ALTER TABLE soul_execution_bundles ADD CONSTRAINT soul_execution_bundles_business_digest_key UNIQUE (business_id, digest)"
      );
      await addConstraint(
        "soul_active_bundles",
        "soul_active_bundles_bundle_fkey",
        `ALTER TABLE soul_active_bundles ADD CONSTRAINT soul_active_bundles_bundle_fkey
          FOREIGN KEY (business_id, digest) REFERENCES soul_execution_bundles(business_id, digest)`
      );
      await addConstraint(
        "soul_bundle_activations",
        "soul_bundle_activations_bundle_fkey",
        `ALTER TABLE soul_bundle_activations ADD CONSTRAINT soul_bundle_activations_bundle_fkey
          FOREIGN KEY (business_id, digest) REFERENCES soul_execution_bundles(business_id, digest)`
      );
    },
  },
  {
    version: 49,
    description: "Soul activation events use their own monotonic sequence",
    up: async (q) => {
      await q.query("CREATE SEQUENCE IF NOT EXISTS soul_activation_sequence");
      await q.query(
        "ALTER TABLE soul_bundle_activations DROP CONSTRAINT IF EXISTS soul_bundle_activations_business_id_digest_key"
      );
      await q.query(`SELECT setval(
        'soul_activation_sequence',
        GREATEST(
          COALESCE((SELECT MAX(activation_sequence) FROM soul_bundle_activations), 0),
          COALESCE((SELECT MAX(activation_sequence) FROM soul_active_bundles), 0),
          1
        ),
        GREATEST(
          COALESCE((SELECT MAX(activation_sequence) FROM soul_bundle_activations), 0),
          COALESCE((SELECT MAX(activation_sequence) FROM soul_active_bundles), 0)
        ) > 0
      )`);
    },
  },
  {
    version: 50,
    description: "durable authorization roles, groups, and assignments",
    up: seedAuthorizationBootstrap,
  },
  {
    version: 51,
    description: "per-principal provider credentials for user-scoped Tool calls",
    up: applyStatements(PRINCIPAL_PROVIDER_TOKEN_STATEMENTS),
  },
  {
    version: 52,
    description: "durable mutation kill switches for the effect plane",
    up: applyStatements(KILL_SWITCH_STORAGE_STATEMENTS),
  },
  {
    version: 53,
    description: "tasks: system-created human work items behind Companion/Tasks/home checklist",
    up: applyStatements(TASK_STORAGE_STATEMENTS),
  },
  {
    version: 54,
    description:
      "agent_loop_checkpoints: durable Tool-call and repair counters across approval parks",
    up: applyStatements(LOOP_CHECKPOINT_STORAGE_STATEMENTS),
  },
  {
    version: 55,
    description:
      "state_retry_attempts: durable Routine State retry budget across park/resume and reclaim",
    up: applyStatements(STATE_RETRY_STORAGE_STATEMENTS),
  },
  {
    version: 56,
    description:
      "state_concurrency_leases: durable mutual exclusion for a Routine State's concurrencyKey",
    up: async (q) => {
      for (const sql of STATE_CONCURRENCY_STORAGE_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 57,
    description:
      "state_concurrency_waits: durable backoff budget for a Routine State contending for a key",
    up: async (q) => {
      for (const sql of STATE_CONTENTION_STORAGE_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 58,
    description:
      "agent_loop_checkpoints.resume_state: durable Agent-loop transcript across an approval park",
    up: async (q) => {
      for (const sql of LOOP_CHECKPOINT_STORAGE_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 59,
    description:
      "approvals.consumed_at/consumed_by_call_id: Tool approval decisions are one-use (I-13)",
    up: async (q) => {
      await q.query("ALTER TABLE approvals ADD COLUMN IF NOT EXISTS consumed_at timestamptz");
      await q.query("ALTER TABLE approvals ADD COLUMN IF NOT EXISTS consumed_by_call_id text");
    },
  },
  {
    version: 60,
    description: "approvals: immutable Guardrail evidence, requester, approver (I-13)",
    up: async (q) => {
      for (const sql of APPROVAL_EVIDENCE_STORAGE_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 61,
    description: "runs.bounds: drop the required Run bounds no reader ever consulted (L3-10)",
    up: async (q) => {
      for (const sql of RUN_BOUNDS_REMOVAL_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 62,
    description: "memory document: one Markdown page per user, plus durable Curator work",
    up: applyStatements(MEMORY_DOCUMENT_STORAGE_STATEMENTS, CURATOR_WORK_STORAGE_STATEMENTS),
  },
  {
    version: 63,
    description: "curator jobs, effect ledger, candidates, task metadata sidecar, admission ledger",
    up: applyStatements(CURATOR_STORAGE_STATEMENTS, CURATOR_ADMISSION_STATEMENTS),
  },
  {
    version: 64,
    // The index is declared in CURATOR_STORAGE_STATEMENTS so one file owns the table's shape, but a
    // database that already ran 63 never revisits it. `IF NOT EXISTS` makes replaying it here a
    // no-op on a fresh install and the only way an upgraded one gets it.
    description: "curator effect index for the shadow review window read",
    up: applyStatements([
      `CREATE INDEX IF NOT EXISTS curator_effect_review_idx
         ON curator_effect (business_id, created_at DESC)`,
    ]),
  },
  {
    version: 65,
    // Migration 62 stored the document as a six-key `jsonb` projection; the page a model is given
    // is now the stored bytes themselves. A database created after this ships gets the text column
    // from 62 directly, so this is a no-op there — hence the column probe rather than an
    // unconditional ALTER. `renderProjectionRow` is local because the shape it reads no longer
    // exists anywhere else; importing a renderer for it would keep a retired shape alive in the
    // package just to serve one already-executed migration.
    description: "memory document: store the rendered Markdown page, not a section projection",
    up: async (q) => {
      for (const table of ["user_memory", "user_memory_revisions"]) {
        const probe = await q.query<{ present: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_name = $1 AND column_name = 'sections'
           ) AS present`,
          [table]
        );
        if (!probe.rows[0]?.present) continue;

        await q.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS document text`);
        const rows = await q.query<{ ctid: string; sections: unknown }>(
          `SELECT ctid::text AS ctid, sections FROM ${table}`
        );
        for (const row of rows.rows) {
          const raw = typeof row.sections === "string" ? JSON.parse(row.sections) : row.sections;
          await q.query(`UPDATE ${table} SET document = $1 WHERE ctid = $2::tid`, [
            renderProjectionRow(raw),
            row.ctid,
          ]);
        }
        await q.query(`UPDATE ${table} SET document = '' WHERE document IS NULL`);
        await q.query(`ALTER TABLE ${table} ALTER COLUMN document SET NOT NULL`);
        await q.query(`ALTER TABLE ${table} DROP COLUMN sections`);
      }
      await q.query(
        `ALTER TABLE user_memory
           DROP CONSTRAINT IF EXISTS user_memory_sections_complete,
           DROP CONSTRAINT IF EXISTS user_memory_sections_closed`
      );
    },
  },
  {
    version: 66,
    // The assertion engine is gone: no reads, no writes, no Tools, no routes. Dropping its tables
    // in the same change is the point — a schema that still describes a retired store is what
    // invites someone to write to it again. There is nothing to preserve: the document was never
    // derived from these rows.
    description: "drop the retired memory assertion engine tables",
    up: applyStatements([
      "DROP TABLE IF EXISTS memory_chunks CASCADE",
      "DROP TABLE IF EXISTS memory_episodes CASCADE",
      "DROP TABLE IF EXISTS memory_pending CASCADE",
      "DROP TABLE IF EXISTS memory_evidence CASCADE",
      "DROP TABLE IF EXISTS memory_assertions CASCADE",
    ]),
  },
  {
    version: 67,
    description: "allow the task-answer memory writer; drop legacy working_memory",
    up: applyStatements([
      `ALTER TABLE user_memory_revisions DROP CONSTRAINT IF EXISTS user_memory_revisions_writer_check`,
      `ALTER TABLE user_memory_revisions
         ADD CONSTRAINT user_memory_revisions_writer_check
         CHECK (writer IN ('tool', 'curator', 'task', 'erasure'))`,
      // `working_memory` was the assertion engine's key/value scratch tier. It has had no reader
      // or writer since the Memory Document replaced it, so leaving it would only invite one.
      "DROP TABLE IF EXISTS working_memory CASCADE",
      // v66 shipped an incomplete list and already recorded itself, so it can never re-run there.
      "DROP TABLE IF EXISTS memory_chunks CASCADE",
      "DROP TABLE IF EXISTS memory_evidence CASCADE",
    ]),
  },
  {
    version: 68,
    description: "deployment-local public web and API origins",
    up: applyStatements([
      ...PUBLIC_ORIGIN_STORAGE_STATEMENTS,
      "ALTER TABLE integration_auth_requests ADD COLUMN IF NOT EXISTS callback_url text",
      "ALTER TABLE integration_auth_requests ADD COLUMN IF NOT EXISTS web_url text",
      "ALTER TABLE integration_auth_requests ADD COLUMN IF NOT EXISTS api_url text",
    ]),
  },
  {
    version: 69,
    // Authored Pages had no ACL, no principals and no tenant column, so the one question
    // `decideSourceAccess` answers for a synced document — may this principal read this? — could
    // not even be asked of a Page. These columns and this table are what make an authored Page an
    // ACL'd subject, so a single gate can serve both halves of Knowledge.
    description:
      "unify Knowledge authorization: ACL entries, business and ACL revision on spaces and pages",
    up: applyStatements([
      // No rows are seeded: absence of a grant is a denial, so a Space is readable by nobody until
      // somebody is granted it. `capability` is a column rather than an assumption so that a later
      // write/comment split is a policy change instead of a migration.
      `CREATE TABLE IF NOT EXISTS knowledge_acl_entries (
        business_id    text NOT NULL,
        subject_kind   text NOT NULL CHECK (subject_kind IN ('space', 'page', 'source')),
        subject_id     text NOT NULL,
        principal_kind text NOT NULL,
        principal_id   text NOT NULL,
        effect         text NOT NULL CHECK (effect IN ('grant', 'deny')),
        capability     text NOT NULL DEFAULT 'read' CHECK (capability IN ('read')),
        origin         text NOT NULL DEFAULT 'authored' CHECK (origin IN ('authored', 'synced')),
        provider       text,
        acl_revision   text NOT NULL DEFAULT '1',
        captured_at    timestamptz NOT NULL DEFAULT now(),
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (business_id, subject_kind, subject_id, principal_kind, principal_id, capability)
      )`,
      `CREATE INDEX IF NOT EXISTS knowledge_acl_entries_subject_idx
         ON knowledge_acl_entries (business_id, subject_kind, subject_id)`,
      // Answers "who can currently read this", which is the exposure audit an operator needs
      // before writing something sensitive into a Space.
      `CREATE INDEX IF NOT EXISTS knowledge_acl_entries_principal_idx
         ON knowledge_acl_entries (business_id, principal_kind, principal_id)`,
      // `subject_id` spans spaces, pages and sources, whose ids are not one type, so this cannot be
      // a foreign key. Deletion must still be real rather than cosmetic, hence the trigger.
      `CREATE OR REPLACE FUNCTION knowledge_acl_entries_prune()
         RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         DELETE FROM knowledge_acl_entries
          WHERE business_id = OLD.business_id
            AND subject_kind = TG_ARGV[0]
            AND subject_id = OLD.id::text;
         RETURN OLD;
       END $$`,
      // The wiki tables are guarded because databases restored from a partial schema reach this
      // migration without them; skipping is correct there, since a Space that does not exist
      // cannot be under-protected.
      `DO $mig69$
       BEGIN
         IF to_regclass('public.knowledge_spaces') IS NULL THEN RETURN; END IF;
         ALTER TABLE knowledge_spaces
           ADD COLUMN IF NOT EXISTS business_id  text NOT NULL DEFAULT '${DEPLOYMENT_BUSINESS_ID.replaceAll("'", "''")}',
           ADD COLUMN IF NOT EXISTS acl_revision text NOT NULL DEFAULT '1';
         DROP TRIGGER IF EXISTS knowledge_spaces_prune_acl ON knowledge_spaces;
         CREATE TRIGGER knowledge_spaces_prune_acl AFTER DELETE ON knowledge_spaces
           FOR EACH ROW EXECUTE FUNCTION knowledge_acl_entries_prune('space');
       END $mig69$`,
      `DO $mig69$
       BEGIN
         IF to_regclass('public.knowledge_pages') IS NULL THEN RETURN; END IF;
         ALTER TABLE knowledge_pages
           ADD COLUMN IF NOT EXISTS business_id  text NOT NULL DEFAULT '${DEPLOYMENT_BUSINESS_ID.replaceAll("'", "''")}',
           ADD COLUMN IF NOT EXISTS acl_revision text NOT NULL DEFAULT '1';
         DROP TRIGGER IF EXISTS knowledge_pages_prune_acl ON knowledge_pages;
         CREATE TRIGGER knowledge_pages_prune_acl AFTER DELETE ON knowledge_pages
           FOR EACH ROW EXECUTE FUNCTION knowledge_acl_entries_prune('page');
       END $mig69$`,
    ]),
  },
  {
    version: 70,
    // GraphRAG: an LLM-built entity graph over the corpus, plus community summaries that answer
    // questions no single chunk contains. Every row records the chunk ids it was derived from,
    // because a derived artefact with no provenance cannot be authorized at query time and must
    // therefore be withheld from everybody.
    description: "GraphRAG entity graph, communities and community summaries",
    up: applyStatements([
      // The baseline installs pg_trgm, but a database that predates the baseline reaches this
      // migration without it, and the entity-name index below cannot be created without it.
      "CREATE EXTENSION IF NOT EXISTS pg_trgm",
      // `source_chunk_ids` is the ACL spine of the whole subsystem, not a debugging aid. It is
      // NOT NULL with no default: a row that cannot say where it came from must not be insertable.
      `CREATE TABLE IF NOT EXISTS knowledge_graph_entities (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id      text NOT NULL,
        entity_key       text NOT NULL,
        name             text NOT NULL,
        type             text NOT NULL,
        description      text NOT NULL DEFAULT '',
        source_chunk_ids text[] NOT NULL,
        build_id         text NOT NULL,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        UNIQUE (business_id, entity_key)
      )`,
      // Trigram, not btree on `lower(name)`: the only lookup is a leading-wildcard `ILIKE`, which
      // a btree cannot serve at all — it would read every entity in the business and refilter.
      `CREATE INDEX IF NOT EXISTS knowledge_graph_entities_name_trgm
         ON knowledge_graph_entities USING gin (name gin_trgm_ops)`,
      `CREATE INDEX IF NOT EXISTS knowledge_graph_entities_business_idx
         ON knowledge_graph_entities (business_id)`,
      // GIN over the provenance array so revoking or deleting a chunk can find everything derived
      // from it without a sequential scan of the graph.
      `CREATE INDEX IF NOT EXISTS knowledge_graph_entities_chunks_idx
         ON knowledge_graph_entities USING gin (source_chunk_ids)`,
      `CREATE TABLE IF NOT EXISTS knowledge_graph_edges (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id      text NOT NULL,
        edge_key         text NOT NULL,
        source_entity_id uuid NOT NULL REFERENCES knowledge_graph_entities(id) ON DELETE CASCADE,
        target_entity_id uuid NOT NULL REFERENCES knowledge_graph_entities(id) ON DELETE CASCADE,
        description      text NOT NULL DEFAULT '',
        weight           double precision NOT NULL DEFAULT 1,
        source_chunk_ids text[] NOT NULL,
        build_id         text NOT NULL,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        UNIQUE (business_id, edge_key)
      )`,
      `CREATE INDEX IF NOT EXISTS knowledge_graph_edges_source_idx
         ON knowledge_graph_edges (source_entity_id)`,
      `CREATE INDEX IF NOT EXISTS knowledge_graph_edges_target_idx
         ON knowledge_graph_edges (target_entity_id)`,
      `CREATE INDEX IF NOT EXISTS knowledge_graph_edges_chunks_idx
         ON knowledge_graph_edges USING gin (source_chunk_ids)`,
      `CREATE TABLE IF NOT EXISTS knowledge_graph_communities (
        community_id        text NOT NULL,
        business_id         text NOT NULL,
        level               integer NOT NULL,
        entity_ids          text[] NOT NULL,
        parent_community_id text,
        build_id            text NOT NULL,
        created_at          timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (business_id, community_id)
      )`,
      `CREATE INDEX IF NOT EXISTS knowledge_graph_communities_level_idx
         ON knowledge_graph_communities (business_id, level)`,
      // `stale` rather than a delete: an invalidated summary must stop being served immediately,
      // but the row is what tells the next build which community to re-summarise.
      `CREATE TABLE IF NOT EXISTS knowledge_graph_community_summaries (
        community_id         text NOT NULL,
        business_id          text NOT NULL,
        build_id             text NOT NULL,
        title                text NOT NULL,
        summary              text NOT NULL,
        provenance_chunk_ids text[] NOT NULL,
        input_tokens         integer NOT NULL DEFAULT 0,
        output_tokens        integer NOT NULL DEFAULT 0,
        stale                boolean NOT NULL DEFAULT false,
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_at           timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (business_id, community_id)
      )`,
      `CREATE INDEX IF NOT EXISTS knowledge_graph_summaries_chunks_idx
         ON knowledge_graph_community_summaries USING gin (provenance_chunk_ids)`,
      `CREATE INDEX IF NOT EXISTS knowledge_graph_summaries_fresh_idx
         ON knowledge_graph_community_summaries (business_id, stale)`,
      // Extraction checkpoint. Keyed by chunk revision so a rebuild only pays for what changed,
      // which is what makes the run resumable after a crash rather than restart-from-zero.
      `CREATE TABLE IF NOT EXISTS knowledge_graph_extractions (
        business_id   text NOT NULL,
        chunk_id      text NOT NULL,
        subject_kind  text NOT NULL CHECK (subject_kind IN ('space', 'page', 'source')),
        subject_id    text NOT NULL,
        revision      text NOT NULL,
        input_tokens  integer NOT NULL DEFAULT 0,
        output_tokens integer NOT NULL DEFAULT 0,
        extracted_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (business_id, chunk_id)
      )`,
      // Deleting a document has to find everything derived from it, and provenance is the only
      // link back. Without this index that sweep is a scan of the whole corpus.
      `CREATE INDEX IF NOT EXISTS knowledge_graph_extractions_subject_idx
         ON knowledge_graph_extractions (business_id, subject_kind, subject_id)`,
    ]),
  },
  {
    version: 71,
    // Authored Pages start gated. Every Page that predates the gate acquires the same blanket read
    // grant a new Page now gets on write; without this they would carry no entries at all and the
    // default-deny gate would make the whole existing corpus unreadable the moment it is consulted.
    // `ON CONFLICT DO NOTHING` keeps an already restricted Page restricted rather than republishing
    // it — a restriction is an allowlist that replaced this grant on purpose.
    description: "backfill the blanket read grant onto Pages authored before the gate",
    up: applyStatements([
      // `knowledge_pages` is a baseline table, so a database migrating up from a recorded schema
      // version predating the baseline has no corpus to backfill. Guard the way migration 68 does,
      // or the whole migration chain aborts on any such database.
      `DO $mig71$
       BEGIN
         IF to_regclass('public.knowledge_pages') IS NULL THEN RETURN; END IF;
         IF to_regclass('public.knowledge_acl_entries') IS NULL THEN RETURN; END IF;
         INSERT INTO knowledge_acl_entries
           (business_id, subject_kind, subject_id, principal_kind, principal_id,
            effect, capability, origin, provider, acl_revision, captured_at)
         SELECT p.business_id, 'page', p.id::text, 'role', 'role-everyone',
                'grant', 'read', 'authored', 'tulipfarm', '1', now()
           FROM knowledge_pages p
          WHERE NOT EXISTS (
                  SELECT 1 FROM knowledge_acl_entries e
                   WHERE e.business_id = p.business_id
                     AND e.subject_kind = 'page'
                     AND e.subject_id = p.id::text)
         ON CONFLICT DO NOTHING;
       END $mig71$`,
    ]),
  },
  {
    version: 72,
    // Who wrote a Page is a fact a reader needs in order to weigh it, and it cannot be recovered
    // later — nothing in the existing schema records it. Both columns stay nullable: a Page that
    // predates this migration has an unknown author, and guessing "user" would label every
    // Agent-written Page as human work.
    description: "record whether a Page was authored by a person or an Agent",
    up: applyStatements([
      `DO $mig72$
       BEGIN
         IF to_regclass('public.knowledge_pages') IS NULL THEN RETURN; END IF;
         ALTER TABLE knowledge_pages ADD COLUMN IF NOT EXISTS author_kind text;
         ALTER TABLE knowledge_pages ADD COLUMN IF NOT EXISTS author_id text;
       END $mig72$`,
    ]),
  },
  {
    version: 73,
    // `source_chunk_ids` and `provenance_chunk_ids` are `text[]`, and Postgres cannot foreign-key
    // an array element, so the graph's provenance had no referential integrity behind it. Three
    // ordinary paths delete chunks without passing through `invalidateGraphForChunks` — deleting a
    // Page (chunks cascade), deleting a Space (Pages deleted in a CTE, then chunks cascade), and
    // re-indexing (chunks deleted and re-inserted with new ids). Each one left entities, edges and
    // summaries derived from text that no longer exists, and a stale summary keeps being served.
    // Enforcing it here means no caller can forget, which is the property a foreign key would have
    // given if one were expressible.
    description: "prune GraphRAG rows derived from deleted knowledge chunks",
    up: applyStatements([
      `DO $mig73$
       BEGIN
         IF to_regclass('public.knowledge_chunks') IS NULL
            OR to_regclass('public.knowledge_graph_entities') IS NULL THEN RETURN; END IF;

         CREATE OR REPLACE FUNCTION knowledge_graph_prune_deleted_chunks()
           RETURNS trigger LANGUAGE plpgsql AS $fn$
         DECLARE
           gone text[];
         BEGIN
           SELECT array_agg(id::text) INTO gone FROM deleted_chunks;
           IF gone IS NULL THEN RETURN NULL; END IF;

           -- Marked before anything is deleted: a summary stays readable until something marks it,
           -- so marking last would leave an interval where the prose is served but the material
           -- behind it is already gone.
           UPDATE knowledge_graph_community_summaries
              SET stale = true, updated_at = now()
            WHERE stale = false AND provenance_chunk_ids && gone;

           -- Edges carry their own provenance, so an edge can outlive both its entities' chunks.
           DELETE FROM knowledge_graph_edges WHERE source_chunk_ids && gone;
           -- Overlap, not containment, and it matches deleteEntitiesDerivedFrom: an entity
           -- described partly from withdrawn text is not re-derivable from what remains.
           DELETE FROM knowledge_graph_entities WHERE source_chunk_ids && gone;
           DELETE FROM knowledge_graph_extractions WHERE chunk_id = ANY(gone);

           RETURN NULL;
         END $fn$;

         DROP TRIGGER IF EXISTS knowledge_chunks_prune_graph ON knowledge_chunks;
         -- Statement-level with a transition table: re-indexing deletes a Page's chunks in one
         -- statement, and a per-row trigger would re-scan the graph once per chunk.
         CREATE TRIGGER knowledge_chunks_prune_graph
           AFTER DELETE ON knowledge_chunks
           REFERENCING OLD TABLE AS deleted_chunks
           FOR EACH STATEMENT
           EXECUTE FUNCTION knowledge_graph_prune_deleted_chunks();
       END $mig73$`,
    ]),
  },
];
