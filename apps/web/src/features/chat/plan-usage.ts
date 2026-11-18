import type { ModelCatalogFamily } from '@tulipfarm/config/model-catalog';
import type { PlanProvider } from '@/features/models/chatgpt-plan-api';
import { planLabels, planUsageUrls } from './reply-failure-copy.ts';

export type PlanUsage = NonNullable<ModelCatalogFamily['planUsage']>;

/** A short "5 min ago" for when a plan last reached its limit. */
export function timeAgo(at: string, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/**
 * What a plan model's selector entry and the composer say about its plan's usage. `warning` marks a plan that reached
 * its limit; the model stays selectable, and its replies fall back when the plan still refuses.
 */
export function planUsageStatus(plan: PlanProvider, usage: PlanUsage, now = Date.now()) {
  const own = usage.plan === 'own';
  const premium = usage.premiumRequests;
  const limited = usage.status === 'limit-reached' && usage.limitedAt !== null;
  const status = limited
    ? `Limit reached · ${timeAgo(usage.limitedAt!, now)}`
    : premium
      ? `${premium.remaining.toLocaleString()} of ${premium.entitlement.toLocaleString()} premium requests left`
      : 'Available';
  return {
    plan: `${own ? 'Your' : 'The'} ${planLabels[plan]} plan`,
    status,
    warning: limited || premium?.remaining === 0,
    manageUrl: planUsageUrls[plan],
  };
}
