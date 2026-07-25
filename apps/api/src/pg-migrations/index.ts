import {
  ARTIFACT_STORAGE_STATEMENTS,
  EVENT_STORAGE_STATEMENTS,
  RUN_STORAGE_STATEMENTS,
  WAIT_STORAGE_STATEMENTS,
} from "@tulipfarm/storage";
import type { Queryable } from "../db";

export interface PgMigration {
  version: number;
  description: string;
  up: (q: Queryable) => Promise<void>;
}

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
  `CREATE TABLE IF NOT EXISTS a2ui_surfaces (
    conversation_id uuid NOT NULL REFERENCES conversations(id),
    surface_id      text NOT NULL,
    spec            jsonb NOT NULL,
    data_model      jsonb NOT NULL,
    updated_at      timestamptz NOT NULL,
    PRIMARY KEY (conversation_id, surface_id)
  )`,
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
 * Hardened authentication and identity (AW-025): user lifecycle status, typed session
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
];
