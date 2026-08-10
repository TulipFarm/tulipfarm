import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { INVOCATION_STORAGE_STATEMENTS } from "@tulipfarm/run-kernel";
import { SOUL_BUNDLE_STORAGE_STATEMENTS } from "@tulipfarm/soul";
import {
  ARTIFACT_STORAGE_STATEMENTS,
  BUDGET_STORAGE_STATEMENTS,
  CHANNEL_DELIVERY_STORAGE_STATEMENTS,
  CHANNEL_INBOUND_STORAGE_STATEMENTS,
  CHANNEL_MENTIONED_THREAD_STORAGE_STATEMENTS,
  CHANNEL_RUN_DELIVERY_APPROVAL_COLUMNS_STATEMENTS,
  CHANNEL_RUN_DELIVERY_STORAGE_STATEMENTS,
  CHILD_STORAGE_STATEMENTS,
  CONCURRENCY_STORAGE_STATEMENTS,
  EVENT_STORAGE_STATEMENTS,
  INTEGRATION_STORAGE_STATEMENTS,
  RUN_BROWSE_STORAGE_STATEMENTS,
  RUN_EVENT_NOTIFY_STATEMENTS,
  RUN_EVENT_STORAGE_STATEMENTS,
  RUN_STORAGE_STATEMENTS,
  SOUL_PUBLICATION_STORAGE_STATEMENTS,
  SOUL_REPOSITORY_STORAGE_STATEMENTS,
  WAIT_STORAGE_STATEMENTS,
} from "@tulipfarm/storage";
import { EFFECT_STORAGE_STATEMENTS } from "@tulipfarm/tool-broker";
import type { Queryable } from "../db";

export interface PgMigration {
  version: number;
  description: string;
  up: (q: Queryable) => Promise<void>;
}

/**
 * Diagnostic log spine. Separate from `obs_event` on purpose: that table's columns are AI-shaped
 * (model, tokens, cost) and its aggregates sum cost across every row, so log volume there would
 * degrade the dashboard it exists to serve. Only `error`/`fatal` records are captured, so the
 * trigram index on `message` stays cheap enough to make substring search interactive.
 */
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
  // (ts DESC, id DESC) matches the keyset pagination order exactly, so a cursor read is an
  // index-only range scan rather than a sort of the whole window.
  "CREATE INDEX IF NOT EXISTS log_event_ts_idx ON log_event (ts DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS log_event_level_ts_idx ON log_event (level, ts DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS log_event_service_ts_idx ON log_event (service, ts DESC, id DESC)",
  // Message search is deliberately left to a scan. A GIN/trigram index would tax every insert on
  // the error path — when the system is least healthy and writing most — to speed up an occasional
  // admin search over a retention-pruned table that the time and level indexes already narrow.
];

/**
 * Process resource samples: one fixed-cadence row per service instance per minute. Separate from
 * `obs_event` (AI-shaped, event-driven) and `log_event` (failure-driven) because this is a gauge —
 * rows arrive on a clock whether or not anything happened, and are aggregated by time bucket rather
 * than paginated. `instance` is retained so a replicated deployment can still be averaged honestly
 * instead of double-counting one service's samples as if they came from one process.
 */
