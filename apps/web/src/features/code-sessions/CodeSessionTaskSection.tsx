import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { CodeSessionView } from '@tulipfarm/agents/code-session-contracts';
import { codingAgentLabels, codingAgents, type CodingAgent } from '@tulipfarm/agents/coding-run-contracts';
import { ArrowUpRightIcon, BranchIcon, CodeIcon } from '@tulipfarm/icons';
import { Badge } from '@tulipfarm/sprout/badge';
import { BrandIcon, type Brand } from '@tulipfarm/sprout/brand-icon';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { toast } from '@tulipfarm/sprout/toast';
import { useFeatureRead } from '@/lib/query';
import { codeSessionApi } from './api';
import { GitHubRepositoryPicker } from './GitHubRepositoryPicker';
import { useFlag } from '@/lib/feature-flags';

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const codingAgentBrand: Record<CodingAgent, Brand> = {
  'claude-code': 'claude',
  codex: 'openai',
  copilot: 'github',
};

export function CodeSessionTaskSection({
  workspaceId,
  workspaceSlug,
  tableId,
  rowId,
  title,
  description,
}: {
  workspaceId: string;
  workspaceSlug: string;
  tableId: string;
  rowId: string;
  title: string;
  description: string | null | undefined;
}) {
  const codeSessionsEnabled = useFlag('code-sessions');
  const api = useMemo(() => codeSessionApi(workspaceId), [workspaceId]);
  const availability = useFeatureRead({
    key: ['code-mode', 'availability', workspaceId] as const,
    enabled: codeSessionsEnabled,
    load: signal => api.availability(signal),
  });
  const repos = useFeatureRead({
    key: ['code-mode', 'repositories', workspaceId] as const,
    enabled: codeSessionsEnabled,
    load: signal => api.repositories(signal),
  });
  const sessions = useFeatureRead({
    key: ['code-sessions', 'row', workspaceId, rowId] as const,
    enabled: codeSessionsEnabled,
    load: signal => api.list({ rowId }, signal),
    pollWhile: data =>
      codeSessionsEnabled && data.sessions.some(session => !['merged', 'stopped', 'failed'].includes(session.stage)),
    interval: 4000,
    maxChecks: 300,
  });

  const [agent, setAgent] = useState<CodingAgent>('claude-code');
  const [repository, setRepository] = useState('');
  const [baseBranch, setBaseBranch] = useState('main');
  const [starting, setStarting] = useState(false);

  const avail = availability.state.kind === 'ready' ? availability.state.data : null;
  const repoItems = repos.state.kind === 'ready' ? repos.state.data.items : [];
  const rowSessions = sessions.state.kind === 'ready' ? sessions.state.data.sessions : [];
  const activeSession = rowSessions.find(session => !['merged', 'stopped', 'failed'].includes(session.stage));
  const latestSession = activeSession ?? rowSessions[0] ?? null;

  if (!codeSessionsEnabled || (avail && !avail.enabled)) return null;

  const effectiveRepo = repository.trim() || repoItems[0]?.fullName || '';
  const selectedAgent = avail?.agents.find(item => item.agent === agent);
  const canStart =
    !starting && REPO_PATTERN.test(effectiveRepo) && baseBranch.trim().length > 0 && (selectedAgent?.available ?? true);

  const start = async () => {
    if (!canStart) return;
    setStarting(true);
    try {
      const request = [title.trim(), description?.trim()].filter(Boolean).join('\n\n');
      await api.start({
        title: title.trim() || 'Code session',
        request: request || title.trim(),
        tableId,
        rowId,
        start: {
          agent,
          repository: effectiveRepo,
          baseBranch: baseBranch.trim(),
        },
      });
      toast.add({ title: `Started ${codingAgentLabels[agent]} session`, type: 'success' });
      await sessions.refresh();
    } catch (error) {
      toast.add({
        title: error instanceof Error ? error.message : 'Could not start code session',
        type: 'error',
      });
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CodeIcon size="sm" aria-hidden="true" />
          <span>Code session</span>
        </div>
        {latestSession && (
          <Badge variant={latestSession.stage === 'failed' ? 'destructive' : 'outline'}>
            {latestSession.stageLabel}
          </Badge>
        )}
      </div>

      {latestSession ? (
        <TaskSessionSummary
          session={latestSession}
          workspaceSlug={workspaceSlug}
          onStop={
            latestSession.isOwner && !['merged', 'stopped', 'failed'].includes(latestSession.stage)
              ? async () => {
                  await api.stop(latestSession.id);
                  await sessions.refresh();
                }
              : undefined
          }
        />
      ) : (
        <div className="space-y-2.5 text-sm">
          <p className="text-xs text-muted-foreground">
            Assign this task to a coding agent. It will brainstorm, draft a plan for your approval, code, test, and open
            a pull request.
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Select value={agent} onValueChange={value => value && setAgent(value as CodingAgent)}>
              <SelectTrigger aria-label="Coding agent">
                <SelectValue>
                  <span className="inline-flex items-center gap-2 whitespace-nowrap">
                    <BrandIcon brand={codingAgentBrand[agent]} size="inline" />
                    <span>{codingAgentLabels[agent]}</span>
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {codingAgents.map(candidate => (
                  <SelectItem key={candidate} value={candidate}>
                    <span className="inline-flex items-center gap-2 whitespace-nowrap">
                      <BrandIcon brand={codingAgentBrand[candidate]} size="inline" />
                      <span>{codingAgentLabels[candidate]}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <GitHubRepositoryPicker
              workspaceId={workspaceId}
              items={repoItems}
              value={effectiveRepo}
              onChange={nextRepo => setRepository(nextRepo)}
              ariaLabel="Repository"
              placeholder="Choose a repository"
            />
            <Input
              aria-label="Base branch"
              placeholder="main"
              value={baseBranch}
              onChange={event => setBaseBranch(event.target.value)}
            />
          </div>
          {selectedAgent && !selectedAgent.available && selectedAgent.reason && (
            <p className="text-xs text-warning">{selectedAgent.reason}</p>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">Questions and approvals appear in your Inbox.</span>
            <Button size="sm" disabled={!canStart} onClick={() => void start()}>
              {starting ? 'Starting…' : 'Start code session'}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function TaskSessionSummary({
  session,
  workspaceSlug,
  onStop,
}: {
  session: CodeSessionView;
  workspaceSlug: string;
  onStop?: (() => Promise<void>) | undefined;
}) {
  const [stopping, setStopping] = useState(false);
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
          <BrandIcon brand={codingAgentBrand[session.agent]} size="inline" />
          <span>{codingAgentLabels[session.agent]}</span>
        </span>
        <span>·</span>
        <span className="font-mono">{session.repository}</span>
        <span>·</span>
        <span className="inline-flex items-center gap-1 font-mono">
          <BranchIcon size="xs" aria-hidden="true" />
          {session.baseBranch} → {session.sessionBranch}
        </span>
      </div>
      {session.summary && <p className="text-sm text-foreground">{session.summary}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {session.pullRequestUrl && (
          <Button
            size="sm"
            variant="outline"
            nativeButton={false}
            render={<a href={session.pullRequestUrl} target="_blank" rel="noreferrer" />}
          >
            PR #{session.pullRequestNumber ?? ''}
            <ArrowUpRightIcon size="xs" aria-hidden="true" />
          </Button>
        )}
        {session.openRequest && session.isOwner && (
          <Button
            size="sm"
            nativeButton={false}
            render={<Link to="/$workspaceSlug/inbox" params={{ workspaceSlug }} />}
          >
            Answer in Inbox
          </Button>
        )}
        {onStop && (
          <Button
            size="sm"
            variant="ghost"
            disabled={stopping}
            onClick={async () => {
              setStopping(true);
              try {
                await onStop();
              } finally {
                setStopping(false);
              }
            }}
          >
            {stopping ? 'Stopping…' : 'Stop'}
          </Button>
        )}
      </div>
    </div>
  );
}
