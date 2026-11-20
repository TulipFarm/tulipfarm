import type { Usage } from './contracts.ts';

export class EvalCapReached extends Error {
  readonly cap: 'requests' | 'cost' | 'replies';
  constructor(cap: 'requests' | 'cost' | 'replies', limit: number) {
    super(`Eval ${cap} cap of ${limit} reached`);
    this.name = 'EvalCapReached';
    this.cap = cap;
  }
}

export interface CapLimits {
  /** Model requests across the whole run, agent and judge together. */
  maxRequests?: number;
  /** Provider cost across the whole run, in picodollars. */
  maxPicoUsd?: number;
  /** Agent replies: cases × repeats × models. */
  maxReplies?: number;
}

/**
 * Hard caps shared by internal and workspace runs. `request` is called before each model request and `spend` after
 * it; reaching a cap throws `EvalCapReached`, which stops the run.
 */
export function createCaps(limits: CapLimits) {
  const spent = { requests: 0, picoUsd: 0, replies: 0 };
  return {
    spent,
    reply() {
      if (limits.maxReplies !== undefined && spent.replies >= limits.maxReplies)
        throw new EvalCapReached('replies', limits.maxReplies);
      spent.replies++;
    },
    request() {
      if (limits.maxRequests !== undefined && spent.requests >= limits.maxRequests)
        throw new EvalCapReached('requests', limits.maxRequests);
      if (limits.maxPicoUsd !== undefined && spent.picoUsd >= limits.maxPicoUsd)
        throw new EvalCapReached('cost', limits.maxPicoUsd);
      spent.requests++;
    },
    spend(picoUsd: number) {
      spent.picoUsd += Math.max(0, Math.round(picoUsd));
    },
  };
}
export type Caps = ReturnType<typeof createCaps>;

/** One USD is 10¹² picodollars, the unit of workspace credits. */
export const picoUsdPerUsd = 1_000_000_000_000;

/** Validates an internal job's caps: a request count and a provider cost in USD. An internal run is never uncapped. */
export function internalCaps({ requests, usd }: { requests: number; usd: number }): CapLimits {
  if (!Number.isInteger(requests) || requests < 1) throw new Error('EVALS_MAX_REQUESTS must be a positive integer');
  if (!Number.isFinite(usd) || usd < 0) throw new Error('EVALS_MAX_COST must be a non-negative number of USD');
  return { maxRequests: requests, maxPicoUsd: Math.round(usd * picoUsdPerUsd) };
}

export const usageCost = (usage: Pick<Usage, 'picoUsd'>) => usage.picoUsd / picoUsdPerUsd;
