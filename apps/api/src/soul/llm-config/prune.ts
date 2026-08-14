import type { LlmConfig, ProviderEntry } from "@tulipfarm/schema";
import type { LlmProviderInfo } from "@tulipfarm/secrets";

const TIERS = ["quick", "standard", "complex"] as const;

export type PruneResult =
  | { action: "unchanged" }
  | { action: "update"; config: LlmConfig }
  | { action: "delete" };

/**
 * Prune entries using the deleted secret directly or by provider default; env:// refs are
 * unaffected.
 */
function entryUsesKey(entry: ProviderEntry, deletedKey: string, ownerProviderId: string): boolean {
  if (entry.api_key_ref === deletedKey) return true;
  if (!entry.api_key_ref && entry.provider === ownerProviderId) return true;
  return false;
}

/**
 * Deleting a key leaves config unchanged, prunes entries, or deletes config when a tier empties.
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
