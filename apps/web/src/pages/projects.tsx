import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import { chatDocumentText, type ChatDocument } from '@tulipfarm/conversations/rich-content';
import { parseChatDraft, type ChatDraft } from '@/features/chat/editor-document';
import { flushSync } from 'react-dom';
import { Link, useNavigate } from '@tanstack/react-router';
import { Add } from 'reicon-react/icons/Add';
import { DocumentText } from 'reicon-react/icons/DocumentText';
import { Folder } from 'reicon-react/icons/Folder';
import { MoreH } from 'reicon-react/icons/MoreH';
import { People } from 'reicon-react/icons/People';
import { Settings } from 'reicon-react/icons/Settings';
import { Upload as UploadIcon } from 'reicon-react/icons/Upload';
import { workspaceRoute, workspaceProjectsRoute, projectDetailRoute, projectSettingsRoute } from '@/router';
import { Alert, AlertDescription, AlertTitle } from '@tulipfarm/sprout/alert';
import { AttachmentDropzone, FileTypeIcon } from '@tulipfarm/sprout/attachment';
import { formatFileSize } from '@/lib/file-viewer';
import { knowledgeGapSummary } from '@/features/files/knowledge-labels';
import { DataList, DataListCell, DataListLink, DataListRow, DataListSecondary } from '@/components/data-list';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@tulipfarm/sprout/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@tulipfarm/sprout/alert-dialog';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { ProjectsSample, StatePanel } from '@tulipfarm/sprout/state-panel';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { useUrlDraft } from '@/features/tables/row-query';
import { Textarea } from '@tulipfarm/sprout/textarea';
import type { RichTextEditorHandle } from '@tulipfarm/sprout/rich-text-editor';
import { ReadFeedback, ReadError } from '@/components/read-feedback';
import { UnsavedChanges, WriteFeedback } from '@/features/tables/feedback';
import { useTableWrite } from '@/features/tables/use-table-write';
import { confirmedRejection, type ReadState } from '@/features/tables/request-state';
import { useFeatureScope } from '@/lib/query';
import {
  conversationApi,
  draftConversationApi,
  textError,
  type ConversationPart,
} from '@/features/chat/conversation-api';
import { ChatModelStatus, useChatModels } from '@/features/chat/chat-models';
import { useIntegrationKeywords } from '@/features/integrations/keywords';
import { Composer } from '@/features/chat/composer';
import { StagedAttachments, useConversationAttachments } from '@/features/chat/conversation-attachments';
import { useConversationCommand } from '@/features/chat/conversation-state';
import { CommandFeedback } from '@/features/chat/conversation-feedback';
import { emptyChatDocument } from '@/features/chat/editor-extensions';
import { useConversationChanges, useConversationList } from '@/features/chat/queries';
import type {
  Project,
  ProjectApi,
  ProjectDetail,
  ProjectEdit,
  ProjectFile,
  ProjectMember,
} from '@/features/projects/api';
import {
  isDirty,
  keepEdits,
  rebaseDraft,
  saveCommand,
  startDraft,
  type DraftField,
  type ProjectText,
} from '@/features/projects/draft';
import {
  useProject,
  useProjectApi,
  useProjectCandidates,
  useProjectChanges,
  useProjects,
  useProjectSource,
} from '@/features/projects/queries';
import {
  addedMessage,
  confirmUploads,
  projectUploads,
  queueUploads,
  uploadLabels,
  uploadSummary,
  type Upload,
} from '@/features/projects/uploads';

function ProjectRead<T>({
  state,
  refresh,
  label,
  children,
}: {
  state: ReadState<T>;
  refresh: () => Promise<void>;
  label: string;
  children: (data: T) => ReactNode;
}) {
  const { workspaceSlug } = workspaceRoute.useParams();
  return (
    <ReadFeedback
      state={state}
      errorTitle={`Could not load ${label}`}
      retry={
        <Button variant="outline" onClick={() => void refresh()}>
          Retry
        </Button>
      }
      loading={
        <div role="status" aria-label={`Loading ${label}`} className="space-y-4 py-2">
          <Skeleton />
          <Skeleton />
          <Skeleton />
          <span className="sr-only">Loading {label}…</span>
        </div>
      }
      unavailable={() => (
        <StatePanel
          kind="unavailable"
          title="Project unavailable"
          description="This project is missing, or you are no longer a member. A project manager can add you."
        >
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link to="/$workspaceSlug/projects" params={{ workspaceSlug }} />}
          >
            Back to projects
          </Button>
          <Button variant="ghost" onClick={() => void refresh()}>
            Check access again
          </Button>
        </StatePanel>
      )}
      refreshError={message => (
        <ReadError message={`${message} The last loaded version is still shown.`}>
          <Button variant="outline" onClick={() => void refresh()}>
            Retry refresh
          </Button>
        </ReadError>
      )}
      refreshing={<p role="status">Refreshing {label}…</p>}
    >
      {children}
    </ReadFeedback>
  );
}

export function ProjectsPage() {
  const { workspace } = workspaceRoute.useRouteContext();
  const api = useProjectApi(workspace.id);
  const read = useProjects(api);
  const search = workspaceProjectsRoute.useSearch();
  const creating = search.new === true;
  const navigate = useNavigate();
  const setCreating = (open: boolean) => {
    void navigate({
      to: '/$workspaceSlug/projects',
      params: { workspaceSlug: workspace.slug },
      search: current => ({ ...current, new: open ? true : undefined }),
      replace: true,
    });
  };
  const filter = (next: ListSearch) => {
    void navigate({
      to: '/$workspaceSlug/projects',
      params: { workspaceSlug: workspace.slug },
      search: current => ({ ...current, ...next }),
      replace: true,
    });
  };
  const create = (
    <Button onClick={() => setCreating(true)}>
      <Add size={16} aria-hidden="true" />
      New project
    </Button>
  );
  return (
    <PageContent>
      <PageHeader
        title="Projects"
        description="Shared spaces for a team's chats, files, and instructions. Only project members can open a project."
        actions={create}
      />
      <CreateProjectDialog api={api} open={creating} onOpenChange={setCreating} />
      <ProjectRead state={read.state} refresh={read.refresh} label="projects">
        {projects => {
          if (!projects.length)
            return (
              <StatePanel
                kind="empty"
                icon={Folder}
                title="No projects yet"
                description="Create a project for work that several people share, like a product launch. Add the people, files, and instructions every chat in it should use."
                sample={<ProjectsSample />}
              >
                {create}
              </StatePanel>
            );
          return (
            <ProjectCatalog
              projects={projects}
              query={search.q ?? ''}
              archived={search.archived === true}
              filter={filter}
            />
          );
        }}
      </ProjectRead>
    </PageContent>
  );
}

