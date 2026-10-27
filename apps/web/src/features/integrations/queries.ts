import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  calendarEventOverlaps,
  parseCalendarRead,
  type CalendarEvent,
} from '@tulipfarm/google-workspace/calendar-events';
import { readUpcomingCalendar } from './calendar-read';
import { useIsFetching } from '@tanstack/react-query';
import { useFeatureRead, useFeatureChanges, featureKey } from '@/lib/query';
import type { ReadIssue } from '@tulipfarm/integrations/contracts';
import { useProviderAuthority } from './query-authority';
import { integrationsApi } from '@/lib/integrations';
import { githubApi } from '@/lib/github';
import {
  googleApi,
  loadGoogleIntegration,
  googleAccessLost,
  GoogleRequestError,
  type GoogleProposal,
} from '@/lib/google-workspace';
import { atlassianApi } from '@/lib/atlassian';
import { loadOwnMembership } from '@/lib/governance';
import { listWorkspaces } from '@/lib/workspaces';
import { loadSlackStatus } from './slack';
import { z } from 'zod';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, requestSignal } from '@/lib/http';
import { IntegrationRequestError } from '@/lib/integrations';
import type { agentApi } from '@/features/agents/api';
import { useFeatureContext } from '@/lib/query/provider';
import { featureReadOptions, freshness, type QueryKey } from '@/lib/query';
import { conversationKeys } from '@/features/chat/queries';
import { recommendationKeys } from '@/features/chat/recommendations';
import { onWindowReturn } from '@/lib/window-return';

function useReadResult<T>(read: ReturnType<typeof useFeatureRead<T>>, key: QueryKey) {
  const { runtime, scope, current } = useFeatureContext();
  const fetching = useIsFetching({ queryKey: featureKey(scope, key), exact: true }) > 0;
  return {
    ...read,
    data: read.state.kind === 'ready' ? read.state.data : null,
    busy: fetching || read.state.kind === 'loading',
    error:
      read.state.kind === 'ready'
        ? read.state.error
        : read.state.kind === 'loading'
          ? null
          : read.state.kind === 'error'
            ? read.state.message
            : 'Current access is unavailable.',
    refresh: async () => {
      await runtime.client.cancelQueries({ queryKey: featureKey(scope, key), exact: true });
      await read.refresh();
      const result = runtime.client.getQueryState<T>(featureKey(scope, key));
      return current() && !result?.error ? (result?.data ?? null) : null;
    },
  };
}

export type IntegrationProvider = 'github' | 'github-personal' | 'google' | 'atlassian' | 'slack';
export const integrationKeys = {
  provider: (provider: IntegrationProvider) => ['integrations', provider] as const,
  authority: (provider: IntegrationProvider) => ['integrations', provider, 'authority'] as const,
  accounts: (provider: IntegrationProvider) => ['integrations', provider, 'accounts'] as const,
  content: (provider: IntegrationProvider) => ['integrations', provider, 'content'] as const,
  detail: (id: string) => ['integrations', 'github', 'detail', id] as const,
  creation: () => ['integrations', 'github', 'creation'] as const,
  grants: (teamId: string) => ['integrations', 'github', 'creation-grants', teamId] as const,
  administration: () => ['integrations', 'administration'] as const,
  selection: (chatId: string, task = false) =>
    ['integrations', 'github-personal', 'content', 'selection', ...(task ? ['task'] : []), chatId] as const,
  investigation: (id: string, task = false) =>
    ['integrations', 'github', 'content', 'investigation', task ? 'task' : 'chat', id] as const,
  investigationAuthority: (id: string, task = false) =>
    ['integrations', 'github', 'investigation-authority', task ? 'task' : 'chat', id] as const,
  selectionAuthority: (chatId: string, task = false) =>
    ['integrations', 'github-personal', 'selection-authority', ...(task ? ['task'] : []), chatId] as const,
  batches: (chatId: string, task = false) =>
    ['integrations', 'github-personal', 'content', 'batches', ...(task ? ['task'] : []), chatId] as const,
  proposals: (cursor: string | null) => ['integrations', 'google', 'content', 'proposals', { cursor }] as const,
  proposal: (id: string) => ['integrations', 'google', 'content', 'proposal', id] as const,
  heartbeat: () => ['integrations', 'google', 'content', 'heartbeat'] as const,
  results: (cursor: string | null) => ['integrations', 'google', 'content', 'results', { cursor }] as const,
  sources: () => ['integrations', 'atlassian', 'sources'] as const,
  accountGrants: (id: string) => ['integrations', 'atlassian', 'grants', id] as const,
  atlassianProposal: (id: string) => ['integrations', 'atlassian', 'content', 'proposal', id] as const,
  operation: (input: Parameters<typeof atlassianApi.read>[1] | null) =>
    ['integrations', 'atlassian', 'content', 'read', input] as const,
  catalog: (id: string | null) => ['integrations', 'atlassian', 'content', 'catalog', id] as const,
  issue: (input: ReadIssue) => ['integrations', 'github', 'content', 'issue', input] as const,
  slackAction: (id: string) => ['integrations', 'slack', 'content', 'action', id] as const,
  slackLink: (workspaceId: string, id: string) => ['integrations', 'slack', 'link', workspaceId, id] as const,
  navigation: (id: string | undefined) => ['integrations', 'navigation', id ?? null] as const,
};

