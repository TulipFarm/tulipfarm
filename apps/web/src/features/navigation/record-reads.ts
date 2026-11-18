import type { FeatureReadOptions } from '@/lib/query';
import { freshness } from '@/lib/query/policy';
import { agentApi } from '@/features/agents/api';
import { agentReads } from '@/features/agents/queries';
import { conversationApi } from '@/features/chat/conversation-api';
import { conversationKeys } from '@/features/chat/queries';
import { fileKeys, filesApi } from '@/features/files/api';
import { projectApi } from '@/features/projects/api';
import { projectKeys } from '@/features/projects/queries';
import { tableApi } from '@/features/tables/api';
import { tableQueries } from '@/features/tables/queries';
import { taskApi } from '@/features/tasks/api';
import { taskReads } from '@/features/tasks/queries';
import { workflowQueries } from '@/features/workflows/queries';

export type RecordSection = 'chat' | 'projects' | 'agents' | 'agent-tasks' | 'workflows' | 'tables' | 'files';

function apis(workspaceId: string) {
  return {
    agents: agentApi(workspaceId),
    chat: conversationApi(workspaceId, () => {}),
    files: filesApi(workspaceId),
    projects: projectApi(workspaceId),
    tables: tableApi(workspaceId),
    tasks: taskApi(workspaceId),
  };
}

let cached: { workspaceId: string; apis: ReturnType<typeof apis> } | undefined;

/** The first read each record page makes, so a link's intent can start it under the same key. */
export function recordRead(workspaceId: string, section: RecordSection, id: string): FeatureReadOptions<unknown> {
  if (cached?.workspaceId !== workspaceId) cached = { workspaceId, apis: apis(workspaceId) };
  const api = cached.apis;
  switch (section) {
    case 'chat':
      return {
        key: conversationKeys.history(id, 1),
        load: signal => api.chat.history(id, signal, 1),
        staleTime: freshness.chat,
      };
    case 'projects':
      return { key: projectKeys.detail(id), load: signal => api.projects.read(id, signal) };
    case 'agents':
      return agentReads.detail(api.agents, id);
    case 'agent-tasks':
      return taskReads.summary(api.tasks, id);
    case 'workflows':
      return workflowQueries.definition(workspaceId, id);
    case 'tables':
      return tableQueries.detail(api.tables, id);
    case 'files':
      return { key: fileKeys.item(id), load: signal => api.files.read(id, signal) };
  }
}
