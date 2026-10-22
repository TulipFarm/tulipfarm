import { DataList, DataListActions, DataListButton, DataListCell, DataListRow } from '@/components/data-list';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Add } from 'reicon-react/icons/Add';
import { ChatRound } from 'reicon-react/icons/ChatRound';
import { Search3 } from 'reicon-react/icons/Search3';
import { MoreH } from 'reicon-react/icons/MoreH';
import { Edit } from 'reicon-react/icons/Edit';
import { Archive } from 'reicon-react/icons/Archive';
import { Trash } from 'reicon-react/icons/Trash';
import { XIcon } from 'lucide-react';
import { workspaceRoute } from '@/router';
import { ChatsSample } from '@/components/empty-samples';
import { Button } from '@tulipfarm/sprout/button';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@tulipfarm/sprout/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { Input } from '@tulipfarm/sprout/input';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@tulipfarm/sprout/input-group';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { ConversationAccess } from '@/features/chat/conversation-access';
import {
  titleError,
  type Chat,
  type ConversationApi,
  type ConversationCommand,
} from '@/features/chat/conversation-api';
import { TableRequestError } from '@/features/tables/request-state';
import { requestSignal } from '@/lib/http';
import { ConversationRead } from '@/features/chat/conversation-feedback';
import { useConversationList } from '@/features/chat/queries';
import { ProjectScopeSelect, useWorkspaceProjects } from '@/features/projects/project-scope';
import { startNavigationMeasure } from '@/lib/navigation-performance';

export function WorkspaceChatsPage() {
  const { workspace, user, sessionId } = workspaceRoute.useRouteContext();
  const project = useSearch({ strict: false, select: search => search.project ?? null });
  return (
    <ConversationAccess key={`${sessionId}:${user.id}:${workspace.id}`} workspaceId={workspace.id}>
      {api => (
        <section aria-label="Personal conversations" className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ConversationList api={api} projectId={project} />
        </section>
      )}
    </ConversationAccess>
  );
}

