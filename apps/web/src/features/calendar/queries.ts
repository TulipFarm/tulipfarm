import { useFeatureRead } from '@/lib/query';
import { integrationKeys, useGoogleIntegration } from '@/features/integrations/queries';
import { googleAppScopes } from '@tulipfarm/google-workspace/public-contracts';
import { calendarApi, readGoogleCalendar } from './api';
import type { CalendarItem } from './model';

export function useCalendarSources(
  workspaceId: string,
  slug: string,
  range: { from: string; to: string },
  taskCursor: string | null,
) {
  const integration = useGoogleIntegration(workspaceId);
  const status = integration.data?.status;
  const connected = status?.status === 'connected' && status.scopes.includes(googleAppScopes.calendar[0]);
  const google = useFeatureRead({
    key: [...integrationKeys.content('google'), 'calendar', range, status],
    enabled: connected === true,
    staleTime: 30000,
    load: (signal: AbortSignal) => {
      if (!status) throw new Error('Google integration unavailable');
      return readGoogleCalendar(workspaceId, status, range, signal);
    },
  });
  const workflows = useFeatureRead({
    key: ['workflows', 'calendar', range],
    load: (signal: AbortSignal) => calendarApi.workflows(workspaceId, range, signal),
    staleTime: 30000,
  });
  const tasks = useFeatureRead({
    key: ['tasks', 'calendar', taskCursor],
    load: (signal: AbortSignal) => calendarApi.tasks(workspaceId, taskCursor, signal),
    staleTime: 30000,
  });
  const items: CalendarItem[] = connected && google.state.kind === 'ready' ? [...google.state.data.items] : [];
  if (workflows.state.kind === 'ready')
    for (const workflow of workflows.state.data.workflows) {
      for (const occurrence of workflow.occurrences)
        items.push({
          id: `workflow:${workflow.id}:${occurrence.runId ?? occurrence.at}`,
          title: workflow.name,
          kind: 'workflow',
          source: 'TulipFarm',
          sourceId: 'workflows',
          status: occurrence.status,
          time: { kind: 'point', at: occurrence.at },
          busy: false,
          href: `/${encodeURIComponent(slug)}/workflows/${workflow.id}${occurrence.runId ? `?view=runs&run=${occurrence.runId}` : ''}`,
          tags: [workflow.personal ? 'My workflow' : 'Following', 'Does not block time'],
        });
    }
  return {
    integration,
    connected,
    google,
    workflows,
    tasks,
    items,
    refresh: async () => {
      await Promise.all([integration.refresh(), google.refresh(), workflows.refresh(), tasks.refresh()]);
    },
  };
}
