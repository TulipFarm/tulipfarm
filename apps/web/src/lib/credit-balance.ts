import { creditSummarySchema, type CreditSummary } from '@tulipfarm/workspace-storage/credits-contracts';
import { settingsRequest } from '@/features/settings/api';
import { useFeatureRead } from '@/lib/query';
import { creditKeys } from './credit-keys';

/** A workspace's credits: `available` is the true balance, `grace` how far below zero it may spend. */
export type CreditStanding = { available: number | null; granted: number | null; grace?: number | null | undefined };

/**
 * Where a workspace's credits stand:
 * - `unlimited`: no billing extension keeps a balance.
 * - `low`: 10% or less of the credits granted are left.
 * - `grace`: the balance is at or below zero, and work continues on grace credits.
 * - `stopped`: nothing is left to spend, grace included, so new work is paused.
 */
export type CreditLevel = 'unlimited' | 'ok' | 'low' | 'grace' | 'stopped';

export function creditLevel(balance: CreditStanding): CreditLevel {
  if (balance.available === null) return 'unlimited';
  const grace = balance.grace ?? 0;
  if (balance.available + grace <= 0) return 'stopped';
  if (balance.available <= 0) return 'grace';
  if (balance.granted !== null && balance.granted > 0 && balance.available <= balance.granted / 10) return 'low';
  return 'ok';
}

/**
 * The workspace's credit summary under the shared credit balance key, so every reader, and every change that spends
 * credits, shares one request. It keeps checking once a minute while credits are metered, and reads once otherwise.
 */
export function useCreditBalance(workspaceId: string) {
  return useFeatureRead<CreditSummary>({
    key: creditKeys.balance(),
    load: async signal =>
      creditSummarySchema.parse(
        await settingsRequest(`/workspaces/${encodeURIComponent(workspaceId)}/credits`, signal),
      ),
    pollWhile: balance => balance.available !== null,
    interval: 60_000,
    maxChecks: Infinity,
  });
}
