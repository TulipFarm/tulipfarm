import { join } from "node:path";

/**
 * Per-business soul checkout path under a shared root: `<root>/<businessId>/soul`. Used once
 * `apps/api` moves from one global `SOUL_PATH` to per-business soul repos (Phase 10) — local dev
 * keeps using `SOUL_PATH` verbatim instead, so this is only reached when `SOUL_ROOT` is set.
 */
export function resolveSoulPath(root: string, businessId: string): string {
  return join(root, businessId, "soul");
}
