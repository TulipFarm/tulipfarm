/**
 * How many network calls one Run may make.
 *
 * The destination cage bounds *where* an Agent can reach and the Tool loop bounds how many
 * iterations it takes, but neither bounds the traffic a single Run sends at one destination. A
 * loop that fetches a paginated API, or a page whose content talks the Agent into crawling, can
 * spend a Run's whole iteration budget on requests — which is this deployment's IP address
 * hammering someone else's service.
 */
export const NETWORK_CALLS_PER_RUN = 40;

/**
 * How many Runs are tracked at once.
 *
 * Counters are held in memory rather than in Postgres because the budget only has to be
 * approximately right, and a write per network call is a real cost for an approximate limit. A
 * Run whose counter is evicted gets a fresh budget, which is the safe direction to be wrong in:
 * eviction only happens under load from many concurrent Runs, and the loop budget still applies.
 */
const TRACKED_RUNS = 2_000;

export interface NetworkBudget {
  /** Records one call and reports whether it may proceed. */
  spend(runId: string): {
    readonly allowed: boolean;
    readonly spent: number;
    readonly limit: number;
  };
}

export function createNetworkBudget(limit: number = NETWORK_CALLS_PER_RUN): NetworkBudget {
  const spent = new Map<string, number>();

  return {
    spend(runId) {
      // A call outside a durable Run has no budget to charge; the Tool's own authorization still
      // applies. Charging every such call to one shared bucket would let one caller starve all.
      if (runId.length === 0) return { allowed: true, spent: 0, limit };

      const next = (spent.get(runId) ?? 0) + 1;
      // Re-inserting moves the key to the end of the Map's insertion order, so the key deleted
      // below is genuinely the least recently used.
      spent.delete(runId);
      spent.set(runId, next);

      if (spent.size > TRACKED_RUNS) {
        const oldest = spent.keys().next();
        if (!oldest.done) spent.delete(oldest.value);
      }

      return { allowed: next <= limit, spent: next, limit };
    },
  };
}
