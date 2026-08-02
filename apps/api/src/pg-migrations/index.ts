import { INVOCATION_STORAGE_STATEMENTS } from "@tulipfarm/run-kernel";
import { SOUL_BUNDLE_STORAGE_STATEMENTS } from "@tulipfarm/soul";
import {
  ARTIFACT_STORAGE_STATEMENTS,
  BUDGET_STORAGE_STATEMENTS,
  CHANNEL_DELIVERY_STORAGE_STATEMENTS,
  CHILD_STORAGE_STATEMENTS,
  CONCURRENCY_STORAGE_STATEMENTS,
  EVENT_STORAGE_STATEMENTS,
  INTEGRATION_STORAGE_STATEMENTS,
  RUN_BROWSE_STORAGE_STATEMENTS,
  RUN_EVENT_NOTIFY_STATEMENTS,
  RUN_EVENT_STORAGE_STATEMENTS,
  RUN_STORAGE_STATEMENTS,
  SOUL_PUBLICATION_STORAGE_STATEMENTS,
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
];
