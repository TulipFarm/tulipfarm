import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { INVOCATION_STORAGE_STATEMENTS } from "@tulipfarm/run-kernel";
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
  dropInvalidEmbeddingIndexes,
  EMBEDDING_COLUMNS,
  EVENT_STORAGE_STATEMENTS,
  embeddingIndexStatements,
  INTEGRATION_STORAGE_STATEMENTS,
  KILL_SWITCH_STORAGE_STATEMENTS,
  RUN_BROWSE_STORAGE_STATEMENTS,
  RUN_EVENT_NOTIFY_STATEMENTS,
  RUN_EVENT_STORAGE_STATEMENTS,
  RUN_STORAGE_STATEMENTS,
  SOUL_PUBLICATION_STORAGE_STATEMENTS,
  SOUL_REPOSITORY_STORAGE_STATEMENTS,
  TASK_STORAGE_STATEMENTS,
  WAIT_STORAGE_STATEMENTS,
} from "@tulipfarm/storage";
import { EFFECT_STORAGE_STATEMENTS } from "@tulipfarm/tool-broker";
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
  `CREATE TABLE IF NOT EXISTS working_memory (
    user_id             uuid NOT NULL,
    key                 text NOT NULL,
    value               text NOT NULL,
    written_by_agent_id text,
    created_at          timestamptz NOT NULL,
    last_written_at     timestamptz NOT NULL,
    PRIMARY KEY (user_id, key)
  )`,
  "CREATE INDEX IF NOT EXISTS working_memory_lru_idx ON working_memory (user_id, last_written_at)",
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
// Legacy `working_memory` stays one release as recovery for the Memory cutover.

const KNOWLEDGE_SYNC_CHECKPOINT_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS knowledge_sync_checkpoints (
    provider       text NOT NULL,
    integration_id text NOT NULL,
    cursor         text,
    updated_at     timestamptz NOT NULL,
    PRIMARY KEY (provider, integration_id)
  )`,
];

/**
 * Memory storage: scoped, versioned Assertions; edits supersede instead of overwriting.
 * `memory_pending` is separate so unconfirmed inferences are unreachable by Assertion queries.
 */
const MEMORY_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS memory_assertions (
    business_id          text NOT NULL,
    assertion_id         text NOT NULL,
    scope                text NOT NULL,
    subject_principal_id text,
    agent_id             text,
    role_id              text,
    run_id               text,
    subject              text NOT NULL,
    statement            text NOT NULL,
    memory_type          text NOT NULL,
    trust_tier           text NOT NULL,
    confidence           double precision NOT NULL,
    importance           double precision NOT NULL,
    origin               text NOT NULL,
    author_principal_id  text NOT NULL,
    author_agent_id      text,
    provenance_run_id    text,
    confirmation         text NOT NULL,
    status               text NOT NULL,
    version              integer NOT NULL,
    created_at           timestamptz NOT NULL,
    updated_at           timestamptz NOT NULL,
    recorded_until       timestamptz,
    valid_from           timestamptz NOT NULL,
    valid_to             timestamptz,
    expires_at           timestamptz,
    supersedes_id        text,
    superseded_by_id     text,
    entities             text[] NOT NULL DEFAULT '{}',
    access_count         integer NOT NULL DEFAULT 0,
    last_accessed_at     timestamptz,
    PRIMARY KEY (business_id, assertion_id)
  )`,
  `CREATE INDEX IF NOT EXISTS memory_assertions_scope_idx
     ON memory_assertions (business_id, scope, subject_principal_id, agent_id, role_id, run_id)
     WHERE status = 'active'`,
  `CREATE INDEX IF NOT EXISTS memory_assertions_subject_idx
     ON memory_assertions (business_id, scope, subject_principal_id, subject)
     WHERE status = 'active'`,
  "CREATE INDEX IF NOT EXISTS memory_assertions_entities_gin ON memory_assertions USING gin (entities)",
  `CREATE TABLE IF NOT EXISTS memory_evidence (
    business_id  text NOT NULL,
    assertion_id text NOT NULL,
    position     integer NOT NULL,
    kind         text NOT NULL,
    ref          text NOT NULL,
    source_id    text,
    revision     text,
    PRIMARY KEY (business_id, assertion_id, position),
    FOREIGN KEY (business_id, assertion_id)
      REFERENCES memory_assertions (business_id, assertion_id) ON DELETE CASCADE
  )`,
  "CREATE INDEX IF NOT EXISTS memory_evidence_source_idx ON memory_evidence (business_id, source_id)",
  `CREATE TABLE IF NOT EXISTS memory_pending (
    business_id  text NOT NULL,
    pending_id   text NOT NULL,
    request      jsonb NOT NULL,
    requested_at timestamptz NOT NULL,
    expires_at   timestamptz NOT NULL,
    PRIMARY KEY (business_id, pending_id)
  )`,
  "CREATE INDEX IF NOT EXISTS memory_pending_expiry_idx ON memory_pending (business_id, expires_at)",
];

