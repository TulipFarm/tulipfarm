# Absolute Work Board: CSRF Double-Submit Cookie

**Issue:** [#9](https://github.com/TulipFarm/project/issues/9)
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

Pre-implementation commit: `effc04d` (feat: bearer API token auth)

---

## Decisions

1. Cookie name: `csrf_token` (httpOnly=false, sameSite=strict)
2. Header name: `x-csrf-token`
3. Token: `randomBytes(32).toString("hex")` — 64 hex chars
4. Login exemption: no-session skip (if no tf_sid, csrfHook returns early)
5. TTL: matches session TTL (default 7 days)
6. Stateless: no server storage — compare cookie ↔ header only

---

## Tasks

### AW-001: csrf.ts — CSRF utilities + unit tests
- **Status:** ✅ DONE — 12 unit tests pass

### AW-002: session.ts — set CSRF cookie on login
- **Status:** ✅ DONE

### AW-003: app.ts — register global CSRF hook
- **Status:** ✅ DONE

### AW-004: Integration tests — CSRF behavior in routes
- **Status:** ✅ DONE — 6 new integration tests; existing tests updated

### AW-005: Self review + requirements validation + full verification
- **Status:** ✅ DONE — lint 0 · typecheck 0 · 65/65 tests pass (18 new)

---

## Acceptance Criteria (#9)

- [x] GET requests pass without CSRF token
- [x] POST/PUT/PATCH/DELETE without correct CSRF header return 403
- [x] Bearer-token-authenticated requests exempt from CSRF check
- [x] CSRF token rotated on login

## Verification

- `pnpm lint` 0 errors · `pnpm typecheck` 0 errors · `pnpm test` 65/65 (12 csrf unit + 6 csrf integration + 47 prior)

---

## Deferred Work

- CSRF token refresh endpoint (if cookie expires mid-session)
- Auth rate-limit (100/min/IP)
- Graceful shutdown (close Redis + Mongo on SIGTERM)
- Public register endpoint
