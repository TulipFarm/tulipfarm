import { useState } from 'react';
import { TerminalIcon } from '@tulipfarm/icons';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import type { CodeSessionRequestAnswer } from '@tulipfarm/agents/code-session-contracts';
import type { OpenCodeSessionRequestItem } from './api';

const kindTitles: Record<OpenCodeSessionRequestItem['request']['kind'], string> = {
  question: 'Question from coding agent',
  'plan-approval': 'Plan approval required',
  'pr-approval': 'Open pull request?',
  'merge-approval': 'Merge approval required',
  budget: 'Active time budget reached',
  stuck: 'Coding session needs guidance',
};

export function CodeSessionRequestCard({
  item,
  busy,
  onAnswer,
}: {
  item: OpenCodeSessionRequestItem;
  busy: boolean;
  onAnswer: (answer: CodeSessionRequestAnswer) => Promise<void>;
}) {
  const { request, session } = item;
  const [freeform, setFreeform] = useState('');
  const [guidance, setGuidance] = useState('');
  const { payload } = request;

  return (
    <li className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <TerminalIcon size="sm" aria-hidden="true" />
          <Badge variant="warning">{kindTitles[request.kind]}</Badge>
          <span className="font-medium">{session.title}</span>
        </div>
        <span className="font-mono text-xs text-muted-foreground">
          {session.repository} · {session.sessionBranch}
        </span>
      </div>

      {payload.kind === 'question' && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Question {payload.questionIndex} of {payload.totalQuestions}
          </p>
          <p className="text-sm font-medium">{payload.question}</p>
          {payload.options.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {payload.options.map(opt => (
                <Button
                  key={opt.number}
                  size="sm"
                  variant={opt.recommended ? 'default' : 'outline'}
                  disabled={busy}
                  onClick={() => void onAnswer({ kind: 'question', optionNumber: opt.number, text: opt.label })}
                >
                  {opt.number}. {opt.label}
                  {opt.recommended ? ' (Recommended)' : ''}
                </Button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <div className="min-w-64 flex-1">
              <Input
                placeholder="Or type a custom answer…"
                value={freeform}
                disabled={busy}
                onChange={event => setFreeform(event.target.value)}
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !freeform.trim()}
              onClick={() => void onAnswer({ kind: 'question', text: freeform.trim() })}
            >
              Send answer
            </Button>
          </div>
        </div>
      )}

      {payload.kind === 'plan-approval' && (
        <div className="space-y-2">
          <p className="text-sm font-medium">{payload.planTitle}</p>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{payload.planSummary}</p>
          <p className="font-mono text-xs text-muted-foreground">
            Approving authorises coding and pushing to {payload.sessionBranch} in {payload.repository}.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="default"
              disabled={busy}
              onClick={() => void onAnswer({ kind: 'plan-approval', decision: 'approve' })}
            >
              Approve plan & start coding
            </Button>
            <div className="min-w-56 flex-1">
              <Input
                placeholder="Feedback for changes…"
                value={guidance}
                disabled={busy}
                onChange={event => setGuidance(event.target.value)}
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !guidance.trim()}
              onClick={() => void onAnswer({ kind: 'plan-approval', decision: 'revise', feedback: guidance.trim() })}
            >
              Request changes
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void onAnswer({ kind: 'plan-approval', decision: 'stop' })}
            >
              Stop
            </Button>
          </div>
        </div>
      )}

      {payload.kind === 'pr-approval' && (
        <div className="space-y-2">
          <p className="text-sm font-medium">
            Open pull request for {payload.sessionBranch} → {payload.baseBranch}
          </p>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{payload.summary}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="default"
              disabled={busy}
              onClick={() => void onAnswer({ kind: 'pr-approval', decision: 'open-pr', draft: payload.draft })}
            >
              {payload.draft ? 'Open draft PR' : 'Open PR'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void onAnswer({ kind: 'pr-approval', decision: 'stop' })}
            >
              Stop
            </Button>
          </div>
        </div>
      )}

      {payload.kind === 'merge-approval' && (
        <div className="space-y-2">
          <p className="text-sm font-medium">PR #{payload.pullRequestNumber}</p>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{payload.diffSummary}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="default"
              disabled={busy}
              onClick={() => void onAnswer({ kind: 'merge-approval', decision: 'merge' })}
            >
              Squash merge & delete branch
            </Button>
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<a href={payload.pullRequestUrl} target="_blank" rel="noreferrer" />}
            >
              View PR
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void onAnswer({ kind: 'merge-approval', decision: 'stop' })}
            >
              Stop
            </Button>
          </div>
        </div>
      )}

      {payload.kind === 'budget' && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Active time reached ({payload.activeMinutes} min of {payload.budgetMinutes} min).
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="default"
              disabled={busy}
              onClick={() => void onAnswer({ kind: 'budget', decision: 'raise-budget', addMinutes: 120 })}
            >
              Add 2 hours & continue
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void onAnswer({ kind: 'budget', decision: 'stop' })}
            >
              Stop session
            </Button>
          </div>
        </div>
      )}

      {payload.kind === 'stuck' && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{payload.summary}</p>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-64 flex-1">
              <Input
                placeholder="Guidance for the next attempt…"
                value={guidance}
                disabled={busy}
                onChange={event => setGuidance(event.target.value)}
              />
            </div>
            <Button
              size="sm"
              variant="default"
              disabled={busy}
              onClick={() =>
                void onAnswer({
                  kind: 'stuck',
                  decision: 'retry',
                  ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
                })
              }
            >
              Retry
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void onAnswer({ kind: 'stuck', decision: 'stop' })}
            >
              Stop
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
