import { useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { workspaceRoute } from '@/router';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useMcpAccessLoss } from '@/features/workspace-mcp/state';
import { conversationApi, type ConversationApi } from './conversation-api';

export function ConversationAccess({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: (api: ConversationApi) => ReactNode;
}) {
  const [denied, setDenied] = useState<number | null>(null);
  const mcpDenied = useMcpAccessLoss(workspaceId);
  const { workspace } = workspaceRoute.useRouteContext();
  const api = useMemo(() => conversationApi(workspaceId, setDenied), [workspaceId]);
  const destination = useLocation({ select: location => location.href });
  if (mcpDenied)
    return (
      <StatePanel
        kind="unavailable"
        title="Private context access changed"
        description="Previously loaded messages, titles, and MCP results have been removed. Start a clean-context chat to continue without unavailable history."
      >
        <Button variant="outline" nativeButton={false} render={<a href={`/${encodeURIComponent(workspace.slug)}`} />}>
          Start clean-context chat
        </Button>
      </StatePanel>
    );
  if (denied)
    return (
      <StatePanel
        heading="h1"
        kind="unavailable"
        title={denied === 401 ? 'Sign in to continue' : 'Personal chats unavailable'}
        description="This chat is missing or your access changed. Previously loaded private content has been cleared."
      >
        <Button
          variant="outline"
          nativeButton={false}
          render={denied === 401 ? <Link to="/login" search={{ redirect: destination }} /> : <Link to="/" />}
        >
          {denied === 401 ? 'Sign in' : 'Back to workspaces'}
        </Button>
      </StatePanel>
    );
  return children(api);
}
