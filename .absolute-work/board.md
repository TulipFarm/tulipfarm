# Absolute Work Board: pnpm dev Turborepo Wiring

**Issue:** [#3](https://github.com/TulipFarm/project/issues/3)  
**Status:** DECOMPOSED  
**Rollback Point:** (to be recorded at execution start)  
**Date Created:** 2026-06-05

---

## Project Conventions

- **Package manager:** pnpm 11.1.3
- **Build system:** Turborepo 2.9.16
- **Languages:** TypeScript (both apps), JSX (web)
- **API runtime:** Node.js with Fastify (tsx for watch mode)
- **Web framework:** Remix v2 with Vite
- **Test runner:** Not yet installed (use manual verification for now)
- **Linter:** ESLint available via `turbo lint`
- **Available scripts:** `pnpm build`, `pnpm dev`, `pnpm lint`, `pnpm typecheck`
- **Directory structure:** `apps/{api,web}`, `packages/`, `scripts/`, `.env.local` at root

---

## Wave 1: Code & Config Updates (Independent, Parallel-Safe)

All tasks in this wave touch disjoint files. Run in any order or in parallel.

### AW-001: Update API port config
- **Type:** code
- **Size:** S (< 50 lines changed)
- **Dependencies:** none
- **Description:** Read `PORT` env var in api startup, default to 4001. Update `apps/api/src/index.ts` line with `app.listen()`.
- **Files to modify:**
  - `apps/api/src/index.ts` (line ~8-10)
- **Test cases:**
  - Run `PORT=5000 tsx watch src/index.ts` → listens on 5000
  - Run `tsx watch src/index.ts` (no env var) → listens on 4001
- **Acceptance criteria:**
  - API listens on `process.env.PORT || 4001`
  - Startup message confirms port

### AW-002: Update Web port config
- **Type:** code
- **Size:** S (< 50 lines changed)
- **Dependencies:** none
- **Description:** Add server config to `apps/web/vite.config.ts` to read `VITE_PORT` env var, default to 4000.
- **Files to modify:**
  - `apps/web/vite.config.ts`
- **Test cases:**
  - Run `VITE_PORT=3000 remix vite:dev` → dev server on 3000
  - Run `remix vite:dev` (no env var) → dev server on 4000
- **Acceptance criteria:**
  - Vite server config includes `server.middlewareMode: false, server.port: process.env.VITE_PORT || 4000`
  - HMR still works (no mixed http/ws protocols)

### AW-003: Update root package.json dev scripts
- **Type:** code
- **Size:** S (< 50 lines changed)
- **Dependencies:** none
- **Description:** Add `dev:api` and `dev:web` scripts to root `package.json` using Turborepo filtering.
- **Files to modify:**
  - `package.json` (root)
- **Test cases:**
  - `pnpm dev:api` runs `turbo dev --filter=@tulipfarm/api` successfully
  - `pnpm dev:web` runs `turbo dev --filter=@tulipfarm/web` successfully
- **Acceptance criteria:**
  - Root package.json has `"dev": "turbo dev"`, `"dev:api": "turbo dev --filter=@tulipfarm/api"`, `"dev:web": "turbo dev --filter=@tulipfarm/web"`

### AW-004: Update README.md with port info
- **Type:** docs
- **Size:** S (< 50 lines changed)
- **Dependencies:** none
- **Description:** Update README.md to reflect new port assignments (4000/4001) and document env var overrides.
- **Files to modify:**
  - `README.md`
- **Test cases:**
  - README clearly states web runs on 4000, api on 4001
  - README documents `VITE_PORT` and `PORT` override capability
  - Example `.env.local` config shown
- **Acceptance criteria:**
  - Port references updated from 3000/3001 to 4000/4001
  - `.env.local` override section added with examples

### AW-005: Update .env.local.example
- **Type:** config
- **Size:** S (< 50 lines changed)
- **Dependencies:** none
- **Description:** Add optional environment variable documentation for port overrides.
- **Files to modify:**
  - `.env.local.example`
- **Test cases:**
  - File includes `# VITE_PORT=4000` (commented out)
  - File includes `# PORT=4001` (commented out)
- **Acceptance criteria:**
  - `.env.local.example` documents port env vars with comments

---

## Wave 2: Per-App Testing (Parallel-Safe Subset)

AW-006 and AW-007 can run in parallel (disjoint files). AW-008 and AW-009 can run in parallel (independent test scenarios).

### AW-006: Test API dev:api script
- **Type:** test
- **Size:** S (manual verification)
- **Dependencies:** AW-001, AW-003
- **Description:** Verify `pnpm dev:api` starts api on port 4001 and reloads on file change.
- **Test cases:**
  - Run `pnpm dev:api` from root → api starts, logs show port 4001
  - Edit `apps/api/src/index.ts`, add a log statement → restart happens within 2s
  - Kill process → session stops gracefully
- **Acceptance criteria:**
  - API starts and listens on 4001
  - File changes trigger restart (tsx watch works)
  - Logs are readable and prefixed `[api]`

### AW-007: Test Web dev:web script
- **Type:** test
- **Size:** S (manual verification)
- **Dependencies:** AW-002, AW-003
- **Description:** Verify `pnpm dev:web` starts web on port 4000 with Vite HMR.
- **Test cases:**
  - Run `pnpm dev:web` from root → web starts, logs show port 4000
  - Edit `apps/web/app/root.tsx`, change a component → HMR triggers without full reload
  - Kill process → session stops gracefully
- **Acceptance criteria:**
  - Web starts and listens on 4000
  - File changes trigger HMR (browser updates without full reload)
  - Logs are readable and prefixed `[web]`

### AW-008: Test concurrent pnpm dev
- **Type:** test
- **Size:** S (manual verification)
- **Dependencies:** AW-001, AW-002, AW-003
- **Description:** Verify `pnpm dev` starts both api and web, both hot reload, all-or-nothing failure works.
- **Test cases:**
  - Run `pnpm dev` → both api and web start in one terminal
  - Verify logs show `[api]` and `[web]` prefixes
  - Edit api file → restart within 2s, logs show both processes still running
  - Edit web file → HMR triggers, api still running
  - Kill api (send SIGTERM) → whole `pnpm dev` exits
- **Acceptance criteria:**
  - Both apps run concurrently in one terminal
  - Logs are merged with prefixes
  - All-or-nothing: killing one app stops the entire session

### AW-009: Test environment variable overrides
- **Type:** test
- **Size:** S (manual verification)
- **Dependencies:** AW-001, AW-002, AW-005
- **Description:** Verify `.env.local` port overrides work for both api and web.
- **Test cases:**
  - Add `PORT=5000` to `.env.local`
  - Run `pnpm dev:api` → api listens on 5000 (confirmed by logs)
  - Add `VITE_PORT=3000` to `.env.local`
  - Run `pnpm dev:web` → web listens on 3000 (confirmed by logs)
  - Remove overrides from `.env.local` → defaults 4001/4000 restored
- **Acceptance criteria:**
  - Environment variables take precedence
  - Defaults are used when env vars not set

---

## Wave 3: Integration & Acceptance

### AW-010: Full acceptance criteria validation
- **Type:** test
- **Size:** M (comprehensive manual verification)
- **Dependencies:** AW-006, AW-007, AW-008, AW-009
- **Description:** Verify all original acceptance criteria from issue #3 are met.
- **Test cases:**
  1. ✓ `pnpm dev` starts both api and web processes in one terminal
  2. ✓ Editing an api file triggers restart within 2s
  3. ✓ Editing a web file triggers Vite HMR without full reload
  4. ✓ Environment variables are loaded from `.env.local`
  5. ✓ `pnpm dev:api` and `pnpm dev:web` work in isolation
  6. ✓ Ports default to 4000 (web) and 4001 (api)
  7. ✓ Ports can be overridden via `VITE_PORT` and `PORT`
- **Acceptance criteria:**
  - All 7 criteria above pass
  - No errors in startup or during hot reload
  - Logs are clear and actionable

---

## Wave 4: Code Review

### AW-011: Self code review
- **Type:** review
- **Size:** S
- **Dependencies:** AW-001, AW-002, AW-003, AW-004, AW-005
- **Description:** Review all changes for correctness, consistency, and adherence to project conventions.
- **Acceptance criteria:**
  - No hardcoded ports remain (all use env vars with defaults)
  - Port config follows project patterns (consistent with existing dotenv usage)
  - Turborepo filtering syntax is correct
  - Documentation is clear and accurate
  - No breaking changes to existing workflows

---

## Wave 5: Requirements Check

### AW-012: Requirements validation
- **Type:** review
- **Size:** S
- **Dependencies:** AW-010
- **Description:** Verify acceptance criteria are genuinely met and document any gaps.
- **Acceptance criteria:**
  - All acceptance criteria from issue #3 are satisfied
  - No edge cases discovered in testing
  - Performance is acceptable (startup time < 10s for both apps)

---

## Wave 6: Final Verification

### AW-013: Full project verification
- **Type:** review
- **Size:** S
- **Dependencies:** AW-011, AW-012
- **Description:** Run full suite (lint, typecheck, build) and confirm no regressions.
- **Test cases:**
  - `pnpm typecheck` passes
  - `pnpm lint` passes
  - `pnpm build` succeeds
  - `pnpm dev` starts and works as designed
- **Acceptance criteria:**
  - No new linting errors
  - No type errors
  - Build succeeds
  - All acceptance criteria still pass

---

## Deferred Work

- [ ] Debugger auto-attach config for VS Code (can be added later)
- [ ] Docker/container support for dev (future enhancement)
- [ ] Integration tests for concurrent startup (can use monorepo test suite later)

---

## Status

- [x] Design approved (2026-06-05)
- [x] Wave 1 complete (2026-06-05)
  - [x] AW-001: API port config (read PORT env var, default 4001)
  - [x] AW-002: Web port config (read VITE_PORT env var, default 4000)
  - [x] AW-003: Root package.json dev scripts (dev:api, dev:web)
  - [x] AW-004: README.md updates (new port info, isolated dev scripts)
  - [x] AW-005: .env.local.example (port override docs)
- [x] Wave 2 complete (2026-06-05)
  - [x] AW-006: Test pnpm dev:api (API starts on 4001) ✓
  - [x] AW-007: Test pnpm dev:web (Web starts on 4000) ✓
  - [x] AW-008: Test concurrent pnpm dev (both apps, merged logs with prefixes) ✓
  - [x] AW-009: Test env var overrides (VITE_PORT=3000 works) ✓
- [x] Wave 3 complete (2026-06-05)
  - [x] AW-010: All 7 acceptance criteria verified ✓
- [x] Wave 4 complete (2026-06-05)
  - [x] AW-011: Self code review passed ✓
- [x] Wave 5 complete (2026-06-05)
  - [x] AW-012: All requirements satisfied, no gaps ✓
- [x] Wave 6 complete (2026-06-05)
  - [x] AW-013: Full verification suite passed ✓

**BOARD STATUS: COMPLETED** (2026-06-05)
