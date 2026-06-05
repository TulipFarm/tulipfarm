# Absolute Work Board: Session Auth (tf_sid cookie, Argon2id, Redis sessions)

**Issue:** [#7](https://github.com/TulipFarm/project/issues/7)
**Status:** COMPLETED
**Date Created:** 2026-06-05
**Date Completed:** 2026-06-05

---

## Project Conventions

- **Package manager:** pnpm 11.1.3 · Turborepo 2.9
- **Language:** TypeScript 6, Node 24
- **Test runner:** Vitest (`*.test.ts` colocated, `--passWithNoTests`)
- **Lint:** Biome 1.9.4 (2-space, double-quote, semicolons, no `any`, no non-null `!`, `import type`)
- **Verify:** `pnpm lint && pnpm typecheck && pnpm test`
- **Target app:** `apps/api` (Fastify, `buildApp()` in `src/app.ts`, Mongo via `src/db.ts`)

---

## Rollback Point

Pre-implementation commit: `9fa5e00` (ai: add AGENTS and update absolute-work)

---

## Decisions

1. User creation → env-seeded bootstrap admin on boot (no register endpoint).
2. Argon2id → `@node-rs/argon2` (prebuilt NAPI).
3. Session store → `SessionStore` interface; Redis (prod) + Memory (tests), injected.
4. Redis client → `ioredis`.
5. Scope → cookie session only; defer bearer + CSRF + rate-limit.

---

## Tasks

### AW-001: Add deps (@node-rs/argon2, ioredis, @fastify/cookie) + env example keys
- **Type:** config | **Size:** S | **Dependencies:** none | **Wave:** 1
- **Files:** `apps/api/package.json`, `.env.local.example`
- **Status:** ✅ DONE

### AW-002: passwords.ts — hashPassword / verifyPassword + test
- **Type:** code+test | **Size:** S | **Dependencies:** AW-001 | **Wave:** 2
- **Files:** `apps/api/src/auth/passwords.ts`, `passwords.test.ts`
- **Acceptance:** hash roundtrip verifies true; wrong pw → false; hash != plaintext.
- **Status:** ✅ DONE

### AW-003: session-store.ts — SessionStore interface + Memory + Redis + test
- **Type:** code+test | **Size:** S | **Dependencies:** AW-001 | **Wave:** 2
- **Files:** `apps/api/src/auth/session-store.ts`, `session-store.test.ts`
- **Acceptance:** Memory create→get returns userId; destroy→get null; sid random 32B base64url.
- **Status:** ✅ DONE

### AW-004: users.ts — UserDoc, UserRepo, MongoUserRepo, bootstrapAdmin
- **Type:** code | **Size:** S | **Dependencies:** AW-001 | **Wave:** 2
- **Files:** `apps/api/src/auth/users.ts`
- **Acceptance:** typechecks; bootstrapAdmin idempotent (count>0 → noop; no env → noop).
- **Status:** ✅ DONE

### AW-005: migration — unique index on users.email
- **Type:** infra | **Size:** S | **Dependencies:** AW-001 | **Wave:** 2
- **Files:** `apps/api/src/migrations/index.ts`
- **Acceptance:** DATA_MIGRATIONS has v1 creating unique index `{ email: 1 }`.
- **Status:** ✅ DONE

### AW-006: routes.ts (login/logout/session + requireAuth) + wire app.ts opts + integration tests
- **Type:** code+test | **Size:** M | **Dependencies:** AW-002, AW-003, AW-004 | **Wave:** 3
- **Files:** `apps/api/src/auth/routes.ts`, `apps/api/src/app.ts`, `apps/api/src/auth/routes.test.ts`
- **Acceptance:** login sets tf_sid + 200; bad creds 401; session 200 w/ cookie, 401 w/o; logout 204 + clears. Existing health/CORS tests still pass.
- **Status:** ✅ DONE

### AW-007: index.ts wiring — RedisSessionStore + MongoUserRepo + bootstrapAdmin call
- **Type:** code | **Size:** S | **Dependencies:** AW-003, AW-004, AW-006 | **Wave:** 4
- **Files:** `apps/api/src/index.ts`
- **Acceptance:** typechecks; boot path constructs Redis+Mongo repos, calls bootstrapAdmin after migrations, passes to buildApp.
- **Status:** ✅ DONE

### AW-008: Self code review (separate agent)
- **Type:** test | **Size:** S | **Dependencies:** AW-007 | **Wave:** 5
- **Status:** ✅ DONE

### AW-009: Requirements validation vs issue #7 ACs
- **Type:** test | **Size:** S | **Dependencies:** AW-008 | **Wave:** 5
- **Status:** ✅ DONE

### AW-010: Full verification — pnpm lint && typecheck && test
- **Type:** test | **Size:** S | **Dependencies:** AW-009 | **Wave:** 5
- **Status:** ✅ DONE

---

## Acceptance Criteria (#7)

- [x] `POST /api/v1/auth/login` sets `tf_sid` cookie on success
- [x] `POST /api/v1/auth/logout` clears session from Redis + cookie
- [x] Passwords stored as Argon2id; plaintext never persisted
- [x] Session stored in Redis with configurable TTL
- [x] Expired/missing session returns 401

## Verification

- `pnpm lint` 5/5 · `pnpm typecheck` 5/5 · `pnpm test` 21/21 (8 unit + 4 app + 9 routes).
- Independent reviewer (cavecrew): 1 finding (maxAge "ms") was a **false positive** —
  verified `@fastify/cookie` calls `cookie.serialize` with no conversion; `cookie` lib
  Max-Age is in seconds, so `ttlSeconds` is correct. clearCookie path-match sufficient.

---

## Deferred Work

- Bearer API-token auth
- CSRF double-submit token
- Auth rate-limit (100/min/IP)
- Public register endpoint
- Graceful shutdown (close Redis + Mongo on SIGTERM) — matches existing Mongo gap