function dependentKeys(provider: IntegrationProvider): readonly QueryKey[] {
  return [
    integrationKeys.content(provider),
    ...(provider === 'github' ? [['integrations', 'github', 'detail']] : []),
    ...(provider === 'google' ? [['knowledge']] : []),
    ['conversations'],
    ['tasks'],
    ['workspace-mcp', 'actions'],
  ];
}

function useIntegrationAuthority(provider: IntegrationProvider) {
  useProviderAuthority(
    integrationKeys.authority(provider),
    [integrationKeys.accounts(provider), ...(provider === 'atlassian' ? [integrationKeys.sources()] : [])],
    dependentKeys(provider),
  );
}

export function useIntegrationChanges() {
  const { change } = useFeatureChanges();
  const { runtime, scope } = useFeatureContext();
  return useMemo(
    () => ({
      atlassianAccounts: async () => {
        if (!runtime.isCurrent(scope)) return;
        await change({
          kind: 'conceal',
          keys: [
            integrationKeys.content('atlassian'),
            integrationKeys.sources(),
            ['conversations'],
            ['tasks'],
            ['workspace-mcp', 'actions'],
          ],
        });
        await change({ keys: [integrationKeys.accounts('atlassian')] });
      },
      authority: (provider: IntegrationProvider) => {
        if (!runtime.isCurrent(scope)) return Promise.resolve();
        return Promise.all([
          change({
            kind: 'conceal',
            keys: [
              integrationKeys.provider(provider),
              ...(provider === 'google' ? [['knowledge']] : []),
              ['conversations'],
              ['tasks'],
              ['workspace-mcp', 'actions'],
            ],
          }),
          change({ keys: [recommendationKeys.all()] }),
        ]).then(() => undefined);
      },
      content: (provider: IntegrationProvider) =>
        change({ keys: [integrationKeys.content(provider), ['conversations'], ['tasks']] }),
      selection: (chatId: string, task = false) => {
        if (!runtime.isCurrent(scope)) return Promise.resolve();
        const dependents = [task ? ['tasks'] : conversationKeys.detail(chatId), integrationKeys.batches(chatId, task)];
        return change({
          kind: 'conceal',
          keys: [
            integrationKeys.selectionAuthority(chatId, task),
            integrationKeys.investigationAuthority(chatId, task),
            integrationKeys.selection(chatId, task),
            integrationKeys.investigation(chatId, task),
            ...dependents,
          ],
        });
      },
      creation: () => change({ keys: [integrationKeys.creation(), ['integrations', 'github', 'creation-grants']] }),
      batches: (chatId: string, task = false) => change({ keys: [integrationKeys.batches(chatId, task)] }),
    }),
    [change, runtime, scope],
  );
}

