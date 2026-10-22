import { useEffect, useRef, useState } from 'react';
import { Add } from 'reicon-react/icons/Add';
import { Page as PageIcon } from 'reicon-react/icons/Page';
import type { WorkspacePath } from '@/pages/workspace';
import { Button } from '@tulipfarm/sprout/button';
import {
  SearchDialog,
  SearchEmpty,
  SearchFooter,
  SearchGroup,
  SearchHint,
  SearchInput,
  SearchItem,
  SearchItemIcon,
  SearchList,
} from '@tulipfarm/sprout/search-dialog';

export type SearchPath = WorkspacePath | '/$workspaceSlug/agents/new' | '/$workspaceSlug/tables/new';
type SearchEntry = { id: string; title: string; to: SearchPath; icon?: typeof Add | undefined };
type NavPage = { label: string; to: WorkspacePath; icon?: typeof Add };

const quickActions: SearchEntry[] = [
  { id: 'action-chat', title: 'New chat', to: '/$workspaceSlug', icon: Add },
  { id: 'action-agent', title: 'Create agent', to: '/$workspaceSlug/agents/new', icon: Add },
  { id: 'action-resource', title: 'Create table', to: '/$workspaceSlug/tables/new', icon: Add },
];

function EntryMedia({ entry }: { entry: SearchEntry }) {
  const Icon = entry.icon ?? PageIcon;
  return (
    <SearchItemIcon>
      <Icon size={14} aria-hidden="true" />
    </SearchItemIcon>
  );
}

export function useSearchShortcut(toggle: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k')
        return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggle]);
}

export function SearchPalette({
  open,
  onOpenChange,
  pages,
  onOpen,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pages: NavPage[];
  onOpen: (to: SearchPath) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [recentIds, setRecentIds] = useState<string[]>([]);
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);
  const pageEntries: SearchEntry[] = pages.map(page => ({
    id: `page-${page.to}`,
    title: page.label,
    to: page.to,
    icon: page.icon,
  }));
  const entries = [...pageEntries, ...quickActions];
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (entry: SearchEntry) => words.every(word => entry.title.toLowerCase().includes(word));
  const recent = words.length
    ? []
    : recentIds
        .map(id => entries.find(entry => entry.id === id))
        .filter(entry => entry !== undefined)
        .slice(0, 3);
  const groups = [
    { heading: 'Recent', items: recent },
    { heading: 'Pages', items: pageEntries.filter(matches) },
    { heading: 'Quick actions', items: quickActions.filter(matches) },
  ].filter(group => group.items.length);

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) setQuery('');
  };
  const select = (entry: SearchEntry) => {
    setRecentIds(ids => [entry.id, ...ids.filter(id => id !== entry.id)].slice(0, 3));
    close(false);
    onOpen(entry.to);
  };

  return (
    <SearchDialog
      open={open}
      onOpenChange={close}
      title="Jump to…"
      description="Find workspace pages and quick actions. This does not search chat messages, agents, workflows, or files."
    >
      <SearchInput
        ref={inputRef}
        value={query}
        onValueChange={setQuery}
        placeholder="Find a page or action…"
        label="Jump to…"
      />
      <SearchList label="Pages and actions">
        {groups.length ? (
          groups.map(group => (
            <SearchGroup key={group.heading} heading={group.heading} count={group.items.length}>
              {group.items.map(entry => (
                <SearchItem
                  key={`${group.heading}-${entry.id}`}
                  value={`${group.heading}-${entry.id}`}
                  onSelect={() => select(entry)}
                  media={<EntryMedia entry={entry} />}
                  title={entry.title}
                />
              ))}
            </SearchGroup>
          ))
        ) : (
          <SearchEmpty
            title="No pages or actions found"
            description="Try another page or action name. To find a saved chat by title, open Chats."
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setQuery('');
                  inputRef.current?.focus();
                }}
              >
                Clear search
              </Button>
            }
          />
        )}
      </SearchList>
      <SearchFooter>
        <SearchHint keys="↑↓">Select</SearchHint>
        <SearchHint keys="↵">Open</SearchHint>
        <SearchHint keys="Esc">Close</SearchHint>
      </SearchFooter>
    </SearchDialog>
  );
}