function ConversationList({ api, projectId }: { api: ConversationApi; projectId: string | null }) {
  const { workspaceSlug } = workspaceRoute.useParams();
  const { workspace } = workspaceRoute.useRouteContext();
  const projects = useWorkspaceProjects(workspace.id);
  const projectList = projects.state.kind === 'ready' ? projects.state.data : [];
  const project = projectList.find(item => item.id === projectId);
  const showProject = (id: string | null) => {
    setPages(1);
    void navigate({ to: '/$workspaceSlug/chat', params: { workspaceSlug }, search: id ? { project: id } : {} });
  };
  const navigate = useNavigate();
  const [archived, setArchived] = useState(false);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [pages, setPages] = useState(1);
  useEffect(() => {
    const next = query.trim();
    if (next === search) return;
    const timer = setTimeout(() => {
      setSearch(next);
      setPages(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [query, search]);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const open = (id: string) => {
    void navigate({ to: '/$workspaceSlug/chat/$chatId', params: { workspaceSlug, chatId: id } });
  };
  const list = useConversationList(api, archived, search, pages, projectId);
  const [editing, setEditing] = useState<Chat | null>(null);
  const [title, setTitle] = useState('');
  const [deleting, setDeleting] = useState<Chat | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    text: string;
    undo?: { chat: Chat; archived: boolean };
    error?: boolean;
  } | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<RenameCommand | null>(null);
  const [finishEntry] = useState(() => startNavigationMeasure('chat-list'));
  useEffect(() => {
    if (list.state.kind !== 'loading') finishEntry(list.state.kind);
  }, [finishEntry, list.state.kind]);
  useEffect(() => {
    listHeading.current?.focus();
  }, []);
  const listReady = list.state.kind === 'ready' && !list.state.error && !list.state.refreshing;
  const titleValidation = editing ? titleError(title) : null;
  const startEditing = (chat: Chat | null) => {
    setEditing(chat);
    setTitle(chat?.title ?? '');
    setRenameError(null);
    setUnconfirmed(null);
  };
  async function archive(chat: Chat, nextArchived: boolean) {
    setPending(chat.id);
    setNotice(null);
    try {
      await api.command(
        { kind: 'archive', chatId: chat.id, commandId: crypto.randomUUID(), archived: nextArchived },
        new AbortController().signal,
      );
      setNotice({
        text: nextArchived ? `“${chat.title}” archived.` : `“${chat.title}” restored.`,
        undo: { chat, archived: !nextArchived },
      });
      void list.refresh();
    } catch {
      setNotice({
        text: `Could not ${nextArchived ? 'archive' : 'restore'} “${chat.title}”. Refresh the list and try again.`,
        error: true,
      });
    } finally {
      setPending(null);
    }
  }
  async function remove(chat: Chat) {
    setPending(chat.id);
    setNotice(null);
    try {
      await api.command(
        { kind: 'delete', chatId: chat.id, commandId: crypto.randomUUID() },
        new AbortController().signal,
      );
      void list.refresh();
    } catch {
      setNotice({ text: `Could not delete “${chat.title}”. Refresh the list and try again.`, error: true });
    } finally {
      setPending(null);
    }
  }
  async function rename(chat: Chat) {
    if (titleValidation) return;
    setPending(chat.id);
    setNotice(null);
    setRenameError(null);
    // Saving the same title again resends the unconfirmed command, so the server replays a rename that already landed instead of refusing it as stale.
    const retry = unconfirmed?.chatId === chat.id && unconfirmed.title === title.trim();
    const command = retry
      ? unconfirmed
      : {
          kind: 'rename' as const,
          chatId: chat.id,
          commandId: crypto.randomUUID(),
          title: title.trim(),
          expectedRevision: chat.titleRevision,
        };
    try {
      await api.command(command, requestSignal());
      startEditing(null);
      void list.refresh();
    } catch (error) {
      const uncertain = !(error instanceof TableRequestError) || error.status >= 500;
      if (uncertain) setUnconfirmed(command);
      else if (retry) setUnconfirmed(null);
      setRenameError(renameFailure(error, !retry && unconfirmed?.chatId === chat.id));
      if (uncertain || error.status === 409) void list.refresh();
    } finally {
      setPending(null);
    }
  }
  return (
    <div role="region" aria-label="Chat list" className="min-h-0 flex-1 overflow-y-auto pb-24">
      <PageContent>
        <PageHeader
          titleRef={listHeading}
          focusable
          title="Chats"
          description={
            projectId
              ? `Shared with everyone in ${project?.name ?? 'this project'}. Most recently active first.`
              : 'Only you can see these chats. Most recently active first.'
          }
          actions={
            <Button
              nativeButton={false}
              disabled={!!project?.archived}
              render={
                <Link
                  to="/$workspaceSlug"
                  params={{ workspaceSlug }}
                  search={projectId ? { project: projectId } : {}}
                />
              }
            >
              New chat
            </Button>
          }
        />
        <div role="group" aria-label="Chat filters" className="flex flex-wrap items-center gap-3">
          <form
            id="chat-list-search"
            className="w-full max-w-sm"
            onSubmit={event => {
              event.preventDefault();
              setPages(1);
              setSearch(query.trim());
            }}
          >
            <InputGroup>
              <InputGroupAddon>
                <Search3 size={14} aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                ref={searchInput}
                id="chat-search"
                aria-label="Search chat titles"
                placeholder="Search chat titles"
                value={query}
                maxLength={640}
                onChange={event => setQuery(event.target.value)}
              />
              <InputGroupAddon align="inline-end">
                {(query || search) && (
                  <InputGroupButton
                    size="icon-xs"
                    aria-label="Clear search"
                    onClick={() => {
                      setQuery('');
                      setSearch('');
                      setPages(1);
                      searchInput.current?.focus();
                    }}
                  >
                    <XIcon aria-hidden="true" />
                  </InputGroupButton>
                )}
              </InputGroupAddon>
            </InputGroup>
          </form>
          <div className="flex flex-wrap items-center gap-3">
            {(projectList.length > 0 || projectId) && (
              <ProjectScopeSelect
                id="chat-project"
                label="Show chats from"
                state={projects.state}
                refresh={projects.refresh}
                value={projectId}
                includeArchived
                onChange={showProject}
              />
            )}
            <div role="group" aria-label="Chat status" className="flex gap-1 rounded-lg bg-muted p-1">
              <Button
                variant={archived ? 'ghost' : 'outline'}
                aria-label="Active chats"
                aria-pressed={!archived}
                onClick={() => {
                  setArchived(false);
                  setPages(1);
                }}
              >
                Active
              </Button>
              <Button
                variant={archived ? 'outline' : 'ghost'}
                aria-label="Archived chats"
                aria-pressed={archived}
                onClick={() => {
                  setArchived(true);
                  setPages(1);
                }}
              >
                Archived
              </Button>
            </div>
          </div>
        </div>
        {list.state.kind === 'unavailable' && (
          <StatePanel
            kind="unavailable"
            icon={ChatRound}
            title="Project unavailable"
            description="This project is missing, or you are no longer a member. Your personal chats are still here."
          >
            <Button variant="outline" onClick={() => showProject(null)}>
              Show personal chats
            </Button>
          </StatePanel>
        )}
        <div className="space-y-4">
          {notice && (
            <Alert variant={notice.error ? 'destructive' : 'default'}>
              <AlertDescription>
                <div className="flex flex-wrap items-center gap-2">
                  <span>{notice.text}</span>
                  {notice.undo && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending !== null}
                      onClick={() => void archive(notice.undo!.chat, notice.undo!.archived)}
                    >
                      Undo
                    </Button>
                  )}
                </div>
              </AlertDescription>
            </Alert>
          )}
          <ConversationRead state={list.state} refresh={list.refresh}>
            {data => (
              <>
                {data.chats.length === 0 ? (
                  search ? (
                    <StatePanel
                      kind="empty"
                      icon={ChatRound}
                      title="No matching chats"
                      description="Try another title or clear your search."
                    >
                      <Button
                        variant="outline"
                        onClick={() => {
                          setQuery('');
                          setSearch('');
                          setPages(1);
                        }}
                      >
                        Clear search
                      </Button>
                    </StatePanel>
                  ) : archived ? (
                    <StatePanel
                      kind="empty"
                      icon={ChatRound}
                      title="No archived chats"
                      description="Chats you archive will appear here. Open one to restore it."
                    >
                      <Button
                        variant="outline"
                        onClick={() => {
                          setArchived(false);
                          setPages(1);
                        }}
                      >
                        Show active chats
                      </Button>
                    </StatePanel>
                  ) : projectId ? (
                    <StatePanel
                      kind="empty"
                      icon={ChatRound}
                      title="No chats in this project yet"
                      description="Start a chat that everyone in this project can read, or move a personal chat here from its chat menu."
                    >
                      {!project?.archived && (
                        <Button
                          nativeButton={false}
                          render={
                            <Link to="/$workspaceSlug" params={{ workspaceSlug }} search={{ project: projectId }} />
                          }
                        >
                          <Add size={16} aria-hidden="true" />
                          Start a project chat
                        </Button>
                      )}
                    </StatePanel>
                  ) : (
                    <StatePanel
                      kind="empty"
                      icon={ChatRound}
                      title="No chats yet"
                      description="Ask about your customers, orders, or invoices in plain language. Every private conversation is saved here so you can pick it up later."
                      sample={<ChatsSample />}
                    >
                      <Button nativeButton={false} render={<Link to="/$workspaceSlug" params={{ workspaceSlug }} />}>
                        <Add size={16} aria-hidden="true" />
                        Start a chat
                      </Button>
                    </StatePanel>
                  )
                ) : (
                  <DataList aria-label="Chats" columns="chats" headings={['Chat', 'Actions']}>
                    {data.chats.map(chat => (
                      <DataListRow key={chat.id}>
                        <DataListCell>
                          <div className="grid w-full min-w-0 gap-1">
                            {editing?.id === chat.id ? (
                              <form
                                className="grid min-w-0 gap-1"
                                onSubmit={event => {
                                  event.preventDefault();
                                  void rename(chat);
                                }}
                              >
                                <div className="flex min-w-0 flex-wrap gap-2">
                                  <div className="min-w-0 flex-1 basis-40">
                                    <Input
                                      autoFocus
                                      aria-label="Chat title"
                                      value={title}
                                      maxLength={640}
                                      aria-invalid={!!(titleValidation ?? renameError)}
                                      aria-describedby={
                                        (titleValidation ?? renameError) ? 'chat-title-error' : undefined
                                      }
                                      onChange={event => {
                                        setTitle(event.target.value);
                                        setRenameError(null);
                                      }}
                                      onKeyDown={event => {
                                        if (event.key === 'Escape') {
                                          event.preventDefault();
                                          startEditing(null);
                                        }
                                      }}
                                    />
                                  </div>
                                  <Button type="submit" size="sm" disabled={pending === chat.id || !!titleValidation}>
                                    {pending === chat.id ? 'Saving…' : renameError ? 'Save again' : 'Save'}
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    disabled={pending === chat.id}
                                    onClick={() => startEditing(null)}
                                  >
                                    Cancel
                                  </Button>
                                </div>
                                {(titleValidation ?? renameError) && (
                                  <p id="chat-title-error" role="alert" className="text-sm text-destructive">
                                    {titleValidation ?? renameError}
                                  </p>
                                )}
                                {chat.titleRevision !== editing.titleRevision && (
                                  <p className="break-words text-sm text-muted-foreground">
                                    Current title: “{chat.title}”
                                  </p>
                                )}
                              </form>
                            ) : (
                              <DataListButton
                                weight="strong"
                                onClick={() => open(chat.id)}
                                aria-label={chat.title}
                                title={chat.title}
                              >
                                {chat.title}
                              </DataListButton>
                            )}
                            <time
                              className="flex flex-wrap gap-x-2 text-xs text-muted-foreground tabular-nums"
                              dateTime={chat.activityAt}
                              title={new Date(chat.activityAt).toLocaleString()}
                              aria-label={`Last activity: ${new Date(chat.activityAt).toLocaleString()}`}
                            >
                              <span>{chatActivityDate(chat.activityAt)}</span>
                              <span>
                                {new Date(chat.activityAt).toLocaleTimeString(undefined, {
                                  hour: 'numeric',
                                  minute: '2-digit',
                                })}
                              </span>
                            </time>
                          </div>
                        </DataListCell>
                        <DataListActions>
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              disabled={pending === chat.id}
                              render={
                                <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${chat.title}`} />
                              }
                            >
                              <MoreH size={16} aria-hidden="true" />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" size="menu">
                              <DropdownMenuItem onClick={() => startEditing(chat)}>
                                <Edit size={14} aria-hidden="true" />
                                Rename
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => void archive(chat, !chat.archived)}>
                                <Archive size={14} aria-hidden="true" />
                                {chat.archived ? 'Restore' : 'Archive'}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem variant="destructive" onClick={() => setDeleting(chat)}>
                                <Trash size={14} aria-hidden="true" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </DataListActions>
                      </DataListRow>
                    ))}
                  </DataList>
                )}
                {data.nextCursor && (
                  <Button variant="outline" disabled={!listReady} onClick={() => setPages(value => value + 1)}>
                    Load more chats
                  </Button>
                )}
              </>
            )}
          </ConversationRead>
        </div>
      </PageContent>
      <AlertDialog
        open={!!deleting}
        onOpenChange={open => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
          <AlertDialogDescription>
            This cannot be undone. The chat disappears now and is retained for 30 days before it is permanently removed.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep chat</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting) void remove(deleting);
                setDeleting(null);
              }}
            >
              Delete chat
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type RenameCommand = Extract<ConversationCommand, { kind: 'rename' }>;

/** `earlierUnconfirmed`: a different rename of this chat may have landed, so a stale revision cannot be blamed on someone else. */
function renameFailure(error: unknown, earlierUnconfirmed: boolean) {
  if (!(error instanceof TableRequestError) || error.status >= 500)
    return 'The rename was not confirmed. Your title is kept. Save again, or cancel to keep the current title.';
  if (error.code === 'title-conflict')
    return `${earlierUnconfirmed ? 'The title changed after you started editing, possibly by your earlier save.' : 'Someone else renamed this chat.'} Your title is kept. Save again to replace the current title, or cancel to keep it.`;
  return `${error.message.replace(/ Your draft is (kept|retained)\.$/, '')} Your title is kept.`;
}

function chatActivityDate(value: string) {
  const date = new Date(value);
  const today = new Date();
  const days = Math.round(
    (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) -
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) /
      86400000,
  );
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}