type ListSearch = { q?: string | undefined; archived?: true | undefined };
const listSearches = new Map<string, ListSearch>();
const listSearch = (workspaceSlug: string, archived?: boolean): ListSearch =>
  listSearches.get(workspaceSlug) ?? (archived ? { archived: true } : {});

function ProjectCatalog({
  projects,
  query,
  archived,
  filter,
}: {
  projects: Project[];
  query: string;
  archived: boolean;
  filter: (next: ListSearch) => void;
}) {
  const { workspace } = workspaceRoute.useRouteContext();
  useEffect(() => {
    listSearches.set(workspace.slug, { q: query || undefined, archived: archived || undefined });
  }, [workspace.slug, query, archived]);
  const [draft, setDraft] = useUrlDraft(query, next => filter({ q: next.trim() || undefined }));
  const named = (project: Project) => project.name.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  const shelf = projects.filter(project => project.archived === archived),
    matches = shelf.filter(named);
  const otherMatches = query ? projects.filter(project => project.archived !== archived && named(project)).length : 0;
  const hasArchived = projects.some(project => project.archived);
  const title = archived ? 'Archived projects' : 'Active projects';
  const clear = () => {
    setDraft('');
    filter({ q: undefined });
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-60 flex-1">
          <SearchField
            id="project-search"
            label="Search projects"
            placeholder={archived ? 'Search archived projects' : 'Search active projects'}
            value={draft}
            maxLength={255}
            onChange={setDraft}
          />
        </div>
        {(hasArchived || archived) && (
          <div role="group" aria-label="Project status" className="flex flex-wrap gap-2">
            <Button
              variant={archived ? 'ghost' : 'secondary'}
              aria-pressed={!archived}
              onClick={() => filter({ archived: undefined })}
            >
              Active
            </Button>
            <Button
              variant={archived ? 'secondary' : 'ghost'}
              aria-pressed={archived}
              onClick={() => filter({ archived: true })}
            >
              Archived
            </Button>
          </div>
        )}
      </div>
      {query && matches.length > 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {matches.length === 1 ? '1 project matches' : `${matches.length} projects match`} “{query}”.
        </p>
      )}
      {query && !matches.length ? (
        <StatePanel
          kind="empty"
          icon={Folder}
          title={`No ${archived ? 'archived' : 'active'} projects match “${query}”`}
          description={
            otherMatches
              ? `${otherMatches} ${archived ? 'active' : 'archived'} ${otherMatches === 1 ? 'project matches' : 'projects match'} this name.`
              : 'Search checks project names. Try another name or clear the search.'
          }
        >
          <Button variant="outline" onClick={clear}>
            Clear search
          </Button>
          {otherMatches > 0 && (
            <Button variant="ghost" onClick={() => filter({ archived: archived ? undefined : true })}>
              Show {archived ? 'active' : 'archived'} matches
            </Button>
          )}
        </StatePanel>
      ) : (
        <ProjectSection
          title={title}
          projects={matches}
          empty={
            archived ? 'No archived projects.' : 'All your projects are archived. Restore one, or create a new project.'
          }
        />
      )}
    </div>
  );
}

