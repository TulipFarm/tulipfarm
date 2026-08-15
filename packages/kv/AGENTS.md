# `@tulipfarm/kv`

The agent key-value store: a namespaced, per-scope JSON scratch space, and the Tool family that
exposes it. It is a package rather than an API module because it is the first Tool family that
executes inside the durable runtime as well as the control plane.

## Read on

KV limits and validation, the `kv_*` Tools, or hosting this family in a new process.

## Skip

The HTTP routes (`apps/api/src/kv/routes.ts`) and the migration that owns the table
(`apps/api/src/migrations/`).

## Map

| Path | Owns |
| --- | --- |
| `src/limits.ts` | Namespace/key grammar and size ceilings |
| `src/repo.ts` | `KvRepo` port and `PgKvRepo` over any `Queryable` |
| `src/service.ts` | Scope resolution, TTL expiry, listing |
| `src/tools.ts` | `KV_TOOLS` — the `kv_set` / `kv_get` / `kv_delete` / `kv_list` declarations |
| `src/tool-result.ts` | Re-exports the shared Tool result helpers |

## Rules

- Every declaration in `KV_TOOLS` must keep clearing `localDispatchRefusal` from
  `@tulipfarm/tool-host` — `tier: "platform"`, no `provider`, `platform.*` resources only.
  `scripts/tool-colocation.test.ts` fails the build otherwise, because the durable runtime hosts
  this family in process.
- `PgKvRepo` takes a `Queryable`, never a `Pool`: it runs against the API pool, the worker pool and
  a PGlite test client alike.
