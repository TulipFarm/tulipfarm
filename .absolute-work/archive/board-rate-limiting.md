# Absolute Work Board: Rate Limiting

**Issue:** [#10](https://github.com/TulipFarm/project/issues/10)
**Status:** COMPLETED
**Date Completed:** 2026-06-05

## Rollback Point
Pre-implementation commit: `e7897d0` (feat: CSRF double-submit cookie protection)

## Project Conventions
- Package manager: pnpm + Turbo monorepo
- Language: TypeScript (strict, biome lint, 2-space, double-quote, semicolons)
- Test runner: Vitest, colocated `*.test.ts`, `app.inject()` for route tests
- Verify: `pnpm --filter @tulipfarm/api lint && typecheck && test`

## Tasks

| ID | Title | Type | Size | Status |
|---|---|---|---|---|
| AW-001 | `rate-limit.ts` core (interface + Redis + Memory + hook factory) | code | M | ✅ completed |
| AW-002 | `rate-limit.test.ts` unit tests | test | S | ✅ completed |
| AW-003 | Wire `AppOptions` + `registerAuthRoutes` | code | S | ✅ completed |
| AW-004 | Integration tests in `routes.test.ts` | test | S | ✅ completed |
| AW-005 | Full verification | infra | S | ✅ completed |

## Key Decisions
- Algorithm: sliding window via Redis ZSET + Lua (atomic); member = random 8-byte hex (avoids score-collision dedup)
- Graceful degrade: Redis error → catch, log.warn, return `allowed:true`
- In-memory impl (`MemoryRateLimiter`): same algorithm, Map-based, used in all tests
- Hook factory `makeRateLimitHook`: sets `X-RateLimit-{Limit,Remaining,Reset}` always; 429 + `Retry-After` when denied
- Key scheme: `rl:auth:{req.ip}` (100/min/60s window for all `/api/v1/auth/*`)
- AppOptions: optional `rateLimiter?` — existing tests pass undefined → no-op, no test changes required

## Verification Results
- `pnpm --filter @tulipfarm/api lint` → 0 errors
- `pnpm --filter @tulipfarm/api typecheck` → 0 errors
- `pnpm --filter @tulipfarm/api test` → **76/76 tests pass** (65 existing + 11 new)

## Acceptance Criteria
- [x] Exceeding limit returns 429 with `Retry-After` header
- [x] `X-RateLimit-{Limit,Remaining,Reset}` headers on every rate-limited response
- [x] Keys are per IP for auth endpoints
- [x] Redis down → requests allowed + logged warning

## Files Changed
| File | Change |
|---|---|
| `apps/api/src/rate-limit.ts` | New: RateLimitResult, RateLimiter, RedisRateLimiter, MemoryRateLimiter, makeRateLimitHook |
| `apps/api/src/rate-limit.test.ts` | New: 7 unit tests for MemoryRateLimiter |
| `apps/api/src/app.ts` | Added `rateLimiter?: RateLimiter` to AppOptions, pass to registerAuthRoutes |
| `apps/api/src/auth/routes/index.ts` | Accept rateLimiter, build preHandler, pass to session/token registrations |
| `apps/api/src/auth/routes/session.ts` | Accept optional rateLimitHook, apply to login/logout/session routes |
| `apps/api/src/auth/routes/tokens.ts` | Accept optional rateLimitHook, apply to all token routes |
| `apps/api/src/auth/routes.test.ts` | Added 4 integration tests for rate limiting |

## Deferred Work
- Resource CRUD rate limiter (1000/min/user) — no resource routes in V1 yet
- Chat rate limiter (60/min/user) — no chat routes in V1 yet
- Admin rate limiter (10/min/user) — no admin routes in V1 yet
