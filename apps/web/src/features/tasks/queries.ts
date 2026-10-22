import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { featureKey, useFeatureChanges, useFeatureRead, useFeatureScope, type QueryKey } from '@/lib/query';
import { TableRequestError, type ReadState } from '@/features/tables/request-state';
import { agentApi, type AgentDetail } from '@/features/agents/api';
import { useAgentDetail, combineAgentReads } from '@/features/agents/queries';
import { conversationApi } from '@/features/chat/conversation-api';
import { conversationKeys } from '@/features/chat/queries';
import { taskApi, type TaskSummary, type TaskProposal } from './api';

type Api = ReturnType<typeof taskApi>;
type Chats = ReturnType<typeof conversationApi>;
export const taskKeys = {
  all: ['tasks'] as const,
  lists: ['tasks', 'list'] as const,
  list: (after?: string, search = '') => ['tasks', 'list', { after: after ?? null, search }] as const,
  detail: (id: string) => ['tasks', 'detail', id] as const,
  summary: (id: string) => ['tasks', 'detail', id, 'summary'] as const,
  context: (id: string) => ['tasks', 'detail', id, 'context'] as const,
  history: (id: string, after = -1) => ['tasks', 'detail', id, 'history', { after }] as const,
  proposals: (id: string) => ['tasks', 'detail', id, 'proposals'] as const,
  proposalPage: (id: string, after?: string) =>
    ['tasks', 'detail', id, 'proposals', 'list', { after: after ?? null }] as const,
  proposal: (id: string, proposalId: string) => ['tasks', 'detail', id, 'proposals', 'detail', proposalId] as const,
  slack: (id: string) => ['tasks', 'detail', id, 'slack-actions'] as const,
  sources: ['tasks', 'sources'] as const,
  sourceTasks: (after?: string, exclude?: string) =>
    ['tasks', 'sources', 'tasks', { after: after ?? null, exclude: exclude ?? null }] as const,
  sourceChats: conversationKeys.list(false, '', 1, null),
  sourceFiles: (chatId: string) => [...conversationKeys.detail(chatId), 'source-files', { pages: 1 }] as const,
  attachment: conversationKeys.attachment,
};

export const taskReads = {
  list: (api: Api, after?: string, search = '') => ({
    key: taskKeys.list(after, search),
    load: (signal: AbortSignal) => api.list(signal, after, search),
  }),
  summary: (api: Api, id: string) => ({
    key: taskKeys.summary(id),
    load: (signal: AbortSignal) => api.read(id, signal),
  }),
  context: (api: Api, id: string) => ({
    key: taskKeys.context(id),
    load: (signal: AbortSignal) => api.context(id, signal),
  }),
  history: (api: Api, id: string, after = -1) => ({
    key: taskKeys.history(id, after),
    load: (signal: AbortSignal) => api.history(id, signal, after),
  }),
  proposals: (api: Api, id: string, after?: string) => ({
    key: taskKeys.proposalPage(id, after),
    load: (signal: AbortSignal) => api.proposals(id, signal, after),
  }),
  proposal: (api: Api, id: string, proposalId: string) => ({
    key: taskKeys.proposal(id, proposalId),
    load: (signal: AbortSignal) => api.proposal(id, proposalId, signal),
  }),
};

/** A task takes a new message once it stops working: an answer, a continuation, or a follow-up. */
export const taskAcceptsMessage = (status: TaskSummary['status']) =>
  ['waiting-clarification', 'paused', 'failed', 'completed'].includes(status);
const requestTitle = (messages: readonly { role: string; text: string }[]) => {
  const request =
    messages
      .find(message => message.role === 'owner')
      ?.text.replace(/\s+/g, ' ')
      .trim() ?? 'Private task';
  return request.length > 160 ? `${request.slice(0, 157)}…` : request;
};

