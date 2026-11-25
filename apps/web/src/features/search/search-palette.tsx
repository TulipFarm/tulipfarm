import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AddIcon,
  AgentIcon,
  AppsIcon,
  ChatIcon,
  ComposeIcon,
  DatabaseIcon,
  DocumentIcon,
  FolderIcon,
  SearchIcon,
  SidebarLeftIcon,
  WorkflowIcon,
} from '@tulipfarm/icons';
import type { WorkspacePath } from '@/pages/workspace';
import { Button } from '@tulipfarm/sprout/button';
import { Kbd } from '@tulipfarm/sprout/kbd';
import {
  SearchDialog,
  SearchEmpty,
  SearchFilter,
  SearchFilters,
  SearchFooter,
  SearchGroup,
  SearchHint,
  SearchInput,
  SearchItem,
  SearchItemIcon,
  SearchList,
} from '@tulipfarm/sprout/search-dialog';
import {
  loadStoredRecents,
  saveStoredRecents,
  useWorkspaceContentSearch,
  type ContentCategory,
  type SearchCategory,
  type SearchPath,
  type SearchTarget,
  type StoredRecentEntry,
  type WorkspaceSearchResult,
} from './workspace-search';

export type { SearchPath, SearchTarget };

export type NavPage = {
  label: string;
  to: WorkspacePath;
  icon?: typeof AddIcon;
  detail?: string;
  keywords?: string[];
  shortcut?: string;
};

type LocalEntry = {
  id: string;
  title: string;
  detail?: string | undefined;
  meta?: string | undefined;
  keywords?: string[] | undefined;
  shortcut?: string | undefined;
  icon?: typeof AddIcon | undefined;
  category: 'pages' | 'actions';
  target: SearchTarget;
};

const isApplePlatform =
  typeof navigator !== 'undefined' && /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
const sidebarShortcut = isApplePlatform ? '⌘B' : 'Ctrl B';

const quickActions: LocalEntry[] = [
  {
    id: 'action-chat',
    title: 'New chat',
    detail: 'Start a fresh conversation in this workspace',
    keywords: ['ask', 'compose', 'conversation', 'message', 'prompt'],
    icon: ComposeIcon,
    category: 'actions',
    target: { kind: 'page', to: '/$workspaceSlug' },
  },
  {
    id: 'action-agent',
    title: 'Create agent',
    detail: 'Set up an autonomous agent with tools and instructions',
    keywords: ['new agent', 'bot', 'assistant', 'automation'],
    icon: AddIcon,
    category: 'actions',
    target: { kind: 'page', to: '/$workspaceSlug/agents/new' },
  },
  {
    id: 'action-table',
    title: 'Create table',
    detail: 'Define a structured table for workspace records',
    keywords: ['new table', 'database', 'spreadsheet', 'records', 'schema'],
    icon: AddIcon,
    category: 'actions',
    target: { kind: 'page', to: '/$workspaceSlug/tables/new' },
  },
  {
    id: 'action-workspace',
    title: 'Create workspace',
    detail: 'Start a separate workspace for another team or project',
    keywords: ['new workspace', 'organization', 'switch'],
    icon: AddIcon,
    category: 'actions',
    target: { kind: 'create-workspace' },
  },
  {
    id: 'action-toggle-sidebar',
    title: 'Toggle sidebar',
    detail: 'Collapse or expand workspace navigation',
    keywords: ['navigation', 'nav', 'hide sidebar', 'show sidebar', 'collapse'],
    shortcut: sidebarShortcut,
    icon: SidebarLeftIcon,
    category: 'actions',
    target: { kind: 'toggle-sidebar' },
  },
];

const categoryLabels: Record<SearchCategory, string> = {
  all: 'All',
  pages: 'Pages',
  chats: 'Chats',
  agents: 'Agents',
  tables: 'Tables',
  workflows: 'Workflows',
  apps: 'Apps',
  files: 'Files',
};

function categoryIcon(category: ContentCategory | 'pages' | 'actions', folder?: boolean): typeof AddIcon {
  switch (category) {
    case 'chats':
      return ChatIcon;
    case 'agents':
      return AgentIcon;
    case 'tables':
      return DatabaseIcon;
    case 'workflows':
      return WorkflowIcon;
    case 'apps':
      return AppsIcon;
    case 'files':
      return folder ? FolderIcon : DocumentIcon;
    case 'actions':
      return AddIcon;
    case 'pages':
      return DocumentIcon;
  }
}

