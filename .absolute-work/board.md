---
id: aw-1749130440
title: "Bootstrap env vars + startup validation"
type: feature
status: completed
created: "2026-06-05T13:24:00Z"
updated: "2026-06-05T13:24:00Z"
git_tracked: false
evaluator_enabled: false
total_tasks: 7
completed_tasks: 0
failed_tasks: 0
current_wave: 1
total_waves: 4
---

## Intake Summary
- **Task**: Harden env var validation at API startup — add WEBHOOK_SIGNING_SECRET, validate secret formats, URI prefixes, SESSION_TTL_SECONDS, add startup confirmation log
- **Type**: feature  **Complexity**: medium
- **Problem**: `validateEnvironment()` only validates ENCRYPTION_KEY format; other secrets/URIs unchecked; no startup confirmation log
- **Success Criteria**: All 4 ACs from issue #13 pass + hardened validation for all required vars
- **Constraints**: Manual validation (no new deps), Biome linter, Vitest, pino logger
- **Dependencies**: None
- **Spec**: docs/plans/2026-06-05-env-validation-design.md
- **Board Persistence**: gitignored

## Project Conventions
- **Package manager**: pnpm 11.1.3
- **Runtime**: TypeScript 6, Node (see .node-version)
- **Test runner**: Vitest v3 (`pnpm test` → `vitest run --passWithNoTests`)
- **Linter/Formatter**: Biome 1.9.4 (`pnpm lint` → `biome check`)
- **Build system**: Turborepo (`pnpm build`)
- **Type check**: `pnpm typecheck` → `tsc --noEmit`
- **Directory conventions**: `apps/api/src/`, colocated `*.test.ts`
- **Verify all**: `pnpm lint && pnpm typecheck && pnpm test`

## Task Graph

### Sub-tasks
| ID | Title | Type | Size | Dependencies | Wave | Run | Status |
|----|-------|------|------|-------------|------|-----|--------|
| AW-001 | Refactor validateEnvironment for DI testability | code | M | - | 1 | seq | completed |
| AW-002 | Add WEBHOOK_SIGNING_SECRET + expand secret validation | code | S | AW-001 | 2 | seq | completed |
| AW-003 | Add URI prefix validation for MONGODB_URI and REDIS_URL | code | S | AW-001 | 2 | seq | completed |
| AW-004 | Add SESSION_TTL_SECONDS guard | code | S | AW-001 | 2 | seq | completed |
| AW-005 | Add logEnvironmentStatus with pino | code | S | AW-001 | 2 | seq | completed |
| AW-006 | Write env-validation.test.ts | test | M | AW-001..AW-005 | 3 | seq | completed |
| AW-007 | Self code review + full project verification | test | S | AW-006 | 4 | seq | completed |

### Dependency Graph
```
[W1] AW-001 [code: Refactor validateEnvironment for DI]      (seq — foundation)
       ├──> [W2] AW-002 [code: Secret validation]              (seq — shared file)
       ├──> [W2] AW-003 [code: URI prefix validation]          (seq — shared file)
       ├──> [W2] AW-004 [code: SESSION_TTL guard]              (seq — shared file)
       └──> [W2] AW-005 [code: Startup log]                    (seq — shared file)
                   └──> [W3] AW-006 [test: env-validation]     (seq)
                              └──> [W4] AW-007 [verify: full]  (seq)
```

### Wave Assignments
- **Wave 1** (1 task): AW-001 [seq — foundation, all others depend on it]
- **Wave 2** (4 tasks): AW-002, AW-003, AW-004, AW-005 [all seq — shared file `index.ts`]
- **Wave 3** (1 task): AW-006 [seq — tests all Wave 2 output]
- **Wave 4** (1 task): AW-007 [seq — mandatory tail: full verification]

## Tasks

### AW-001: Refactor validateEnvironment for DI testability
- **Type**: code
- **Size**: M
- **Dependencies**: none
- **Wave**: 1  **Run**: seq
- **Status**: planned

#### Research Notes
- Key files: `apps/api/src/index.ts:16-41`
- Current: `validateEnvironment()` reads `process.env` directly, calls `process.exit(1)`
- Pattern: extract to `validateEnvironment(env, exit)` with defaults
- Risk: must not change runtime behavior — only add params with defaults