export const slackLinkStatusSchema = z.object({
  state: z.enum(['unlinked', 'consent-required', 'reconnect-required', 'dispatch-held', 'cancelled']),
  execution: z.enum(['disabled', 'pending', 'sending', 'retry', 'sent', 'unknown', 'blocked']),
});
export function useSlackLink(workspaceId: string, eventId: string) {
  return useFeatureRead({
    key: integrationKeys.slackLink(workspaceId, eventId),
    load: async signal => {
      const response = await jsonResponse(`${apiOrigin}/v1/workspaces/${workspaceId}/slack/link/${eventId}`, {
        signal: requestSignal(signal),
        cache: 'no-store',
      });
      if (!response.ok) throw new IntegrationRequestError(response.status);
      return slackLinkStatusSchema.parse(await readJson(response));
    },
  });
}

export function useIntegrationCallbackChanges() {
  const { change } = useFeatureChanges();
  return useCallback(
    async (workspaceId: string, provider: IntegrationProvider) => {
      const membership = await loadOwnMembership(workspaceId, AbortSignal.timeout(15000));
      const prefix = ['workspace', workspaceId, 'membership', membership.membershipId];
      await change({
        kind: 'conceal',
        keys: [
          integrationKeys.provider(provider),
          ...(provider === 'google' ? [['knowledge']] : []),
          ['conversations'],
          ['tasks'],
          ['workspace-mcp', 'actions'],
        ].map(key => [...prefix, ...key]),
      });
      await change({ keys: [[...prefix, ...recommendationKeys.all()]] });
    },
    [change],
  );
}

export function useAtlassianRecovery(workspaceId: string) {
  const { runtime, scope, current } = useFeatureContext();
  return useCallback(
    (id: string) =>
      runtime.client.fetchQuery(
        featureReadOptions(
          runtime,
          scope,
          {
            key: integrationKeys.atlassianProposal(id),
            staleTime: 0,
            load: signal => atlassianApi.proposal(workspaceId, id, signal),
          },
          current,
        ),
      ),
    [runtime, scope, current, workspaceId],
  );
}

export function useAtlassianOperation(workspaceId: string, input: Parameters<typeof atlassianApi.read>[1] | null) {
  useIntegrationAuthority('atlassian');
  return useFeatureRead({
    key: integrationKeys.operation(input),
    enabled: input !== null,
    load: signal =>
      input ? atlassianApi.read(workspaceId, input, signal) : Promise.reject(new Error('Select an operation')),
  });
}

export function useCalendarActionEvent(workspaceId: string, proposal: GoogleProposal, eventId: string) {
  useIntegrationAuthority('google');
  const key = [
    'integrations',
    'google',
    'content',
    'calendar-event',
    proposal.id,
    proposal.integration,
    eventId,
  ] as const;
  return useReadResult(
    useFeatureRead({
      key,
      load: async signal => {
        const operation = {
          kind: 'calendar.events.get' as const,
          calendarId: 'calendarId' in proposal.operation ? proposal.operation.calendarId : 'primary',
          eventId,
        };
        const { integrationId, accountId, generation, scopes } = proposal.integration;
        const response = await googleApi.read(
          workspaceId,
          { operation, expectedIntegration: { integrationId, accountId, generation, scopes } },
          signal,
        );
        return parseCalendarRead(operation, response.data);
      },
    }),
    key,
  );
}
export function useAtlassianCatalog(workspaceId: string, sourceId: string | null) {
  useIntegrationAuthority('atlassian');
  return useFeatureRead({
    key: integrationKeys.catalog(sourceId),
    enabled: sourceId !== null,
    load: signal =>
      sourceId ? atlassianApi.discover(workspaceId, sourceId, signal) : Promise.reject(new Error('Select a source')),
  });
}

