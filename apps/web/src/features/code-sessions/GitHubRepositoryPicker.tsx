import { useMemo, useState } from 'react';
import { CheckIcon, ChevronDownIcon, FolderIcon, LockIcon } from '@tulipfarm/icons';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import { Button } from '@tulipfarm/sprout/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@tulipfarm/sprout/command';
import { Popover, PopoverContent, PopoverTrigger } from '@tulipfarm/sprout/popover';
import { useFeatureRead } from '@/lib/query';
import { codeSessionApi, type CodeRepositoryChoice } from './api';

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function GitHubRepositoryPicker({
  id,
  workspaceId,
  value,
  onChange,
  items: preloadedItems,
  disabled = false,
  allowClear = false,
  placeholder = 'Choose a repository',
  ariaLabel = 'GitHub repository',
}: {
  id?: string | undefined;
  workspaceId: string;
  value: string;
  onChange: (repository: string) => void;
  items?: CodeRepositoryChoice[] | undefined;
  disabled?: boolean | undefined;
  allowClear?: boolean | undefined;
  placeholder?: string | undefined;
  ariaLabel?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const api = useMemo(() => codeSessionApi(workspaceId), [workspaceId]);
  const loaded = useFeatureRead({
    key: ['code-mode', 'repositories', workspaceId] as const,
    enabled: preloadedItems === undefined,
    load: signal => api.repositories(signal),
  });

  const repositories = preloadedItems ?? (loaded.state.kind === 'ready' ? loaded.state.data.items : []);
  const loading = preloadedItems === undefined && loaded.state.kind === 'loading';
  const trimmedQuery = query.trim();
  const hasExactMatch = repositories.some(repo => repo.fullName.toLowerCase() === trimmedQuery.toLowerCase());
  const canUseCustom = REPO_PATTERN.test(trimmedQuery) && !hasExactMatch;

  const select = (fullName: string) => {
    onChange(fullName);
    setQuery('');
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button id={id} variant="outline" disabled={disabled} aria-label={ariaLabel} />}>
        <span className="flex w-full items-center justify-between gap-2 text-left">
          <span className="inline-flex min-w-0 items-center gap-2">
            <BrandIcon brand="github" size="inline" />
            <span className={value ? 'truncate font-normal' : 'truncate font-normal text-muted-foreground'}>
              {value || placeholder}
            </span>
          </span>
          <ChevronDownIcon size="xs" aria-hidden="true" />
        </span>
      </PopoverTrigger>
      <PopoverContent align="start">
        <Command>
          <CommandInput placeholder="Search repositories or type owner/repo…" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>
              {loading
                ? 'Loading GitHub repositories…'
                : 'No connected repositories found. Connect GitHub in Settings → Integrations, or type owner/repo above.'}
            </CommandEmpty>
            {allowClear && value && (
              <CommandGroup heading="Selection">
                <CommandItem value="__none__" onSelect={() => select('')}>
                  <span>None</span>
                </CommandItem>
              </CommandGroup>
            )}
            {repositories.length > 0 && (
              <CommandGroup heading="Repositories">
                {repositories.map(repo => {
                  const selected = value.toLowerCase() === repo.fullName.toLowerCase();
                  return (
                    <CommandItem key={repo.repositoryId} value={repo.fullName} onSelect={() => select(repo.fullName)}>
                      {repo.visibility === 'public' ? (
                        <FolderIcon size="sm" aria-hidden="true" />
                      ) : (
                        <LockIcon size="sm" aria-hidden="true" />
                      )}
                      <span className="truncate">{repo.fullName}</span>
                      {selected && <CheckIcon size="xs" aria-hidden="true" />}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
            {canUseCustom && (
              <CommandGroup heading="Custom repository">
                <CommandItem value={`custom:${trimmedQuery}`} onSelect={() => select(trimmedQuery)}>
                  <FolderIcon size="sm" aria-hidden="true" />
                  <span>Use {trimmedQuery}</span>
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
