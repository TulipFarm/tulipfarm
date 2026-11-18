import { useState } from 'react';
import { accountLabel, useOwnPlans } from '@/features/models/plan-accounts';
import type { PlanProvider } from '@/features/models/chatgpt-plan-api';

export type PlanAccountChoice = {
  options: { id: string; label: string }[];
  value: string | null;
  onChange: (id: string) => void;
};

const storageKey = (workspaceId: string, provider: PlanProvider) => `tulipfarm:plan-account:${workspaceId}:${provider}`;

function stored(workspaceId: string, provider: PlanProvider) {
  try {
    return window.localStorage.getItem(storageKey(workspaceId, provider));
  } catch {
    return null;
  }
}

/**
 * The member's own accounts of a plan model's provider that are on for chats, and the one a message tries first: the
 * last one picked here, else the first. Its other accounts on for chats, then shared plans, answer when it can't.
 */
export function usePlanAccount(workspaceId: string, plan: PlanProvider | undefined): PlanAccountChoice | undefined {
  const provider = plan ?? 'claude';
  const owns = useOwnPlans(workspaceId, provider, Boolean(plan));
  const [picked, setPicked] = useState<Partial<Record<PlanProvider, string>>>({});
  if (!plan) return undefined;
  const options = owns
    .filter(item => item.state === 'connected' && item.useForChat)
    .map(item => ({ id: item.connectionId, label: accountLabel(plan, item.account) }));
  const want = picked[plan] ?? stored(workspaceId, plan);
  return {
    options,
    value: options.find(option => option.id === want)?.id ?? options[0]?.id ?? null,
    onChange: id => {
      setPicked(current => ({ ...current, [plan]: id }));
      try {
        window.localStorage.setItem(storageKey(workspaceId, plan), id);
      } catch {
        /* The pick still applies until reload when storage is off. */
      }
    },
  };
}
