import type { LlmConfig, ProviderEntry } from "@tulipfarm/schema";
import type { LlmProviderInfo } from "@tulipfarm/secrets";

const TIERS = ["quick", "standard", "complex"] as const;

export type PruneResult =
  | { action: "unchanged" }
  | { action: "update"; config: LlmConfig }
  | { action: "delete" };

/**
 * A provider entry resolves its api key from `api_key_ref` when set, or from the
 * registry's default key for its provider type when not. Either path becomes broken
 * when `deletedKey` is removed, so both cases must be pruned.
 *
 * Entries with `env://` refs are unaffected — they read from process.env, not the
 * secrets store.
 */
function entryUsesKey(entry: ProviderEntry, deletedKey: string, ownerProviderId: string): boolean {
  if (entry.api_key_ref === deletedKey) return true;
  if (!entry.api_key_ref && entry.provider === ownerProviderId) return true;
  return false;
}

/**
 * Computes the effect of deleting a provider api_key secret on the LlmConfig.
 *
 * - "unchanged" — no entries reference the deleted key; nothing to do.
 * - "update"    — affected entries removed; every tier still has ≥1 provider; write pruned config.
 * - "delete"    — at least one tier is left empty after pruning (can't produce a valid config);
 *                 delete the file entirely so the server boots in a clean unconfigured state.
 */
export function pruneLlmConfig(
  config: LlmConfig,
  deletedKey: string,
  owner: LlmProviderInfo
): PruneResult {
  let changed = false;
  const tiers = config.tiers;
  // A migrated Soul keeps its credentials in provider connections, not tiers — there is no tier
  // entry that could reference the deleted key, so deleting one cannot invalidate the config.
  if (!tiers) return { action: "unchanged" };
  const nextTiers = { ...tiers };

  for (const tier of TIERS) {
    const original = tiers[tier].providers;
    const kept = original.filter((entry) => !entryUsesKey(entry, deletedKey, owner.id));
    nextTiers[tier] = { ...tiers[tier], providers: kept };
    if (kept.length !== original.length) changed = true;
  }

  if (!changed) return { action: "unchanged" };

  if (TIERS.some((t) => nextTiers[t].providers.length === 0)) {
    return { action: "delete" };
  }

  return { action: "update", config: { ...config, tiers: nextTiers } };
}