#### Execution Plan
- Files to modify: `apps/api/src/index.ts`
- Approach: Refactor `validateEnvironment()` to accept `env: Record<string, string | undefined>` and `exit: (code: number) => never` with defaults of `process.env` and `process.exit`. Extract `validateBase64Secret(name, env, exit)` and `validateUriPrefix(name, prefixes, env, exit)` helpers. Export `validateEnvironment` for test imports.
- Acceptance criteria:
  - [ ] `validateEnvironment` accepts env record + exit callback
  - [ ] Existing behavior unchanged when called without args
  - [ ] Function exported for test imports
  - [ ] Biome lint + typecheck pass

---

### AW-002: Add WEBHOOK_SIGNING_SECRET + expand secret validation
- **Type**: code
- **Size**: S
- **Dependencies**: AW-001
- **Wave**: 2  **Run**: seq
- **Status**: planned

#### Execution Plan
- Files to modify: `apps/api/src/index.ts`
- Approach: Add `WEBHOOK_SIGNING_SECRET` to required array. Loop all 3 secrets through `validateBase64Secret`.
- Acceptance criteria:
  - [ ] Required array contains 6 vars including WEBHOOK_SIGNING_SECRET
  - [ ] JWT_SECRET and WEBHOOK_SIGNING_SECRET get 32-byte base64 validation

---

### AW-003: Add URI prefix validation for MONGODB_URI and REDIS_URL
- **Type**: code
- **Size**: S
- **Dependencies**: AW-001
- **Wave**: 2  **Run**: seq
- **Status**: planned

#### Execution Plan
- Files to modify: `apps/api/src/index.ts`
- Approach: Call `validateUriPrefix` for MONGODB_URI (`mongodb://`, `mongodb+srv://`) and REDIS_URL (`redis://`, `rediss://`).
- Acceptance criteria:
  - [ ] MONGODB_URI validated for protocol prefix
  - [ ] REDIS_URL validated for protocol prefix

---

### AW-004: Add SESSION_TTL_SECONDS guard
- **Type**: code
- **Size**: S
- **Dependencies**: AW-001
- **Wave**: 2  **Run**: seq
- **Status**: planned

#### Execution Plan
- Files to modify: `apps/api/src/index.ts`
- Approach: If `env.SESSION_TTL_SECONDS` defined, parse + check `isNaN || <= 0` → exit.
- Acceptance criteria:
  - [ ] NaN value → exit(1) with clear message
  - [ ] Negative value → exit(1) with clear message
  - [ ] Absent value → passes (optional)

---

### AW-005: Add logEnvironmentStatus with pino
- **Type**: code
- **Size**: S
- **Dependencies**: AW-001
- **Wave**: 2  **Run**: seq
- **Status**: planned

#### Execution Plan
- Files to modify: `apps/api/src/index.ts`
- Approach: Add `logEnvironmentStatus(logger)` fn. Call after `buildApp()` in `boot()`.
- Acceptance criteria:
  - [ ] Startup log shows all required var names as "✓ set"
  - [ ] Values NOT logged (redacted)
  - [ ] Uses app.log (pino)

---

### AW-006: Write env-validation.test.ts
- **Type**: test
- **Size**: M
- **Dependencies**: AW-001, AW-002, AW-003, AW-004, AW-005
- **Wave**: 3  **Run**: seq
- **Status**: planned

#### Execution Plan
- Files to create: `apps/api/src/env-validation.test.ts`
- 12 test cases covering all validation branches

---

### AW-007: Self code review + full project verification
- **Type**: test
- **Size**: S
- **Dependencies**: AW-006
- **Wave**: 4  **Run**: seq
- **Status**: planned

#### Execution Plan
- Run `pnpm lint && pnpm typecheck && pnpm test`
- Review changed files for scope creep
- Verify `.env.local.example` completeness (AC-3)

## Rollback Point
- Pre-execution commit: 5efe32c3c9d6047f4cba9f035450d8a8e0c3221f
- Recorded: 2026-06-05T13:24:00Z
- Note: `apps/api/src/index.ts` has 1 uncommitted change (unused var cleanup in catch block)

## Execution Log
- 2026-06-05T14:32:00Z: Session resumed. All AW-001–AW-006 already implemented. AW-007 ran: 115/115 tests pass, typecheck clean, Biome lint clean (fixed 4x `delete` → `= undefined` + formatter in test file).
- 2026-06-05T14:32:00Z: Board marked completed.

## Deferred Work
