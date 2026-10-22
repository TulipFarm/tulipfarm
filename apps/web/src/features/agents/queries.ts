import { useMemo } from 'react';
import { useFeatureChanges, useFeatureRead, type QueryKey } from '@/lib/query';
import { useQueryClient } from '@tanstack/react-query';
import { featureKey, useFeatureScope } from '@/lib/query';
import { agentApi, type AgentCommand, type AgentContext, type AgentDetail } from './api';
import type { ReadState } from '@/features/tables/request-state';
import { TableRequestError } from '@/features/tables/request-state';

type Api = ReturnType<typeof agentApi>;
export const agentKeys = {
  all: ['agents'] as const,
  lists: ['agents', 'list'] as const,
  list: (after?: string, search = '') => ['agents', 'list', { after: after ?? null, search }] as const,
  context: ['agents', 'authoring-context'] as const,
  detail: (id: string) => ['agents', 'detail', id] as const,
  policy: (id: string) => ['agents', 'detail', id, 'policy'] as const,
  schedules: (id: string) => ['agents', 'detail', id, 'schedules'] as const,
  availability: (id: string) => ['agents', 'detail', id, 'chat-availability'] as const,
  turn: (id: string, turnId: string | null) => ['agents', 'detail', id, 'turn', turnId] as const,
  command: (id: string, commandId: string | null) => ['agents', 'commands', id, commandId] as const,
  slackDestinations: ['agents', 'slack-destinations'] as const,
  slackChannel: (channel: string) => ['agents', 'slack-channels', channel] as const,
};
export const agentReads = {
  list: (api: Api, after?: string, search = '') => ({
    key: agentKeys.list(after, search),
    load: (signal: AbortSignal) => api.list(signal, after, search),
  }),
  context: (api: Api) => ({ key: agentKeys.context, load: (signal: AbortSignal) => api.context(signal) }),
  detail: (api: Api, id: string) => ({
    key: agentKeys.detail(id),
    load: (signal: AbortSignal) => api.detail(id, signal),
  }),
  policy: (api: Api, id: string) => ({
    key: agentKeys.policy(id),
    load: (signal: AbortSignal) => api.policy(id, signal),
  }),
  schedules: (api: Api, id: string) => ({
    key: agentKeys.schedules(id),
    load: (signal: AbortSignal) => api.schedules(id, signal),
  }),
};
export function combineAgentReads<A, B, T>(a: ReadState<A>, b: ReadState<B>, combine: (a: A, b: B) => T): ReadState<T> {
  if (a.kind === 'unavailable') return a;
  if (b.kind === 'unavailable') return b;
  if (a.kind === 'error') return a;
  if (b.kind === 'error') return b;
  if (a.kind === 'loading' || b.kind === 'loading') return { kind: 'loading' };
  return {
    kind: 'ready',
    data: combine(a.data, b.data),
    refreshing: a.refreshing || b.refreshing,
    error: a.error ?? b.error,
  };
}
export function useAgents(api: Api, after?: string, search = '') {
  const page = useFeatureRead(agentReads.list(api, after, search));
  const context = useFeatureRead(agentReads.context(api));
  return {
    state: combineAgentReads(page.state, context.state, (page, context) => ({ page, context })),
    refresh: async () => {
      await Promise.all([page.refresh(), context.refresh()]);
    },
  };
}
export function useAgentDetail(api: Api, id: string, enabled = true) {
  return useFeatureRead({ ...agentReads.detail(api, id), enabled });
}
export function useAgentPage(api: Api, id: string, creating: boolean) {
  const context = useFeatureRead(agentReads.context(api));
  const detail = useAgentDetail(api, id, !creating);
  const selected: ReadState<AgentDetail | null> = creating
    ? { kind: 'ready', data: null, refreshing: false, error: null }
    : detail.state;
  const state: ReadState<{ context: AgentContext; detail: AgentDetail | null }> = combineAgentReads(
    context.state,
    selected,
    (context, detail) => ({ context, detail }),
  );
  return {
    state,
    refresh: async () => {
      await Promise.all([context.refresh(), detail.refresh()]);
    },
  };
}
export function useAgentPolicy(api: Api, id: string, enabled = true) {
  return useFeatureRead({ ...agentReads.policy(api, id), enabled });
}
export function useAgentSchedules(api: Api, id: string, enabled = true) {
  return useFeatureRead({ ...agentReads.schedules(api, id), enabled });
}
export function useAgentAvailability(api: Api, id: string, enabled = true) {
  return useFeatureRead({ key: agentKeys.availability(id), load: signal => api.chatAvailability(id, signal), enabled });
}
export function agentTurnPending(turn: Awaited<ReturnType<Api['turn']>>) {
  return ['pending', 'selecting', 'tool'].includes(turn.status);
}
export function useAgentTurn(api: Api, id: string, turnId: string | null, enabled: boolean) {
  const client = useQueryClient(),
    scope = useFeatureScope();
  const { change } = useFeatureChanges();
  const key = agentKeys.turn(id, turnId);
  return useFeatureRead({
    key,
    enabled: enabled && !!turnId,
    pollWhile: agentTurnPending,
    interval: 500,
    maxChecks: 120,
    load: async signal => {
      if (!turnId) throw new Error('No turn selected');
      const turn = await api.turn(id, turnId, signal);
      const previous = client.getQueryData<Awaited<ReturnType<Api['turn']>>>(featureKey(scope, key));
      if (
        !signal.aborted &&
        JSON.stringify([previous?.status, previous?.model, previous?.execution]) !==
          JSON.stringify([turn.status, turn.model, turn.execution])
      ) {
        void change({
          keys: [
            ['credits', 'balance'],
            ['credits', 'usage'],
            ...(turn.execution?.status === 'completed' ? [['tables']] : []),
          ],
        });
      }
      return turn;
    },
  });
}
export function useAgentCommand(api: Api, id: string, command: AgentCommand | null, enabled: boolean) {
  const changed = useAgentChanges();
  const client = useQueryClient(),
    scope = useFeatureScope();
  const key = agentKeys.command(id, command?.commandId ?? null);
  return useFeatureRead<AgentCommand>({
    key,
    enabled: enabled && !!command,
    pollWhile: value => value.status === 'preparing',
    load: async signal => {
      if (!command) throw new Error('No save selected');
      const value = await api.command(command.commandId, signal);
      if (
        !signal.aborted &&
        value.status === 'accepted' &&
        client.getQueryData<AgentCommand>(featureKey(scope, key))?.status !== 'accepted'
      )
        void changed(id);
      return value;
    },
  });
}
export function agentChangeKeys(id: string): readonly QueryKey[] {
  return [agentKeys.detail(id), agentKeys.lists, agentKeys.context, ['tasks'], ['conversations', 'list']];
}
export function useAgentChanges() {
  const { change } = useFeatureChanges();
  return useMemo(() => (id: string) => change({ keys: agentChangeKeys(id) }), [change]);
}
export function useAgentAccessChanges() {
  const { change } = useFeatureChanges();
  return useMemo(() => (keys: readonly QueryKey[]) => change({ kind: 'conceal', keys }), [change]);
}
export function useAgentApi(workspaceId: string) {
  const changed = useAgentChanges();
  const accessChanged = useAgentAccessChanges();
  const { change } = useFeatureChanges();
  return useMemo(() => {
    const api = agentApi(workspaceId);
    async function modelCommand<T>(work: Promise<T>) {
      try {
        return await work;
      } catch (error) {
        if (error instanceof TableRequestError && error.code === 'credits-exhausted')
          void change({ keys: [['credits', 'balance']] });
        if (error instanceof TableRequestError && error.code === 'model-family-unavailable')
          void change({ keys: [['models', 'catalog']] });
        throw error;
      }
    }
    async function saved<T>(id: string, work: Promise<T>) {
      const result = await work;
      void changed(id);
      return result;
    }
    async function permissions<T>(id: string, work: Promise<T>) {
      const result = await work;
      void accessChanged(agentChangeKeys(id));
      return result;
    }
    async function usage<T>(id: string, work: Promise<T>) {
      const result = await modelCommand(work);
      void change({ keys: [agentKeys.detail(id), ['credits', 'balance'], ['credits', 'usage']] });
      return result;
    }
    return {
      ...api,
      save: async (id: string, input: Parameters<Api['save']>[1]) => {
        const result = await modelCommand(api.save(id, input));
        if (result.status === 'accepted') void changed(id);
        return result;
      },
      updatePolicy: (id: string, input: Parameters<Api['updatePolicy']>[1]) =>
        permissions(id, api.updatePolicy(id, input)),
      configure: (id: string, input: Parameters<Api['configure']>[1]) => permissions(id, api.configure(id, input)),
      remove: (id: string) => permissions(id, api.remove(id)),
      activate: (id: string, input: Parameters<Api['activate']>[1]) => saved(id, api.activate(id, input)),
      activateInspection: (id: string, input: Parameters<Api['activateInspection']>[1]) =>
        saved(id, api.activateInspection(id, input)),
      revokeActivation: (id: string, activationId: string) => permissions(id, api.revokeActivation(id, activationId)),
      schedule: (id: string, input: Parameters<Api['schedule']>[1]) => saved(id, api.schedule(id, input)),
      revokeSchedule: (id: string, scheduleId: string) => saved(id, api.revokeSchedule(id, scheduleId)),
      chat: (id: string, input: Parameters<Api['chat']>[1]) => usage(id, api.chat(id, input)),
      retryModel: (id: string, turnId: string, input: Parameters<Api['retryModel']>[2]) =>
        usage(id, api.retryModel(id, turnId, input)),
    };
  }, [workspaceId, changed, change, accessChanged]);
}