export function useManagedIntegrations(workspaceId: string, enabled = true) {
  useIntegrationAuthority('github');
  return useFeatureRead({
    key: integrationKeys.accounts('github'),
    enabled,
    load: signal => integrationsApi.list(workspaceId, signal),
  });
}
export function useIntegrationDetail(workspaceId: string, id: string, enabled = true) {
  useIntegrationAuthority('github');
  const key = integrationKeys.detail(id);
  return useReadResult(
    useFeatureRead({ key, load: signal => integrationsApi.get(workspaceId, id, signal), enabled }),
    key,
  );
}
export function useIntegrationCreation(workspaceId: string) {
  return useFeatureRead({
    key: integrationKeys.creation(),
    load: signal => integrationsApi.creationContext(workspaceId, signal),
  });
}
export function useIntegrationGrants(workspaceId: string, teamId: string) {
  const key = integrationKeys.grants(teamId);
  return useReadResult(
    useFeatureRead({ key, load: signal => integrationsApi.creationGrants(workspaceId, teamId, signal) }),
    key,
  );
}
export function useIntegrationAdministration(workspaceId: string) {
  return useFeatureRead({
    key: integrationKeys.administration(),
    load: signal => integrationsApi.collaborators(workspaceId, signal),
  });
}
export function useGitHubAccounts(workspaceId: string, enabled = true) {
  useIntegrationAuthority('github-personal');
  return useFeatureRead({
    key: integrationKeys.accounts('github-personal'),
    enabled,
    load: signal => githubApi.list(workspaceId, signal),
  });
}
export function useGitHubInvestigation(workspaceId: string, id: string, task = false) {
  useIntegrationAuthority('github');
  useIntegrationAuthority('github-personal');
  useProviderAuthority(
    integrationKeys.investigationAuthority(id, task),
    [integrationKeys.investigation(id, task)],
    [task ? ['tasks'] : conversationKeys.detail(id)],
  );
  return useFeatureRead({
    key: integrationKeys.investigation(id, task),
    load: signal => githubApi.investigation(workspaceId, id, task, signal),
  });
}
export function useGitHubSelection(workspaceId: string, chatId: string, task = false) {
  useIntegrationAuthority('github-personal');
  useProviderAuthority(
    integrationKeys.selectionAuthority(chatId, task),
    [integrationKeys.selection(chatId, task)],
    [task ? ['tasks'] : conversationKeys.detail(chatId), integrationKeys.batches(chatId, task)],
  );
  return useFeatureRead({
    key: integrationKeys.selection(chatId, task),
    load: signal => (task ? githubApi.taskSelection : githubApi.selection)(workspaceId, chatId, signal),
  });
}
export function useGitHubBatches(workspaceId: string, chatId: string, task = false) {
  useIntegrationAuthority('github-personal');
  const key = integrationKeys.batches(chatId, task);
  return useReadResult(
    useFeatureRead({
      key,
      load: signal => (task ? githubApi.taskBatches : githubApi.batches)(workspaceId, chatId, signal),
    }),
    key,
  );
}
export function useGoogleIntegration(workspaceId: string, enabled = true) {
  useIntegrationAuthority('google');
  const key = integrationKeys.accounts('google');
  return useReadResult(
    useFeatureRead({ key, enabled, load: signal => loadGoogleIntegration(workspaceId, signal) }),
    key,
  );
}

type GoogleIntegration = Awaited<ReturnType<typeof loadGoogleIntegration>>;
function calendarBinding(integration: GoogleIntegration | null | undefined) {
  const status = integration?.status;
  return status?.status === 'connected'
    ? {
        integrationId: status.integrationId,
        accountId: status.accountId,
        generation: status.generation,
        scopes: status.scopes,
      }
    : null;
}
const upcomingStaleTime = 30_000;
const upcomingKey = (binding: ReturnType<typeof calendarBinding>) => [
  ...integrationKeys.content('google'),
  'upcoming',
  binding,
];
type UpcomingMeetingsState =
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'error'; retry: () => void }
  | { kind: 'ready'; events: CalendarEvent[]; refreshing: boolean; failed: boolean; retry: () => void };
