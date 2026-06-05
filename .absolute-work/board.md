# Absolute Work Board: Basic CI Pipeline

**Issue:** [#5](https://github.com/TulipFarm/project/issues/5)
**Status:** COMPLETED
**Date Completed:** 2026-06-05
**Date Created:** 2026-06-05

---

## Project Conventions

- **Package manager:** pnpm 11.1.3
- **Build system:** Turborepo 2.9.16
- **Language:** TypeScript 6, Node 24
- **Workspaces:** apps/api, apps/web, apps/tsconfig, packages/ui, packages/types, packages/utils
- **Lint:** Biome (to be added)
- **Test runner:** vitest (to be added)

---

## Rollback Point

Pre-implementation commit: `db1723e` (feat: migration-on-boot framework)

---

## Tasks

### AW-001: Add @biomejs/biome + vitest to root devDependencies + test script
- **Type:** config | **Size:** S | **Dependencies:** none
- **Status:** ✅ DONE

### AW-002: Create `biome.json` at repo root
- **Type:** config | **Size:** S | **Dependencies:** AW-001
- **Status:** ✅ DONE

### AW-003: Add `lint` + `test` scripts to all workspace packages
- **Type:** config | **Size:** S | **Dependencies:** AW-001
- **Status:** ✅ DONE

### AW-004: Add `test` task to `turbo.json`
- **Type:** config | **Size:** S | **Dependencies:** none
- **Status:** ✅ DONE

### AW-005: Create `.github/workflows/ci.yml`
- **Type:** infra | **Size:** S | **Dependencies:** AW-001–AW-004
- **Status:** ✅ DONE

### AW-006: Verification — pnpm install + lint + typecheck + test
- **Type:** test | **Size:** S | **Dependencies:** AW-005
- **Status:** ✅ DONE

---

## Acceptance Criteria

- [ ] CI runs on push to main and on PRs
- [ ] Biome lint passes on all packages
- [ ] `tsc --noEmit` passes across all workspaces
- [ ] Unit tests run and pass (skip gracefully if none yet)
- [ ] CI fails fast on first error

---

## Deferred Work

None
