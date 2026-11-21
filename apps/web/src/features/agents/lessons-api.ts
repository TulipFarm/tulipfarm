import { useMemo } from 'react';
import { agentLessonsViewSchema, type AgentLessonsView } from '@tulipfarm/agents/agent-lesson-contracts';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { useFeatureRead } from '@/lib/query';
import { TableRequestError } from '@/features/tables/request-state';

export type AgentLessonsData = AgentLessonsView;
export type AgentLesson = AgentLessonsView['lessons'][number];
export type AgentSuggestion = AgentLessonsView['suggestions'][number];

const messages: Partial<Record<string, string>> = {
  'lesson-private':
    'Remove names, links, numbers and quotes. Everyone who runs this agent gets its lessons, so keep them general.',
  'lessons-unavailable': 'Lessons are unavailable right now. Try again in a moment.',
  'invalid-request': 'Write a lesson of up to 200 characters.',
};

export function lessonsApi(workspaceId: string, agentId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/lessons`;
  async function request(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
    const response = await jsonResponse(`${base}${path}`, {
      method,
      cache: 'no-store',
      signal: signal ?? AbortSignal.timeout(15000),
      body,
    });
    const value = await readJson(response);
    if (!response.ok) {
      const code = responseError(value, 'agent-operation-failed');
      throw new TableRequestError(
        response.status,
        code,
        messages[code] ??
          (response.status === 404
            ? 'This item was deleted, or you can no longer edit this agent. Reload the page to see the latest.'
            : "Your change wasn't saved. Try again."),
      );
    }
    return agentLessonsViewSchema.parse(value);
  }
  return {
    read: (signal: AbortSignal) => request('', 'GET', undefined, signal),
    edit: (lessonId: string, text: string) => request(`/${encodeURIComponent(lessonId)}`, 'PUT', { text }),
    remove: (lessonId: string) => request(`/${encodeURIComponent(lessonId)}`, 'DELETE'),
    clear: () => request('', 'DELETE'),
    dismiss: (suggestionId: string) => request(`/suggestions/${encodeURIComponent(suggestionId)}`, 'DELETE'),
  };
}
export type LessonsApi = ReturnType<typeof lessonsApi>;

export const lessonKeys = { all: (agentId: string) => ['agents', 'detail', agentId, 'lessons'] as const };

export function useLessonsApi(workspaceId: string, agentId: string) {
  return useMemo(() => lessonsApi(workspaceId, agentId), [workspaceId, agentId]);
}
export function useAgentLessons(api: LessonsApi, agentId: string, enabled: boolean) {
  return useFeatureRead({ key: lessonKeys.all(agentId), load: api.read, enabled });
}