/** The person's own tasks that take a message now, named by the request that started each. A task whose history became unreadable is left out. */
export function useTaskDestinations(api: Api, search: string) {
  return useFeatureRead({
    key: [...taskKeys.lists, 'destinations', { search }],
    staleTime: 0,
    load: async signal => {
      const page = await api.list(signal, undefined, search);
      const tasks = await Promise.all(
        page.tasks
          .filter(task => taskAcceptsMessage(task.status))
          .map(async task => {
            try {
              return {
                id: task.id,
                status: task.status,
                title: requestTitle((await api.history(task.id, signal)).messages),
              };
            } catch (error) {
              if (error instanceof TableRequestError && [403, 404].includes(error.status)) return null;
              throw error;
            }
          }),
      );
      return tasks.filter(task => task !== null);
    },
  });
}
export type TaskDestination = { id: string; status: TaskSummary['status']; title: string };

export function taskPending(task: TaskSummary) {
  return task.status !== 'completed' && task.status !== 'failed';
}
export function taskAccountingChanged(previous: TaskSummary | undefined, task: TaskSummary) {
  return (
    !previous ||
    previous.generation !== task.generation ||
    previous.status !== task.status ||
    previous.cost.chargedCreditUnits !== task.cost.chargedCreditUnits ||
    previous.cost.heldCreditUnits !== task.cost.heldCreditUnits
  );
}
const creditKeys = [
  ['credits', 'balance'],
  ['credits', 'usage'],
] as const;
export function taskChangeKeys(id: string): readonly QueryKey[] {
  return [taskKeys.detail(id), taskKeys.lists, taskKeys.sources, ...creditKeys];
}
export function useTasks(api: Api, after?: string, search = '') {
  const client = useQueryClient(),
    scope = useFeatureScope();
  const { change } = useFeatureChanges();
  const key = taskKeys.list(after, search);
  return useFeatureRead({
    ...taskReads.list(api, after, search),
    load: async signal => {
      const page = await api.list(signal, after, search);
      signal.throwIfAborted();
      const previous = client.getQueryData<Awaited<ReturnType<Api['list']>>>(featureKey(scope, key));
      if (
        page.tasks.some(task =>
          taskAccountingChanged(
            previous?.tasks.find(value => value.id === task.id),
            task,
          ),
        )
      )
        void change({ keys: creditKeys });
      return page;
    },
  });
}
export function useTaskDetail(api: Api, id: string) {
  const client = useQueryClient(),
    scope = useFeatureScope();
  const { change } = useFeatureChanges();
  return useFeatureRead({
    ...taskReads.summary(api, id),
    pollWhile: taskPending,
    interval: 500,
    maxChecks: 120,
    load: async signal => {
      const task = await api.read(id, signal);
      signal.throwIfAborted();
      const previous = client.getQueryData<TaskSummary>(featureKey(scope, taskKeys.summary(id)));
      if (taskAccountingChanged(previous, task))
        void change({
          keys: [
            ...(previous
              ? [
                  taskKeys.context(id),
                  taskKeys.history(id),
                  taskKeys.proposals(id),
                  taskKeys.slack(id),
                  taskKeys.lists,
                  taskKeys.sources,
                ]
              : []),
            ...creditKeys,
          ],
        });
      return task;
    },
  });
}
export function useTaskHistory(api: Api, id: string, task: TaskSummary) {
  return useFeatureRead({
    ...taskReads.context(api, id),
    pollWhile: () => ['pending', 'waiting-approval'].includes(task.status),
  });
}
export function useTaskIdentity(workspaceId: string, taskId: string, agentId: string) {
  const api = useTaskApi(workspaceId);
  const agents = useMemo(() => agentApi(workspaceId), [workspaceId]);
  const history = useFeatureRead(taskReads.history(api, taskId));
  const agent = useAgentDetail(agents, agentId);
  const agentState: ReadState<AgentDetail | null> =
    agent.state.kind === 'unavailable' && agent.state.status !== 401
      ? { kind: 'ready' as const, data: null, refreshing: false, error: null }
      : agent.state;
  return {
    state: combineAgentReads(history.state, agentState, (history, agent) => ({
      title: requestTitle(history.messages),
      agent: agent?.name ?? 'Agent no longer available',
    })),
    refresh: async () => {
      await Promise.all([history.refresh(), agent.refresh()]);
    },
  };
}
export function useTaskProposals(api: Api, id: string, after: string | undefined, running: boolean) {
  return useFeatureRead({ ...taskReads.proposals(api, id, after), pollWhile: () => running });
}
export function useTaskProposal(api: Api, id: string, proposalId: string) {
  const client = useQueryClient(),
    scope = useFeatureScope();
  const { change } = useFeatureChanges();
  const key = taskKeys.proposal(id, proposalId);
  return useFeatureRead<TaskProposal>({
    ...taskReads.proposal(api, id, proposalId),
    pollWhile: proposal =>
      proposal.status.decision === 'approve' &&
      !proposal.status.superseded &&
      proposal.status.actions.some(action => action.status === 'unattempted'),
    load: async signal => {
      const proposal = await api.proposal(id, proposalId, signal);
      signal.throwIfAborted();
      const previous = client.getQueryData<TaskProposal>(featureKey(scope, key));
      const completed = proposal.status.actions
        .filter(action => action.status === 'completed')
        .map(action => action.id)
        .sort()
        .join(',');
      const prior = previous?.status.actions
        .filter(action => action.status === 'completed')
        .map(action => action.id)
        .sort()
        .join(',');
      if (completed && completed !== prior)
        void change({ keys: [taskKeys.summary(id), taskKeys.context(id), taskKeys.lists, ['tables'], ...creditKeys] });
      return proposal;
    },
  });
}
export function useTaskSlackActions(api: ReturnType<typeof agentApi>, id: string) {
  return useFeatureRead({ key: taskKeys.slack(id), load: signal => api.slackTaskActions(id, signal) });
}
export function useTaskAttachment(api: Chats, chatId: string, id: string) {
  return useFeatureRead({ key: taskKeys.attachment(chatId, id), load: signal => api.attachment(chatId, id, signal) });
}
export function useTaskSources(api: Api, after: string | undefined, exclude: string | undefined, enabled: boolean) {
  return useFeatureRead({
    key: taskKeys.sourceTasks(after, exclude),
    enabled,
    load: async signal => {
      const page = await api.list(signal, after);
      const tasks = await Promise.all(
        page.tasks
          .filter(task => task.id !== exclude)
          .map(async task => {
            try {
              const history = await api.context(task.id, signal);
              return {
                kind: 'available' as const,
                id: task.id,
                title: history[0]?.text ?? 'Private task',
                sequence: history.at(-1)?.sequence ?? 0,
              };
            } catch (error) {
              if (error instanceof TableRequestError && [403, 404].includes(error.status))
                return { kind: 'unavailable' as const, id: task.id };
              throw error;
            }
          }),
      );
      return { tasks, nextCursor: page.nextCursor };
    },
  });
}
export function useTaskSourceChats(api: Chats, enabled: boolean) {
  return useFeatureRead({ key: taskKeys.sourceChats, enabled, load: signal => api.list(signal, false, '', 1) });
}
export function useTaskSourceFiles(api: Chats, chatId: string, enabled: boolean) {
  return useFeatureRead({
    key: taskKeys.sourceFiles(chatId),
    enabled: enabled && !!chatId,
    load: async signal => {
      const history = await api.history(chatId, signal, 1);
      const ids = [
        ...new Set(
          history.messages.flatMap(message =>
            message.parts.flatMap(part => (part.kind === 'attachment' ? [part.attachmentId] : [])),
          ),
        ),
      ];
      return Promise.all(ids.map(id => api.attachment(chatId, id, signal)));
    },
  });
}
export function useTaskApi(workspaceId: string) {
  const { change } = useFeatureChanges();
  return useMemo(() => {
    const api = taskApi(workspaceId);
    return {
      ...api,
      command: async (...args: Parameters<Api['command']>) => {
        try {
          const result = await api.command(...args);
          void change({ keys: taskChangeKeys(result.id) });
          return result;
        } catch (error) {
          if (error instanceof TableRequestError && error.code === 'credits-exhausted')
            void change({ keys: creditKeys });
          if (error instanceof TableRequestError && error.code === 'model-family-unavailable')
            void change({ keys: [['models', 'catalog']] });
          throw error;
        }
      },
      action: async (...args: Parameters<Api['action']>) => {
        const result = await api.action(...args);
        void change({ keys: [...taskChangeKeys(args[0]), ...(args[2].kind === 'execute' ? [['tables']] : [])] });
        return result;
      },
    };
  }, [workspaceId, change]);
}