/** Backfills `working_memory` to confirmed preferences; old table stays for recovery. */
/** Recall columns index short Assertions in place; nullable embeddings keep lexical fallback. */
const MEMORY_RECALL_INDEX_STATEMENTS: string[] = [
  `ALTER TABLE memory_assertions
     ADD COLUMN IF NOT EXISTS tsv tsvector
     GENERATED ALWAYS AS (to_tsvector('english', subject || ' ' || statement)) STORED`,
  "ALTER TABLE memory_assertions ADD COLUMN IF NOT EXISTS embedding vector",
  "ALTER TABLE memory_assertions ADD COLUMN IF NOT EXISTS embedding_model text",
  "ALTER TABLE memory_assertions ADD COLUMN IF NOT EXISTS embedding_dim integer",
  `CREATE INDEX IF NOT EXISTS memory_assertions_tsv_idx
     ON memory_assertions USING gin (tsv)`,
];

/** Episodes use chunks, but project back to authorized MemoryAssertions for recall. */
const MEMORY_EPISODE_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS memory_episodes (
    business_id          text NOT NULL,
    episode_id           text NOT NULL,
    assertion_id         text NOT NULL,
    scope                text NOT NULL,
    subject_principal_id text,
    agent_id             text,
    role_id              text,
    run_id               text,
    source_type          text NOT NULL,
    source_id            text NOT NULL,
    summary              text NOT NULL,
    decisions            text[] NOT NULL DEFAULT '{}',
    outcome              text NOT NULL DEFAULT '',
    author_principal_id  text NOT NULL,
    author_agent_id      text,
    provenance_run_id    text,
    evidence             jsonb NOT NULL DEFAULT '[]',
    started_at           timestamptz,
    ended_at             timestamptz,
    created_at           timestamptz NOT NULL,
    updated_at           timestamptz NOT NULL,
    PRIMARY KEY (business_id, episode_id),
    UNIQUE (business_id, source_type, source_id),
    FOREIGN KEY (business_id, assertion_id)
      REFERENCES memory_assertions (business_id, assertion_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS memory_episodes_scope_idx
     ON memory_episodes (business_id, scope, subject_principal_id, agent_id, role_id, run_id)`,
  `CREATE INDEX IF NOT EXISTS memory_episodes_assertion_idx
     ON memory_episodes (business_id, assertion_id)`,
  `CREATE TABLE IF NOT EXISTS memory_chunks (
    business_id          text NOT NULL,
    chunk_id             text NOT NULL,
    episode_id           text NOT NULL,
    assertion_id         text NOT NULL,
    scope                text NOT NULL,
    subject_principal_id text,
    agent_id             text,
    role_id              text,
    run_id               text,
    chunk_type           text NOT NULL,
    position             integer NOT NULL,
    text                 text NOT NULL,
    tsv                  tsvector
      GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
    embedding            vector,
    embedding_model      text,
    embedding_dim        integer,
    created_at           timestamptz NOT NULL,
    PRIMARY KEY (business_id, chunk_id),
    FOREIGN KEY (business_id, episode_id)
      REFERENCES memory_episodes (business_id, episode_id) ON DELETE CASCADE,
    FOREIGN KEY (business_id, assertion_id)
      REFERENCES memory_assertions (business_id, assertion_id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS memory_chunks_episode_position_idx
     ON memory_chunks (business_id, episode_id, position)`,
  `CREATE INDEX IF NOT EXISTS memory_chunks_assertion_idx
     ON memory_chunks (business_id, assertion_id)`,
  `CREATE INDEX IF NOT EXISTS memory_chunks_scope_idx
     ON memory_chunks (business_id, scope, subject_principal_id, agent_id, role_id, run_id)`,
  "CREATE INDEX IF NOT EXISTS memory_chunks_tsv_idx ON memory_chunks USING gin (tsv)",
];

/** Erasure helpers add the missing pending-candidate lookup; cascades remove owned rows. */
const MEMORY_ERASURE_STATEMENTS: string[] = [
  `CREATE INDEX IF NOT EXISTS memory_pending_supersedes_idx
     ON memory_pending (business_id, ((request ->> 'supersedesId')))`,
];

async function backfillWorkingMemory(q: Queryable, businessId: string): Promise<void> {
  // Databases reconstructed from arbitrary versions may legitimately lack this table.
  const { rows } = await q.query("SELECT to_regclass('public.working_memory') AS table_name");
  if ((rows[0] as { table_name: string | null } | undefined)?.table_name == null) return;

  await q.query(
    `INSERT INTO memory_assertions (
       business_id, assertion_id, scope, subject_principal_id, subject, statement,
       memory_type, trust_tier, confidence, importance, origin,
       author_principal_id, author_agent_id, confirmation, status, version,
       created_at, updated_at, valid_from, entities, access_count
     )
     SELECT
       $1, gen_random_uuid()::text, 'user_private', wm.user_id::text, wm.key, wm.value,
       'preference', 'user_stated', 1, 1, 'explicit',
       wm.user_id::text, wm.written_by_agent_id, 'confirmed', 'active', 1,
       wm.created_at, wm.last_written_at, wm.created_at, '{}', 0
     FROM working_memory wm
     WHERE NOT EXISTS (
       SELECT 1 FROM memory_assertions a
       WHERE a.business_id = $1
         AND a.scope = 'user_private'
         AND a.subject_principal_id = wm.user_id::text
         AND a.subject = wm.key
     )
     ON CONFLICT DO NOTHING`,
    [businessId]
  );
}

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

  await seedBootstrapRole(q, "owner", [
    { action: "*", resourceType: "authz.role", effect: "allow" },
    { action: "*", resourceType: "authz.role", domain: "*", effect: "allow" },
    { action: "*", resourceType: "authz.assignment", effect: "allow" },
    { action: "*", resourceType: "authz.assignment", domain: "*", effect: "allow" },
    { action: "*", resourceType: "authz.relation", effect: "allow" },
    { action: "*", resourceType: "authz.relation", domain: "*", effect: "allow" },
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

export const PG_MIGRATIONS: PgMigration[] = [
  {
    version: 1,
    description: "greenfield baseline",
    up: async (q) => {
      for (const sql of BASELINE_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 2,
    description: "hardened authentication and identity",
    up: async (q) => {
      for (const sql of IDENTITY_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 3,
    description: "transactional event inbox and outbox",
    up: async (q) => {
      for (const sql of EVENT_STORAGE_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 4,
    description: "durable Runs, States, attempts, and lineage",
    up: async (q) => {
      for (const sql of RUN_STORAGE_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 5,
    description: "immutable typed outputs and Artifacts",
    up: async (q) => {
      for (const sql of ARTIFACT_STORAGE_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 6,
    description: "durable waits, timers, and resume tokens",
    up: async (q) => {
      for (const sql of WAIT_STORAGE_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 7,
    description: "budgets, limits, and target concurrency",
    up: async (q) => {
      for (const sql of [...BUDGET_STORAGE_STATEMENTS, ...CONCURRENCY_STORAGE_STATEMENTS]) {
        await q.query(sql);
      }
    },
  },
  {
    version: 8,
    description: "child Run links",
    up: async (q) => {
      for (const sql of CHILD_STORAGE_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 9,
    description: "persisted Run event stream",
    up: async (q) => {
      for (const sql of RUN_EVENT_STORAGE_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 10,
    description: "durable Tool intents and effect ledger",
    up: async (q) => {
      for (const sql of EFFECT_STORAGE_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 11,
    description: "Integration Apps, installations, AccessGrants, and channel routing",
    up: async (q) => {
      for (const sql of [
        ...INTEGRATION_STORAGE_STATEMENTS,
        ...CHANNEL_DELIVERY_STORAGE_STATEMENTS,
      ]) {
        await q.query(sql);
      }
    },
  },
  {
    version: 12,
    description: "unified durable invocation cutover",
    up: async (q) => {
      for (const sql of INVOCATION_STORAGE_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 13,
    description: "operational Run browser page order",
    up: async (q) => {
      for (const sql of RUN_BROWSE_STORAGE_STATEMENTS) {
        await q.query(sql);
      }
    },
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
    up: async (q) => {
      for (const sql of [
        ...SOUL_PUBLICATION_STORAGE_STATEMENTS,
        ...SOUL_BUNDLE_STORAGE_STATEMENTS,
      ]) {
        await q.query(sql);
      }
    },
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
    up: async (q) => {
      for (const sql of WEBHOOK_VAULT_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 23,
    description: "Channel inbound dedup, run-delivery correlation, and mention-thread tracking",
    up: async (q) => {
      for (const sql of [
        ...CHANNEL_INBOUND_STORAGE_STATEMENTS,
        ...CHANNEL_RUN_DELIVERY_STORAGE_STATEMENTS,
        ...CHANNEL_MENTIONED_THREAD_STORAGE_STATEMENTS,
      ]) {
        await q.query(sql);
      }
    },
  },
  {
    version: 24,
    description: "channel_run_deliveries: track the posted approval prompt",
    up: async (q) => {
      for (const sql of CHANNEL_RUN_DELIVERY_APPROVAL_COLUMNS_STATEMENTS) {
        await q.query(sql);
      }
    },
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
    up: async (q) => {
      for (const sql of SOUL_REPOSITORY_STORAGE_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 29,
    description: "knowledge_source_records / knowledge_source_chunks: ACL-first Knowledge storage",
    up: async (q) => {
      for (const sql of KNOWLEDGE_SOURCES_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 30,
    description: "slack_knowledge_checkpoints: durable per-channel Slack Knowledge sync cursor",
    up: async (q) => {
      for (const sql of SLACK_KNOWLEDGE_CHECKPOINT_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 31,
    description: "routine_schedule_state: cron/interval/datetime Routine trigger fire-state",
    up: async (q) => {
      for (const sql of ROUTINE_SCHEDULE_STATE_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    // Leave version 32 unused; renumbering would make upgraded deployments skip migrations.
    version: 33,
    description:
      "memory_assertions / memory_evidence / memory_pending: scoped, versioned, bi-temporal Memory",
    up: async (q) => {
      for (const sql of MEMORY_STATEMENTS) {
        await q.query(sql);
      }
      await backfillWorkingMemory(q, DEPLOYMENT_BUSINESS_ID);
    },
  },
  {
    version: 34,
    description: "memory_assertions: lexical + vector recall index columns",
    up: async (q) => {
      for (const sql of MEMORY_RECALL_INDEX_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 35,
    description: "memory_episodes / memory_chunks: episodic Memory recall index",
    up: async (q) => {
      for (const sql of MEMORY_EPISODE_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 36,
    description: "memory erasure helper indexes",
    up: async (q) => {
      for (const sql of MEMORY_ERASURE_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 37,
    description: "confluence_knowledge_checkpoints: durable Confluence Knowledge sync cursor",
    up: async (q) => {
      for (const sql of CONFLUENCE_KNOWLEDGE_CHECKPOINT_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 38,
    description: "knowledge_sync_checkpoints: durable K3 Knowledge sync cursors",
    up: async (q) => {
      for (const sql of KNOWLEDGE_SYNC_CHECKPOINT_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    // Renumbered from 31; main had already shipped 31-38.
    version: 39,
    description: "integration_auth_requests: one-use state + PKCE verifier for the auth broker",
    up: async (q) => {
      for (const sql of INTEGRATION_AUTH_REQUEST_STATEMENTS) {
        await q.query(sql);
      }
    },
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
    up: async (q) => {
      for (const sql of LOG_EVENT_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 44,
    description: "resource_sample: per-process CPU and memory samples",
    up: async (q) => {
      for (const sql of RESOURCE_SAMPLE_STATEMENTS) {
        await q.query(sql);
      }
    },
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
    up: async (q) => {
      for (const sql of PRINCIPAL_PROVIDER_TOKEN_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 52,
    description: "durable mutation kill switches for the effect plane",
    up: async (q) => {
      for (const sql of KILL_SWITCH_STORAGE_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 53,
    description: "tasks: system-created human work items behind Companion/Tasks/home checklist",
    up: async (q) => {
      for (const sql of TASK_STORAGE_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
];
