import { useEffect, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { defaultCallTimeoutMs } from '@tulipfarm/config/timeouts';
import { CheckedCitation, type CitationState } from '@tulipfarm/sprout/chat-sources';
import { apiOrigin } from '@/lib/auth';

export const knowledgeCitationPrefix = '#knowledge-citation=';
const citationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(0|[1-9][0-9]{0,3})$/;
const evidenceSchema = z.object({
  title: z.string(),
  heading: z.string(),
  text: z.string(),
  truncated: z.boolean(),
  source: z.enum(['note', 'file', 'google', 'slack', 'github', 'confluence', 'jira', 'conversation']),
});
const sourceNames = {
  note: 'Note',
  file: 'File',
  google: 'Google Workspace',
  slack: 'Slack',
  github: 'GitHub',
  confluence: 'Confluence',
  jira: 'Jira',
  conversation: 'Chat recap',
} as const;

export function knowledgeCitationId(href: string) {
  if (!href.startsWith(knowledgeCitationPrefix)) return null;
  const id = href.slice(knowledgeCitationPrefix.length);
  return citationPattern.test(id) ? id : null;
}

function labelText(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(labelText).join('');
  return 'knowledge source';
}

// Access is checked on every open; a revoked or changed source never shows its old passage.
export function KnowledgeCitation({
  workspaceId,
  citationId,
  children,
}: {
  workspaceId: string;
  citationId: string;
  children: ReactNode;
}) {
  const [state, setState] = useState<CitationState>({ kind: 'idle' });
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function load() {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setState({ kind: 'loading' });
    try {
      const response = await fetch(
        `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/knowledge/citations/${encodeURIComponent(citationId)}`,
        {
          credentials: 'include',
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(defaultCallTimeoutMs)]),
        },
      );
      if (response.status === 404) {
        setState({
          kind: 'unavailable',
          message:
            'This source changed, was removed, or your access ended. Its passage is hidden. Ask again to search current knowledge.',
        });
        return;
      }
      if (!response.ok) throw new Error('citation-unavailable');
      const evidence = evidenceSchema.parse(await response.json());
      setState({
        kind: 'ready',
        title: evidence.title,
        location: [sourceNames[evidence.source], evidence.heading].filter(Boolean).join(' · '),
        excerpt: evidence.truncated ? `${evidence.text}…` : evidence.text,
      });
    } catch {
      if (!controller.signal.aborted)
        setState({ kind: 'error', message: 'We couldn’t check access to this source. Your answer is unchanged.' });
    } finally {
      if (active.current === controller) active.current = null;
    }
  }
  return (
    <CheckedCitation label={labelText(children)} state={state} onOpen={() => void load()} onRetry={() => void load()} />
  );
}
