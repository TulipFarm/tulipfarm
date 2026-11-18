import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { PlanProvider } from '@tulipfarm/config';
import type { SubscriptionModel, SubscriptionModelPlan } from '@tulipfarm/integrations/subscriptions';
import type { PlanModelChoice, PlanUsage } from './model-catalog.ts';

type PremiumRequests = NonNullable<PlanUsage['premiumRequests']>;

const quotaTtlMs = 5 * 60_000;
const quotaWaitMs = 1_500;
const maxCached = 1_000;

const copilotUser = z
  .object({
    quota_snapshots: z
      .object({
        premium_interactions: z
          .object({
            entitlement: z.number(),
            remaining: z.number(),
            unlimited: z.boolean().optional(),
            token_based_billing: z.boolean().optional(),
          })
          .loose()
          .nullable()
          .optional(),
      })
      .loose(),
  })
  .loose();

/**
 * The premium requests left on the GitHub Copilot plan of `token` this period, from the Copilot user endpoint GitHub's
 * own clients read. Null when GitHub does not say, the plan is unlimited, or it bills by usage instead of a count.
 */
export async function copilotPremiumRequests(
  token: string,
  fetcher: typeof fetch = fetch,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<PremiumRequests | null> {
  const response = await fetcher('https://api.github.com/copilot_internal/user', {
    headers: { authorization: `token ${token}`, accept: 'application/json' },
    signal,
  });
  if (!response.ok) return null;
  const snapshot = copilotUser.safeParse(await response.json()).data?.quota_snapshots.premium_interactions;
  if (!snapshot || snapshot.unlimited || snapshot.token_based_billing) return null;
  const entitlement = Math.floor(snapshot.entitlement);
  if (entitlement <= 0) return null;
  return { remaining: Math.min(Math.max(Math.floor(snapshot.remaining), 0), entitlement), entitlement };
}

/**
 * Adds each plan model's usage status: what replies last said about its plan's usage limit and, for Copilot, the
 * premium requests left. Copilot's count is read with the plan owner's token, kept for five minutes, and never holds
 * the model list for long: a count not back in time shows on a later request.
 */
export function createPlanUsage(options: {
  copilotToken?: ((workspaceId: string, ownerMembershipId: string) => Promise<string>) | undefined;
  fetcher?: typeof fetch;
}) {
  const cache = new Map<string, { expires: number; value: Promise<PremiumRequests | null> }>();

  async function premiumRequests(
    workspaceId: string,
    plan: Pick<SubscriptionModelPlan, 'connectionId' | 'ownerMembershipId'>,
  ) {
    const { copilotToken } = options;
    if (!copilotToken) return null;
    const key = `${workspaceId}:${plan.connectionId}`;
    let entry = cache.get(key);
    if (!entry || entry.expires <= Date.now()) {
      const value = copilotToken(workspaceId, plan.ownerMembershipId)
        .then(token => copilotPremiumRequests(token, options.fetcher))
        .catch(() => null);
      entry = { expires: Date.now() + quotaTtlMs, value };
      if (cache.size >= maxCached) cache.clear();
      cache.set(key, entry);
    }
    return Promise.race([entry.value, sleep(quotaWaitMs, null, { ref: false })]);
  }

  const choices = async (
    workspaceId: string,
    provider: PlanProvider,
    models: readonly (SubscriptionModel & { plan: SubscriptionModelPlan })[],
  ): Promise<PlanModelChoice[]> => {
    const counts = new Map<string, Promise<PremiumRequests | null>>();
    return Promise.all(
      models.map(async ({ slug, label, plan }) => {
        if (provider === 'copilot' && !counts.has(plan.connectionId))
          counts.set(plan.connectionId, premiumRequests(workspaceId, plan));
        return {
          slug,
          label,
          usage: {
            plan: plan.own ? 'own' : 'shared',
            status: plan.limitedAt ? 'limit-reached' : 'available',
            limitedAt: plan.limitedAt?.toISOString() ?? null,
            premiumRequests: (await counts.get(plan.connectionId)) ?? null,
          },
        } satisfies PlanModelChoice;
      }),
    );
  };
  /** The model choices of a plan with their usage status, and the Copilot premium requests left on one connection. */
  return Object.assign(choices, { premiumRequests });
}