const RESOURCE_SAMPLE_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS resource_sample (
    id         uuid PRIMARY KEY,
    ts         timestamptz NOT NULL,
    service    text NOT NULL,
    instance   text NOT NULL,
    cpu_pct    real NOT NULL,
    rss_bytes  bigint NOT NULL
  )`,
  // Every read is "one window, grouped by service", so the service-leading index serves the query
  // directly; the ts-only index covers the retention sweep.
  "CREATE INDEX IF NOT EXISTS resource_sample_ts_idx ON resource_sample (ts DESC)",
  "CREATE INDEX IF NOT EXISTS resource_sample_service_ts_idx ON resource_sample (service, ts DESC)",
];

/**
 * Greenfield schema baseline. Development databases from before this baseline must be reset;
 * TulipFarm does not preserve compatibility with the pre-rebuild development schema.
 *
 * Statements run separately for compatibility with both pg.Pool and PGlite. Every statement is
 * idempotent so a baseline interrupted before schema_version advances can safely run again.
 */
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

/**
 * Hardened authentication and identity: user lifecycle status, typed session
 * authentication evidence, API clients as first-class service identities, one-use OIDC
 * authorization requests, and verified external identity mappings with one-use link tokens.
 */
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

/**
 * Raw webhook delivery bytes, stored encrypted before the canonical event is derived. This
 * predates any Run — `ArtifactService` requires a `{runId, stateKey, attempt}` producer, which
 * does not exist yet at ingestion time — so it is its own table rather than an Artifact.
 */
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

/**
 * Postgres storage for `@tulipfarm/knowledge`'s source/chunk ports (ACL-first Knowledge, e.g.
 * Slack conversation indexing) — distinct from `knowledge_pages`/`knowledge_chunks` above, which
 * back the wiki. `knowledge_source_chunks` cascades off its source so a deleted/revoked source's
 * text cannot outlive the record that authorizes it.
 */
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

/**
 * Durable per-channel resume position for `syncSlackKnowledge`
 * (`SlackKnowledgeCheckpointStore`), keyed by `integrationId` alone — the port takes no
 * `businessId` argument, and `integrationId` (`slack:<appId>:<teamId>`) is already
 * business-unique per `slack-binding.ts`.
 */
const SLACK_KNOWLEDGE_CHECKPOINT_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS slack_knowledge_checkpoints (
    integration_id text NOT NULL,
    channel_id     text NOT NULL,
    cursor         text,
    updated_at     timestamptz NOT NULL,
    PRIMARY KEY (integration_id, channel_id)
  )`,
];

/**
 * Durable fire-state for `cron`/`interval`/`datetime` Routine `x-triggers` (the schedule
 * dispatcher's due-scan). One row per `(businessId, routineSlug, triggerIndex)`, created lazily on
 * first tick and dropped once the schedule dispatcher sees the trigger no longer exists.
 */
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
// The legacy `working_memory` table is deliberately NOT dropped here. Migration v33 carried every
// row across as a confirmed `user_private` preference Assertion and nothing has read or written the
// table since — `EngineMemoryRepo` serves the KV surface off `memory_assertions` — so it is dead
// weight. But it is also the only cheap recovery path if the backfill turns out to be wrong in
// production, which is why `memory/backfill.pg.test.ts` asserts "leaves the legacy table intact so
// the cutover stays recoverable". Dropping it in the same release as the cutover would destroy that
// path. It should retire one release later, once the cutover has been proven live.

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
 * Memory storage (MEM-V1). Replaces the flat `working_memory` key/value table with scoped,
 * versioned Assertions.
 *
 * Two properties the shape has to guarantee:
 * - **Nothing is overwritten.** An edit writes a new row and marks the prior one `superseded`, so
 *   what was believed and when stays reconstructable. `created_at`/`recorded_until` carry
 *   transaction time and `valid_from`/`valid_to` carry valid time — the bi-temporal pair.
 * - **Scope ownership is columnar, not inferred.** `subject_principal_id`, `agent_id`, `role_id`,
 *   and `run_id` are the owner identities `authorizeMemoryScope` matches against; a lookup can
 *   filter on them, but authorization still runs on every row a query returns.
 *
 * `memory_pending` deliberately holds the whole request as jsonb rather than sharing the assertion
 * table: an inferred statement that was never confirmed must not be reachable by any query that
 * reads Assertions, and keeping it in a different table makes that structural instead of a
 * `WHERE` clause someone can forget.
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
  // The scope-owner lookup every read starts from: "active memory owned by this scope".
  `CREATE INDEX IF NOT EXISTS memory_assertions_scope_idx
     ON memory_assertions (business_id, scope, subject_principal_id, agent_id, role_id, run_id)
     WHERE status = 'active'`,
  // Upsert-by-subject: the adapter resolves a key to the assertion it supersedes.
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

/**
 * Carry every `working_memory` row over as a confirmed `user_private` preference Assertion.
 *
 * The old table is left in place rather than dropped: it is the only copy of this data, and a
 * failed cutover has to be recoverable. A later migration retires it once the adapter has run in
 * production. `ON CONFLICT DO NOTHING` plus the `NOT EXISTS` guard make a re-run a no-op, so an
 * interrupted baseline can safely replay.
 */
