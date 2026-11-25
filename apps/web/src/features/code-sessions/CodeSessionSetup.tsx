import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  FolderIcon,
  GitBranchIcon,
  LockIcon,
  SettingsIcon,
} from '@tulipfarm/icons';
import { BrandIcon, type Brand } from '@tulipfarm/sprout/brand-icon';
import { Button } from '@tulipfarm/sprout/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@tulipfarm/sprout/command';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { Input } from '@tulipfarm/sprout/input';
import { InputGroupButton } from '@tulipfarm/sprout/input-group';
import { Label } from '@tulipfarm/sprout/label';
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from '@tulipfarm/sprout/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@tulipfarm/sprout/tooltip';
import type { CodingAgent } from '@tulipfarm/agents/coding-run-contracts';
import type { CodeModeAvailability, CodeSessionStartInput } from '@tulipfarm/agents/code-session-contracts';
import { githubKnowledgeApi } from '@/features/integrations/github-knowledge-api';
import { discoverGitHubRepositories } from '@/features/integrations/github-repositories';
import { codeSessionApi, type CodeRepositoryChoice } from './api';

export type CodeSessionDraftConfig = {
  codingAgent: CodingAgent;
  repository: string;
  baseBranch: string;
  budgetSeconds: number;
};

type CodingAgentMeta = {
  id: CodingAgent;
  label: string;
  subtitle: string;
  brand: Brand;
};

const CODING_AGENTS: readonly CodingAgentMeta[] = [
  { id: 'claude-code', label: 'Claude Code', subtitle: 'Anthropic CLI', brand: 'claude' },
  { id: 'codex', label: 'Codex', subtitle: 'OpenAI CLI', brand: 'openai' },
  { id: 'copilot', label: 'Copilot CLI', subtitle: 'GitHub CLI', brand: 'github' },
];

const BUDGET_PRESETS = [1, 2, 4, 8] as const;
const BRANCH_PRESETS = ['main', 'master', 'develop'] as const;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function defaultCodeSessionDraft(availability: CodeModeAvailability | null): CodeSessionDraftConfig {
  const firstAvailable = availability?.agents.find(a => a.available)?.agent ?? 'claude-code';
  return {
    codingAgent: firstAvailable,
    repository: '',
    baseBranch: 'main',
    budgetSeconds: 4 * 3600,
  };
}

export function buildCodeSessionStartInput(draft: CodeSessionDraftConfig): CodeSessionStartInput | null {
  const repository = draft.repository.trim();
  const baseBranch = draft.baseBranch.trim() || 'main';
  if (!REPO_PATTERN.test(repository)) return null;
  if (/\s|\.\./.test(baseBranch)) return null;
  return {
    agent: draft.codingAgent,
    repository,
    baseBranch,
    budgetMinutes: Math.max(15, Math.min(1440, Math.round(draft.budgetSeconds / 60))),
  };
}

function useCodeRepositories(workspaceId: string, availability: CodeModeAvailability | null) {
  const [repositories, setRepositories] = useState<CodeRepositoryChoice[]>([]);
  const [loading, setLoading] = useState(false);

  const accountKey = useMemo(
    () => (availability?.githubAccounts ?? []).map(account => account.id).join(','),
    [availability?.githubAccounts],
  );

  useEffect(() => {
    const controller = new AbortController();
    const api = codeSessionApi(workspaceId);
    const ghApi = githubKnowledgeApi(workspaceId);
    const merged = new Map<string, CodeRepositoryChoice>();

    const publish = () => {
      if (controller.signal.aborted) return;
      setRepositories([...merged.values()].sort((a, b) => a.fullName.localeCompare(b.fullName)));
    };

    setLoading(true);
    const accountIds = accountKey ? accountKey.split(',') : [];

    const dbPromise = api
      .repositories(controller.signal)
      .then(result => {
        for (const item of result.items) merged.set(item.fullName.toLowerCase(), item);
        publish();
      })
      .catch(() => undefined);

    const livePromises = accountIds.map(accountId =>
      discoverGitHubRepositories(ghApi, accountId, controller.signal)
        .then(items => {
          for (const item of items) {
            merged.set(item.fullName.toLowerCase(), {
              repositoryId: item.repositoryId,
              fullName: item.fullName,
              visibility: item.visibility,
            });
          }
          publish();
        })
        .catch(() => undefined),
    );

    void Promise.allSettled([dbPromise, ...livePromises]).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });

    return () => controller.abort();
  }, [workspaceId, accountKey]);

  return { repositories, loading };
}

