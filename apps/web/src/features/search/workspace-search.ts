import { useEffect, useMemo, useRef, useState } from 'react';
import { agentApi } from '@/features/agents/api';
import { appApi, type AppSummary } from '@/features/apps/api';
import { chatListReads, conversationRequest } from '@/features/chat/chat-list-api';
import { filesApi } from '@/features/files/api';
import { tableApi } from '@/features/tables/api';
import { TableRequestError } from '@/features/tables/request-state';
import { workflowQueries } from '@/features/workflows/queries';
import { requestSignal } from '@/lib/http';
import {
  loadStoredRecents,
  matchesWords,
  saveStoredRecents,
  type ContentCategory,
  type SearchCategory,
  type SearchPath,
  type SearchTarget,
  type StoredRecentEntry,
} from './recent-storage';

export {
  loadStoredRecents,
  saveStoredRecents,
  type ContentCategory,
  type SearchCategory,
  type SearchPath,
  type SearchTarget,
  type StoredRecentEntry,
};

export type WorkspaceSearchResult = {
  id: string;
  category: ContentCategory;
  title: string;
  meta?: string | undefined;
  detail?: string | undefined;
  target: SearchTarget;
  folder?: boolean;
};

type CachedWorkflow = { id: string; name: string; enabled: boolean; summary: string };

export type WorkspaceSearchState = {
  recentChats: WorkspaceSearchResult[];
  chats: WorkspaceSearchResult[];
  agents: WorkspaceSearchResult[];
  tables: WorkspaceSearchResult[];
  workflows: WorkspaceSearchResult[];
  apps: WorkspaceSearchResult[];
  files: WorkspaceSearchResult[];
  searching: boolean;
  partialFailure: boolean;
};

const emptyState: WorkspaceSearchState = {
  recentChats: [],
  chats: [],
  agents: [],
  tables: [],
  workflows: [],
  apps: [],
  files: [],
  searching: false,
  partialFailure: false,
};

