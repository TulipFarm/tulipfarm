import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { MessageResponse } from '@tulipfarm/sprout/message-response';
import { apiOrigin } from '@/lib/auth';
import { KnowledgeCitation, knowledgeCitationId } from './knowledge-citation';

// Matches the knowledge search tool's reconnect link for stale GitHub access.
export const githubReconnectHref = '#github-reconnect';

function DownloadLink({ path, children }: { path: string; children: ReactNode }) {
  const [state, setState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function download() {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setState('loading');
    try {
      const response = await fetch(`${apiOrigin}${path}`, {
        credentials: 'include',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
      });
      if (!response.ok) throw new Error('download-unavailable');
      const filename =
        response.headers.get('content-disposition')?.match(/filename="([A-Za-z0-9_.-]+)"/)?.[1] ?? 'github-download';
      const blob = await response.blob();
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
      } finally {
        URL.revokeObjectURL(url);
      }
      setState('success');
    } catch {
      if (!controller.signal.aborted) setState('error');
    } finally {
      active.current = null;
    }
  }
  return (
    <span>
      <Button
        variant="link"
        size="md"
        disabled={state === 'loading'}
        aria-busy={state === 'loading'}
        onClick={() => void download()}
      >
        {children}
      </Button>
      {state === 'loading' && <span role="status"> Checking access and downloading…</span>}
      {state === 'success' && <span role="status"> Download sent to your browser.</span>}
      {state === 'error' && (
        <span role="alert">
          {' '}
          Download unavailable. Check your selected GitHub account and source access, then select the link to retry. If
          the file changed or expired, request a new download.
        </span>
      )}
    </span>
  );
}

export function GitHubChatResponse({
  workspaceId,
  chatId,
  children,
  task = false,
}: {
  workspaceId: string;
  chatId: string;
  children: string;
  task?: boolean;
}) {
  const prefix = `/v1/workspaces/${workspaceId}/github/${task ? 'tasks' : 'chats'}/${chatId}/downloads/`;
  const workspaceSlug = useParams({ strict: false }).workspaceSlug;
  return (
    <MessageResponse
      renderLink={(href, label) => {
        if (href === githubReconnectHref && workspaceSlug)
          return (
            <Link to="/$workspaceSlug/integrations" params={{ workspaceSlug }} hash="github-accounts">
              {label}
            </Link>
          );
        const citation = knowledgeCitationId(href);
        if (citation)
          return (
            <KnowledgeCitation workspaceId={workspaceId} citationId={citation}>
              {label}
            </KnowledgeCitation>
          );
        return href.startsWith(prefix) && /^[0-9a-f-]{36}$/.test(href.slice(prefix.length)) ? (
          <DownloadLink path={href}>{label}</DownloadLink>
        ) : (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {label}
          </a>
        );
      }}
    >
      {children}
    </MessageResponse>
  );
}
