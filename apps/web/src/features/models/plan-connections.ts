import { useMemo } from 'react';
import { useFeatureRead } from '@/lib/query';
import { chatGptPlanApi } from './chatgpt-plan-api';
import { tokenPlanApi, type TokenPlanProvider } from './token-plan-api';

export const chatGptConnectionKey = ['models', 'chatgpt-connection'] as const;
export const tokenConnectionKey = (provider: TokenPlanProvider) => ['models', `${provider}-connection`] as const;

/** The member's own ChatGPT connections, or null when this server doesn't offer ChatGPT plans. */
export function useChatGptConnection(workspaceId: string, enabled = true) {
  const api = useMemo(() => chatGptPlanApi(workspaceId), [workspaceId]);
  return useFeatureRead({ key: chatGptConnectionKey, enabled, load: api.connection });
}

/** The member's own Claude or Copilot connections, or null when this server doesn't offer that plan. */
export function useTokenConnection(workspaceId: string, provider: TokenPlanProvider, enabled = true) {
  const api = useMemo(() => tokenPlanApi(workspaceId, provider), [workspaceId, provider]);
  return useFeatureRead({ key: tokenConnectionKey(provider), enabled, load: api.connection });
}