/**
 * Recall index columns on `memory_assertions` (M2).
 *
 * Assertions are indexed in place rather than in a chunk table: an assertion is one short
 * statement (the KV surface caps values at 256 chars), so chunking would add a join and a
 * consistency problem to split text that never needs splitting. Episodes are long-form and do get
 * their own chunk table when they land.
 *
 * `tsv` is a generated column so the lexical arm cannot drift from the statement it indexes —
 * there is no write path that could forget to refresh it. The embedding is nullable and carries
 * its own model/dim, matching `knowledge_chunks`: a deployment with no embedding provider runs the
 * lexical and entity arms alone rather than failing.
 */
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

/**
 * Episodic Memory storage (M5).
 *
 * Episodes are longer than Assertions and may need several recall handles, so their searchable
 * text lives in `memory_chunks`. Each chunk points at an episodic Assertion projection; that lets
 * the existing M2 recall pipeline keep returning authorized `MemoryAssertion`s while the new table
 * supplies the retrieval arms. Scope owner columns are duplicated onto both tables so operational
 * queries can stay narrow, but authorization still runs through `authorizeMemoryScope` after every
 * recall candidate.
 */
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

/**
 * M6 erasure helpers.
 *
 * Hard erasure deletes rows, so the schema already has the important part: `ON DELETE CASCADE`
 * from evidence, Episodes, and chunks. This migration adds the only missing lookup shape for
 * pending candidates that explicitly reference an Assertion through `supersedesId`; the erase
 * write path also does an exact-content scan so copied summaries cannot survive.
 */
const MEMORY_ERASURE_STATEMENTS: string[] = [
  `CREATE INDEX IF NOT EXISTS memory_pending_supersedes_idx
     ON memory_pending (business_id, ((request ->> 'supersedesId')))`,
];

async function backfillWorkingMemory(q: Queryable, businessId: string): Promise<void> {
  // A database that never created the legacy table has nothing to carry across — and must still
  // migrate. Skipping is not merely defensive: migrations run against databases reconstructed from
  // an arbitrary recorded version, where earlier tables may legitimately be absent.
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

/**
 * One-use authorization requests for the Integration auth broker
 * (`integrations/auth-broker.ts`). Mirrors `oidc_auth_requests`: the PKCE verifier is held here
 * rather than in the `state` the provider echoes back, so a captured callback URL cannot be
 * replayed and a code obtained in one browser cannot be redeemed in another.
 */
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

/*
 * GitHub App credentials moved from bespoke flat keys to the same `integration.<slug>.<ENV>` space
 * every other integration's credentials live in, so the declarative auth flow writes exactly what
 * the token-minting code reads. Renaming the key is safe: the key is not authenticated data in the
 * AES-GCM envelope, so the ciphertext still decrypts unchanged.
 *
 * `WHERE NOT EXISTS` keeps this idempotent and non-destructive — if a deployment has already
 * connected GitHub through the new flow, the newer value wins and the stale row is dropped rather
 * than overwriting it.
 */
const GITHUB_APP_SECRET_KEY_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ["github-app-id", "integration.github.GITHUB_APP_ID"],
  ["github-app-slug", "integration.github.GITHUB_APP_SLUG"],
  ["github-app-private-key", "integration.github.GITHUB_APP_PRIVATE_KEY"],
  ["github-app-webhook-secret", "integration.github.GITHUB_WEBHOOK_SECRET"],
];