function formatRelativeTime(iso: string): string | undefined {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return undefined;
  const diffSeconds = Math.round((Date.now() - parsed) / 1000);
  if (diffSeconds < 60) return 'Just now';
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(parsed).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatRowCount(count: string): string {
  const numeric = Number(count);
  if (Number.isNaN(numeric)) return `${count} rows`;
  return `${numeric.toLocaleString()} ${numeric === 1 ? 'row' : 'rows'}`;
}

function mapWorkflowResult(workflow: CachedWorkflow): WorkspaceSearchResult {
  return {
    id: `workflow-${workflow.id}`,
    category: 'workflows',
    title: workflow.name,
    meta: workflow.enabled ? 'Enabled' : 'Paused',
    detail: workflow.summary || undefined,
    target: { kind: 'workflow', workflowId: workflow.id },
  };
}

function mapAppResult(app: AppSummary): WorkspaceSearchResult {
  return {
    id: `app-${app.id}`,
    category: 'apps',
    title: app.title,
    meta: app.kind === 'public' ? 'Public app' : 'Private app',
    detail: app.webAddress ?? `/${app.slug}`,
    target: { kind: 'app', appSlug: app.slug },
  };
}

export function useWorkspaceContentSearch({
  workspaceId,
  enabled,
  appsEnabled,
  query,
  category,
}: {
  workspaceId: string;
  enabled: boolean;
  appsEnabled: boolean;
  query: string;
  category: SearchCategory;
}): WorkspaceSearchState {
  const [state, setState] = useState<WorkspaceSearchState>(emptyState);
  const workflowsCacheRef = useRef<{ workspaceId: string; items: CachedWorkflow[] } | null>(null);
  const appsCacheRef = useRef<{ workspaceId: string; items: AppSummary[] } | null>(null);

  const chatsReader = useMemo(
    () =>
      chatListReads(
        conversationRequest(workspaceId, status => {
          throw new TableRequestError(status, 'search-chats-unavailable', 'Chats could not be searched.');
        }),
      ),
    [workspaceId],
  );

  // Load recent chats once when the palette opens so zero-query search shows active work immediately.
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const signal = requestSignal(controller.signal);
    void chatsReader
      .list(signal, false, '', 1)
      .then(result => {
        if (controller.signal.aborted) return;
        const recentChats: WorkspaceSearchResult[] = result.chats.slice(0, 6).map(chat => ({
          id: `chat-${chat.id}`,
          category: 'chats',
          title: chat.title || 'Untitled chat',
          meta: chat.pinned ? 'Pinned' : undefined,
          detail: formatRelativeTime(chat.activityAt),
          target: { kind: 'chat', chatId: chat.id },
        }));
        setState(current => ({ ...current, recentChats }));
      })
      .catch(() => {
        // Recent chats are a progressive enhancement; ignore errors quietly.
      });
    return () => controller.abort();
  }, [chatsReader, enabled]);

  // Run debounced content queries across enabled workspace resources.
  useEffect(() => {
    if (!enabled) {
      setState(current => ({ ...emptyState, recentChats: current.recentChats }));
      return;
    }

    const trimmed = query.trim();
    const browsingSingleContentCategory = category !== 'all' && category !== 'pages';
    if (!trimmed && !browsingSingleContentCategory) {
      setState(current => ({
        ...emptyState,
        recentChats: current.recentChats,
      }));
      return;
    }

    const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
    const limit = category === 'all' ? 5 : 15;
    const include = (target: ContentCategory) => category === 'all' || category === target;
    const shouldSearchChats = include('chats');
    const shouldSearchAgents = include('agents');
    const shouldSearchTables = include('tables');
    const shouldSearchWorkflows = include('workflows');
    const shouldSearchApps = appsEnabled && include('apps');
    const shouldSearchFiles = include('files') && trimmed.length > 0;

    const controller = new AbortController();
    const delay = trimmed ? 160 : 0;

    setState(current => ({ ...current, searching: true, partialFailure: false }));

    const timer = window.setTimeout(() => {
      const signal = requestSignal(controller.signal);

      const loadWorkflows = async (): Promise<WorkspaceSearchResult[]> => {
        if (!shouldSearchWorkflows) return [];
        let list: CachedWorkflow[];
        if (workflowsCacheRef.current?.workspaceId === workspaceId) {
          list = workflowsCacheRef.current.items;
        } else {
          const loaded = await workflowQueries.list(workspaceId).load(signal);
          list = loaded
            .filter(item => item.archivedAt === null)
            .map(item => {
              const triggerCount = item.definition.triggers.length;
              const stepCount = item.definition.steps.length;
              const parts = [
                triggerCount > 0 ? `${triggerCount} ${triggerCount === 1 ? 'trigger' : 'triggers'}` : '',
                stepCount > 0 ? `${stepCount} ${stepCount === 1 ? 'step' : 'steps'}` : '',
              ].filter(Boolean);
              return {
                id: item.id,
                name: item.definition.name,
                enabled: item.enabled,
                summary: parts.join(' · '),
              };
            });
          workflowsCacheRef.current = { workspaceId, items: list };
        }
        const filtered = words.length ? list.filter(item => matchesWords(item.name, words)) : list;
        return filtered.slice(0, limit).map(mapWorkflowResult);
      };

      const loadApps = async (): Promise<WorkspaceSearchResult[]> => {
        if (!shouldSearchApps) return [];
        let list: AppSummary[];
        if (appsCacheRef.current?.workspaceId === workspaceId) {
          list = appsCacheRef.current.items;
        } else {
          list = await appApi(workspaceId).list(signal);
          appsCacheRef.current = { workspaceId, items: list };
        }
        const filtered = words.length
          ? list.filter(item => matchesWords(`${item.title} ${item.slug} ${item.webAddress ?? ''}`, words))
          : list;
        return filtered.slice(0, limit).map(mapAppResult);
      };

      const loadChats = async (): Promise<WorkspaceSearchResult[]> => {
        if (!shouldSearchChats) return [];
        const result = await chatsReader.list(signal, false, trimmed, 1);
        return result.chats.slice(0, limit).map(chat => ({
          id: `chat-${chat.id}`,
          category: 'chats',
          title: chat.title || 'Untitled chat',
          meta: chat.pinned ? 'Pinned' : undefined,
          detail: formatRelativeTime(chat.activityAt),
          target: { kind: 'chat', chatId: chat.id },
        }));
      };

      const loadAgents = async (): Promise<WorkspaceSearchResult[]> => {
        if (!shouldSearchAgents) return [];
        const result = await agentApi(workspaceId).list(signal, undefined, trimmed, false);
        return result.agents.slice(0, limit).map(agent => ({
          id: `agent-${agent.id}`,
          category: 'agents',
          title: agent.name,
          target: { kind: 'agent', agentId: agent.id },
        }));
      };

      const loadTables = async (): Promise<WorkspaceSearchResult[]> => {
        if (!shouldSearchTables) return [];
        const result = await tableApi(workspaceId).list(undefined, signal, trimmed || undefined, false, {
          by: 'changed',
          direction: 'desc',
        });
        return result.tables.slice(0, limit).map(table => {
          const fieldLabels = table.definition.fields.slice(0, 4).map(field => field.label);
          const extraFields = table.definition.fields.length - fieldLabels.length;
          const detail = fieldLabels.length
            ? extraFields > 0
              ? `${fieldLabels.join(', ')} +${extraFields}`
              : fieldLabels.join(', ')
            : undefined;
          return {
            id: `table-${table.id}`,
            category: 'tables',
            title: table.definition.label,
            meta: formatRowCount(table.recordCount),
            detail,
            target: { kind: 'table', tableId: table.id },
          };
        });
      };

      const loadFiles = async (): Promise<WorkspaceSearchResult[]> => {
        if (!shouldSearchFiles) return [];
        const items = await filesApi(workspaceId).search(trimmed, signal);
        return items
          .filter(item => !item.trashed)
          .slice(0, limit)
          .map(item => ({
            id: `file-${item.id}`,
            category: 'files',
            title: item.name,
            meta: item.kind === 'folder' ? 'Folder' : item.mediaType?.split('/').pop()?.toUpperCase(),
            target: { kind: 'file', fileId: item.id },
            folder: item.kind === 'folder',
          }));
      };

      void Promise.allSettled([loadChats(), loadAgents(), loadTables(), loadWorkflows(), loadApps(), loadFiles()]).then(
        results => {
          if (controller.signal.aborted) return;
          const [chatsRes, agentsRes, tablesRes, workflowsRes, appsRes, filesRes] = results;
          const attempted = [
            shouldSearchChats ? chatsRes : null,
            shouldSearchAgents ? agentsRes : null,
            shouldSearchTables ? tablesRes : null,
            shouldSearchWorkflows ? workflowsRes : null,
            shouldSearchApps ? appsRes : null,
            shouldSearchFiles ? filesRes : null,
          ].filter(Boolean);
          const partialFailure = attempted.some(res => res?.status === 'rejected');
          setState(current => ({
            recentChats: current.recentChats,
            chats: chatsRes.status === 'fulfilled' ? chatsRes.value : [],
            agents: agentsRes.status === 'fulfilled' ? agentsRes.value : [],
            tables: tablesRes.status === 'fulfilled' ? tablesRes.value : [],
            workflows: workflowsRes.status === 'fulfilled' ? workflowsRes.value : [],
            apps: appsRes.status === 'fulfilled' ? appsRes.value : [],
            files: filesRes.status === 'fulfilled' ? filesRes.value : [],
            searching: false,
            partialFailure,
          }));
        },
      );
    }, delay);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [appsEnabled, category, chatsReader, enabled, query, workspaceId]);

  return state;
}