export function CodeSessionBar({
  workspaceId,
  workspaceSlug,
  availability,
  draft,
  onChange,
  disabled,
}: {
  workspaceId: string;
  workspaceSlug: string;
  availability: CodeModeAvailability | null;
  draft: CodeSessionDraftConfig;
  onChange: (next: CodeSessionDraftConfig) => void;
  disabled: boolean;
}) {
  const [repoOpen, setRepoOpen] = useState(false);
  const [repoQuery, setRepoQuery] = useState('');
  const [branchOpen, setBranchOpen] = useState(false);
  const { repositories, loading: reposLoading } = useCodeRepositories(workspaceId, availability);

  const budgetHours = Math.max(1, Math.min(24, Math.round(draft.budgetSeconds / 3600)));
  const trimmedQuery = repoQuery.trim();
  const queryIsValidRepo = REPO_PATTERN.test(trimmedQuery);
  const queryAlreadyListed = repositories.some(repo => repo.fullName.toLowerCase() === trimmedQuery.toLowerCase());
  const currentBranch = draft.baseBranch.trim() || 'main';

  const selectRepository = (fullName: string) => {
    onChange({ ...draft, repository: fullName });
    setRepoQuery('');
    setRepoOpen(false);
  };

  return (
    <div className="code-mode-bar flex w-full items-center justify-between gap-2 px-3 pt-2 pb-1.5 font-mono text-xs">
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <Popover open={repoOpen} onOpenChange={setRepoOpen}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={draft.repository ? `Repository: ${draft.repository}` : 'Select repository'}
                disabled={disabled}
              />
            }
          >
            <span className="code-mode-icon flex shrink-0" aria-hidden="true">
              <FolderIcon size="sm" />
            </span>
            <span
              className={draft.repository ? 'code-mode-repo-value truncate' : 'code-mode-repo-placeholder truncate'}
            >
              {draft.repository || 'Select repository'}
            </span>
            <ChevronDownIcon size="sm" aria-hidden="true" />
          </PopoverTrigger>
          <PopoverContent size="menu" align="start" side="top" sideOffset={8}>
            <Command>
              <CommandInput placeholder="Search or enter owner/repo…" value={repoQuery} onValueChange={setRepoQuery} />
              <CommandList>
                <CommandEmpty>
                  {reposLoading
                    ? 'Loading GitHub repositories…'
                    : availability?.githubConnected
                      ? 'No matching repositories. Type owner/repo to use any repository.'
                      : 'Connect GitHub to browse your repositories, or type owner/repo above.'}
                </CommandEmpty>
                {repositories.length > 0 && (
                  <CommandGroup heading="Repositories">
                    {repositories.map(repo => {
                      const selected = draft.repository.toLowerCase() === repo.fullName.toLowerCase();
                      return (
                        <CommandItem
                          key={repo.repositoryId}
                          value={repo.fullName}
                          onSelect={() => selectRepository(repo.fullName)}
                        >
                          {repo.visibility === 'public' ? (
                            <FolderIcon size="sm" aria-hidden="true" />
                          ) : (
                            <LockIcon size="sm" aria-hidden="true" />
                          )}
                          <span className="min-w-0 flex-1 truncate font-mono text-xs">{repo.fullName}</span>
                          {selected && <CheckIcon size="sm" aria-hidden="true" />}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                )}
                {queryIsValidRepo && !queryAlreadyListed && (
                  <CommandGroup heading="Custom repository">
                    <CommandItem value={trimmedQuery} onSelect={() => selectRepository(trimmedQuery)}>
                      <FolderIcon size="sm" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">Use {trimmedQuery}</span>
                    </CommandItem>
                  </CommandGroup>
                )}
              </CommandList>
            </Command>
            {availability && !availability.githubConnected && (
              <div className="flex items-center justify-between gap-2 border-t px-2.5 py-2 text-xs">
                <span className="text-muted-foreground">GitHub not connected</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  nativeButton={false}
                  render={
                    <Link
                      to="/$workspaceSlug/integrations/$integrationId"
                      params={{ workspaceSlug, integrationId: 'github' }}
                    />
                  }
                >
                  Connect GitHub
                </Button>
              </div>
            )}
          </PopoverContent>
        </Popover>

        <span className="code-mode-sep select-none" aria-hidden="true">
          /
        </span>

        <Popover open={branchOpen} onOpenChange={setBranchOpen}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Base branch: ${currentBranch}`}
                disabled={disabled}
              />
            }
          >
            <span className="code-mode-branch-icon flex shrink-0" aria-hidden="true">
              <GitBranchIcon size="sm" />
            </span>
            <span className="max-w-28 truncate">{currentBranch}</span>
            <ChevronDownIcon size="sm" aria-hidden="true" />
          </PopoverTrigger>
          <PopoverContent align="start" side="top" sideOffset={8}>
            <div className="flex flex-col gap-3">
              <div className="space-y-1">
                <PopoverTitle>Base branch</PopoverTitle>
                <PopoverDescription>Branch the session starts from and targets in its PR.</PopoverDescription>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {BRANCH_PRESETS.map(branch => (
                  <Button
                    key={branch}
                    type="button"
                    size="sm"
                    variant={currentBranch === branch ? 'default' : 'outline'}
                    disabled={disabled}
                    onClick={() => {
                      onChange({ ...draft, baseBranch: branch });
                      setBranchOpen(false);
                    }}
                  >
                    {branch}
                  </Button>
                ))}
              </div>
              <div className="space-y-1">
                <Label htmlFor="code-session-base-branch">Custom branch</Label>
                <Input
                  id="code-session-base-branch"
                  placeholder="main"
                  value={draft.baseBranch}
                  disabled={disabled}
                  onChange={event => onChange({ ...draft, baseBranch: event.target.value })}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      setBranchOpen(false);
                    }
                  }}
                />
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <Popover>
          <PopoverTrigger
            render={
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Active budget: ${budgetHours} hours`}
                disabled={disabled}
              />
            }
          >
            <ClockIcon size="sm" aria-hidden="true" />
            <span>{budgetHours}h</span>
          </PopoverTrigger>
          <PopoverContent align="end" side="top" sideOffset={8}>
            <div className="flex flex-col gap-3">
              <div className="space-y-1">
                <PopoverTitle>Session budget</PopoverTitle>
                <PopoverDescription>Active sandbox time before pausing to ask.</PopoverDescription>
              </div>
              <div className="flex items-center gap-1.5">
                {BUDGET_PRESETS.map(preset => (
                  <Button
                    key={preset}
                    type="button"
                    size="sm"
                    variant={budgetHours === preset ? 'default' : 'outline'}
                    disabled={disabled}
                    onClick={() => onChange({ ...draft, budgetSeconds: preset * 3600 })}
                  >
                    {preset}h
                  </Button>
                ))}
              </div>
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="code-session-budget-hours">Custom (hours)</Label>
                <div className="w-20">
                  <Input
                    id="code-session-budget-hours"
                    type="number"
                    min={1}
                    max={24}
                    value={String(budgetHours)}
                    disabled={disabled}
                    onChange={event => {
                      const hours = Math.max(1, Math.min(24, Number(event.target.value) || 4));
                      onChange({ ...draft, budgetSeconds: hours * 3600 });
                    }}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">Commits include Co-Authored-By: TulipFarm automatically.</p>
            </div>
          </PopoverContent>
        </Popover>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Code settings"
                nativeButton={false}
                render={<Link to="/$workspaceSlug/settings/code" params={{ workspaceSlug }} />}
              />
            }
          >
            <SettingsIcon size="sm" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>Code settings</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

export function CodeSessionNotice({
  workspaceSlug,
  availability,
  loading,
  codingAgent,
}: {
  workspaceSlug: string;
  availability: CodeModeAvailability | null;
  loading: boolean;
  codingAgent: CodingAgent;
}) {
  if (loading || !availability) return null;

  const selectedAgentInfo = availability.agents.find(a => a.agent === codingAgent) ?? null;

  if (availability.unavailableReason) {
    return (
      <div className="code-mode-notice flex items-center gap-2 px-3.5 py-1.5 text-xs">
        <span className="code-mode-notice-dot shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{availability.unavailableReason}</span>
      </div>
    );
  }

  if (selectedAgentInfo && !selectedAgentInfo.available && selectedAgentInfo.reason) {
    return (
      <div className="code-mode-notice flex items-center justify-between gap-2 px-3.5 py-1.5 text-xs">
        <span className="flex min-w-0 items-center gap-2">
          <span className="code-mode-notice-dot shrink-0" aria-hidden="true" />
          <span className="truncate">{selectedAgentInfo.reason}</span>
        </span>
        <span className="code-mode-notice-link shrink-0 font-medium">
          <Link to="/$workspaceSlug/settings/models" params={{ workspaceSlug }}>
            Connect plan
          </Link>
        </span>
      </div>
    );
  }

  if (!availability.githubConnected) {
    return (
      <div className="code-mode-notice flex items-center justify-between gap-2 px-3.5 py-1.5 text-xs">
        <span className="flex min-w-0 items-center gap-2">
          <span className="code-mode-notice-dot shrink-0" aria-hidden="true" />
          <span className="truncate">Connect GitHub to push branches and open pull requests.</span>
        </span>
        <span className="code-mode-notice-link shrink-0 font-medium">
          <Link to="/$workspaceSlug/integrations/$integrationId" params={{ workspaceSlug, integrationId: 'github' }}>
            Connect GitHub
          </Link>
        </span>
      </div>
    );
  }

  return null;
}

export function CodeAgentPicker({
  value,
  availability,
  onChange,
  disabled,
}: {
  value: CodingAgent;
  availability: CodeModeAvailability | null;
  onChange: (agent: CodingAgent) => void;
  disabled: boolean;
}) {
  const active = CODING_AGENTS.find(agent => agent.id === value) ?? CODING_AGENTS[0]!;
  const activeInfo = availability?.agents.find(a => a.agent === active.id) ?? null;
  const needsSetup = activeInfo !== null && !activeInfo.available;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <InputGroupButton
                  size="md"
                  variant="ghost"
                  aria-label={`Coding agent: ${active.label}`}
                  disabled={disabled}
                />
              }
            />
          }
        >
          <span className="relative inline-flex items-center">
            <BrandIcon brand={active.brand} size="inline" />
            {needsSetup && <span aria-hidden="true" className="code-mode-agent-warn" />}
          </span>
          <span className="truncate">{active.label}</span>
          <ChevronDownIcon size="sm" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>Coding agent</TooltipContent>
      </Tooltip>
      <DropdownMenuContent size="menu" side="top" align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Coding agent</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={next => {
              if (next === 'claude-code' || next === 'codex' || next === 'copilot') {
                onChange(next);
              }
            }}
          >
            {CODING_AGENTS.map(agent => {
              const info = availability?.agents.find(a => a.agent === agent.id) ?? null;
              const unavailable = info !== null && !info.available;
              return (
                <DropdownMenuRadioItem key={agent.id} value={agent.id} closeOnClick>
                  <span className="flex w-full items-start gap-2.5 py-0.5">
                    <span className="mt-0.5 flex shrink-0">
                      <BrandIcon brand={agent.brand} size="inline" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span>{agent.label}</span>
                      <span className="text-xs text-muted-foreground">{agent.subtitle}</span>
                    </span>
                    {unavailable && (
                      <span className="ml-auto shrink-0 self-center text-xs text-muted-foreground">Not connected</span>
                    )}
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
