# Absolute Work Board: Bearer API Token Auth

**Issue:** [#8](https://github.com/TulipFarm/project/issues/8)
**Status:** COMPLETED
**Date Completed:** 2026-06-05
**Date Created:** 2026-06-05

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

Pre-implementation commit: `05b2d63` (feat: session auth)

---

## Decisions

1. Token format: `tulip_<base64url(randomBytes(32))>` — 49 chars, namespaced.
2. Hashing: SHA-256 (node crypto) — tokens are high-entropy random, no slow KDF needed.
3. Storage: `api_tokens` MongoDB collection.
4. Listing: admin sees all; member sees own.
5. Revocation: hard delete (simpler auth path — not found = not valid).
6. Admin can create token for other users via optional `userId` body field.
7. Dual-auth: cookie checked first, Bearer fallback.

---

## Tasks

### AW-001: api-tokens.ts — TokenDoc, TokenRepo, MongoTokenRepo, createApiToken, hashToken + tests
- **Type:** code+test | **Size:** S | **Dependencies:** none | **Wave:** 1
- **Files:** `apps/api/src/auth/api-tokens.ts`, `apps/api/src/auth/api-tokens.test.ts`
- **Status:** ✅ DONE

### AW-002: Migration v2 — unique index on api_tokens.tokenHash
- **Type:** infra | **Size:** S | **Dependencies:** none | **Wave:** 1
- **Files:** `apps/api/src/migrations/index.ts`
- **Status:** ✅ DONE

### AW-003: routes.ts — dual-auth requireAuth + token CRUD + route tests
- **Type:** code+test | **Size:** M | **Dependencies:** AW-001 | **Wave:** 2
- **Files:** `apps/api/src/auth/routes.ts`, `apps/api/src/auth/routes.test.ts`
- **Status:** ✅ DONE

### AW-004: app.ts + index.ts wiring
- **Type:** code | **Size:** S | **Dependencies:** AW-003 | **Wave:** 3
- **Files:** `apps/api/src/app.ts`, `apps/api/src/index.ts`
- **Status:** ✅ DONE

### AW-005: Self code review
- **Type:** test | **Size:** S | **Dependencies:** AW-004 | **Wave:** 4
- **Status:** ✅ DONE — cavecrew reviewer: no issues found

### AW-006: Requirements validation vs issue #8 ACs
- **Type:** test | **Size:** S | **Dependencies:** AW-005 | **Wave:** 4
- **Status:** ✅ DONE — all 5 ACs validated

### AW-007: Full verification — pnpm lint && typecheck && test
- **Type:** test | **Size:** S | **Dependencies:** AW-006 | **Wave:** 4
- **Status:** ✅ DONE — lint 0 errors · typecheck 0 errors · 47/47 tests pass

---

## Acceptance Criteria (#8)

- [x] `POST /api/v1/auth/tokens` creates a token (admin or self)
- [x] `Authorization: Bearer <token>` authenticates requests
- [x] Tokens stored hashed; raw value shown only at creation
- [x] `DELETE /api/v1/auth/tokens/:id` revokes a token
- [x] Both session and token auth work on the same endpoints (dual-auth)

## Verification

- `pnpm lint` 0 errors · `pnpm typecheck` 0 errors · `pnpm test` 47/47 (10 api-tokens unit + 9 session routes + 14 token routes + 4 bearer + 4 app + 4 session-store + 2 passwords)

---

## Deferred Work

- CSRF double-submit token
- Auth rate-limit (100/min/IP)
- Graceful shutdown (close Redis + Mongo on SIGTERM)
- Public register endpoint
