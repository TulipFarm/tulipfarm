# kv — generic scoped key-value store (KV-V1)

A single Postgres table (`kv_store`) for arbitrary platform values — application salt, install id,
feature flags, cached/bootstrap state, agent scratch data. Fills the gap left by the three existing
stores: `secrets` (encrypted), `working_memory` (per-user, char-capped), `resources` (soul-defined
documents). Plaintext JSONB — anything genuinely secret belongs in `secrets`.

## Model

Identity is the composite PK `(scope, owner_id, namespace, key)`:

- `scope` ∈ `system | user | agent` (CHECK-enforced).
- `owner_id` is `NOT NULL DEFAULT ''`; the `''` sentinel marks "no owner" for `system`. A nullable
  column can't sit in a PRIMARY KEY, and NULL is distinct in unique indexes (which would break
  `ON CONFLICT`) — so the repo maps `'' ↔ undefined` and no caller ever sees the sentinel.
- `value jsonb` (any JSON), `expires_at timestamptz NULL` (NULL = never).

Reads filter `expires_at IS NULL OR expires_at > now()` (**lazy expiry**, no sweeper in v1). Writes
are **last-write-wins** upserts; `created_at` is preserved across updates. CHECK
`((scope='system') = (owner_id=''))` pins the system⇔sentinel invariant.

## Files

- `repo.ts` — `KvEntry`, `KvRepo`, `PgKvRepo` (sentinel mapping, lazy-expiry SQL, upsert/get/delete/list).
- `service.ts` — `KvService`: charset/length validation, value **byte** cap (`MAX_VALUE_BYTES`), TTL.
- `limits.ts` — caps + the `KV_NAME_RE` charset.
- `tools.ts` — `kv_get/kv_set/kv_delete/kv_list` agent tools.
- `routes.ts` — HTTP routes.
- `tool-result.ts` — re-export of the shared tool result helpers.

## Surfaces & access control (sandboxed by caller identity)

The caller never names scope/owner — it is derived from identity, so isolation is by construction:

- **Internal** (`PgKvRepo` / `KvService`) — backend code may address any scope.
- **Agent tools** — hard-wired `scope='agent'`, `owner_id = ctx.agentId`. An agent only ever sees its
  own private scratch space (shared across that agent's users/conversations — intentional).
- **User routes** `/api/v1/kv/:namespace/:key` (+ `/:namespace` list) — `scope='user'`, owner = caller.
- **Admin routes** `/api/v1/admin/kv/...` — `scope='system'`; non-admins get 403. Separate prefix (not
  `/api/v1/kv/system`) so it can't collide with a user namespace literally named `system`.

## Wiring

Migration v9 (`pg-migrations/index.ts`) creates the table. `index.ts` constructs
`new KvService(new PgKvRepo(pool))` and threads it into `buildToolRegistry` (agent tools) and
`buildApp` (HTTP routes). `tools/setup.ts` registers `KV_TOOLS` with `ctx.agentId` as the owner.

## Tests

`repo.pg.test.ts` (PGlite), `service.test.ts` + `tools.test.ts` (in-memory fakes), `routes.test.ts`
(Fastify inject + PGlite). KV-specific migration assertions live in `../pg-migrate.test.ts`.