async function renameGitHubAppSecretKeys(q: Queryable): Promise<void> {
  // A database restored without a `secrets` table has no App credentials to carry over; the
  // pg-migrate suite exercises exactly that shape.
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
      // Pre-existing messages keep a NULL `turn_id`: they predate Turns, and a backfill would have
      // to invent which Turn each belonged to. No `business_id` column — these tables are
      // deployment-scoped, and `DEPLOYMENT_BUSINESS_ID` already says so.
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
      // What a Worker attempt produced. Keyed by `(turn_id, attempt)` rather than by Turn, because
      // a Worker killed mid-turn is retried under a *new* attempt: without the attempt in the key,
      // the retry's completion would collide with the dead attempt's and the turn would either
      // duplicate its assistant Message or refuse to finish at all.
      await q.query(`CREATE TABLE IF NOT EXISTS turn_completions (
        turn_id    uuid NOT NULL REFERENCES conversation_turns(id),
        attempt    integer NOT NULL CHECK (attempt >= 0),
        status     text NOT NULL,
        message_id uuid,
        cursor     bigint NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL,
        PRIMARY KEY (turn_id, attempt)
      )`);
      // Which attempt wrote a Message, so a reader can tell a superseded attempt's output from the
      // one that completed the Turn. NULL on every pre-existing row: they predate Worker attempts.
      await q.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS attempt integer");
      // The Worker asks for a Turn by the Run it claimed, never the other way round, so this is the
      // lookup every executed turn makes before it does anything else.
      await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_run_idx
        ON conversation_turns (run_id) WHERE run_id IS NOT NULL`);

      // A channel sender bound to a TulipFarm account is an external identity mapping like any
      // other — `external_identity_mappings (provider, external_subject)` already keys on exactly
      // that, and `assertExternalIdentityMapped` already fails closed over it. A second table would
      // be a second authority for the same question, so channels reuse this one with the
      // integration slug as the provider. What is new is `verified_via`: an auto-link from a
      // provider-verified email and a human confirming a bind link are not equally strong evidence
      // and an audit must be able to tell them apart. NULL on pre-existing rows, which predate the
      // distinction.
      await q.query(
        "ALTER TABLE external_identity_mappings ADD COLUMN IF NOT EXISTS verified_via text"
      );
      // Outstanding bind offers. The row exists so a nonce can be *consumed*: the link is signed,
      // but a signature alone cannot be revoked or spent, so replaying a redeemed link would
      // otherwise re-bind the sender. No `user_id` — at issue time no account is known yet, which
      // is the whole reason the link is being sent.
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
      // `stream_resume` buffered the SSE frames one API process produced, so that the client that
      // lost the connection could ask that process for them again. A chat turn is now executed by
      // the Worker and read back from `run_events` — durable, gapless, and readable from any
      // instance — which leaves this table buffering a stream nothing writes.
      await q.query("DROP TABLE IF EXISTS stream_resume");
    },
  },
  {
    version: 19,
    description: "allow a deployment-owned service client",
    up: async (q) => {
      // Every API client so far was minted by a person, so `owner_user_id` recorded who is
      // accountable for it. The client this API mints for its own Worker has no such person: it is
      // created on first boot, before the setup wizard has made a single user, and a deployment
      // that never opens the wizard still has to execute the Runs it accepts.
      //
      // NULL therefore means "owned by the deployment", and it is not an authorization change:
      // `apiClientPrincipal` has always derived authority from the client itself, never from its
      // owner, so nothing reads this column to decide anything. What it costs is that the client
      // list can show an owner nobody can page — which is the truth about a process, and better
      // than attributing it to whichever human happened to run setup first.
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
      // Before this migration the dispatcher overloaded `bundle.routineId` as the Run source. Copy
      // it once so queued and in-flight Runs keep the same executor after every reader cuts over to
      // the dedicated column; new writers must supply the source explicitly.
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
      // `routine_runs` and `routine_run_events` were the in-API Routine engine's own store. A
      // Routine is now compiled to a Run and executed by the Worker against `runs`/`run_events`,
      // and the engine that wrote these has been deleted — so nothing reads or writes them.
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
      // An invited account has no password until its link is redeemed, and the column should say
      // so rather than holding a placeholder that only fails to verify by accident.
      await q.query("ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL");
      // The forced-reset gate existed only to make an admin-minted temporary password single-use.
      // Nothing mints one now — the invited user chooses their own password on redemption.
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
    // 32 is deliberately left unused: this branch reserved a gap while main's numbering was still
    // moving, and closing it now would be worse than leaving it. `pg-migrate` filters
    // `version > currentVersion`, so renumbering 33+ downward would silently skip these on any
    // deployment already past 33. A gap is harmless; a reused number is not.
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
    // Renumbered from 31 on merge with main: main had already shipped 31-38, and
    // `pg-migrate` filters `version > currentVersion`, so keeping 31 would make every
    // deployment already past 38 skip this migration silently.
    version: 39,
    description: "integration_auth_requests: one-use state + PKCE verifier for the auth broker",
    up: async (q) => {
      for (const sql of INTEGRATION_AUTH_REQUEST_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    // Renumbered from 32 on merge with main — same reason as 39 above.
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
      // Until now a person was only ever their email address, so every surface that had to name
      // someone printed a login credential at them. NULL means "has not set one" rather than
      // backfilling the local part of the address, because a derived name is a guess and a guess
      // that looks authored is worse than an honest absence — readers fall back to the email.
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
];
