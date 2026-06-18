import type { Queryable } from "../db";

export interface PgMigration {
  version: number;
  description: string;
  up: (q: Queryable) => Promise<void>;
}

/**
 * Greenfield baseline (spec §6): extensions, the `resources` schema (per-type tables
 * are created later by the P2 reconciler), `schema_version`, and every fixed-shape
 * `public` table. Knowledge/vector tables land in a later migration (P3).
 *
 * Each statement is issued separately so the same SQL runs on `pg.Pool` (simple
 * protocol) and PGlite (single-statement `query`). All statements are idempotent.
 */
const INIT_STATEMENTS: string[] = [
  "CREATE EXTENSION IF NOT EXISTS vector",
  "CREATE EXTENSION IF NOT EXISTS citext",
  "CREATE SCHEMA IF NOT EXISTS resources",
  `CREATE TABLE IF NOT EXISTS users (
    id            uuid PRIMARY KEY,
    email         citext NOT NULL UNIQUE,
    password_hash text NOT NULL,
    role          text NOT NULL,
    created_at    timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS api_tokens (
    id         uuid PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users(id),
    name       text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    prefix     text NOT NULL,
    created_at timestamptz NOT NULL
  )`,
  // Mirrors SecretDoc — AES-256-GCM envelope split across encrypted_value/iv/auth_tag.
  `CREATE TABLE IF NOT EXISTS secrets (
    key             text PRIMARY KEY,
    type            text NOT NULL,
    encrypted_value text NOT NULL,
    iv              text NOT NULL,
    auth_tag        text NOT NULL,
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    sid        text PRIMARY KEY,
    user_id    uuid NOT NULL,
    expires_at timestamptz NOT NULL
  )`,
  // D2 owner invariant, now DB-enforced.
  `CREATE TABLE IF NOT EXISTS conversations (
    id         uuid PRIMARY KEY,
    user_id    uuid,
    agent_id   text,
    model      text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT conversations_owner_check CHECK (user_id IS NOT NULL OR agent_id IS NOT NULL)
  )`,
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
  // Fixed-window rate-limit counter (D7).
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key          text NOT NULL,
    window_start timestamptz NOT NULL,
    count        integer NOT NULL,
    PRIMARY KEY (key, window_start)
  )`,
  // Display-id sequences (one row per resource type).
  `CREATE TABLE IF NOT EXISTS counters (
    type text PRIMARY KEY,
    seq  bigint NOT NULL
  )`,
];

/**
 * Knowledge/vector subsystem (P3, spec KN-V1-002). `vector` is unconstrained + NULLABLE:
 * exact-scan cosine search (no HNSW — not on PGlite), dimension-agnostic across model swaps,
 * NULL embedding when no provider is available (lexical `tsv` still works). `tsv` is computed
 * at insert time (not a GENERATED column, for PGlite portability).
 */
const KNOWLEDGE_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS knowledge_documents (
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
    created_at             timestamptz NOT NULL,
    updated_at             timestamptz NOT NULL,
    UNIQUE (source, source_id)
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id          uuid PRIMARY KEY,
    document_id uuid NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    chunk_index integer NOT NULL,
    content     text NOT NULL,
    embedding   vector,
    tsv         tsvector NOT NULL,
    model       text,
    dim         integer,
    created_at  timestamptz NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS knowledge_chunks_tsv_gin ON knowledge_chunks USING gin (tsv)",
  "CREATE INDEX IF NOT EXISTS knowledge_chunks_document_idx ON knowledge_chunks (document_id)",
  "CREATE INDEX IF NOT EXISTS knowledge_chunks_dim_idx ON knowledge_chunks (dim)",
  `CREATE TABLE IF NOT EXISTS knowledge_collections (
    id          uuid PRIMARY KEY,
    name        text NOT NULL UNIQUE,
    description text,
    domain      text,
    version     integer NOT NULL DEFAULT 1,
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge_documents_collections (
    document_id   uuid NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    collection_id uuid NOT NULL REFERENCES knowledge_collections(id) ON DELETE CASCADE,
    PRIMARY KEY (document_id, collection_id)
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge_revisions (
    id              uuid PRIMARY KEY,
    document_id     uuid NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    revision_number integer NOT NULL,
    content         text NOT NULL,
    plain_text      text NOT NULL,
    reason          text,
    created_at      timestamptz NOT NULL,
    UNIQUE (document_id, revision_number)
  )`,
];

/**
 * Durable SSE resume buffer (DB-V1 SSE resume). One row per streamed event, keyed by
 * `(stream_id, seq)` so a reconnecting client can replay everything after its `Last-Event-ID`.
 * Transient: a pg-boss job GCs rows past their TTL (durable messages persist separately in
 * `messages`). `created_at` is indexed for the cutoff delete.
 */
const STREAM_RESUME_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS stream_resume (
    stream_id  uuid    NOT NULL,
    seq        integer NOT NULL,
    event_type text    NOT NULL,
    data       jsonb   NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (stream_id, seq)
  )`,
  "CREATE INDEX IF NOT EXISTS stream_resume_gc_idx ON stream_resume (created_at)",
];

/**
 * Approval requests (AGT-V1-002). Shared by tool-call approvals (kind='tool_call') and future
 * routine human_approval states (kind='routine_state'). Tool approvals are ephemeral in-memory
 * (the DB is for audit + routines v0.11); the status index supports pending-list queries.
 */
const APPROVALS_STATEMENTS: string[] = [
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
];

/**
 * Conversation titles (UUID-chat persistence). A nullable `title` filled in asynchronously by the
 * quick-tier title generator after the first turn, plus a `(user_id, updated_at)` index backing the
 * newest-first "Recent chats" sidebar list. Idempotent `ALTER`/`CREATE` so re-runs are safe.
 */
const CONVERSATION_TITLE_STATEMENTS: string[] = [
  "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS title text",
  "CREATE INDEX IF NOT EXISTS conversations_user_updated_idx ON conversations (user_id, updated_at)",
];

/**
 * Per-message thumbs up/down feedback (FB-V1). One current vote per (message, user) — re-voting
 * upserts, un-voting deletes. `rating` is +1/-1; the optional `note` captures a down-vote reason for
 * a future self-improvement loop. `conversation_id` is denormalised (derived server-side from the
 * message) to back per-conversation queries. `user_id` is FK-less, mirroring `conversations.user_id`.
 */
const MESSAGE_FEEDBACK_STATEMENTS: string[] = [
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
  // Reads filter by (conversation_id, user_id); lookups by message_id alone ride the UNIQUE index's
  // leftmost column, so no separate message_id index is needed.
  "CREATE INDEX IF NOT EXISTS message_feedback_convo_idx ON message_feedback (conversation_id)",
];

/**
 * Conversation starring (Chats browse page). A `starred` flag so the Chats page can pin chats; the
 * column is NOT NULL DEFAULT false so existing rows backfill to unstarred. Idempotent `ALTER` for
 * safe re-runs.
 */
const CONVERSATION_STARRED_STATEMENTS: string[] = [
  "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS starred boolean NOT NULL DEFAULT false",
];

/**
 * Human-in-the-loop suspend/resume (A2UI HITL). `pending_interactions` records a turn that paused on
 * an `ask_user` tool call: the row holds the pending tool-call id + the awaited answer schema, so the
 * next request injects the user's response as that call's tool-result and resumes the run. The partial
 * index supports the one hot query — the single open interaction per conversation. `a2ui_surfaces`
 * persists each rendered surface's spec + data model so resume (and future live `updateDataModel` ops)
 * can recompute bound nodes server-side.
 */
const HITL_STATEMENTS: string[] = [
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
];

/**
 * Generic scoped key-value store (KV-V1). Identity is the composite PK
 * (scope, owner_id, namespace, key). `owner_id` is `NOT NULL DEFAULT ''` rather than nullable: a
 * nullable column can't be part of a PRIMARY KEY, and NULL is "distinct" in unique indexes — which
 * would make `ON CONFLICT` never fire for system rows and silently insert duplicates. The empty-string
 * sentinel keeps the PK legal and last-write-wins upsert reliable across all three scopes; the repo
 * maps '' <-> undefined so no caller sees it. `value` is plaintext jsonb (secrets live in `secrets`).
 * `expires_at` NULL = never expires; reads filter `expires_at IS NULL OR expires_at > now()` (lazy
 * expiry, no sweeper in v1). The CHECKs pin the scope enum and the system<=>'' owner invariant (the
 * latter mirrors `conversations_owner_check`).
 */
const KV_STATEMENTS: string[] = [
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
  // Backs list-by-namespace (scope, owner_id, namespace) lookups.
  "CREATE INDEX IF NOT EXISTS kv_store_owner_ns_idx ON kv_store (scope, owner_id, namespace)",
];

/**
 * Envelope encryption (SEC-V1 key recovery). Secrets are encrypted under a Data Encryption Key
 * (DEK); the DEK is wrapped (same AES-256-GCM codec) under one or more Key Encryption Keys and
 * stored here — one row per (dek_id, kek_label). The `env` wrap is the operational path
 * (ENCRYPTION_KEY); the `recovery` wrap is the offline break-glass path. The partial unique index
 * enforces at most one active env wrap and one active recovery wrap (rotation retires before
 * inserting). The canary columns (a fixed plaintext encrypted under the DEK) live on the env wrap
 * for the fail-fast boot check. `secrets.dek_id` tags which DEK encrypted a row; NULL = legacy
 * (still encrypted directly under ENCRYPTION_KEY, until `keys backfill` migrates it).
 */
const ENVELOPE_KEY_STATEMENTS: string[] = [
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
  "ALTER TABLE secrets ADD COLUMN IF NOT EXISTS dek_id uuid",
];

export const PG_MIGRATIONS: PgMigration[] = [
  {
    version: 1,
    description: "init: extensions, resources schema, baseline public tables",
    up: async (q) => {
      for (const sql of INIT_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 2,
    description: "knowledge: documents, chunks (pgvector + tsvector), collections, revisions",
    up: async (q) => {
      for (const sql of KNOWLEDGE_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 3,
    description: "stream_resume: durable SSE replay buffer keyed by (stream_id, seq)",
    up: async (q) => {
      for (const sql of STREAM_RESUME_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 4,
    description: "approvals: approval-gate table for tool-call and routine human_approval states",
    up: async (q) => {
      for (const sql of APPROVALS_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 5,
    description: "conversations.title + (user_id, updated_at) index for the Recent chats list",
    up: async (q) => {
      for (const sql of CONVERSATION_TITLE_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 6,
    description:
      "message_feedback: per-message thumbs up/down feedback keyed by (message_id, user_id)",
    up: async (q) => {
      for (const sql of MESSAGE_FEEDBACK_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 7,
    description: "conversations.starred flag for pinning chats on the Chats page",
    up: async (q) => {
      for (const sql of CONVERSATION_STARRED_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 8,
    description: "HITL: pending_interactions (ask_user suspend/resume) + a2ui_surfaces store",
    up: async (q) => {
      for (const sql of HITL_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 9,
    description:
      "kv_store: generic scoped key-value store (composite PK, lazy expiry, jsonb value)",
    up: async (q) => {
      for (const sql of KV_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
  {
    version: 10,
    description:
      "wrapped_deks: DEK/KEK envelope table + secrets.dek_id (envelope encryption + key recovery)",
    up: async (q) => {
      for (const sql of ENVELOPE_KEY_STATEMENTS) {
        await q.query(sql);
      }
    },
  },
];
