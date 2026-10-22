import { useRef, useState } from 'react';
import { Add } from 'reicon-react/icons/Add';
import { Folder } from 'reicon-react/icons/Folder';
import { Lock } from 'reicon-react/icons/Lock';
import { ChevronDown } from 'reicon-react/icons/ChevronDown';
import { Button } from '@tulipfarm/sprout/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  defaultCommandFilter,
  type CommandFilter,
} from '@tulipfarm/sprout/command';
import { Popover, PopoverContent, PopoverTrigger } from '@tulipfarm/sprout/popover';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@tulipfarm/sprout/dialog';
import { Label } from '@tulipfarm/sprout/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import type { ReadState } from '@/features/tables/request-state';
import type { Project } from './api';
import { useProjectApi, useProjects } from './queries';

export function useWorkspaceProjects(workspaceId: string) {
  return useProjects(useProjectApi(workspaceId));
}

/** Project names are matched word by word; sprout's default also accepts scattered letters, which finds unrelated projects. */
const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
const projectFilter: CommandFilter = (value, search, keywords = []) => {
  const haystack = fold([value, ...keywords].join(' '));
  return fold(search)
    .split(/\s+/)
    .every(word => haystack.includes(word))
    ? defaultCommandFilter(value, search, keywords)
    : 0;
};

export function ProjectScopeSelect({
  id,
  label,
  state,
  refresh,
  value,
  onChange,
  onNewProject,
  includeArchived = false,
  disabled = false,
  badge = false,
}: {
  id: string;
  label: string;
  state: ReadState<Project[]>;
  refresh: () => Promise<void>;
  value: string | null;
  onChange: (projectId: string | null) => void;
  onNewProject?: () => void;
  includeArchived?: boolean;
  disabled?: boolean;
  badge?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const projects = state.kind === 'ready' ? state.data : [];
  const choices = projects.filter(project => includeArchived || !project.archived || project.id === value);
  const selected = projects.find(project => project.id === value);
  const name = value
    ? selected
      ? `${selected.name}${selected.archived ? ' (archived)' : ''}`
      : state.kind === 'loading'
        ? 'Loading project…'
        : 'Project unavailable'
    : 'Personal chats';
  const Icon = value ? Folder : Lock;
  const privateBadge = badge && !value;
  const failed = state.kind !== 'loading' && (state.kind !== 'ready' || !!state.error);
  const pick = (projectId: string | null) => {
    setOpen(false);
    onChange(projectId);
  };
  return (
    <Popover
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (!next) setSearch('');
      }}
    >
      <PopoverTrigger
        render={
          <Button
            id={id}
            type="button"
            variant={privateBadge ? 'ghost' : badge ? 'scope' : 'outline'}
            size={badge ? 'badge' : 'default'}
            aria-label={`${label}: ${name}`}
            title={privateBadge ? 'Personal chat. Choose a project to share it.' : name}
            disabled={disabled}
          />
        }
      >
        <Icon size={16} aria-hidden="true" />
        <span className="truncate">{privateBadge ? 'Personal chat' : name}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent size="picker" side={badge ? 'top' : 'bottom'} align="start" sideOffset={8}>
        <Command filter={projectFilter}>
          <CommandInput
            ref={searchInput}
            aria-label="Search projects"
            placeholder="Search projects…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList aria-label="Chat projects">
            {state.kind === 'ready' && !failed && (
              <CommandEmpty>
                <span>No matching projects.</span>
                <div className="mt-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSearch('');
                      searchInput.current?.focus();
                    }}
                  >
                    Clear search
                  </Button>
                </div>
              </CommandEmpty>
            )}
            <CommandGroup>
              <CommandItem
                value="private"
                keywords={['Personal chats']}
                data-checked={!value}
                onSelect={() => pick(null)}
              >
                <Lock size={16} aria-hidden="true" />
                Personal chats
              </CommandItem>
            </CommandGroup>
            {choices.length > 0 && (
              <CommandGroup heading="Projects">
                {choices.map(project => (
                  <CommandItem
                    key={project.id}
                    value={project.id}
                    keywords={[project.name]}
                    data-checked={project.id === value}
                    onSelect={() => pick(project.id)}
                  >
                    <Folder size={16} aria-hidden="true" />
                    <span className="min-w-0 break-words">
                      {project.name}
                      {project.archived ? ' (archived)' : ''}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
          {state.kind === 'loading' && (
            <p role="status" className="px-3 py-2 text-sm text-muted-foreground">
              Loading projects…
            </p>
          )}
          {failed && (
            <div className="space-y-2 px-3 py-2">
              <p role="alert" className="text-sm text-destructive">
                Could not load projects.{projects.length > 0 ? ' Showing the last loaded projects.' : ''}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={state.kind === 'ready' && state.refreshing}
                onClick={() => void refresh()}
              >
                Retry loading projects
              </Button>
            </div>
          )}
          {state.kind === 'ready' && !failed && choices.length === 0 && !search && (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              No active projects yet. Create one for shared chats.
            </p>
          )}
        </Command>
        {onNewProject && (
          <div className="border-t p-1">
            <Button
              type="button"
              variant="ghost"
              size="nav"
              onClick={() => {
                setOpen(false);
                onNewProject();
              }}
            >
              <Add size={16} aria-hidden="true" />
              New project
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function MoveToProjectDialog({
  workspaceId,
  open,
  onOpenChange,
  onMove,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMove: (projectId: string) => void;
}) {
  const projects = useWorkspaceProjects(workspaceId);
  const [projectId, setProjectId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const active = projects.state.kind === 'ready' ? projects.state.data.filter(project => !project.archived) : [];
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        onOpenChange(next);
        if (!next) {
          setProjectId('');
          setConfirmed(false);
        }
      }}
    >
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>Move chat to a project</DialogTitle>
          <DialogDescription>The chat becomes shared. You cannot move it back to personal chats.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto">
          {projects.state.kind === 'loading' ? (
            <div role="status" aria-label="Loading projects" className="space-y-3">
              <Skeleton />
              <Skeleton />
            </div>
          ) : projects.state.kind !== 'ready' ? (
            <StatePanel
              kind="error"
              heading="h3"
              title="Could not load projects"
              description="Check your connection, then try again."
            >
              <Button variant="outline" onClick={() => void projects.refresh()}>
                Retry
              </Button>
            </StatePanel>
          ) : !active.length ? (
            <StatePanel
              kind="empty"
              heading="h3"
              title="No projects to move into"
              description="Create a project or ask a project manager to add you, then try again."
            />
          ) : (
            <form
              className="space-y-4"
              onSubmit={event => {
                event.preventDefault();
                if (projectId && confirmed) {
                  onMove(projectId);
                  onOpenChange(false);
                  setProjectId('');
                  setConfirmed(false);
                }
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="move-project">Project</Label>
                <Select value={projectId} onValueChange={value => setProjectId(value ?? '')}>
                  <SelectTrigger id="move-project" width="full">
                    <SelectValue>
                      {active.find(project => project.id === projectId)?.name ?? 'Choose a project'}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Choose a project</SelectItem>
                    {active.map(project => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-start gap-3">
                <Checkbox id="move-confirm" checked={confirmed} onCheckedChange={setConfirmed} />
                <Label htmlFor="move-confirm">
                  I understand that every project member can read the full history of this chat, including earlier
                  messages.
                </Label>
              </div>
              <p className="text-sm text-muted-foreground">
                Earlier replies that used information some members cannot see stay hidden from them.
              </p>
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!projectId || !confirmed}>
                  Move chat
                </Button>
              </div>
            </form>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