export function useUpcomingMeetings(workspaceId: string): UpcomingMeetingsState {
  const integration = useGoogleIntegration(workspaceId);
  const binding = calendarBinding(integration.data);
  const [now, setNow] = useState(Date.now);
  const read = useFeatureRead({
    key: upcomingKey(binding),
    enabled: binding !== null,
    load: signal =>
      googleRead(() =>
        readUpcomingCalendar(async (operation, signal) => {
          if (!binding) throw new GoogleRequestError(403, 'integration-required');
          return (await googleApi.read(workspaceId, { operation, expectedIntegration: binding }, signal)).data;
        }, signal),
      ),
    staleTime: upcomingStaleTime,
  });
  const latest = useRef({ integration, read });
  latest.current = { integration, read };
  const retry = () => {
    void latest.current.integration.refresh().then(() => latest.current.read.refresh());
  };
  const nextEnd =
    read.state.kind === 'ready'
      ? Math.min(
          ...read.state.data.events.flatMap(event =>
            event.time.kind === 'timed' && Date.parse(event.time.endsAt) > now ? [Date.parse(event.time.endsAt)] : [],
          ),
        )
      : Infinity;
  useEffect(() => {
    const tick = () => {
      setNow(Date.now());
      const state = latest.current.read.state;
      if (document.visibilityState === 'visible' && navigator.onLine && state.kind === 'ready' && !state.error)
        void latest.current.read.refresh();
    };
    const timer = setTimeout(tick, Math.max(1, Math.min(60_000, nextEnd - Date.now())));
    return () => {
      clearTimeout(timer);
    };
  }, [now, nextEnd]);
  const { runtime, scope } = useFeatureContext();
  useEffect(
    () =>
      onWindowReturn(() => {
        setNow(Date.now());
        // Compare times directly: observers update their stale flag with timers, which background tabs throttle.
        const refetchStale = (key: QueryKey, staleTime: number) =>
          runtime.client.refetchQueries(
            {
              queryKey: featureKey(scope, key),
              exact: true,
              type: 'active',
              predicate: query => query.isStaleByTime(staleTime),
            },
            { cancelRefetch: false },
          );
        const integrationKey = integrationKeys.accounts('google');
        // Read the binding from the refetched integration: the last render may still hold a replaced account.
        void refetchStale(integrationKey, freshness.ordinary).then(() =>
          refetchStale(
            upcomingKey(
              calendarBinding(runtime.client.getQueryData<GoogleIntegration>(featureKey(scope, integrationKey))),
            ),
            upcomingStaleTime,
          ),
        );
      }),
    [runtime, scope],
  );
  // Render nothing until Google is known to be connected, so a disconnected workspace never flashes the section.
  if (!binding) return { kind: 'hidden' };
  if (integration.state.kind === 'error' || integration.error) return { kind: 'error', retry };
  if (read.state.kind === 'loading') return { kind: 'loading' };
  if (read.state.kind === 'unavailable') return { kind: 'hidden' };
  if (read.state.kind === 'error') return { kind: 'error', retry };
  const data = read.state.data;
  const events = data.events.filter(event =>
    calendarEventOverlaps(event, now, now + 12 * 60 * 60 * 1000, data.calendarTimeZone),
  );
  if (!events.length) return read.state.error ? { kind: 'error', retry } : { kind: 'hidden' };
  return { kind: 'ready', events, refreshing: read.state.refreshing, failed: !!read.state.error, retry };
}
async function googleRead<T>(load: () => Promise<T>) {
  try {
    return await load();
  } catch (error) {
    if (googleAccessLost(error) && error instanceof GoogleRequestError && ![401, 403, 404].includes(error.status))
      throw new GoogleRequestError(403, error.code);
    throw error;
  }
}
export function useGoogleProposals(workspaceId: string, cursor: string | null = null) {
  useIntegrationAuthority('google');
  const key = integrationKeys.proposals(cursor);
  return useReadResult(
    useFeatureRead({ key, load: signal => googleRead(() => googleApi.proposals(workspaceId, cursor, signal)) }),
    key,
  );
}
export function useGoogleProposal(workspaceId: string, id: string) {
  useIntegrationAuthority('google');
  const key = integrationKeys.proposal(id);
  return useReadResult(
    useFeatureRead({ key, load: signal => googleRead(() => googleApi.proposal(workspaceId, id, signal)) }),
    key,
  );
}
export function useGoogleHeartbeat(workspaceId: string) {
  useIntegrationAuthority('google');
  const key = integrationKeys.heartbeat();
  return useReadResult(
    useFeatureRead({ key, load: signal => googleRead(() => googleApi.heartbeat(workspaceId, signal)) }),
    key,
  );
}
export function useGoogleResults(workspaceId: string, cursor: string | null) {
  useIntegrationAuthority('google');
  const key = integrationKeys.results(cursor);
  return useReadResult(
    useFeatureRead({ key, load: signal => googleRead(() => googleApi.results(workspaceId, cursor, signal)) }),
    key,
  );
}
export function useAtlassianAccounts(workspaceId: string, enabled = true) {
  useIntegrationAuthority('atlassian');
  return useFeatureRead({
    key: integrationKeys.accounts('atlassian'),
    enabled,
    load: signal => atlassianApi.accounts(workspaceId, signal),
  });
}
export function useAtlassianSources(workspaceId: string) {
  useIntegrationAuthority('atlassian');
  return useFeatureRead({ key: integrationKeys.sources(), load: signal => atlassianApi.sources(workspaceId, signal) });
}
export function useAtlassianGrants(workspaceId: string, id: string, enabled: boolean) {
  const key = integrationKeys.accountGrants(id);
  return useReadResult(
    useFeatureRead({ key, load: signal => atlassianApi.grants(workspaceId, id, signal), enabled }),
    key,
  );
}
export function useAtlassianProposal(workspaceId: string, id: string, enabled: boolean) {
  useIntegrationAuthority('atlassian');
  const key = integrationKeys.atlassianProposal(id);
  return useReadResult(
    useFeatureRead({ key, load: signal => atlassianApi.proposal(workspaceId, id, signal), enabled }),
    key,
  );
}
export function useSlackIntegration(workspaceId: string, enabled = true) {
  useIntegrationAuthority('slack');
  return useFeatureRead({
    key: integrationKeys.accounts('slack'),
    enabled,
    load: signal => loadSlackStatus(workspaceId, signal),
  });
}
export function useSlackAction(api: Pick<ReturnType<typeof agentApi>, 'slackAction'>, id: string) {
  useIntegrationAuthority('slack');
  const key = integrationKeys.slackAction(id);
  return useReadResult(useFeatureRead({ key, load: signal => api.slackAction(id, signal) }), key);
}
export function useIntegrationWorkspace(workspaceId: string | undefined) {
  const key = integrationKeys.navigation(workspaceId);
  return useReadResult(
    useFeatureRead({
      key,
      load: async () =>
        workspaceId ? ((await listWorkspaces()).find(workspace => workspace.id === workspaceId) ?? null) : null,
    }),
    key,
  );
}

// Explicit recovery reads share the same cache and transport as mounted readers.
export function useIntegrationRecovery() {
  const { runtime, scope, current } = useFeatureContext();
  return useCallback(
    async (workspaceId: string, id: string) => {
      return runtime.client.fetchQuery(
        featureReadOptions(
          runtime,
          scope,
          {
            key: integrationKeys.detail(id),
            staleTime: 0,
            load: signal => integrationsApi.get(workspaceId, id, signal),
          },
          current,
        ),
      );
    },
    [runtime, scope, current],
  );
}

export function useIntegrationIssue(workspaceId: string) {
  const { runtime, scope, current } = useFeatureContext();
  return useCallback(
    (input: ReadIssue, signal: AbortSignal) =>
      runtime.client.fetchQuery({
        ...featureReadOptions(
          runtime,
          scope,
          {
            key: integrationKeys.issue(input),
            staleTime: 0,
            load: querySignal => integrationsApi.readIssue(workspaceId, input, AbortSignal.any([signal, querySignal])),
          },
          current,
        ),
        retry: false,
      }),
    [runtime, scope, current, workspaceId],
  );
}
