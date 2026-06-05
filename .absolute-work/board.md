# Absolute Work Board: Cursor Pagination Utility

**Issue:** [#11](https://github.com/TulipFarm/project/issues/11)
**Status:** COMPLETED
**Date Completed:** 2026-06-05
**Started:** 2026-06-05

## Rollback Point
Pre-implementation commit: `9e03c88` (feat: rate limiting — sliding window per IP for auth endpoints)

## Project Conventions
- Package manager: pnpm + Turbo monorepo
- Language: TypeScript (strict, biome lint, 2-space, double-quote, semicolons)
- Test runner: Vitest, colocated `*.test.ts`, `app.inject()` for route tests
- Verify: `pnpm --filter @tulipfarm/api lint && typecheck && test`

## Tasks

| ID | Title | Type | Size | Status |
|---|---|---|---|---|
| AW-001 | `pagination.ts` utility (encode/decode cursor, parsePaginationQuery, paginateCollection) | code | M | ✅ completed |
| AW-002 | `pagination.test.ts` unit tests (pure fns) | test | S | ✅ completed |
| AW-003 | TokenRepo: add `findAllPaginated` + `findByUserIdPaginated` | code | S | ✅ completed |
| AW-004 | Update `GET /api/v1/auth/tokens` route for cursor pagination | code | S | ✅ completed |
| AW-005 | Integration tests for paginated tokens route | test | S | ✅ completed |
| AW-006 | Full verification | infra | S | ✅ completed |

## DAG
```
AW-001
  ├── AW-002 (parallel w/ AW-003, Wave 2)
  └── AW-003 (parallel w/ AW-002, Wave 2)
        └── AW-004 (Wave 3)
              └── AW-005 (Wave 4)
                    └── AW-006 (Wave 5)
```

## Waves
| Wave | Tasks | Mode |
|------|-------|------|
| 1 | AW-001 | sequential |
| 2 | AW-002, AW-003 | parallel |
| 3 | AW-004 | sequential |
| 4 | AW-005 | sequential |
| 5 | AW-006 | sequential |

## Acceptance Criteria
- [ ] All list endpoints accept `limit` (default 20, max 100) and `cursor`
- [ ] Response includes `nextCursor: null` when no more results
- [ ] Cursor is opaque (base64-encoded internal state)
- [ ] Consistent ordering guaranteed (by `createdAt` + `_id`)

## Key Decisions
- Cursor = base64(JSON `{ createdAt, _id }`) — opaque to callers
- `paginateCollection` in `pagination.ts` — single MongoDB impl reused by all repos
- `limit + 1` fetch trick to detect next page without `count()` query
- Invalid non-empty cursor → route returns 400; absent/empty cursor → first page
- `parsePaginationQuery` clamps limit to `[1, 100]`, defaults to 20

## Verification Results
- `pnpm --filter @tulipfarm/api lint` → 0 errors
- `pnpm --filter @tulipfarm/api typecheck` → 0 errors
- `pnpm --filter @tulipfarm/api test` → **95/95 tests pass** (76 existing + 19 new)

## Acceptance Criteria
- [x] All list endpoints accept `limit` (default 20, max 100) and `cursor`
- [x] Response includes `nextCursor: null` when no more results
- [x] Cursor is opaque (base64-encoded internal state)
- [x] Consistent ordering guaranteed (by `createdAt` + `_id`)

## Files Changed
| File | Change |
|---|---|
| `apps/api/src/pagination.ts` | New: `encodeCursor`, `decodeCursor`, `parsePaginationQuery`, `paginateCollection`, `PaginatedResult` |
| `apps/api/src/pagination.test.ts` | New: 15 unit tests for pure pagination fns |
| `apps/api/src/auth/api-tokens.ts` | Added `findAllPaginated` + `findByUserIdPaginated` to `TokenRepo` interface + `MongoTokenRepo` |
| `apps/api/src/auth/routes/tokens.ts` | Updated `GET /api/v1/auth/tokens` to accept `?limit&cursor`, return `nextCursor` |
| `apps/api/src/auth/routes.test.ts` | Added 4 pagination integration tests + updated `MemoryTokenRepo` |
| `apps/api/src/auth/api-tokens.test.ts` | Updated `MemoryTokenRepo` stub to implement new interface methods |

## Deferred Work
(none)
