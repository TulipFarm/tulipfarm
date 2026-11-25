import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRightIcon, BranchIcon, CodeIcon, StopIcon, TerminalIcon } from '@tulipfarm/icons';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { codingAgentLabels, codingAgents, type CodingAgent } from '@tulipfarm/agents/coding-run-contracts';
import {
  codeSessionStageLabels,
  codeSessionTerminalStages,
  codeSessionViewSchema,
  codeTerminalChunkSchema,
  type CodeSessionRequestAnswer,
  type CodeSessionRequestView,
  type CodeSessionView,
  type CodeTerminalChunk,
} from '@tulipfarm/agents/code-session-contracts';
import { codeSessionApi } from './api';

export function liveTerminalCanvasId(sessionId: string): string {
  return `live-terminal:${sessionId}`;
}

const runStateVariants: Record<CodeSessionView['runState'], 'secondary' | 'warning' | 'success' | 'destructive'> = {
  queued: 'secondary',
  working: 'secondary',
  waiting: 'warning',
  done: 'success',
  failed: 'destructive',
};

export function LiveTerminalCanvas({ workspaceId, sessionId }: { workspaceId: string; sessionId: string }) {
  const api = useMemo(() => codeSessionApi(workspaceId), [workspaceId]);
  const [session, setSession] = useState<CodeSessionView | null>(null);
  const [chunks, setChunks] = useState<CodeTerminalChunk[]>([]);
  const [connected, setConnected] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [stopping, setStopping] = useState(false);
  const lastChunkIdRef = useRef(0);
  const scrollEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setChunks([]);
    lastChunkIdRef.current = 0;
  }, [sessionId]);

  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const source = new EventSource(api.terminalStreamUrl(sessionId, lastChunkIdRef.current), {
      withCredentials: true,
    });
    source.onopen = () => {
      setConnected(true);
      setStreamError(null);
    };
    source.addEventListener('session', event => {
      const parsed = codeSessionViewSchema.safeParse(JSON.parse((event as MessageEvent<string>).data));
      if (parsed.success) setSession(parsed.data);
    });
    source.addEventListener('chunk', event => {
      const parsed = codeTerminalChunkSchema.safeParse(JSON.parse((event as MessageEvent<string>).data));
      if (!parsed.success) return;
      const incoming = parsed.data;
      lastChunkIdRef.current = Math.max(lastChunkIdRef.current, incoming.id);
      setChunks(prev => (prev.some(item => item.id === incoming.id) ? prev : [...prev, incoming]));
    });
    source.onerror = () => {
      setConnected(false);
      source.close();
      retryTimer = setTimeout(() => setAttempt(n => n + 1), 1500);
    };
    return () => {
      clearTimeout(retryTimer);
      source.close();
    };
  }, [api, sessionId, attempt]);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [chunks.length, session?.openRequest?.id]);

  const refreshNow = useCallback(async () => {
    try {
      const snapshot = await api.terminal(sessionId, lastChunkIdRef.current);
      setSession(snapshot.session);
      if (snapshot.chunks.length > 0) {
        const last = snapshot.chunks.at(-1);
        if (last) lastChunkIdRef.current = Math.max(lastChunkIdRef.current, last.id);
        setChunks(prev => {
          const seen = new Set(prev.map(item => item.id));
          const additions = snapshot.chunks.filter(item => !seen.has(item.id));
          return additions.length > 0 ? [...prev, ...additions] : prev;
        });
      }
      setStreamError(null);
    } catch (err) {
      setStreamError(err instanceof Error ? err.message : 'Unable to reach terminal stream.');
    }
  }, [api, sessionId]);

  async function handleStop() {
    if (!session || stopping) return;
    setStopping(true);
    try {
      const updated = await api.stop(session.id);
      setSession(updated);
      await refreshNow();
    } catch (err) {
      setStreamError(err instanceof Error ? err.message : 'Could not stop session.');
    } finally {
      setStopping(false);
    }
  }

  const active = session ? !codeSessionTerminalStages.has(session.stage) : true;

  return (
    <div className="code-live-terminal">
      <div className="code-live-terminal-header">
        <div className="code-live-terminal-meta">
          <div className="code-live-terminal-title-row">
            <TerminalIcon size="sm" aria-hidden="true" />
            <span className="code-live-terminal-title">{session?.title ?? 'Live coding terminal'}</span>
            {session && (
              <>
                <Badge variant="secondary">{codingAgentLabels[session.agent]}</Badge>
                <Badge variant="secondary">{codeSessionStageLabels[session.stage]}</Badge>
                <Badge variant={runStateVariants[session.runState]}>{session.runState}</Badge>
              </>
            )}
          </div>
          {session && (
            <div className="code-live-terminal-subrow">
              <span className="code-live-terminal-repo">
                <CodeIcon size="sm" aria-hidden="true" />
                {session.repository}
              </span>
              <span className="code-live-terminal-branch">
                <BranchIcon size="sm" aria-hidden="true" />
                {session.baseBranch} → {session.sessionBranch}
              </span>
              <span className="code-live-terminal-status-dot" data-connected={connected ? 'true' : 'false'}>
                {connected ? 'live' : 'reconnecting…'}
              </span>
            </div>
          )}
        </div>
        <div className="code-live-terminal-actions">
          {session?.pullRequestUrl && (
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<a href={session.pullRequestUrl} target="_blank" rel="noreferrer" />}
            >
              PR #{session.pullRequestNumber ?? ''}
              <ArrowUpRightIcon size="sm" aria-hidden="true" />
            </Button>
          )}
          {session && active && (
            <Button size="sm" variant="outline" disabled={stopping} onClick={handleStop}>
              <StopIcon size="sm" aria-hidden="true" />
              {stopping ? 'Stopping…' : 'Stop'}
            </Button>
          )}
        </div>
      </div>

      <div
        className="code-live-terminal-output"
        role="log"
        aria-live="polite"
        aria-label="Coding agent terminal output"
      >
        {chunks.length === 0 ? (
          <div className="code-live-terminal-line" data-stream="system">
            Connecting to {session ? codingAgentLabels[session.agent] : 'coding agent'} terminal…
          </div>
        ) : (
          chunks.map(chunk => (
            <pre key={chunk.id} className="code-live-terminal-line" data-stream={chunk.stream}>
              {chunk.chunk}
            </pre>
          ))
        )}
        {streamError && (
          <div className="code-live-terminal-line" data-stream="stderr">
            {streamError}
          </div>
        )}
        {session && active && !session.openRequest && (
          <div className="code-live-terminal-running">
            <span className="code-live-terminal-cursor" aria-hidden="true" />
            <span>
              {codingAgentLabels[session.agent]} is running ({codeSessionStageLabels[session.stage]}). You can leave
              this tab; any questions will also appear in your Inbox.
            </span>
          </div>
        )}
        <div ref={scrollEndRef} />
      </div>

      {session?.openRequest && (
        <TerminalRequestPrompt
          workspaceId={workspaceId}
          session={session}
          request={session.openRequest}
          onAnswered={refreshNow}
        />
      )}
    </div>
  );
}

