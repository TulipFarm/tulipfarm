# Auth Domain — Agent Conventions

Authentication for the API: sessions, CSRF, passwords, and API tokens. This is the densest
`apps/api` domain — it inherits the route/test conventions in `apps/api/AGENTS.md` and the
OpenAPI schema rule in the root `AGENTS.md`.

## Module map

| File | Role |
| --- | --- |
| `passwords.ts` | Password hashing + verification. |
| `session-store.ts` | Server-side session store (issue / get / destroy, TTL). |
| `csrf.ts` | CSRF token issue / verify for cookie-session requests. |
| `api-tokens.ts` | API token mint + `hashToken` + repo lookup by hash. |
| `users.ts` | `UserRepo` / `UserDoc`. |
| `middleware.ts` | `makeRequireAuth(store, repo, tokenRepo)` → `requireAuth` PreHandler. |
| `schemas.ts` | Shared JSON Schemas for auth routes — import, don't inline. |
| `routes/` | `registerAuthRoutes` (index) → `registerSessionRoutes`, `registerTokenRoutes`. |

## How `requireAuth` resolves a request

1. Session cookie `tf_sid` → `session-store` → `UserRepo.findById` → set `req.user`.
2. Else `Authorization: Bearer <token>` → `findByHash(hashToken(raw))` → `req.user`.
3. Else `401 { error: "unauthorized" }`.

## Conventions

- Protected routes take `requireAuth` as the last handler arg and declare
  `security: [{ sessionCookie: [] }, { bearerToken: [] }]` in their schema (root `AGENTS.md`).
- **Never store secrets in plaintext** — hash passwords and tokens; look tokens up by hash.
- Shared response shapes live in `schemas.ts`; reuse them across routes.

## How to extend

- **New auth method** (e.g. OAuth): add `<method>.ts`, teach `middleware.ts` to recognize it,
  and register routes under `routes/`.
- **New token type / scope:** extend `api-tokens.ts` + the token routes; keep hash-only storage.

## Tests

Per `apps/api/AGENTS.md`: `buildApp` + Fastify `inject` (never a real server). Fakes implement
the real repo/store interfaces. Colocated `*.test.ts` already cover passwords, csrf, api-tokens,
session-store, and routes.
