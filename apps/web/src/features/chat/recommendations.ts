import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { z } from 'zod';
import { recommendationListSchema } from '@tulipfarm/recommendations/contracts';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson } from '@/lib/http';
import { freshness, useFeatureRead } from '@/lib/query';
import { useFeatureContext } from '@/lib/query/provider';
import { onWindowReturn } from '@/lib/window-return';
import { createRecommendationStream } from './recommendation-stream';

const recommendationSchema = z.object({
  id: z.string(),
  kind: z.enum(['onboarding', 'prompt']),
  label: z.string(),
  brands: z.array(z.enum(['gmail', 'google-calendar', 'github', 'slack'])),
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('prompt'), prompt: z.string() }),
    z.object({
      kind: z.literal('open'),
      destination: z.enum(['integrations', 'files', 'members']),
      sourcePicker: z.enum(['github', 'slack', 'google']).optional(),
    }),
  ]),
});
const recommendationsSchema = z.object({ onboarding: z.boolean(), items: z.array(recommendationSchema) });
export type Recommendation = z.infer<typeof recommendationSchema>;
export type Recommendations = z.infer<typeof recommendationsSchema> &
  Partial<Pick<z.infer<typeof recommendationListSchema>, 'status' | 'version'>>;

export const recommendationKeys = { all: () => ['recommendations'] as const };
export const sourcePickerHash = {
  github: 'github-accounts',
  slack: 'slack-account',
  google: 'google-workspace',
} as const;

class RecommendationRequestError extends Error {
  constructor(readonly status: number) {
    super('recommendations-unavailable');
  }
}

async function loadRecommendations(workspaceId: string, signal: AbortSignal): Promise<Recommendations> {
  const response = await jsonResponse(`${apiOrigin}/v1/workspaces/${workspaceId}/recommendations`, {
    signal,
    cache: 'no-store',
  });
  if (!response.ok) throw new RecommendationRequestError(response.status);
  return recommendationListSchema.parse(await readJson(response));
}

/** Generic prompts that claim no integration or data, shown while loading or when the personalised list is unavailable. */
export const fallbackRecommendations: Recommendation[] = [
  {
    id: 'follow-ups',
    kind: 'prompt',
    label: 'Plan customer follow-ups',
    brands: [],
    action: {
      kind: 'prompt',
      prompt:
        'Help me plan customer follow-ups. Ask me about my customers and current process, then give me a short checklist with next actions. Do not send messages or change rows.',
    },
  },
  {
    id: 'support',
    kind: 'prompt',
    label: 'Draft a support reply',
    brands: [],
    action: {
      kind: 'prompt',
      prompt:
        'Help me draft a reply to a customer support request. Ask me to paste the request and our relevant policy, then write a draft for my review. Do not send it.',
    },
  },
  {
    id: 'week',
    kind: 'prompt',
    label: 'Plan my week',
    brands: [],
    action: {
      kind: 'prompt',
      prompt:
        'Help me plan my week. Ask about my priorities, deadlines, and meetings, then suggest a short plan with the most important tasks first.',
    },
  },
  {
    id: 'standup',
    kind: 'prompt',
    label: 'Prepare a daily team update',
    brands: [],
    action: {
      kind: 'prompt',
      prompt:
        'Help me prepare a short daily team update. Ask what the team finished, what is next, and what is blocked, then show me the draft. Do not post or send it.',
    },
  },
  {
    id: 'process',
    kind: 'prompt',
    label: 'Write down a business process',
    brands: [],
    action: {
      kind: 'prompt',
      prompt:
        'Help me write down one of my business processes. Ask me how it works step by step, then summarize it as a clear checklist.',
    },
  },
];

// Connecting an app usually happens in another tab or after an OAuth redirect, so a return to this window rechecks stale data.
export function useRecommendations(workspaceId: string) {
  const { runtime, scope, current } = useFeatureContext();
  const key = useMemo(() => [...recommendationKeys.all(), 'saved'], []);
  const read = useFeatureRead({
    key,
    load: signal => loadRecommendations(workspaceId, signal),
    staleTime: freshness.chat,
  });
  const stream = useMemo(
    () =>
      createRecommendationStream(
        `${apiOrigin}/v1/workspaces/${workspaceId}/recommendations/events`,
        { workspaceId, membershipId: scope.kind === 'workspace' ? scope.membershipId : '' },
        kind => {
          if (current()) void runtime.applyChange(scope, { kind, keys: [key] });
        },
      ),
    [workspaceId, runtime, scope, current, key],
  );
  const live = useSyncExternalStore(stream.subscribe, stream.snapshot, stream.snapshot);
  useEffect(() => {
    const sync = () => {
      if (document.visibilityState === 'hidden') {
        stream.stop();
        void runtime.applyChange(scope, { kind: 'conceal', keys: [key] });
      } else if (current()) stream.start();
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      stream.stop();
    };
  }, [stream, runtime, scope, current, key]);
  useEffect(
    () =>
      onWindowReturn(() => {
        stream.retry();
      }),
    [stream],
  );
  const state = read.state;
  const items =
    state.kind === 'ready' && live === 'open' && state.data.items.length ? state.data.items : fallbackRecommendations;
  const status =
    state.kind === 'ready' ? (state.data.status ?? 'ready') : state.kind === 'loading' ? 'loading' : 'unavailable';
  const failed = state.kind === 'error' || (state.kind === 'ready' && !!state.error);
  const messages = {
    loading: 'Loading saved recommendations.',
    pending: 'New recommendations are waiting for a background update.',
    running: 'Recommendations are updating in the background.',
    ready: null,
    failed: 'The background update failed. You can still use the prompts below.',
    'budget-paused': 'Background updates are paused at the platform spending limit.',
    unavailable: null,
  };
  return {
    items,
    message: failed
      ? 'Saved recommendations could not be loaded.'
      : live === 'unavailable'
        ? 'Live updates are not available. Reload the saved list to reconnect.'
        : live === 'connecting'
          ? 'Connecting to recommendation updates.'
          : messages[status],
    error: failed || live === 'unavailable',
    retry: () => {
      stream.retry();
      void read.refresh();
    },
    refreshing: state.kind === 'loading' || (state.kind === 'ready' && state.refreshing),
  };
}