function TerminalRequestPrompt({
  workspaceId,
  session,
  request,
  onAnswered,
}: {
  workspaceId: string;
  session: CodeSessionView;
  request: CodeSessionRequestView;
  onAnswered: () => Promise<void>;
}) {
  const api = useMemo(() => codeSessionApi(workspaceId), [workspaceId]);
  const [customText, setCustomText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCustomText('');
    setError(null);
  }, [request.id]);

  async function submit(answer: CodeSessionRequestAnswer) {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.answerRequest(session.id, request.id, answer, request.decisionDigest);
      await onAnswered();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send answer.');
    } finally {
      setSubmitting(false);
    }
  }

  const payload = request.payload;

  return (
    <div className="code-live-terminal-prompt" role="region" aria-label="Interactive coding agent prompt">
      <div className="code-live-terminal-prompt-header">
        <span className="code-live-terminal-prompt-badge">Waiting for your input</span>
        <span className="code-live-terminal-prompt-hint">
          Answer right here in the terminal, or leave and answer later in Inbox.
        </span>
      </div>

      {payload.kind === 'question' && (
        <div className="code-live-terminal-prompt-body">
          <p className="code-live-terminal-prompt-question">
            Question ({payload.questionIndex}/{payload.totalQuestions}): {payload.question}
          </p>
          <div className="code-live-terminal-option-list">
            {payload.options.map(option => (
              <div key={option.number} className="code-live-terminal-option-row">
                <Button
                  size="sm"
                  variant={option.recommended ? 'default' : 'outline'}
                  disabled={submitting}
                  onClick={() =>
                    submit({
                      kind: 'question',
                      optionNumber: option.number,
                      text: option.label,
                    })
                  }
                >
                  {option.number}. {option.label}
                  {option.recommended ? ' (Recommended)' : ''}
                </Button>
              </div>
            ))}
          </div>
          <div className="code-live-terminal-input-row">
            <span className="code-live-terminal-caret" aria-hidden="true">
              ❯
            </span>
            <div className="code-live-terminal-input-wrap">
              <Input
                value={customText}
                placeholder="Or type a custom answer and press Enter…"
                aria-label="Custom terminal answer"
                onChange={event => setCustomText(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && customText.trim()) {
                    event.preventDefault();
                    void submit({ kind: 'question', text: customText.trim() });
                  }
                }}
              />
            </div>
            <Button
              size="sm"
              variant="default"
              disabled={submitting || !customText.trim()}
              onClick={() => submit({ kind: 'question', text: customText.trim() })}
            >
              Send
            </Button>
          </div>
        </div>
      )}

      {payload.kind === 'plan-approval' && (
        <div className="code-live-terminal-prompt-body">
          <p className="code-live-terminal-prompt-question">Plan approval: {payload.planTitle}</p>
          <p className="code-live-terminal-prompt-summary">{payload.planSummary}</p>
          <div className="code-live-terminal-input-row">
            <span className="code-live-terminal-caret" aria-hidden="true">
              ❯
            </span>
            <div className="code-live-terminal-input-wrap">
              <Input
                value={customText}
                placeholder="Optional feedback if requesting changes…"
                aria-label="Plan feedback"
                onChange={event => setCustomText(event.target.value)}
              />
            </div>
          </div>
          <div className="code-live-terminal-action-row">
            <Button
              size="sm"
              variant="default"
              disabled={submitting || Boolean(payload.pushAccessError)}
              onClick={() => submit({ kind: 'plan-approval', decision: 'approve' })}
            >
              Approve plan & start coding
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={submitting}
              onClick={() =>
                submit({
                  kind: 'plan-approval',
                  decision: 'revise',
                  ...(customText.trim() ? { feedback: customText.trim() } : {}),
                })
              }
            >
              Request changes
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={submitting}
              onClick={() => submit({ kind: 'plan-approval', decision: 'stop' })}
            >
              Stop
            </Button>
          </div>
        </div>
      )}

      {payload.kind === 'pr-approval' && (
        <div className="code-live-terminal-prompt-body">
          <p className="code-live-terminal-prompt-question">
            Open pull request for {payload.repository} ({payload.baseBranch} ← {payload.sessionBranch})?
          </p>
          <p className="code-live-terminal-prompt-summary">{payload.summary}</p>
          <div className="code-live-terminal-action-row">
            <Button
              size="sm"
              variant="default"
              disabled={submitting}
              onClick={() => submit({ kind: 'pr-approval', decision: 'open-pr', draft: false })}
            >
              Open PR
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={submitting}
              onClick={() => submit({ kind: 'pr-approval', decision: 'open-pr', draft: true })}
            >
              Open as draft
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={submitting}
              onClick={() => submit({ kind: 'pr-approval', decision: 'keep-branch' })}
            >
              Keep branch only
            </Button>
          </div>
        </div>
      )}

      {payload.kind === 'merge-approval' && (
        <div className="code-live-terminal-prompt-body">
          <p className="code-live-terminal-prompt-question">Merge pull request #{payload.pullRequestNumber}?</p>
          <p className="code-live-terminal-prompt-summary">{payload.diffSummary}</p>
          <div className="code-live-terminal-input-row">
            <span className="code-live-terminal-caret" aria-hidden="true">
              ❯
            </span>
            <div className="code-live-terminal-input-wrap">
              <Input
                value={customText}
                placeholder="Optional feedback if requesting changes…"
                aria-label="Merge feedback"
                onChange={event => setCustomText(event.target.value)}
              />
            </div>
          </div>
          <div className="code-live-terminal-action-row">
            <Button
              size="sm"
              variant="default"
              disabled={submitting}
              onClick={() => submit({ kind: 'merge-approval', decision: 'merge' })}
            >
              Squash & merge
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={submitting}
              onClick={() =>
                submit({
                  kind: 'merge-approval',
                  decision: 'request-changes',
                  ...(customText.trim() ? { feedback: customText.trim() } : {}),
                })
              }
            >
              Request changes
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={submitting}
              onClick={() => submit({ kind: 'merge-approval', decision: 'stop' })}
            >
              Stop
            </Button>
          </div>
        </div>
      )}

      {payload.kind === 'budget' && (
        <div className="code-live-terminal-prompt-body">
          <p className="code-live-terminal-prompt-question">
            Active-time budget reached ({payload.activeMinutes}/{payload.budgetMinutes} min).
          </p>
          <div className="code-live-terminal-action-row">
            <Button
              size="sm"
              variant="default"
              disabled={submitting}
              onClick={() => submit({ kind: 'budget', decision: 'raise-budget', addMinutes: 120 })}
            >
              Add 2 hours
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={submitting}
              onClick={() => submit({ kind: 'budget', decision: 'raise-budget', addMinutes: 240 })}
            >
              Add 4 hours
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={submitting}
              onClick={() => submit({ kind: 'budget', decision: 'stop' })}
            >
              Stop
            </Button>
          </div>
        </div>
      )}

      {payload.kind === 'stuck' && (
        <div className="code-live-terminal-prompt-body">
          <p className="code-live-terminal-prompt-question">Session paused ({payload.reason})</p>
          <p className="code-live-terminal-prompt-summary">{payload.summary}</p>
          <div className="code-live-terminal-input-row">
            <span className="code-live-terminal-caret" aria-hidden="true">
              ❯
            </span>
            <div className="code-live-terminal-input-wrap">
              <Input
                value={customText}
                placeholder="Guidance for retry (optional)…"
                aria-label="Retry guidance"
                onChange={event => setCustomText(event.target.value)}
              />
            </div>
          </div>
          <div className="code-live-terminal-action-row">
            <Button
              size="sm"
              variant="default"
              disabled={submitting}
              onClick={() =>
                submit({
                  kind: 'stuck',
                  decision: 'retry',
                  ...(customText.trim() ? { guidance: customText.trim() } : {}),
                })
              }
            >
              Retry
            </Button>
            {codingAgents
              .filter(candidate => candidate !== session.agent)
              .map((candidate: CodingAgent) => (
                <Button
                  key={candidate}
                  size="sm"
                  variant="outline"
                  disabled={submitting}
                  onClick={() =>
                    submit({
                      kind: 'stuck',
                      decision: 'switch-agent',
                      agent: candidate,
                      ...(customText.trim() ? { guidance: customText.trim() } : {}),
                    })
                  }
                >
                  Switch to {codingAgentLabels[candidate]}
                </Button>
              ))}
            <Button
              size="sm"
              variant="outline"
              disabled={submitting}
              onClick={() => submit({ kind: 'stuck', decision: 'stop' })}
            >
              Stop
            </Button>
          </div>
        </div>
      )}

      {error && <p className="code-live-terminal-error">{error}</p>}
    </div>
  );
}