function IconMedia({ icon }: { icon?: typeof AddIcon | undefined }) {
  const Icon = icon ?? DocumentIcon;
  return (
    <SearchItemIcon>
      <Icon size={18} aria-hidden="true" />
    </SearchItemIcon>
  );
}

function matchesEntry(entry: LocalEntry, words: string[]) {
  if (!words.length) return true;
  const haystack = `${entry.title} ${entry.detail ?? ''} ${(entry.keywords ?? []).join(' ')}`.toLowerCase();
  return words.every(word => haystack.includes(word));
}

export function SearchPalette({
  open,
  onOpenChange,
  workspaceId,
  workspaceReady,
  pages,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspaceReady: boolean;
  pages: NavPage[];
  onSelect: (target: SearchTarget) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<SearchCategory>('all');
  const [recents, setRecents] = useState<StoredRecentEntry[]>(() => loadStoredRecents(workspaceId));

  useEffect(() => {
    setRecents(loadStoredRecents(workspaceId));
  }, [workspaceId]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setCategory('all');
    }
  }, [open]);

  const pageEntries = useMemo<LocalEntry[]>(
    () =>
      pages.map(page => ({
        id: `page-${page.to}`,
        title: page.label,
        detail: page.detail,
        keywords: page.keywords,
        shortcut: page.shortcut,
        icon: page.icon,
        category: 'pages',
        target: { kind: 'page', to: page.to },
      })),
    [pages],
  );

  const pageIcons = useMemo(() => {
    const map = new Map<string, typeof AddIcon>();
    for (const entry of [...pageEntries, ...quickActions]) {
      if (entry.icon) map.set(entry.id, entry.icon);
    }
    return map;
  }, [pageEntries]);

  const content = useWorkspaceContentSearch({
    workspaceId,
    enabled: open && workspaceReady,
    query,
    category,
  });

  const trimmed = query.trim();
  const words = useMemo(() => trimmed.toLowerCase().split(/\s+/).filter(Boolean), [trimmed]);
  const isZeroState = words.length === 0 && category === 'all';

  const matchingPages = useMemo(
    () => (category === 'all' || category === 'pages' ? pageEntries.filter(entry => matchesEntry(entry, words)) : []),
    [category, pageEntries, words],
  );

  const matchingActions = useMemo(
    () => (category === 'all' ? quickActions.filter(entry => matchesEntry(entry, words)) : []),
    [category, words],
  );

  const validRecents = useMemo(() => {
    if (!isZeroState) return [];
    const allowedPageIds = new Set(pageEntries.map(entry => entry.id));
    const allowedActionIds = new Set(quickActions.map(entry => entry.id));
    return recents.filter(entry => {
      if (entry.category === 'pages') return allowedPageIds.has(entry.id);
      if (entry.category === 'actions') return allowedActionIds.has(entry.id);
      return true;
    });
  }, [isZeroState, pageEntries, recents]);

  const recentChats = useMemo(() => {
    if (!isZeroState) return [];
    const recentIds = new Set(validRecents.map(entry => entry.id));
    return content.recentChats.filter(item => !recentIds.has(item.id)).slice(0, 4);
  }, [content.recentChats, isZeroState, validRecents]);

  const filterChips = useMemo<{ id: SearchCategory; label: string; icon?: typeof AddIcon }[]>(() => {
    const items: { id: SearchCategory; label: string; icon?: typeof AddIcon }[] = [
      { id: 'all', label: 'All' },
      { id: 'pages', label: 'Pages', icon: DocumentIcon },
    ];
    if (workspaceReady) {
      items.push(
        { id: 'chats', label: 'Chats', icon: ChatIcon },
        { id: 'agents', label: 'Agents', icon: AgentIcon },
        { id: 'tables', label: 'Tables', icon: DatabaseIcon },
        { id: 'workflows', label: 'Workflows', icon: WorkflowIcon },
        { id: 'apps', label: 'Apps', icon: AppsIcon },
        { id: 'files', label: 'Files', icon: FolderIcon },
      );
    }
    return items;
  }, [workspaceReady]);

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setQuery('');
      setCategory('all');
    }
  };

  const rememberAndSelect = (entry: StoredRecentEntry) => {
    if (entry.target.kind !== 'toggle-sidebar') {
      const next = [entry, ...recents.filter(item => item.id !== entry.id)].slice(0, 4);
      setRecents(next);
      saveStoredRecents(workspaceId, next);
    }
    close(false);
    onSelect(entry.target);
  };

  const selectLocal = (entry: LocalEntry) =>
    rememberAndSelect({
      id: entry.id,
      title: entry.title,
      meta: entry.category === 'actions' ? 'Action' : 'Page',
      category: entry.category,
      target: entry.target,
    });

  const selectContent = (item: WorkspaceSearchResult) =>
    rememberAndSelect({
      id: item.id,
      title: item.title,
      meta: categoryLabels[item.category].slice(0, -1),
      category: item.category,
      target: item.target,
      folder: item.folder,
    });

  const contentGroups = [
    { heading: 'Chats', category: 'chats' as const, items: content.chats },
    { heading: 'Agents', category: 'agents' as const, items: content.agents },
    { heading: 'Tables', category: 'tables' as const, items: content.tables },
    { heading: 'Workflows', category: 'workflows' as const, items: content.workflows },
    { heading: 'Apps', category: 'apps' as const, items: content.apps },
    { heading: 'Files', category: 'files' as const, items: content.files },
  ].filter(group => group.items.length > 0);

  const hasAnyResults =
    validRecents.length > 0 ||
    recentChats.length > 0 ||
    matchingPages.length > 0 ||
    matchingActions.length > 0 ||
    contentGroups.length > 0;

  const needsQueryForFiles = category === 'files' && !trimmed;

  const toggleCategory = (next: SearchCategory) => {
    setCategory(current => (current === next ? 'all' : next));
    inputRef.current?.focus();
  };

  const resetSearch = () => {
    setQuery('');
    setCategory('all');
    inputRef.current?.focus();
  };

  return (
    <SearchDialog
      open={open}
      onOpenChange={close}
      title="Search workspace"
      description="Search pages, quick actions, chats, agents, tables, workflows, apps, and files in this workspace."
    >
      <SearchInput
        ref={inputRef}
        value={query}
        onValueChange={setQuery}
        placeholder={workspaceReady ? 'Search chats, tables, agents, pages…' : 'Find a page or action…'}
        label="Search workspace"
      />
      <SearchFilters label="Filter results by type">
        {filterChips.map(chip => {
          const Icon = chip.icon;
          return (
            <SearchFilter
              key={chip.id}
              pressed={category === chip.id}
              onPressedChange={() => toggleCategory(chip.id)}
              icon={Icon && <Icon size={14} aria-hidden="true" />}
            >
              {chip.label}
            </SearchFilter>
          );
        })}
      </SearchFilters>
      <SearchList label="Search results">
        {hasAnyResults ? (
          <>
            {validRecents.length > 0 && (
              <SearchGroup heading="Recent" count={validRecents.length}>
                {validRecents.map(entry => (
                  <SearchItem
                    key={`recent-${entry.id}`}
                    value={`recent-${entry.id}`}
                    onSelect={() => rememberAndSelect(entry)}
                    media={<IconMedia icon={pageIcons.get(entry.id) ?? categoryIcon(entry.category, entry.folder)} />}
                    title={entry.title}
                    meta={entry.meta}
                  />
                ))}
              </SearchGroup>
            )}

            {isZeroState && matchingActions.length > 0 && (
              <SearchGroup heading="Quick actions" count={matchingActions.length}>
                {matchingActions.map(entry => (
                  <SearchItem
                    key={`action-${entry.id}`}
                    value={`action-${entry.id}`}
                    onSelect={() => selectLocal(entry)}
                    media={<IconMedia icon={entry.icon} />}
                    title={entry.title}
                    detail={entry.detail}
                    trailing={entry.shortcut && <Kbd variant="outline">{entry.shortcut}</Kbd>}
                  />
                ))}
              </SearchGroup>
            )}

            {recentChats.length > 0 && (
              <SearchGroup heading="Recent chats" count={recentChats.length}>
                {recentChats.map(item => (
                  <SearchItem
                    key={`recent-chat-${item.id}`}
                    value={`recent-chat-${item.id}`}
                    onSelect={() => selectContent(item)}
                    media={<IconMedia icon={ChatIcon} />}
                    title={item.title}
                    meta={item.meta}
                    detail={item.detail}
                  />
                ))}
              </SearchGroup>
            )}

            {matchingPages.length > 0 && (
              <SearchGroup heading="Pages" count={matchingPages.length}>
                {matchingPages.map(entry => (
                  <SearchItem
                    key={`page-${entry.id}`}
                    value={`page-${entry.id}`}
                    onSelect={() => selectLocal(entry)}
                    media={<IconMedia icon={entry.icon} />}
                    title={entry.title}
                    detail={entry.detail}
                    trailing={entry.shortcut && <Kbd variant="outline">{entry.shortcut}</Kbd>}
                  />
                ))}
              </SearchGroup>
            )}

            {!isZeroState && matchingActions.length > 0 && (
              <SearchGroup heading="Quick actions" count={matchingActions.length}>
                {matchingActions.map(entry => (
                  <SearchItem
                    key={`action-${entry.id}`}
                    value={`action-${entry.id}`}
                    onSelect={() => selectLocal(entry)}
                    media={<IconMedia icon={entry.icon} />}
                    title={entry.title}
                    detail={entry.detail}
                    trailing={entry.shortcut && <Kbd variant="outline">{entry.shortcut}</Kbd>}
                  />
                ))}
              </SearchGroup>
            )}

            {contentGroups.map(group => (
              <SearchGroup key={group.heading} heading={group.heading} count={group.items.length}>
                {group.items.map(item => (
                  <SearchItem
                    key={`${group.heading}-${item.id}`}
                    value={`${group.heading}-${item.id}`}
                    onSelect={() => selectContent(item)}
                    media={<IconMedia icon={categoryIcon(item.category, item.folder)} />}
                    title={item.title}
                    meta={item.meta}
                    detail={item.detail}
                  />
                ))}
              </SearchGroup>
            ))}
          </>
        ) : content.searching ? (
          <SearchEmpty
            media={<SearchIcon size={18} aria-hidden="true" />}
            title="Searching workspace…"
            description={`Looking for “${trimmed || categoryLabels[category].toLowerCase()}” across your workspace.`}
          />
        ) : needsQueryForFiles ? (
          <SearchEmpty
            media={
              <>
                <FolderIcon size={18} aria-hidden="true" />
                <DocumentIcon size={18} aria-hidden="true" />
              </>
            }
            title="Type to search files"
            description="Enter a file or folder name above to search the workspace library."
          />
        ) : (
          <SearchEmpty
            media={
              <>
                <SearchIcon size={18} aria-hidden="true" />
                <ChatIcon size={18} aria-hidden="true" />
                <DatabaseIcon size={18} aria-hidden="true" />
              </>
            }
            title={
              trimmed
                ? category === 'all'
                  ? `No results for “${trimmed}”`
                  : `No ${categoryLabels[category].toLowerCase()} matching “${trimmed}”`
                : `No ${categoryLabels[category].toLowerCase()} yet`
            }
            description={
              category !== 'all'
                ? 'Try searching across all types or using a shorter keyword.'
                : 'Try a different keyword, or filter by pages, chats, agents, tables, workflows, or files.'
            }
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                {category !== 'all' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setCategory('all');
                      inputRef.current?.focus();
                    }}
                  >
                    Search all types
                  </Button>
                )}
                {trimmed && (
                  <Button variant="outline" size="sm" onClick={resetSearch}>
                    Clear search
                  </Button>
                )}
              </div>
            }
          />
        )}
      </SearchList>
      <SearchFooter>
        <SearchHint keys="↑↓">Select</SearchHint>
        <SearchHint keys="↵">Open</SearchHint>
        <SearchHint keys="Esc">Close</SearchHint>
        {content.searching && (
          <span role="status" className="ml-auto text-xs text-muted-foreground">
            Searching…
          </span>
        )}
        {!content.searching && content.partialFailure && (
          <span role="status" className="ml-auto text-xs text-muted-foreground">
            Some workspace items could not be searched.
          </span>
        )}
      </SearchFooter>
    </SearchDialog>
  );
}
