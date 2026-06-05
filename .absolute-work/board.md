# Absolute Work Board: Migration-on-Boot Framework

**Issue:** [#4](https://github.com/TulipFarm/project/issues/4)
**Status:** COMPLETED
**Date Created:** 2026-06-05
**Date Completed:** 2026-06-05

---

## Project Conventions

- **Package manager:** pnpm 11.1.3
- **Build system:** Turborepo 2.9.16
- **Language:** TypeScript
- **API runtime:** Node.js with Fastify (tsx for watch mode)
- **Database:** MongoDB via native `mongodb` driver
- **Available scripts:** `pnpm typecheck`, `pnpm dev:api`, `pnpm dev`

---

## Tasks

### AW-001: Add `mongodb` dependency
- **Type:** config | **Size:** S | **Dependencies:** none
- **Status:** ✅ DONE
- Added `mongodb` ^6.x to `apps/api/package.json`

### AW-002: Add `yaml` dependency (pre-existing gap)
- **Type:** config | **Size:** S | **Dependencies:** none
- **Status:** ✅ DONE
- `soul/migrate.ts` imported `yaml` but it was not in deps. Added it.

### AW-003: Create `apps/api/src/db.ts`
- **Type:** code | **Size:** S | **Dependencies:** AW-001
- **Status:** ✅ DONE
- MongoDB connection singleton exposing `connectDb()` and `getDb()`

### AW-004: Create `apps/api/src/migrations/index.ts`
- **Type:** code | **Size:** S | **Dependencies:** AW-001
- **Status:** ✅ DONE
- `DataMigration` interface + empty `DATA_MIGRATIONS` registry (parallel to soul migrations)

### AW-005: Create `apps/api/src/migrate.ts`
- **Type:** code | **Size:** S | **Dependencies:** AW-003, AW-004
- **Status:** ✅ DONE
- Runner: reads `_meta.schema_version.version`, runs pending, upserts version after each. Exits non-zero on failure.

### AW-006: Wire boot sequence in `apps/api/src/index.ts`
- **Type:** code | **Size:** S | **Dependencies:** AW-003, AW-005
- **Status:** ✅ DONE
- `boot()`: connectDb → runSoulMigrations → runDataMigrations → app.listen

### AW-007: Typecheck verification
- **Type:** test | **Size:** S | **Dependencies:** AW-001–AW-006
- **Status:** ✅ DONE — `pnpm typecheck --filter @tulipfarm/api` passes clean

---

## Acceptance Criteria

- [x] Migrations run in order on every boot; already-applied are no-ops
- [x] Failing migration causes api to exit non-zero and log a clear error
- [x] `schema_version` doc in `_meta` collection tracks current applied version
- [x] No partial/silent migration — version only updated after successful `up()`
- [x] Soul migrations also wired (INST-009 covers both)

---

## Deferred Work

None

---

## Rollback Point

Pre-implementation commit: `fc335c7` (chore: local dev bootstrap)

**BOARD STATUS: COMPLETED** (2026-06-05)