function ProjectSection({ title, projects, empty }: { title: string; projects: Project[]; empty?: string }) {
  const { workspaceSlug } = workspaceRoute.useParams();
  return (
    <section className="min-w-0 space-y-2">
      <h2 className="text-sm font-medium">{title}</h2>
      {projects.length ? (
        <DataList aria-label={title} columns="three" headings={['Name', 'Instructions', 'Your access']}>
          {projects.map(project => (
            <DataListRow key={project.id}>
              <DataListCell>
                <DataListLink
                  render={
                    <Link to="/$workspaceSlug/projects/$projectId" params={{ workspaceSlug, projectId: project.id }} />
                  }
                >
                  {project.name}
                </DataListLink>
                {project.archived && <Badge variant="secondary">Archived</Badge>}
              </DataListCell>
              <DataListSecondary>{project.instructions || 'No instructions yet.'}</DataListSecondary>
              <DataListCell>{project.manager ? 'Manager' : 'Member'}</DataListCell>
            </DataListRow>
          ))}
        </DataList>
      ) : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
    </section>
  );
}

function CreateProjectDialog({
  api,
  open,
  onOpenChange,
}: {
  api: ProjectApi;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { workspaceSlug } = workspaceRoute.useParams();
  const navigate = useNavigate();
  const changed = useProjectChanges();
  const [name, setName] = useState('');
  const [id, setId] = useState(() => crypto.randomUUID());
  const write = useTableWrite(
    async (input: { id: string; name: string }) => {
      const project = await api.create(input.id, input.name);
      void changed(project.id);
      return project;
    },
    project => {
      setName('');
      setId(crypto.randomUUID());
      void navigate({ to: '/$workspaceSlug/projects/$projectId', params: { workspaceSlug, projectId: project.id } });
    },
  );
  const busy = write.state.kind === 'sending';
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!busy) {
          onOpenChange(next);
          write.reset();
        }
      }}
    >
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            You become its manager. You can add members, files, and instructions next.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={event => {
            event.preventDefault();
            if (!busy && name.trim()) void write.submit({ id, name: name.trim() });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="project-name">Project name</Label>
            <Input
              id="project-name"
              autoFocus
              value={name}
              maxLength={160}
              required
              disabled={busy}
              placeholder="For example, Spring launch"
              onChange={event => setName(event.target.value)}
            />
          </div>
          <WriteFeedback
            state={write.state}
            checkStatus={() => void changed()}
            retry={input => void write.submit(input)}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()} aria-busy={busy}>
              Create project
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProjectPage({
  projectId,
  title,
  children,
}: {
  projectId: string;
  title: string;
  children: (api: ProjectApi, detail: ProjectDetail, refresh: () => Promise<void>) => ReactNode;
}) {
  const { workspace } = workspaceRoute.useRouteContext();
  const api = useProjectApi(workspace.id);
  const read = useProject(api, projectId);
  return (
    <PageContent>
      {read.state.kind !== 'ready' && (
        <PageHeader
          back={{
            label: 'Back to projects',
            link: (
              <Link
                to="/$workspaceSlug/projects"
                params={{ workspaceSlug: workspace.slug }}
                search={listSearch(workspace.slug)}
              />
            ),
          }}
          title={title}
        />
      )}
      <ProjectRead state={read.state} refresh={read.refresh} label="project">
        {detail => <Fragment key={projectId}>{children(api, detail, read.refresh)}</Fragment>}
      </ProjectRead>
    </PageContent>
  );
}

export function ProjectDetailPage() {
  return (
    <ProjectPage projectId={projectDetailRoute.useParams().projectId} title="Project">
      {(api, detail, refresh) => <ProjectView api={api} detail={detail} refresh={refresh} />}
    </ProjectPage>
  );
}

export function ProjectSettingsPage() {
  return (
    <ProjectPage projectId={projectSettingsRoute.useParams().projectId} title="Project settings">
      {(api, detail, refresh) => <ProjectSettings api={api} detail={detail} refresh={refresh} />}
    </ProjectPage>
  );
}

function ProjectView({
  api,
  detail,
  refresh,
}: {
  api: ProjectApi;
  detail: ProjectDetail;
  refresh: () => Promise<void>;
}) {
  const { project } = detail;
  const { workspace } = workspaceRoute.useRouteContext();
  const scope = useFeatureScope();
  const canEdit = project.manager && !project.archived;
  const settings = (
    <Link
      to="/$workspaceSlug/projects/$projectId/settings"
      params={{ workspaceSlug: workspace.slug, projectId: project.id }}
    />
  );
  return (
    <>
      <PageHeader
        back={{
          label: 'Back to projects',
          link: (
            <Link
              to="/$workspaceSlug/projects"
              params={{ workspaceSlug: workspace.slug }}
              search={listSearch(workspace.slug, project.archived)}
            />
          ),
        }}
        title={project.name}
        actions={
          <Button variant="ghost" size="sm" nativeButton={false} render={settings}>
            <Settings size={16} aria-hidden="true" />
            {project.manager ? 'Edit project' : 'Project details'}
          </Button>
        }
      />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 pt-6 lg:flex-row">
        <div className="min-w-0 flex-1 space-y-8">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <p aria-hidden="true" className="break-words text-2xl font-medium">
                {project.name}
              </p>
              {project.archived && <Badge variant="secondary">Archived</Badge>}
            </div>
            {project.instructions ? (
              <p className="line-clamp-3 whitespace-pre-wrap break-words text-muted-foreground">
                {project.instructions}
              </p>
            ) : (
              canEdit && (
                <p className="text-sm text-muted-foreground">
                  Tell every chat here how to work.{' '}
                  <span className="text-foreground underline underline-offset-2">
                    <Link
                      to="/$workspaceSlug/projects/$projectId/settings"
                      params={{ workspaceSlug: workspace.slug, projectId: project.id }}
                    >
                      Add instructions
                    </Link>
                  </span>
                </p>
              )
            )}
          </div>
          {project.archived ? (
            <ArchivedNotice api={api} project={project} refresh={refresh} />
          ) : (
            <ProjectComposer
              key={`${workspace.id}:${scope.userId}:${scope.kind === 'workspace' ? scope.membershipId : ''}:${project.id}`}
              project={project}
            />
          )}
          <ProjectChats project={project} />
        </div>
        <aside aria-label="Project context" className="min-w-0 space-y-8 lg:w-68 lg:shrink-0 lg:pt-2">
          <ProjectFiles api={api} project={project} files={detail.files} canEdit={canEdit} refresh={refresh} />
          <ProjectPeople project={project} members={detail.members} settings={settings} />
        </aside>
      </div>
    </>
  );
}

const emptyRichDocument = (): ChatDocument => ({ version: 1, doc: structuredClone(emptyChatDocument) });

function ProjectComposer({ project }: { project: Project }) {
  const { workspace, user } = workspaceRoute.useRouteContext();
  const navigate = useNavigate();
  const changes = useConversationChanges();
  const models = useChatModels(workspace.id, user);
  const integrations = useIntegrationKeywords(workspace.id, workspace.slug);
  const read = useProject(useProjectApi(workspace.id), project.id);
  const base = useMemo(() => conversationApi(workspace.id, () => {}), [workspace.id]);
  const [chatId] = useState(() => crypto.randomUUID());
  const api = useMemo(
    () =>
      draftConversationApi(
        base,
        chatId,
        () => {
          void changes.created(chatId);
        },
        project.id,
      ),
    [base, chatId, changes, project.id],
  );
  const uploads = useConversationAttachments(api, chatId);
  const [content, setContent] = useState<ChatDraft>(emptyRichDocument);
  const [refreshed, setRefreshed] = useState(false);
  const input = useRef<RichTextEditorHandle>(null);
  const reviewing = useRef(false);
  const allowNavigation = useRef(false);
  const write = useConversationCommand(api, () => {
    setContent(emptyRichDocument());
    uploads.clear();
    allowNavigation.current = true;
    void navigate({ to: '/$workspaceSlug/chat/$chatId', params: { workspaceSlug: workspace.slug, chatId } });
  });
  useEffect(() => {
    if (write.state.kind === 'idle' && reviewing.current) {
      reviewing.current = false;
      input.current?.focus();
    }
  }, [write.state.kind]);
  const ready =
    read.state.kind === 'ready' && !read.state.error && !read.state.refreshing && !read.state.data.project.archived;
  const modelReady = models.state.kind === 'ready' && !models.state.error && !models.state.refreshing;
  async function refresh() {
    setRefreshed(false);
    await Promise.all([read.refresh(), models.refresh()]);
    setRefreshed(true);
  }
  const parsed = parseChatDraft(content);
  const text = parsed.success ? chatDocumentText(parsed.data) : '';
  const validation = parsed.success
    ? text
      ? textError(text)
      : null
    : 'This message has unsupported formatting. Remove it before sending.';
  const canSend =
    ready &&
    modelReady &&
    parsed.success &&
    uploads.ready &&
    (text.trim() ? !textError(text) : uploads.files.length > 0) &&
    models.usable &&
    !!models.model;
  function send() {
    if (!parsed.success || !canSend || !models.model || write.locked) return;
    const parts: ConversationPart[] = text.trim() ? [{ kind: 'text', text, content: parsed.data }] : [];
    for (const file of uploads.files) parts.push({ kind: 'attachment', attachmentId: file.id });
    setRefreshed(false);
    void write.submit({
      kind: 'send',
      chatId,
      commandId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      model: models.model.id,
      parts,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  }
  const failed = write.state.kind === 'rejected' || write.state.kind === 'uncertain';
  return (
    <div className="space-y-2">
      <UnsavedChanges
        dirty={write.state.kind !== 'accepted' && (!!text.trim() || uploads.files.length > 0 || write.locked)}
        allowNavigation={allowNavigation}
      />
      <Composer
        content={content}
        inputRef={input}
        onContentChange={setContent}
        onSend={send}
        canSend={canSend}
        placeholder={`New chat in ${project.name}…`}
        disabled={write.locked || !ready}
        sending={write.state.kind === 'sending' || write.state.kind === 'accepted'}
        validation={validation}
        onFiles={uploads.add}
        attachments={
          uploads.files.length || uploads.error ? (
            <StagedAttachments uploads={uploads} disabled={write.locked || !ready} />
          ) : undefined
        }
        model={models.model}
        models={models.choices}
        onModelChange={models.select}
        integrations={{ keywords: integrations.keywords, onConnect: integrations.connect }}
      />
      <CommandFeedback
        write={write}
        refresh={() => void refresh()}
        refreshed={refreshed && ready}
        review={() => {
          reviewing.current = true;
        }}
      />
      <ChatModelStatus catalog={models} slug={workspace.slug} quiet={failed && !refreshed} />
    </div>
  );
}

function ArchivedNotice({
  api,
  project,
  refresh,
}: {
  api: ProjectApi;
  project: Project;
  refresh: () => Promise<void>;
}) {
  return (
    <Alert>
      <AlertTitle>This project is archived</AlertTitle>
      <AlertDescription>
        Members can read its chats and files, but no one can send messages or make changes.
        {project.manager ? '' : ' A project manager can restore it.'}
      </AlertDescription>
      {project.manager && (
        <div className="pt-2">
          <ArchiveButton api={api} project={project} refresh={refresh} />
        </div>
      )}
    </Alert>
  );
}

function ArchiveButton({ api, project, refresh }: { api: ProjectApi; project: Project; refresh: () => Promise<void> }) {
  const changed = useProjectChanges();
  const archive = useTableWrite(
    async (archived: boolean) => {
      const saved = await api.edit(project.id, {
        expectedRevision: project.revision,
        name: project.name,
        instructions: project.instructions,
        archived,
      });
      void changed(project.id);
      return saved;
    },
    () => {},
  );
  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        disabled={archive.state.kind === 'sending'}
        aria-busy={archive.state.kind === 'sending'}
        onClick={() => void archive.submit(!project.archived)}
      >
        {project.archived ? 'Restore project' : 'Archive project'}
      </Button>
      <WriteFeedback
        state={archive.state}
        checkStatus={() => void refresh()}
        retry={value => void archive.submit(value)}
      />
    </div>
  );
}

function ProjectPeople({
  project,
  members,
  settings,
}: {
  project: Project;
  members: ProjectMember[];
  settings: ReactElement;
}) {
  const shown = members.slice(0, 5);
  return (
    <section aria-labelledby="project-people" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id="project-people" className="text-sm font-medium">
          Members
        </h2>
        {project.manager && !project.archived && (
          <Button variant="ghost" size="sm" nativeButton={false} render={settings}>
            Manage
          </Button>
        )}
      </div>
      <ul className="space-y-1.5">
        {shown.map(member => (
          <li key={member.membershipId} className="flex min-w-0 items-center justify-between gap-2 text-sm">
            <span className="truncate">{member.name}</span>
            {member.role === 'manager' && <span className="shrink-0 text-xs text-muted-foreground">Manager</span>}
          </li>
        ))}
      </ul>
      {members.length > shown.length && (
        <p className="text-xs text-muted-foreground">and {members.length - shown.length} more</p>
      )}
      <p className="text-xs text-muted-foreground">Every member can read and reply in this project's chats.</p>
    </section>
  );
}

function ProjectChats({ project }: { project: Project }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const api = useMemo(() => conversationApi(workspace.id, () => {}), [workspace.id]);
  const [pages, setPages] = useState(1);
  const list = useConversationList(api, false, '', pages, project.id);
  return (
    <section aria-labelledby="project-recents" className="space-y-2">
      <h2 id="project-recents" className="text-sm font-medium text-muted-foreground">
        Recents
      </h2>
      <ProjectRead state={list.state} refresh={list.refresh} label="project chats">
        {data =>
          data.chats.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {project.archived
                ? 'No one started a chat before this project was archived.'
                : 'No chats yet. Start one above, or move a personal chat here from its chat menu.'}
            </p>
          ) : (
            <>
              <ul aria-label="Project chats" className="-mx-3 divide-y">
                {data.chats.map(chat => (
                  <li key={chat.id} className="grid min-w-0">
                    <Button
                      variant="ghost"
                      size="lg"
                      nativeButton={false}
                      render={
                        <Link
                          to="/$workspaceSlug/chat/$chatId"
                          params={{ workspaceSlug: workspace.slug, chatId: chat.id }}
                        />
                      }
                      title={chat.title}
                    >
                      <span className="min-w-0 flex-1 truncate">{chat.title}</span>
                      <time dateTime={chat.activityAt} className="shrink-0 text-sm text-muted-foreground">
                        {new Date(chat.activityAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </time>
                    </Button>
                  </li>
                ))}
              </ul>
              {data.nextCursor && (
                <Button variant="outline" onClick={() => setPages(value => value + 1)}>
                  Load more chats
                </Button>
              )}
            </>
          )
        }
      </ProjectRead>
    </section>
  );
}

function ProjectSettings({
  api,
  detail,
  refresh,
}: {
  api: ProjectApi;
  detail: ProjectDetail;
  refresh: () => Promise<void>;
}) {
  const { project } = detail;
  const { workspace } = workspaceRoute.useRouteContext();
  const canEdit = project.manager && !project.archived;
  return (
    <>
      <PageHeader
        back={{
          label: project.name,
          link: (
            <Link
              to="/$workspaceSlug/projects/$projectId"
              params={{ workspaceSlug: workspace.slug, projectId: project.id }}
            />
          ),
        }}
        title={project.manager ? 'Edit project' : 'Project details'}
      />
      <div className="mx-auto w-full max-w-2xl space-y-10 pt-6">
        {project.archived && <ArchivedNotice api={api} project={project} refresh={refresh} />}
        <section aria-labelledby="project-details" className="space-y-3">
          <h2 id="project-details" className="text-base font-medium">
            Details
          </h2>
          <ProjectInstructions api={api} project={project} canEdit={canEdit} refresh={refresh} />
        </section>
        <section aria-labelledby="project-members" className="space-y-3">
          <h2 id="project-members" className="text-base font-medium">
            Members
          </h2>
          <ProjectMembers api={api} project={project} members={detail.members} refresh={refresh} />
        </section>
        {project.manager && !project.archived && (
          <section aria-labelledby="project-archive" className="space-y-3 border-t pt-8">
            <h2 id="project-archive" className="text-base font-medium">
              Archive project
            </h2>
            <p className="text-sm text-muted-foreground">
              Archived projects stay readable, but no one can send messages or change files. A manager can restore it
              later.
            </p>
            <ArchiveButton api={api} project={project} refresh={refresh} />
          </section>
        )}
      </div>
    </>
  );
}

const knowledgeAccept =
  '.txt,.md,.markdown,.json,.jsonl,.yaml,.yml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.c,.h,.cpp,.cs,.sh,.sql,.toml,.ini,.log,.pdf,.docx';

function ProjectFiles({
  api,
  project,
  files,
  canEdit,
  refresh,
}: {
  api: ProjectApi;
  project: Project;
  files: ProjectFile[];
  canEdit: boolean;
  refresh: () => Promise<void>;
}) {
  const changed = useProjectChanges();
  const [pasting, setPasting] = useState(false);
  const [viewing, setViewing] = useState<ProjectFile | null>(null);
  const [message, setMessage] = useState('');
  const scope = useFeatureScope();
  const key = `${scope.kind === 'workspace' ? scope.membershipId : scope.userId} ${project.id}`;
  const batch = useSyncExternalStore(projectUploads.subscribe, () => projectUploads.batch(key));
  type StateChange = { file: ProjectFile; pinned: boolean; removed: boolean };
  const write = useTableWrite(
    async (change: StateChange) => {
      await api.knowledgeState(project.id, change.file.id, { pinned: change.pinned, removed: change.removed });
      void changed(project.id);
      return change;
    },
    change =>
      setMessage(
        change.removed
          ? `${change.file.title} removed.`
          : change.pinned
            ? `${change.file.title} pinned. Chats always include it first.`
            : `${change.file.title} unpinned.`,
      ),
  );
  async function upload(next: readonly Upload[]) {
    setMessage('');
    const done = await projectUploads.send(
      key,
      next,
      async item => {
        await api.upload(project.id, item.id, item.revisionId, item.file);
        void changed(project.id);
      },
      confirmedRejection,
    );
    if (done?.some(item => item.state.kind === 'uncertain')) void changed(project.id);
  }
  const confirmed = confirmUploads(batch.uploads, files);
  const uploading = batch.running;
  useEffect(() => {
    if (uploading) return;
    if (confirmed.length && confirmed.every(item => item.state.kind === 'added')) {
      projectUploads.replace(key, []);
      setMessage(addedMessage(confirmed));
    } else if (confirmed !== batch.uploads) projectUploads.replace(key, confirmed);
  }, [uploading, confirmed, batch.uploads, key]);
  const busy = write.state.kind === 'sending' || uploading;
  const picker = useRef<HTMLInputElement>(null);
  const add = (chosen: File[]) => {
    if (chosen.length) void upload([...confirmed, ...queueUploads(chosen)]);
  };
  return (
    <section aria-labelledby="project-files" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id="project-files" className="text-sm font-medium">
          Files
        </h2>
        {canEdit && files.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger disabled={busy} render={<Button variant="ghost" size="sm" />}>
              <Add size={16} aria-hidden="true" />
              Add
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" size="menu">
              <DropdownMenuItem onClick={() => picker.current?.click()}>
                <UploadIcon size={14} aria-hidden="true" />
                Upload files
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setPasting(true)}>
                <DocumentText size={14} aria-hidden="true" />
                Paste text
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {canEdit && files.length > 0 && (
        <Input
          ref={picker}
          type="file"
          accept={knowledgeAccept}
          multiple
          hidden
          tabIndex={-1}
          aria-hidden
          onChange={event => {
            add(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
      )}
      <p className="text-xs text-muted-foreground">
        Every chat here reads these files. Pinned files come first. Up to 20 MB in total.
      </p>
      {canEdit && files.length === 0 && (
        <div className="space-y-2 pt-1">
          <AttachmentDropzone accept={knowledgeAccept} disabled={busy} onFiles={add} />
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPasting(true)}>
            <DocumentText size={16} aria-hidden="true" />
            Paste text instead
          </Button>
        </div>
      )}
      <ProjectUploads
        uploads={confirmed}
        running={uploading}
        canRetry={canEdit}
        retry={id =>
          void upload(confirmed.map(item => (item.id === id ? { ...item, state: { kind: 'waiting' } } : item)))
        }
        dismiss={() => projectUploads.replace(key, [])}
      />
      {write.state.kind === 'sending' && (
        <p role="status" className="text-sm text-muted-foreground">
          Saving…
        </p>
      )}
      {message && !busy && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <WriteFeedback
        state={write.state}
        checkStatus={() => void refresh()}
        retry={change => void write.submit(change)}
      />
      {files.length === 0 ? (
        !canEdit && <p className="text-sm text-muted-foreground">No files yet. A project manager can add them.</p>
      ) : (
        <ul aria-label="Project files" className="divide-y">
          {files.map(file => (
            <li key={file.id} className="flex min-w-0 items-start gap-2 py-2">
              <FileTypeIcon name={file.filename} mediaType="text/plain" />
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  <p className="min-w-0 truncate text-sm font-medium" title={file.title}>
                    {file.title}
                  </p>
                  {file.pinned && <Badge>Pinned</Badge>}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {formatFileSize(file.bytes)} ·{' '}
                  {file.source ? (
                    <>
                      From <FileSourceLink source={file.source} />
                    </>
                  ) : (
                    <>
                      Updated{' '}
                      {new Date(file.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </>
                  )}
                </p>
                {file.source && !file.source.available && (
                  <p className="text-xs text-warning">
                    Source unavailable. Chats don’t use it.{canEdit ? ' Share the file again, or remove it.' : ''}
                  </p>
                )}
                {file.gaps && file.gaps.count > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {knowledgeGapSummary(file.gaps)} Chats use the rest of the text.
                  </p>
                )}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={busy}
                  render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${file.title}`} />}
                >
                  <MoreH size={16} aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" size="menu">
                  <DropdownMenuItem disabled={file.source?.available === false} onClick={() => setViewing(file)}>
                    View text
                  </DropdownMenuItem>
                  {canEdit && (
                    <>
                      <DropdownMenuItem
                        onClick={() => {
                          setMessage('');
                          void write.submit({ file, pinned: !file.pinned, removed: false });
                        }}
                      >
                        {file.pinned ? 'Unpin' : 'Pin to top'}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => {
                          setMessage('');
                          void write.submit({ file, pinned: false, removed: true });
                        }}
                      >
                        Remove
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      )}
      <PasteTextDialog
        api={api}
        project={project}
        open={pasting}
        onOpenChange={setPasting}
        saved={title => setMessage(`${title} added.`)}
      />
      <Dialog
        open={!!viewing}
        onOpenChange={open => {
          if (!open) setViewing(null);
        }}
      >
        <DialogContent size="form">
          {viewing && <FileSource api={api} project={project} file={viewing} />}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function ProjectUploads({
  uploads,
  running,
  canRetry,
  retry,
  dismiss,
}: {
  uploads: readonly Upload[];
  running: boolean;
  canRetry: boolean;
  retry: (id: string) => void;
  dismiss: () => void;
}) {
  if (!uploads.length) return null;
  return (
    <section aria-label="Uploads" className="space-y-2 rounded-xl border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="text-sm font-medium">
          {uploadSummary(uploads)}
        </p>
        {!running && (
          <Button variant="ghost" size="sm" aria-label="Dismiss upload results" onClick={dismiss}>
            Dismiss
          </Button>
        )}
      </div>
      <ul className="divide-y">
        {uploads.map(upload => (
          <li key={upload.id} className="flex min-w-0 items-center gap-3 py-2">
            <FileTypeIcon name={upload.file.name} mediaType={upload.file.type || 'application/octet-stream'} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm" title={upload.file.name}>
                {upload.file.name}
              </p>
              <p className="text-xs text-muted-foreground">{uploadLabels[upload.state.kind]}</p>
            </div>
            {canRetry && upload.state.kind === 'uncertain' && (
              <Button
                variant="outline"
                size="sm"
                disabled={running}
                aria-label={`Retry adding ${upload.file.name}`}
                onClick={() => retry(upload.id)}
              >
                Retry
              </Button>
            )}
          </li>
        ))}
      </ul>
      {uploads.flatMap(upload =>
        upload.state.kind === 'rejected' || upload.state.kind === 'uncertain'
          ? [
              <Alert key={upload.id} variant="destructive">
                <AlertDescription>
                  {upload.file.name}: {upload.state.message}
                </AlertDescription>
              </Alert>,
            ]
          : [],
      )}
    </section>
  );
}

function FileSourceLink({ source }: { source: NonNullable<ProjectFile['source']> }) {
  const { workspace } = workspaceRoute.useRouteContext();
  if (!source.fileId) return <>a file in Files</>;
  return (
    <span className="underline underline-offset-2 hover:text-foreground">
      <Link
        to="/$workspaceSlug/files/$fileId"
        params={{ workspaceSlug: workspace.slug, fileId: source.fileId }}
        search={{}}
      >
        Files
      </Link>
    </span>
  );
}

function FileSource({ api, project, file }: { api: ProjectApi; project: Project; file: ProjectFile }) {
  const read = useProjectSource(api, project.id, file.revisionId);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{file.title}</DialogTitle>
        <DialogDescription>The text chats read from {file.filename}.</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 overflow-y-auto">
        <ProjectRead state={read.state} refresh={read.refresh} label="file text">
          {source => <pre className="whitespace-pre-wrap break-words font-sans text-sm">{source.content}</pre>}
        </ProjectRead>
      </div>
    </>
  );
}

function PasteTextDialog({
  api,
  project,
  open,
  onOpenChange,
  saved,
}: {
  api: ProjectApi;
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  saved: (title: string) => void;
}) {
  const changed = useProjectChanges();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [ids, setIds] = useState(() => ({ id: crypto.randomUUID(), revisionId: crypto.randomUUID() }));
  const write = useTableWrite(
    async (input: { title: string; content: string }) => {
      const result = await api.saveText(project.id, ids.id, {
        revisionId: ids.revisionId,
        expectedRevision: null,
        ...input,
      });
      void changed(project.id);
      return result;
    },
    () => {
      saved(title.trim());
      setTitle('');
      setContent('');
      setIds({ id: crypto.randomUUID(), revisionId: crypto.randomUUID() });
      onOpenChange(false);
    },
  );
  const busy = write.state.kind === 'sending';
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!busy) {
          onOpenChange(next);
          write.reset();
        }
      }}
    >
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>Paste text</DialogTitle>
          <DialogDescription>Save notes as a project file. Chats in this project can use it.</DialogDescription>
        </DialogHeader>
        <form
          className="min-h-0 space-y-4 overflow-y-auto"
          onSubmit={event => {
            event.preventDefault();
            if (!busy && title.trim() && content.trim()) void write.submit({ title: title.trim(), content });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="knowledge-title">Title</Label>
            <Input
              id="knowledge-title"
              value={title}
              maxLength={255}
              required
              disabled={busy}
              placeholder="For example, Launch brief"
              onChange={event => setTitle(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="knowledge-content">Text</Label>
            <Textarea
              id="knowledge-content"
              value={content}
              rows={10}
              maxLength={1048576}
              required
              disabled={busy}
              onChange={event => setContent(event.target.value)}
            />
          </div>
          <WriteFeedback
            state={write.state}
            checkStatus={() => void changed(project.id)}
            retry={input => void write.submit(input)}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !title.trim() || !content.trim()} aria-busy={busy}>
              Save text
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProjectInstructions({
  api,
  project,
  canEdit,
  refresh,
}: {
  api: ProjectApi;
  project: Project;
  canEdit: boolean;
  refresh: () => Promise<void>;
}) {
  const changed = useProjectChanges();
  const [stored, setStored] = useState(() => startDraft(project));
  const { draft, conflicts } = rebaseDraft(stored, project);
  if (draft !== stored) setStored(draft);
  const write = useTableWrite(
    async (edit: ProjectEdit) => {
      const saved = await api.edit(project.id, edit);
      void changed(project.id);
      return saved;
    },
    saved => setStored(current => (saved.revision > current.base.revision ? startDraft(saved) : current)),
  );
  if (write.state.kind === 'uncertain' && draft.base.revision > write.state.input.expectedRevision) write.reset();
  const save = useRef<HTMLButtonElement>(null);
  const update = (values: Partial<ProjectText>) =>
    setStored(current => ({ ...current, values: { ...current.values, ...values } }));
  const dirty = isDirty(draft);
  const busy = write.state.kind === 'sending';
  const locked = busy || write.state.kind === 'uncertain';
  if (!canEdit)
    return (
      <section aria-label="Project instructions" className="space-y-2 pt-4">
        <p className="text-sm text-muted-foreground">
          Chats in this project follow these instructions.
          {project.manager ? '' : ' Only project managers can change them.'}
        </p>
        <p className="whitespace-pre-wrap break-words">{project.instructions || 'No instructions yet.'}</p>
      </section>
    );
  return (
    <section aria-label="Project instructions" className="space-y-4 pt-4">
      <UnsavedChanges dirty={dirty} />
      <form
        className="space-y-4"
        onSubmit={event => {
          event.preventDefault();
          if (!locked && dirty && !conflicts.length && draft.values.name.trim()) void write.submit(saveCommand(draft));
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="project-rename">Project name</Label>
          <Input
            id="project-rename"
            value={draft.values.name}
            maxLength={160}
            required
            disabled={locked}
            onChange={event => update({ name: event.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="project-instructions">Instructions</Label>
          <Textarea
            id="project-instructions"
            value={draft.values.instructions}
            rows={10}
            disabled={locked}
            placeholder="For example, answer as the launch team. Use the launch brief for dates."
            onChange={event => update({ instructions: event.target.value })}
          />
          <p className="text-sm text-muted-foreground">
            Every new message in this project's chats follows these instructions. They do not grant tools or
            permissions.
          </p>
        </div>
        {conflicts.length > 0 && (
          <DraftConflict
            project={project}
            conflicts={conflicts}
            disabled={busy}
            keep={() => {
              flushSync(() => setStored(keepEdits(draft, project)));
              save.current?.focus();
            }}
          />
        )}
        <WriteFeedback state={write.state} checkStatus={() => void refresh()} retry={edit => void write.submit(edit)} />
        <div className="flex flex-wrap gap-2">
          <Button
            ref={save}
            type="submit"
            disabled={locked || !dirty || conflicts.length > 0 || !draft.values.name.trim()}
            aria-busy={busy}
          >
            Save changes
          </Button>
          {dirty && (
            <Button
              type="button"
              variant="ghost"
              disabled={locked}
              onClick={() => {
                setStored(startDraft(project));
                write.reset();
              }}
            >
              Discard changes
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}

function DraftConflict({
  project,
  conflicts,
  disabled,
  keep,
}: {
  project: Project;
  conflicts: DraftField[];
  disabled: boolean;
  keep: () => void;
}) {
  const saved =
    conflicts.length > 1
      ? 'a new project name and instructions'
      : conflicts[0] === 'name'
        ? 'a new project name'
        : 'new instructions';
  return (
    <div className="space-y-3">
      <Alert>
        <AlertTitle>This project changed while you were editing</AlertTitle>
        <AlertDescription>
          Someone saved {saved}. Your edits are still here. Keep them to save over the newer version, or discard your
          changes to load it.
        </AlertDescription>
      </Alert>
      <dl className="space-y-2 text-sm">
        {conflicts.map(field => (
          <div key={field} className="space-y-1">
            <dt className="font-medium">{field === 'name' ? 'Newer project name' : 'Newer instructions'}</dt>
            <dd className="whitespace-pre-wrap break-words text-muted-foreground">
              {project[field] || 'No instructions.'}
            </dd>
          </div>
        ))}
      </dl>
      <Button type="button" variant="outline" disabled={disabled} onClick={keep}>
        Keep my edits
      </Button>
    </div>
  );
}

function ProjectMembers({
  api,
  project,
  members,
  refresh,
}: {
  api: ProjectApi;
  project: Project;
  members: ProjectMember[];
  refresh: () => Promise<void>;
}) {
  const { user, workspace } = workspaceRoute.useRouteContext();
  const navigate = useNavigate();
  const changed = useProjectChanges();
  const candidates = useProjectCandidates(api, project.manager && !project.archived);
  const [adding, setAdding] = useState('');
  const [role, setRole] = useState<ProjectMember['role']>('member');
  const [message, setMessage] = useState('');
  type Change = {
    membershipId: string;
    role: ProjectMember['role'];
    removed: boolean;
    label: string;
    self: boolean;
    name?: string;
  };
  const [undo, setUndo] = useState<Change | null>(null);
  const [leaving, setLeaving] = useState<Change | null>(null);
  const write = useTableWrite(
    async (input: Change) => {
      await api.member(project.id, { membershipId: input.membershipId, role: input.role, removed: input.removed });
      void changed(input.self && input.removed && !project.manager ? undefined : project.id);
      return input;
    },
    input => {
      if (input.self && input.removed && !project.manager) {
        void navigate({ to: '/$workspaceSlug/projects', params: { workspaceSlug: workspace.slug } });
        return;
      }
      setAdding('');
      setMessage(input.label);
      setUndo(
        input.removed && input.name
          ? {
              membershipId: input.membershipId,
              role: input.role,
              removed: false,
              label: `${input.name} is back in this project as a ${input.role}.`,
              self: false,
            }
          : null,
      );
    },
  );
  const busy = write.state.kind === 'sending';
  const canEdit = project.manager && !project.archived;
  const managers = members.filter(member => member.role === 'manager').length;
  const submit = (input: Change) => {
    setMessage('');
    setUndo(null);
    void write.submit(input);
  };
  return (
    <section aria-label="Project members" className="space-y-4 pt-4">
      <p className="text-sm text-muted-foreground">
        Members can read and reply in every project chat. Managers can also change files, instructions, and members.
      </p>
      {message && !busy && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status" className="text-sm">
            {message}
          </p>
          {undo && canEdit && (
            <Button variant="outline" size="sm" onClick={() => submit(undo)}>
              Undo
            </Button>
          )}
        </div>
      )}
      <AlertDialog
        open={leaving !== null}
        onOpenChange={open => {
          if (!open) setLeaving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>Leave {project.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            You lose access to this project's chats, files, and instructions right away. A project manager must add you
            again before you can return.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay in project</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (leaving) submit(leaving);
                setLeaving(null);
              }}
            >
              Leave project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <WriteFeedback state={write.state} checkStatus={() => void refresh()} retry={input => void write.submit(input)} />
      <ul aria-label="Members" className="divide-y">
        {members.map(member => {
          const self = member.userId === user.id;
          const lastManager = member.role === 'manager' && managers === 1;
          return (
            <li key={member.membershipId} className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0 flex-1 basis-48">
                <p className="break-words font-medium">
                  {member.name}
                  {self && ' (you)'}
                </p>
                {member.email && <p className="break-all text-sm text-muted-foreground">{member.email}</p>}
                {canEdit && lastManager && (
                  <p className="text-sm text-muted-foreground">
                    Make another member a manager before this manager leaves or steps down.
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {canEdit ? (
                  <Select
                    value={member.role}
                    disabled={busy || lastManager}
                    onValueChange={value => {
                      if (value === 'manager' || value === 'member')
                        submit({
                          membershipId: member.membershipId,
                          role: value,
                          removed: false,
                          label: `${member.name} is now a ${value}.`,
                          self,
                        });
                    }}
                  >
                    <SelectTrigger size="sm" aria-label={`Role for ${member.name}`}>
                      <SelectValue>{member.role === 'manager' ? 'Manager' : 'Member'}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="manager">Manager</SelectItem>
                      <SelectItem value="member">Member</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge variant="secondary">{member.role === 'manager' ? 'Manager' : 'Member'}</Badge>
                )}
                {(canEdit || self) && !lastManager && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      self
                        ? setLeaving({
                            membershipId: member.membershipId,
                            role: member.role,
                            removed: true,
                            label: 'You left this project.',
                            self,
                          })
                        : submit({
                            membershipId: member.membershipId,
                            role: member.role,
                            removed: true,
                            label: `${member.name} removed. They can no longer open this project's chats, files, or instructions.`,
                            self,
                            name: member.name,
                          })
                    }
                    aria-label={self ? undefined : `Remove ${member.name}`}
                  >
                    {self ? 'Leave project' : 'Remove'}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {canEdit && (
        <form
          aria-label="Add a member"
          className="space-y-3 border-t pt-4"
          onSubmit={event => {
            event.preventDefault();
            const person =
              candidates.state.kind === 'ready'
                ? candidates.state.data.find(item => item.membershipId === adding)
                : undefined;
            if (person && !busy)
              submit({
                membershipId: person.membershipId,
                role,
                removed: false,
                label: `${person.name} added.`,
                self: false,
              });
          }}
        >
          <h3 className="font-medium">Add a member</h3>
          <ProjectRead state={candidates.state} refresh={candidates.refresh} label="workspace members">
            {people => {
              const available = people.filter(
                person => !members.some(member => member.membershipId === person.membershipId),
              );
              if (!available.length)
                return (
                  <p className="text-sm text-muted-foreground">
                    Everyone in this workspace is already a member. Invite more people from workspace settings.
                  </p>
                );
              const selectedPerson = available.find(person => person.membershipId === adding);
              return (
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-0 space-y-2">
                    <Label htmlFor="project-candidate">Person</Label>
                    <Select value={adding} disabled={busy} onValueChange={value => setAdding(value ?? '')}>
                      <SelectTrigger id="project-candidate">
                        <SelectValue>
                          {selectedPerson
                            ? selectedPerson.email
                              ? `${selectedPerson.name} (${selectedPerson.email})`
                              : selectedPerson.name
                            : 'Choose a person'}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">Choose a person</SelectItem>
                        {available.map(person => (
                          <SelectItem key={person.membershipId} value={person.membershipId}>
                            {person.email ? `${person.name} (${person.email})` : person.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="project-candidate-role">Role</Label>
                    <Select
                      value={role}
                      disabled={busy}
                      onValueChange={value => {
                        if (value === 'manager' || value === 'member') setRole(value);
                      }}
                    >
                      <SelectTrigger id="project-candidate-role">
                        <SelectValue>{role === 'manager' ? 'Manager' : 'Member'}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="manager">Manager</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Button type="submit" disabled={busy || !adding}>
                    <People size={16} aria-hidden="true" />
                    Add member
                  </Button>
                </div>
              );
            }}
          </ProjectRead>
        </form>
      )}
    </section>
  );
}
