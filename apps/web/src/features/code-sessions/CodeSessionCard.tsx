import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { TerminalIcon } from '@tulipfarm/icons';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { codingAgentLabels } from '@tulipfarm/agents/coding-run-contracts';
import {
  codeSessionStageLabels,
  codeSessionTerminalStages,
  type CodeSessionView,
} from '@tulipfarm/agents/code-session-contracts';
import { useCanvas } from '@/features/chat/canvas-state';
import { codeSessionApi } from './api';
import { liveTerminalCanvasId } from './LiveTerminalCanvas';

const runStateVariants: Record<CodeSessionView['runState'], 'secondary' | 'warning' | 'success' | 'destructive'> = {
  queued: 'secondary',
  working: 'secondary',
  waiting: 'warning',
  done: 'success',
  failed: 'destructive',
};

export function CodeSessionCard({
  workspaceId,
  workspaceSlug,
  sessionId,
}: {
  workspaceId: string;
  workspaceSlug: string;
  sessionId: string;
}) {
  const api = useMemo(() => codeSessionApi(workspaceId), [workspaceId]);
  const canvas = useCanvas();
  const [session, setSession] = useState<CodeSessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const autoOpenedRef = useRef<string | null>(null);

  const openTerminal = useCallback(
    (title?: string) => {
      canvas.show({
        id: liveTerminalCanvasId(sessionId),
        title: title ? `Terminal · ${title}` : 'Terminal',
        content: { kind: 'live-terminal', workspaceId, sessionId },
      });
    },
    [canvas, sessionId, workspaceId],
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await api.read(sessionId, signal);
        setSession(next);
        setError(null);
      } catch (err) {
        if (signal?.aborted) return;
        setError(err instanceof Error ? err.message : 'Unable to load code session.');
      }
    },
    [api, sessionId],
  );

  useEffect(() => {
    if (!session) return;
    if (autoOpenedRef.current === session.id) return;
    if (codeSessionTerminalStages.has(session.stage)) return;
    autoOpenedRef.current = session.id;
    openTerminal(session.title);
  }, [session, openTerminal]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(() => {
      if (session && codeSessionTerminalStages.has(session.stage)) return;
      void load(controller.signal);
    }, 4000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load, session?.stage]);

  async function handleStop() {
    if (!session || stopping) return;
    setStopping(true);
    try {
      const updated = await api.stop(session.id);
      setSession(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not stop session.');
    } finally {
      setStopping(false);
    }
  }

  if (error && !session) {
    return <div className="rounded-lg border p-3 text-sm text-destructive">{error}</div>;
  }

  if (!session) {
    return <div className="rounded-lg border p-3 text-sm text-muted-foreground">Loading code session…</div>;
  }

  const active = !codeSessionTerminalStages.has(session.stage);

  return (
    <div className="code-session-card rounded-lg border p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <TerminalIcon size="sm" aria-hidden="true" />
            <span className="font-medium text-sm">{session.title}</span>
            {active ? (
              <>
                <Badge variant="secondary">{codeSessionStageLabels[session.stage]}</Badge>
                <Badge variant={runStateVariants[session.runState]}>{session.runState}</Badge>
              </>
            ) : (
              <Badge variant={runStateVariants[session.runState]}>{codeSessionStageLabels[session.stage]}</Badge>
            )}
          </div>
          <p className="font-mono text-xs text-muted-foreground">
            {codingAgentLabels[session.agent]} · {session.repository} ({session.baseBranch} → {session.sessionBranch})
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={session.openRequest ? 'default' : 'outline'}
            onClick={() => openTerminal(session.title)}
          >
            <TerminalIcon size="sm" aria-hidden="true" />
            {session.openRequest ? 'Answer in terminal' : 'Open terminal'}
          </Button>
          {session.openRequest && (
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link to="/$workspaceSlug/inbox" params={{ workspaceSlug }} />}
            >
              Inbox
            </Button>
          )}
          {session.pullRequestUrl && (
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<a href={session.pullRequestUrl} target="_blank" rel="noreferrer" />}
            >
              PR #{session.pullRequestNumber ?? ''}
            </Button>
          )}
          {active && (
            <Button size="sm" variant="ghost" disabled={stopping} onClick={() => void handleStop()}>
              {stopping ? 'Stopping…' : 'Stop'}
            </Button>
          )}
        </div>
      </div>

      {session.summary && <p className="text-sm text-muted-foreground whitespace-pre-wrap">{session.summary}</p>}

      {session.errorMessage && <p className="text-xs text-destructive">{session.errorMessage}</p>}

      {session.steps.length > 0 && (
        <div className="border-t pt-2 space-y-1">
          {session.steps.slice(0, 3).map(step => (
            <div key={step.id} className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="truncate font-mono">
                {step.stage} · {step.finalMessage ?? step.outcome}
              </span>
              <span className="shrink-0">{step.outcome}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
