import { emptyChatIntro } from './bud-state';
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { chatDocumentReferences, chatDocumentText, type ChatDocument } from '@tulipfarm/conversations/rich-content';
import { parseChatDraft, type ChatDraft } from './editor-document';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { createPortal } from 'react-dom';
import { newChatSearch, workspaceChatRoute, workspaceRoute } from '@/router';
import { ArrowDown } from 'reicon-react/icons/ArrowDown';
import { Danger } from 'reicon-react/icons/Danger';
import { Folder } from 'reicon-react/icons/Folder';
import { ChevronDown } from 'reicon-react/icons/ChevronDown';
import { Sparkle } from 'reicon-react/icons/Sparkle';
import { Alert, AlertDescription, AlertTitle } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { ChatCanvasToggle, ChatWithCanvas } from './canvas-items';
import { CanvasProvider, useCanvas, useResultAttention } from './canvas-state';
import { WorkflowCanvasButton, workflowCanvasItem } from './workflow-canvas';
import { useWorkflowHandoff, WorkflowHandoffNotice } from './workflow-handoff';
import type { WorkflowReference } from '@/features/workflows/workflow-detail';
import { RecordChangesCard, RowViewCard, RowViewResponse } from './records-canvas';
import { recordChangesForTools } from './record-changes';
import { workflowResults } from './workflow-results';
import type { RowView } from '@tulipfarm/conversations/row-view';

import { ChatHeaderContext } from './header-context';
import { Input } from '@tulipfarm/sprout/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@tulipfarm/sprout/popover';
import { Label } from '@tulipfarm/sprout/label';
import { Message, MessageBubble, MessageContent, MessageFooter } from '@tulipfarm/sprout/message';
import { GitHubChatResponse } from './github-download';
import { MessageActions } from '@tulipfarm/sprout/message-actions';
import { ToolActivity } from '@tulipfarm/sprout/tool-activity';
import { SubagentFanout } from './subagent-fanout';
import { toolActivityItems, visibleActivityTools } from './tool-labels';
import { newestTools, reconcileLiveTools, unclaimedToolTurns } from './live-tools';
import { useCurrentReply, type OutgoingMessage } from './current-reply';
import { TypedText } from '@tulipfarm/sprout/typed-text';
import { UnsavedChanges } from '@/features/tables/feedback';
import {
  draftConversationApi,
  textError,
  titleError,
  type Chat,
  type ConversationApi,
  type ConversationMessage,
  type ConversationPart,
  type SkillReference,
} from './conversation-api';
import { ConversationAccess } from './conversation-access';
import { CommandFeedback, ConversationRead } from './conversation-feedback';
import { useConversationCommand } from './conversation-state';
import { useConversationChanges, useConversationHistory } from './queries';
import { useConversationStream } from './use-conversation-stream';
import { ConversationAttachment, StagedAttachments, useConversationAttachments } from './conversation-attachments';
import { Composer } from './composer';
import { ConversationFileReference, ConversationGoogleFileReference, useRichFileMentions } from './file-mentions';
import { ImageCards } from './image-cards';
import { SentSkill, SkillUse, StagedSkill, useRichSkillPicker } from './skill-picker';
import type { RichTextEditorHandle } from '@tulipfarm/sprout/rich-text-editor';
import { emptyChatDocument } from './editor-extensions';
import { RichMessage } from './rich-message';
import { useIntegrationKeywords } from '@/features/integrations/keywords';
import { ChatModelStatus, useChatModels } from './chat-models';
import { useFlag } from '@/lib/feature-flags';
import { StartingTasks } from './starting-tasks';
import { ChatPlans } from './plans';
import { InteractionCard } from './interaction-card';
import { AuthoringDraftCard } from './authoring-draft-card';
import { Welcome } from './welcome';
import { agentApi } from '@/features/agents/api';
import { skillApi } from '@/features/skills/api';
import { TableHandoffNotice, useTableHandoff } from './table-handoff';
import { SlackAction } from '@/features/agents/slack-action';
import { PendingGoogleActions } from './pending-google-actions';
import { CalendarReadCard, ChatGoogleProposal } from './calendar-canvas';
import { GitHubAccountCard } from './github-account-card';
import { GitHubInvestigationCard } from './github-investigation-card';
import { GitHubBatches } from './github-batches';
import { TableProposalCard } from './table-proposal-card';
import { ApprovalDock, ApprovalDockProvider } from './approval-dock';
import { ChoiceDock, ChoiceDockProvider, usePendingQuestion } from './choice-dock';
import { McpChatActions } from '@/features/workspace-mcp/selection';
import { IntegrationLinks } from './integration-links';
import { UpcomingMeetings, showAllMeetingsPrompt } from './upcoming-meetings';
import { CompactionStatus, SentCompact } from './compaction';
import { ChatMaintenance } from './maintenance';
import { compactCommand, compactCommandError, compactsOnRetry, contextFailure } from './compaction-copy';
import { fallbackNote, replyFailure, replyRetrying, retryLabel } from './reply-failure-copy';
import { MoveToProjectDialog, ProjectScopeSelect, useWorkspaceProjects } from '@/features/projects/project-scope';
import { Bud, BudWelcome, budState } from './bud';
import { useBud } from './bud-context';
import { BudPreferences } from './bud-preferences';
import './conversation.css';

const ApprovalPreview = import.meta.env.DEV ? lazy(() => import('./approval-mock')) : null;
const CanvasMockControls = import.meta.env.DEV ? lazy(() => import('./canvas-mock')) : null;
const WorkflowMock = import.meta.env.DEV ? lazy(() => import('@/features/workflows/workflow-mock')) : null;

export function PrivateConversations({ workspaceId }: { workspaceId: string }) {
  const assistant = useBud();
  const chatId = workspaceChatRoute.useParams({ shouldThrow: false })?.chatId;
  if (WorkflowMock && window.location.pathname.startsWith('/workflow-mock/')) {
    return (
      <Suspense fallback={<p role="status">Loading workflow mock...</p>}>
        <WorkflowMock surface="chat" />
      </Suspense>
    );
  }
  if (ApprovalPreview && window.location.pathname.startsWith('/approval-mock/')) {
    return (
      <Suspense fallback={<p role="status">Loading approval mock...</p>}>
        <ApprovalPreview />
      </Suspense>
    );
  }
  if (chatId && assistant?.state?.conversationId === chatId)
    return (
      <section
        aria-label="Private Bud conversation"
        ref={assistant.mainHost}
        className="flex min-h-0 flex-1 flex-col"
      />
    );
  return (
    <ConversationAccess workspaceId={workspaceId}>{api => <ConversationWorkspace api={api} />}</ConversationAccess>
  );
}

export function BudConversation({
  workspaceId,
  chatId,
  headerElement,
  visible,
  compact,
}: {
  workspaceId: string;
  chatId: string;
  headerElement: HTMLDivElement | null;
  visible: boolean;
  compact: boolean;
}) {
  const { user, workspace } = workspaceRoute.useRouteContext();
  const models = useChatModels(workspaceId, user);
  const navigate = useNavigate();
  const openFullChat = useCallback(() => {
    void navigate({ to: '/$workspaceSlug/chat/$chatId', params: { workspaceSlug: workspace.slug, chatId } });
  }, [navigate, workspace.slug, chatId]);
  return (
    <ConversationAccess workspaceId={workspaceId}>
      {api => (
        <CanvasProvider onOpenItem={compact ? openFullChat : undefined}>
          <ApprovalDockProvider>
            <ChoiceDockProvider>
              <ChatWithCanvas enabled={!compact}>
                <PendingGoogleActions workspaceId={workspaceId} slug={workspace.slug} chatId={chatId} />
                <ConversationDetail
                  api={api}
                  chatId={chatId}
                  headerElement={headerElement}
                  models={models}
                  persistent
                  visible={visible}
                  compact={compact}
                />
              </ChatWithCanvas>
            </ChoiceDockProvider>
          </ApprovalDockProvider>
        </CanvasProvider>
      )}
    </ConversationAccess>
  );
}

const emptyRichDocument = (): ChatDocument => ({ version: 1, doc: structuredClone(emptyChatDocument) });
const textDocument = (text: string): ChatDocument => ({
  version: 1,
  doc: { type: 'doc', content: [{ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) }] },
});
const createTablePrompt =
  'Help me create a new table. Ask me what kind of rows it holds (for example, customers or invoices) and which fields I need, then propose the table for my review.';
const newChatPrefillKey = (workspaceId: string) => `tulipfarm:new-chat-prefill:${workspaceId}`;
type NewChatPrefill = {
  source: 'intent' | 'storage';
  prompt: string;
  skill?: { id: string; revision: string };
  workflow?: WorkflowReference;
};

function Greeting() {
  const { user, sessionId } = workspaceRoute.useRouteContext();
  return <Welcome key={`${user.id}:${sessionId}`} name={user.name} />;
}

function ConversationWorkspace({ api }: { api: ConversationApi }) {
  const { workspace, user } = workspaceRoute.useRouteContext();
  const models = useChatModels(workspace.id, user);
  const chatId = workspaceChatRoute.useParams({ shouldThrow: false })?.chatId;
  const { workspaceSlug } = workspaceRoute.useParams();
  const navigate = useNavigate();
  const headerElement = useContext(ChatHeaderContext);
  const project = useSearch({ strict: false, select: search => search.project ?? null });
  const searchIntent = newChatSearch.parse(Object.fromEntries(new URLSearchParams(window.location.search)));
  const skillIntent = {
    intent: searchIntent.intent,
    id: searchIntent.skillId,
    revision: searchIntent.skillRevision,
    version: searchIntent.skillVersion,
  };
  const intent = skillIntent.intent;
  const prefillKey = newChatPrefillKey(workspace.id);
  const storedPrefill = sessionStorage.getItem(prefillKey);
  const tableHandoff = useTableHandoff(
    workspace.id,
    intent === 'edit-table' || intent === 'add-rows' ? intent : null,
    searchIntent.tableId ?? null,
  );
  const workflowHandoff = useWorkflowHandoff(workspace.id, intent === 'edit-workflow', searchIntent.workflowId ?? null);
  const prefill: NewChatPrefill | null =
    intent === 'create-agent'
      ? {
          source: 'intent',
          prompt:
            'Help me create an agent. Read the authoring context and ask only what is still needed about its purpose, instructions, team, skills, access, Slack channels, and scheduled task prompts. Keep it private by default. Prepare the complete setup for my review; do not activate or install anything without my explicit approval.',
        }
      : intent === 'create-skill'
        ? {
            source: 'intent',
            prompt:
              'Help me create a reusable skill. Ask only what you need to know, then prepare a skill package for my review.',
          }
        : intent === 'edit-skill' && skillIntent.id && skillIntent.version
          ? {
              source: 'intent',
              prompt: `Help me edit skill ${skillIntent.id}, starting from saved version ${skillIntent.version}. Read the skill first, ask what I want to change, and preserve unrelated files. Prepare the changes for my review.`,
            }
          : intent === 'use-skill' && skillIntent.id && skillIntent.revision
            ? { source: 'intent', prompt: '', skill: { id: skillIntent.id, revision: skillIntent.revision } }
            : intent === 'create-table'
              ? { source: 'intent', prompt: createTablePrompt }
              : intent === 'create-workflow'
                ? {
                    source: 'intent',
                    prompt:
                      'Help me create a workflow. Ask what should start it, which steps and agents it needs, and who should act. Use configured connected sources when needed. Prepare a workflow draft for my review, without saving or activating it.',
                  }
                : workflowHandoff?.kind === 'ready'
                  ? { source: 'intent', prompt: workflowHandoff.prompt, workflow: workflowHandoff.reference }
                  : tableHandoff?.kind === 'ready'
                    ? { source: 'intent', prompt: tableHandoff.prompt }
                    : storedPrefill === createTablePrompt
                      ? { source: 'storage', prompt: storedPrefill }
                      : null;
  const consumePrefill = (source: NewChatPrefill['source']) => {
    if (source === 'storage') {
      sessionStorage.removeItem(prefillKey);
      return;
    }
    if (intent === 'create-table') sessionStorage.setItem(prefillKey, createTablePrompt);
    // Dropping the handled request from the link keeps this draft mounted, so the draft's leave guard does not apply.
    void navigate({
      to: '/$workspaceSlug',
      params: { workspaceSlug },
      search: project ? { project } : {},
      replace: true,
      ignoreBlocker: true,
    });
  };
  const [draftChatId, setDraftChatId] = useState(() => crypto.randomUUID());
  const previousChatId = useRef(chatId);
  const changes = useConversationChanges();
  const projects = useWorkspaceProjects(workspace.id);
  const draftApi = useMemo(
    () =>
      draftConversationApi(
        api,
        draftChatId,
        () => {
          void changes.created(draftChatId);
        },
        project,
      ),
    [api, changes, draftChatId, project],
  );
  const draft = !chatId;
  const activeChatId = chatId ?? draftChatId;
  const activeApi = chatId && chatId !== draftChatId ? api : draftApi;
  useLayoutEffect(() => {
    if (!chatId && previousChatId.current === draftChatId) setDraftChatId(crypto.randomUUID());
    previousChatId.current = chatId;
  }, [chatId, draftChatId]);
  const scope = (disabled: boolean) => (
    <ProjectScopeSelect
      id="new-chat-project"
      label="Start this chat in"
      badge
      disabled={disabled}
      state={projects.state}
      refresh={projects.refresh}
      value={project}
      onChange={id =>
        void navigate({ to: '/$workspaceSlug', params: { workspaceSlug }, search: id ? { project: id } : {} })
      }
      onNewProject={() =>
        void navigate({ to: '/$workspaceSlug/projects', params: { workspaceSlug }, search: { new: true } })
      }
    />
  );
  return (
    <section aria-label="Personal conversations" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {CanvasMockControls && workspaceSlug === 'canvas-mock' && (
        <Suspense>
          <CanvasMockControls />
        </Suspense>
      )}
      {chatId && <PendingGoogleActions key={chatId} workspaceId={workspace.id} slug={workspaceSlug} chatId={chatId} />}
      <CanvasProvider key={activeChatId}>
        <ApprovalDockProvider>
          <ChoiceDockProvider>
            <ChatWithCanvas>
              <ConversationDetail
                api={activeApi}
                chatId={activeChatId}
                headerElement={headerElement}
                models={models}
                draft={draft}
                draftProjectId={project}
                scope={draft ? scope : undefined}
                prefill={draft ? prefill : null}
                onPrefillApplied={consumePrefill}
                notice={
                  draft && tableHandoff ? (
                    <TableHandoffNotice handoff={tableHandoff} workspaceSlug={workspaceSlug} />
                  ) : draft && workflowHandoff ? (
                    <WorkflowHandoffNotice handoff={workflowHandoff} />
                  ) : null
                }
              />
            </ChatWithCanvas>
          </ChoiceDockProvider>
        </ApprovalDockProvider>
      </CanvasProvider>
    </section>
  );
}

function ConversationDetail({
  api,
  chatId,
  headerElement,
  models,
  draft = false,
  draftProjectId = null,
  scope,
  prefill = null,
  onPrefillApplied,
  notice = null,
  persistent = false,
  visible = true,
  compact = false,
}: {
  api: ConversationApi;
  chatId: string;
  headerElement: HTMLDivElement | null;
  models: ReturnType<typeof useChatModels>;
  draft?: boolean;
  draftProjectId?: string | null;
  scope?: ((disabled: boolean) => ReactNode) | undefined;
  prefill?: NewChatPrefill | null;
  onPrefillApplied?: (source: NewChatPrefill['source']) => void;
  notice?: ReactNode;
  persistent?: boolean;
  visible?: boolean;
  compact?: boolean;
}) {
  const questionPending = usePendingQuestion();
  const { workspace } = workspaceRoute.useRouteContext();
  const [moving, setMoving] = useState(false);
  const projects = useWorkspaceProjects(workspace.id);
  const navigate = useNavigate();
  const { workspaceSlug } = workspaceRoute.useParams();
  const integrations = useIntegrationKeywords(workspace.id, workspaceSlug, draft ? undefined : chatId);
  const [pages, setPages] = useState(1);
  const stream = useConversationStream(api, chatId, !draft);
  const modelFamilies = models.state.kind === 'ready' ? models.state.data.families : [];
  const imagesReader = useFlag('images');
  const read = useConversationHistory(api, chatId, pages, stream.status === 'open');
  const savedData = read.state.kind === 'ready' ? read.state.data : null;
  const data = useMemo(
    () => (savedData ? { ...savedData, messages: reconcileLiveTools(savedData.messages, stream.tools) } : null),
    [savedData, stream.tools],
  );
  const activityTools = visibleActivityTools(newestTools(data?.messages ?? [], stream.tools));
  const incomingTurns = unclaimedToolTurns(data?.messages ?? [], stream.tools);
  useResultAttention(
    'reply',
    !!data?.messages.some(message => message.turn?.status === 'waiting'),
    'Your input is needed in chat',
  );
  useEffect(() => {
    if (!data || !visible || compact) return;
    const previous = document.title;
    document.title = `${data.chat.title} · TulipFarm`;
    return () => {
      document.title = previous;
    };
  }, [data?.chat.title, visible, compact]);
  const sharedChat = draft ? draftProjectId !== null : read.state.kind === 'ready' && !!read.state.data.chat.projectId;
  const privateChat = data !== null && !sharedChat;
  const [content, setContent] = useState<ChatDraft>(emptyRichDocument);
  const [mode, setMode] = useState<'normal' | 'plan'>('normal');
  const contentResult = parseChatDraft(content);
  const validContent = contentResult.success ? contentResult.data : null;
  const text = validContent ? chatDocumentText(validContent) : '';
  const composerInput = useRef<RichTextEditorHandle>(null);
  const canvas = useCanvas();
  const appliedComposer = useRef<string | null>(null);
  const appliedPrefill = useRef<NewChatPrefill['source'] | null>(null);
  const [skillHandoffError, setSkillHandoffError] = useState('');
  useEffect(() => {
    if (!prefill || prefill.skill) {
      appliedPrefill.current = null;
      return;
    }
    if (appliedPrefill.current !== prefill.source) {
      appliedPrefill.current = prefill.source;
      // A link's request that arrives after the person started typing, such as a table handoff they retried, goes before their text so neither is lost.
      if (!text || prefill.source === 'intent') {
        const prompt = textDocument(prefill.prompt);
        setContent(current =>
          text
            ? { ...current, doc: { ...current.doc, content: [...prompt.doc.content, ...(current.doc.content ?? [])] } }
            : prompt,
        );
        // A link can open a new chat before its editor exists; focus once the editor has rendered.
        requestAnimationFrame(() => composerInput.current?.focus());
      }
      onPrefillApplied?.(prefill.source);
      if (prefill.workflow) canvas.show(workflowCanvasItem(workspace.id, prefill.workflow));
    }
  }, [prefill, text, onPrefillApplied]);
  const uploads = useConversationAttachments(api, chatId);
  const mentions = useRichFileMentions(draft ? 'new' : chatId, validContent, composerInput);
  useEffect(() => {
    const request = canvas.composerRequest;
    if (!request || appliedComposer.current === request.id) return;
    appliedComposer.current = request.id;
    const files = request.files.length ? mentions.attach(request.files) : [];
    const chips = (files ?? []).flatMap(file => [
      { type: 'fileReference' as const, attrs: { source: file.source, id: file.id } },
      { type: 'text' as const, text: ' ' },
    ]);
    const paragraphs =
      chips.length || request.prompt
        ? [
            {
              type: 'paragraph' as const,
              content: [...chips, ...(request.prompt ? [{ type: 'text' as const, text: request.prompt }] : [])],
            },
          ]
        : [];
    setContent(current => ({
      ...current,
      doc: { ...current.doc, content: [...paragraphs, ...(current.doc.content ?? [])] },
    }));
    if (window.matchMedia('(max-width: 767px)').matches) canvas.setOpen(false);
    composerInput.current?.focus();
    canvas.consumeComposer(request.id);
  }, [canvas.composerRequest, canvas.consumeComposer]);
  const skills = useRichSkillPicker(workspace.id, composerInput, privateChat || (draft && !sharedChat));
  useEffect(() => {
    if (!prefill?.skill || sharedChat) return;
    const selected = prefill.skill,
      controller = new AbortController();
    void skillApi(workspace.id)
      .read(selected.id, controller.signal)
      .then(
        detail => {
          if (controller.signal.aborted) return;
          if (
            (detail.management &&
              (!detail.management.enabled || detail.management.activeRevision !== selected.revision)) ||
            (!detail.management && detail.revision !== selected.revision)
          ) {
            setSkillHandoffError(
              'This skill version changed or is disabled. Choose an available skill with the / picker.',
            );
          } else {
            skills.stage({
              skillId: selected.id,
              revision: selected.revision,
              name: detail.reviewedDefinition?.name ?? detail.definition.name,
            });
            composerInput.current?.focus();
          }
          onPrefillApplied?.(prefill.source);
        },
        () => {
          if (!controller.signal.aborted) {
            setSkillHandoffError('Could not load the selected skill. Return to Skills and try again.');
            onPrefillApplied?.(prefill.source);
          }
        },
      );
    return () => controller.abort();
  }, [prefill?.skill?.id, prefill?.skill?.revision, sharedChat, workspace.id]);
  const composerExtensions = useMemo(
    () => [skills.extension, ...mentions.extensions],
    [skills.extension, mentions.extensions],
  );
  const picker = skills.suggestion
    ? { id: 'skill-suggestions', activeId: `skill-option-${skills.suggestion.active}`, panel: skills.panel }
    : mentions.suggestion
      ? { id: 'file-suggestions', activeId: `file-option-${mentions.suggestion.active}`, panel: mentions.panel }
      : undefined;
  const [editing, setEditing] = useState<Pick<Chat, 'title' | 'titleRevision'> | null>(null);
  const [refreshed, setRefreshed] = useState(false);
  const [outgoing, setOutgoing] = useState<OutgoingMessage | null>(null);
  const posting = useRef(false);
  const sendNavigation = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const timelineContent = useRef<HTMLDivElement>(null);
  const followLatest = useRef<'following' | 'scrolled' | 'inspecting'>('following');
  const olderScrollHeight = useRef<number | null>(null);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [unseenUpdates, setUnseenUpdates] = useState(false);
  const updateKey = JSON.stringify([
    data?.messages.at(-1)?.id,
    activityTools.map(tool => [tool.id, tool.activityStatus ?? tool.status]),
  ]);
  const lastUpdate = useRef(updateKey);
  useEffect(() => {
    if (lastUpdate.current !== updateKey && followLatest.current !== 'following') setUnseenUpdates(true);
    lastUpdate.current = updateKey;
  }, [updateKey]);
  const focused = useRef(false);
  useEffect(() => {
    if (read.state.kind === 'ready' && !focused.current) {
      if (document.activeElement === document.body) heading.current?.focus();
      focused.current = true;
    }
  }, [read.state.kind]);
  const refresh = async () => {
    await read.refresh();
    setRefreshed(true);
  };
  const write = useConversationCommand(api, command => {
    if (command.kind === 'send') {
      setContent(emptyRichDocument());
      uploads.clear();
      mentions.clear();
      skills.clear();
    }
    if (command.kind === 'rename') setEditing(null);
    read.restart();
    stream.retry();
    setRefreshed(true);
  });
  const submit = (command: Parameters<typeof write.submit>[0]) => {
    setRefreshed(false);
    void write.submit(command);
  };
  const ready = read.state.kind === 'ready' && !read.state.error && !read.state.refreshing;
  // Background polls set refreshing; locking on them would flicker every control.
  const commandFailed = write.state.kind === 'rejected' || write.state.kind === 'uncertain';
  const locked = write.locked || read.state.kind !== 'ready' || !!read.state.error;
  const validation = validContent
    ? text
      ? (textError(text) ?? compactCommandError(text))
      : null
    : 'This message has unsupported formatting. Remove it or use supported formatting before sending.';
  const staged = uploads.files.length > 0 || mentions.references.length > 0 || skills.staged !== null;
  const hasText = !!text.trim();
  // Google decides who can open a Drive file, so a chat other people can read can't use one (the server refuses it too).
  const googleBlocked = sharedChat && mentions.references.some(reference => reference.source === 'google');
  const canSend =
    !!validContent &&
    uploads.ready &&
    !googleBlocked &&
    (hasText ? !textError(text) && !compactCommandError(text) : staged);
  function send() {
    if (locked || !validContent || !canSend || !models.usable || !models.model) return;
    const compact = !draft && !staged ? compactCommand(text) : null;
    if (compact) {
      post(validContent, [{ kind: 'compact', ...compact }], null, []);
      return;
    }
    const parts: ConversationPart[] = skills.staged
      ? [{ kind: 'skill', skillId: skills.staged.skillId, revision: skills.staged.revision }]
      : [];
    if (hasText) parts.push({ kind: 'text', text, content: validContent });
    for (const file of uploads.files) parts.push({ kind: 'attachment', attachmentId: file.id });
    const orderedReferences = chatDocumentReferences(validContent)
      .map(identity =>
        mentions.references.find(reference => reference.source === identity.source && reference.id === identity.id),
      )
      .filter(reference => reference !== undefined);
    for (const reference of orderedReferences)
      parts.push(
        reference.source === 'tulipfarm'
          ? { kind: 'file', fileId: reference.id }
          : {
              kind: 'google-file',
              fileId: reference.id,
              name: reference.name,
              mimeType: reference.mediaType,
              expectedIntegration: reference.binding,
            },
      );
    post(hasText ? validContent : emptyRichDocument(), parts, skills.staged, orderedReferences);
  }
  function pickGitHub(login: string) {
    const reply = `I selected GitHub account ${login}. Continue my previous GitHub request with it.`;
    if (!locked && models.usable) post(textDocument(reply), [{ kind: 'text', text: reply }]);
  }
  function post(
    shown: ChatDocument,
    parts: ConversationPart[],
    skill: SkillReference | null = null,
    references = mentions.references,
  ) {
    if (!models.model || locked || posting.current) return;
    posting.current = true;
    const messageId = crypto.randomUUID();
    if (draft) {
      sendNavigation.current = true;
      void navigate({ to: '/$workspaceSlug/chat/$chatId', params: { workspaceSlug, chatId } }).finally(() => {
        sendNavigation.current = false;
      });
    }
    setOutgoing({ id: messageId, content: structuredClone(shown), references: [...references], skill, at: Date.now() });
    followLatest.current = 'following';
    setRefreshed(false);
    void write
      .submit({
        kind: 'send',
        chatId,
        commandId: crypto.randomUUID(),
        messageId,
        model: models.model.id,
        parts,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        mode,
      })
      .finally(() => {
        posting.current = false;
      });
  }
  const titleValidation = editing ? titleError(editing.title) : null;
  const project =
    data?.chat.projectId && projects.state.kind === 'ready'
      ? projects.state.data.find(item => item.id === data.chat.projectId)
      : undefined;
  const projectArchived = !!project?.archived;
  const sharedProjectId = data?.chat.projectId;
  const projectSharingScope = sharedProjectId
    ? () => (
        <Popover>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="scope"
                size="sm"
                aria-label={`Project sharing details: ${project?.name ?? 'project'}`}
                title="Project sharing details"
              />
            }
          >
            <Folder size={16} aria-hidden="true" />
            <span className="truncate">
              {project?.name ?? 'Project unavailable'}
              {projectArchived ? ' (archived)' : ''}
            </span>
          </PopoverTrigger>
          <PopoverContent side="top" align="start">
            <PopoverTitle>Shared in this project</PopoverTitle>
            <p className="text-sm text-muted-foreground">Project members can read this chat.</p>
            {projectArchived && (
              <p className="text-sm text-muted-foreground">The project is archived, so this chat is read-only.</p>
            )}
            <div className="grid min-w-0 grid-cols-1">
              <Button
                variant="link"
                size="md"
                nativeButton={false}
                render={
                  <Link
                    to="/$workspaceSlug/projects/$projectId"
                    params={{ workspaceSlug, projectId: sharedProjectId }}
                  />
                }
              >
                <span className="min-w-0 flex-1 truncate text-start">{project?.name ?? 'Open project'}</span>
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      )
    : undefined;
  const { pending, turn, thinking, narration, answerText, activity, status, stalledTurn, slowTurn } = useCurrentReply({
    messages: data?.messages,
    outgoing,
    command: write.state.kind,
    stream,
  });
  const currentTool = activityTools.find(tool => (tool.activityStatus ?? tool.status) === 'running');
  const activityLabel =
    currentTool && !status
      ? currentTool.activity?.trim() || currentTool.presentation?.label || toolActivityItems([currentTool])[0]?.label
      : thinking
        ? activity.label
        : null;
  const empty = data?.messages.length === 0 && !pending && incomingTurns.length === 0;
  const latestId = pending?.id ?? data?.messages.at(-1)?.id;
  const firstId = data?.messages.at(0)?.id;
  useLayoutEffect(() => {
    const element = timeline.current;
    if (!element) return;
    if (olderScrollHeight.current !== null) {
      element.scrollTop += element.scrollHeight - olderScrollHeight.current;
      olderScrollHeight.current = null;
    } else if (followLatest.current === 'following') element.scrollTop = element.scrollHeight;
  }, [latestId, firstId, thinking]);
  useLayoutEffect(() => {
    const element = timeline.current;
    const content = timelineContent.current;
    if (!element || !content) return;
    const observer = new ResizeObserver(() => {
      if (followLatest.current === 'following' && olderScrollHeight.current === null)
        element.scrollTop = element.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      className={
        !compact && empty
          ? 'flex min-h-0 flex-1 flex-col overflow-y-auto pt-8 pb-24 sm:pt-16 sm:pb-12'
          : 'flex min-h-0 flex-1 flex-col'
      }
    >
      {!draft && (
        <MoveToProjectDialog
          workspaceId={workspace.id}
          open={moving}
          onOpenChange={setMoving}
          onMove={projectId => submit({ kind: 'move', chatId, commandId: crypto.randomUUID(), projectId })}
        />
      )}
      <UnsavedChanges
        dirty={
          !persistent &&
          (!!text || staged || !!editing || write.state.kind === 'sending' || write.state.kind === 'uncertain')
        }
        allowNavigation={sendNavigation}
      />
      {!compact &&
        headerElement &&
        createPortal(
          <>
            {!empty && !sharedChat && (draft || data) && <Bud state={budState(data?.messages, !!pending, stream)} />}
            {data ? (
              <>
                <h1
                  ref={heading}
                  tabIndex={-1}
                  title={data.chat.title}
                  className="min-w-0 flex-1 truncate text-sm font-medium"
                >
                  <TypedText text={data.chat.title} animate={!data.chat.titleManual && data.chat.titleRevision > 1} />
                </h1>
                {!draft && (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<Button size="icon-sm" variant="ghost" aria-label="Chat actions" title="Chat actions" />}
                    >
                      <ChevronDown size={16} aria-hidden="true" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent size="menu" align="end">
                      <DropdownMenuItem
                        disabled={locked || !!editing}
                        onClick={() => setEditing({ title: data.chat.title, titleRevision: data.chat.titleRevision })}
                      >
                        Edit title
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={locked}
                        onClick={() =>
                          submit({
                            kind: 'archive',
                            chatId,
                            commandId: crypto.randomUUID(),
                            archived: !data.chat.archived,
                          })
                        }
                      >
                        {data.chat.archived ? 'Restore chat' : 'Archive chat'}
                      </DropdownMenuItem>
                      {!data.chat.projectId && !persistent && (
                        <DropdownMenuItem disabled={locked} onClick={() => setMoving(true)}>
                          Move to project
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </>
            ) : (
              <span className="text-sm text-muted-foreground">
                {read.state.kind === 'loading' ? 'Loading chat…' : 'Chat unavailable'}
              </span>
            )}
            <ChatCanvasToggle />
          </>,
          headerElement,
        )}
      <div
        ref={timeline}
        role="region"
        aria-label="Conversation"
        tabIndex={0}
        className={
          compact
            ? 'conversation-timeline min-h-0 flex-1 overflow-y-auto overscroll-contain px-3'
            : empty
              ? 'conversation-timeline shrink-0 px-4 sm:px-6'
              : 'conversation-timeline min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 sm:px-6'
        }
        onScroll={event => {
          const element = event.currentTarget;
          if (followLatest.current !== 'inspecting')
            followLatest.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 80 ? 'following' : 'scrolled';
          setAwayFromLatest(followLatest.current !== 'following');
        }}
      >
        <div
          ref={timelineContent}
          className={
            compact
              ? 'w-full space-y-3 py-3'
              : empty
                ? 'mx-auto w-full max-w-3xl space-y-4 pt-4 pb-3'
                : 'mx-auto w-full max-w-3xl space-y-6 py-6 sm:py-8'
          }
        >
          {data?.chat.archived && (
            <p role="status" className="text-sm text-muted-foreground">
              This chat is archived. Messages remain saved and reply work continues.
            </p>
          )}
          {!draft &&
            data &&
            (data.chat.isClosed ||
              data.messages.some(message =>
                message.parts.some(part => part.kind === 'compaction' && part.trigger === 'inactivity'),
              )) && <ChatMaintenance api={api} chatId={chatId} isClosed={data.chat.isClosed} disabled={locked} />}
          {editing && (
            <form
              className="space-y-2 rounded-lg border p-4"
              onSubmit={event => {
                event.preventDefault();
                if (!locked && !titleValidation)
                  submit({
                    kind: 'rename',
                    chatId,
                    commandId: crypto.randomUUID(),
                    title: editing.title.trim(),
                    expectedRevision: editing.titleRevision,
                  });
              }}
            >
              <Label htmlFor="chat-title">Chat title</Label>
              <Input
                id="chat-title"
                autoFocus
                value={editing.title}
                maxLength={640}
                disabled={locked}
                aria-invalid={!!titleValidation}
                aria-describedby={titleValidation ? 'title-error' : undefined}
                onChange={event => setEditing({ ...editing, title: event.target.value })}
              />
              {titleValidation && (
                <p id="title-error" role="alert">
                  {titleValidation}
                </p>
              )}
              <div className="flex gap-2">
                <Button type="submit" disabled={locked || !!titleValidation}>
                  Save title
                </Button>
                <Button variant="ghost" disabled={write.locked} onClick={() => setEditing(null)}>
                  Cancel title edit
                </Button>
              </div>
            </form>
          )}
          {!draft && <McpChatActions workspaceId={workspace.id} chatId={chatId} />}
          <ConversationRead
            state={read.state.kind === 'ready' && data ? { ...read.state, data } : read.state}
            refresh={read.refresh}
            quiet={commandFailed}
          >
            {history => (
              <>
                {history.nextBefore && (
                  <div className="flex justify-center">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!ready}
                      onClick={() => {
                        olderScrollHeight.current = timeline.current?.scrollHeight ?? null;
                        setPages(value => value + 1);
                      }}
                    >
                      Load older messages
                    </Button>
                  </div>
                )}
                {empty ? (
                  compact ? (
                    <p className="text-sm text-muted-foreground">What can I help you with?</p>
                  ) : (
                    <div className="flex items-center gap-4">
                      {sharedChat ? <Sparkle size={28} aria-hidden="true" /> : <BudWelcome />}
                      <div className="min-w-0 space-y-1">
                        <h2 className="text-2xl font-medium tracking-tight">
                          <Greeting />
                        </h2>
                        <p className="text-base text-pretty text-muted-foreground">{emptyChatIntro(draft)}</p>
                      </div>
                    </div>
                  )
                ) : (
                  <ol aria-label="Messages" className={compact ? 'space-y-3' : 'space-y-8'}>
                    {[
                      ...history.messages.map(message => (
                        <li key={message.turn ? `turn:${message.turn.id}` : message.id} className="space-y-3">
                          <ConversationEntry
                            api={api}
                            chatId={chatId}
                            slug={workspaceSlug}
                            message={message}
                            rowViews={rowViewsForMessage(history.messages, message)}
                            disabled={locked}
                            retryHandoff={compactionId => {
                              if (!locked && models.usable)
                                post(textDocument('Retry handoff'), [{ kind: 'compact', compactionId }], null, []);
                            }}
                            control={kind => {
                              if (message.turn)
                                submit({
                                  kind,
                                  chatId,
                                  commandId: crypto.randomUUID(),
                                  turnId: message.turn.id,
                                  expectedGeneration: message.turn.generation,
                                });
                            }}
                          />
                          <ToolActivity
                            key="activity"
                            variant="transcript"
                            items={toolActivityItems(message.tools)}
                            active={thinking && !!turn && message.turn?.id === turn.id}
                            activityLabel={message.turn?.id === turn?.id ? activityLabel : undefined}
                            onToggle={() => {
                              followLatest.current = 'inspecting';
                              setAwayFromLatest(true);
                            }}
                          />
                          {message.tools.map(tool => {
                            const replyTurn = message.turn;
                            return tool.tool === 'agents.delegate' ? (
                              <SubagentFanout
                                key={`subagents:${tool.id}`}
                                tool={tool}
                                live={stream.subagents?.get(tool.id)}
                                families={modelFamilies}
                                stop={
                                  replyTurn?.status === 'processing'
                                    ? key =>
                                        api.stopSubagent(
                                          chatId,
                                          replyTurn.id,
                                          tool.id,
                                          key,
                                          AbortSignal.timeout(15_000),
                                        )
                                    : undefined
                                }
                              />
                            ) : null;
                          })}
                          <ConversationTools
                            api={api}
                            chatId={chatId}
                            slug={workspaceSlug}
                            message={message}
                            changed={read.refresh}
                            githubLocked={
                              locked ||
                              history.messages.some(
                                item => item.turn && !['completed', 'cancelled', 'blocked'].includes(item.turn.status),
                              )
                            }
                            pickGitHub={pickGitHub}
                            correct={() => composerInput.current?.focus()}
                          />
                        </li>
                      )),
                      pending ? (
                        <li key="pending">
                          <Message align="end">
                            <MessageContent>
                              {pending.skill && <SentSkill skill={pending.skill} />}
                              <MessageBubble variant="secondary">
                                <RichMessage
                                  content={pending.content}
                                  file={reference =>
                                    reference.source === 'tulipfarm' ? (
                                      <ConversationFileReference
                                        workspaceId={workspace.id}
                                        slug={workspaceSlug}
                                        fileId={reference.id}
                                      />
                                    ) : (
                                      (() => {
                                        const item = pending.references.find(
                                          candidate => candidate.source === 'google' && candidate.id === reference.id,
                                        );
                                        return item?.source === 'google' ? (
                                          <ConversationGoogleFileReference
                                            slug={workspaceSlug}
                                            fileId={item.id}
                                            name={item.name}
                                            mimeType={item.mediaType}
                                          />
                                        ) : null;
                                      })()
                                    )
                                  }
                                />
                              </MessageBubble>
                            </MessageContent>
                          </Message>
                        </li>
                      ) : null,
                      ...incomingTurns.map(incoming => (
                        <li key={`turn:${incoming.id}`}>
                          <ToolActivity
                            key="activity"
                            variant="transcript"
                            items={toolActivityItems(incoming.tools)}
                            active={thinking}
                            activityLabel={activityLabel}
                            onToggle={() => {
                              followLatest.current = 'inspecting';
                              setAwayFromLatest(true);
                            }}
                          />
                          {incoming.tools.map(tool =>
                            tool.tool === 'agents.delegate' ? (
                              <SubagentFanout
                                key={`subagents:${tool.id}`}
                                tool={tool}
                                live={stream.subagents?.get(tool.id)}
                                families={modelFamilies}
                                stop={key =>
                                  api.stopSubagent(chatId, incoming.id, tool.id, key, AbortSignal.timeout(15_000))
                                }
                              />
                            ) : null,
                          )}
                        </li>
                      )),
                    ]}
                    {pending && !turn && !incomingTurns.length && (
                      <li>
                        <ToolActivity variant="transcript" items={[]} active={thinking} activityLabel={activityLabel} />
                      </li>
                    )}
                    {answerText ? (
                      <li aria-busy="true">
                        <Message align="start">
                          <MessageContent>
                            <span className="sr-only">TulipFarm said</span>
                            <AssistantText
                              workspaceId={workspace.id}
                              chatId={chatId}
                              text={answerText}
                              rowViews={
                                history.messages.at(-1)
                                  ? rowViewsForMessage(history.messages, history.messages.at(-1)!)
                                  : []
                              }
                            />
                          </MessageContent>
                        </Message>
                      </li>
                    ) : (
                      thinking && (
                        <li aria-busy="true" className="space-y-2">
                          {narration && <p className="text-sm text-muted-foreground">{narration}</p>}
                          {slowTurn && (
                            <div className="flex flex-wrap items-center gap-3">
                              <p role="status" className="text-sm text-muted-foreground">
                                This step is taking longer than usual. The reply continues, or you can stop it.
                              </p>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={locked}
                                onClick={() =>
                                  submit({
                                    kind: 'cancel',
                                    chatId,
                                    commandId: crypto.randomUUID(),
                                    turnId: slowTurn.id,
                                    expectedGeneration: slowTurn.generation,
                                  })
                                }
                              >
                                Stop reply
                              </Button>
                            </div>
                          )}
                        </li>
                      )
                    )}
                    {stalledTurn && (
                      <li>
                        <Alert>
                          <AlertTitle>Reply is taking too long</AlertTitle>
                          <AlertDescription>
                            The reply has not started after 1 minute. Cancel it, then send your message again.
                          </AlertDescription>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={locked}
                              onClick={() =>
                                submit({
                                  kind: 'cancel',
                                  chatId,
                                  commandId: crypto.randomUUID(),
                                  turnId: stalledTurn.id,
                                  expectedGeneration: stalledTurn.generation,
                                })
                              }
                            >
                              Cancel reply
                            </Button>
                          </div>
                        </Alert>
                      </li>
                    )}
                  </ol>
                )}
                {!empty && (
                  <IntegrationLinks
                    workspaceId={workspace.id}
                    slug={workspaceSlug}
                    chatId={chatId}
                    messages={history.messages}
                  />
                )}
                {!draft && !empty && (
                  <ChatPlans
                    workspaceId={workspace.id}
                    chatId={chatId}
                    tools={history.messages.flatMap(message => message.tools)}
                    foreground={visible && !compact}
                    revision={(() => {
                      const last = history.messages.at(-1);
                      return `${last?.id}:${last?.turn?.status}`;
                    })()}
                  />
                )}
              </>
            )}
          </ConversationRead>
          {!draft && data?.hasGitHubProposals && (
            <GitHubBatches
              workspaceId={workspace.id}
              chatId={chatId}
              revision={JSON.stringify(data.messages.map(message => [message.id, message.turn?.status, message.tools]))}
            />
          )}
        </div>
      </div>
      <footer className={compact ? 'shrink-0 px-3 pb-3' : 'shrink-0 px-3 pt-2 pb-3 sm:px-6 sm:pb-5'}>
        <div className="mx-auto w-full max-w-3xl space-y-3">
          {awayFromLatest && (
            <div className="flex justify-center">
              <Button
                size="sm"
                variant="outline"
                aria-label="Jump to latest"
                title="Jump to latest"
                onClick={() => {
                  const element = timeline.current;
                  if (element) element.scrollTop = element.scrollHeight;
                  followLatest.current = 'following';
                  setAwayFromLatest(false);
                  setUnseenUpdates(false);
                }}
              >
                <ArrowDown size={16} aria-hidden="true" />
                {unseenUpdates ? 'New updates' : 'Jump to latest'}
              </Button>
            </div>
          )}
          <CommandFeedback
            write={write}
            refreshed={refreshed && ready}
            refresh={() => void refresh()}
            review={() => {
              if (editing && read.state.kind === 'ready')
                setEditing({ ...editing, titleRevision: read.state.data.chat.titleRevision });
            }}
          />
          {skillHandoffError && (
            <Alert variant="destructive">
              <AlertDescription>{skillHandoffError}</AlertDescription>
            </Alert>
          )}
          {notice}
          <div data-slot="conversation-input" className={questionPending ? 'space-y-1' : 'space-y-3'}>
            <div
              className={compact ? 'max-h-64 space-y-3 overflow-y-auto overscroll-contain empty:hidden' : 'space-y-3'}
            >
              {!sharedChat && <BudPreferences chatId={chatId} />}
              <ApprovalDock />
              <ChoiceDock />
            </div>
            <Composer
              compact={compact}
              inputRef={composerInput}
              content={pending ? emptyRichDocument() : content}
              onContentChange={setContent}
              onSend={send}
              canSend={!locked && canSend && models.usable}
              placeholder={compact ? 'Reply…' : empty ? 'What would you like to get done?' : 'Reply…'}
              mode={!sharedChat && !compact ? { value: mode, onChange: setMode } : undefined}
              scope={draft && empty ? scope : projectSharingScope}
              onStop={
                turn && !text && !staged
                  ? () =>
                      submit({
                        kind: 'cancel',
                        chatId,
                        commandId: crypto.randomUUID(),
                        turnId: turn.id,
                        expectedGeneration: turn.generation,
                      })
                  : undefined
              }
              disabled={write.locked || projectArchived}
              sending={write.state.kind === 'sending'}
              validation={validation}
              onFiles={uploads.add}
              integrations={{ keywords: integrations.keywords, onConnect: integrations.connect }}
              attachments={
                !pending && (staged || uploads.error || mentions.notice) ? (
                  <div className="space-y-2">
                    {skills.staged && (
                      <StagedSkill skill={skills.staged} disabled={write.locked} onRemove={skills.remove} />
                    )}
                    <StagedAttachments
                      uploads={uploads}
                      disabled={write.locked}
                      reading={
                        imagesReader
                          ? {
                              imageInput:
                                modelFamilies.find(family => family.id === models.model?.id)?.imageInput ?? null,
                            }
                          : undefined
                      }
                      references={{ items: mentions.references, notice: mentions.notice }}
                      blocked={
                        googleBlocked && (
                          <GooglePrivateOnly
                            disabled={write.locked}
                            draft={draft}
                            remove={() => {
                              for (const reference of mentions.references)
                                if (reference.source === 'google') mentions.remove(reference);
                            }}
                            usePrivate={() => {
                              if (draft || mentions.moveGoogleToNewChat())
                                void navigate({
                                  to: '/$workspaceSlug',
                                  params: { workspaceSlug },
                                  search: {},
                                  ignoreBlocker: true,
                                });
                            }}
                          />
                        )
                      }
                    />
                  </div>
                ) : undefined
              }
              extensions={composerExtensions}
              picker={picker}
              model={models.model}
              models={models.choices}
              onModelChange={models.select}
            />
          </div>
          {!compact && empty && (
            <StartingTasks
              disabled={locked || !models.usable || !!text || staged}
              onChoose={prompt => {
                if (!locked && models.usable && !text && !staged)
                  post(textDocument(prompt), [{ kind: 'text', text: prompt }]);
              }}
            />
          )}
          {draft && empty && (
            <div className="pt-6">
              <UpcomingMeetings
                workspaceId={workspace.id}
                disabled={locked || !models.usable || !!text || staged}
                onShowAll={() => {
                  if (!locked && models.usable && !text && !staged)
                    post(textDocument(showAllMeetingsPrompt), [{ kind: 'text', text: showAllMeetingsPrompt }]);
                }}
              />
            </div>
          )}
          <ChatModelStatus
            catalog={models}
            slug={workspaceSlug}
            quiet={commandFailed || (read.state.kind === 'ready' && !!read.state.error)}
          />
          {!compact && !empty && (
            <p className="text-center text-xs text-muted-foreground">
              TulipFarm can make mistakes. Check important details.
            </p>
          )}
        </div>
      </footer>
    </div>
  );
}

const turnLabels = {
  queued: 'Reply queued',
  processing: 'Reply in progress',
  waiting: 'Waiting for you',
  reconciling: 'Reply checking an earlier action',
  failed: 'Reply failed',
  completed: 'Reply completed',
  cancelled: 'Reply cancelled',
  blocked: 'Reply blocked',
};
function GooglePrivateOnly({
  disabled,
  draft,
  usePrivate,
  remove,
}: {
  disabled: boolean;
  draft: boolean;
  usePrivate: () => void;
  remove: () => void;
}) {
  return (
    <Alert>
      <AlertTitle>Google Drive files work only in personal chats</AlertTitle>
      <AlertDescription>
        Google controls who can open them, and other people in this project might not have access. Your draft is kept.
      </AlertDescription>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" disabled={disabled} onClick={usePrivate}>
          {draft ? 'Start a personal chat instead' : 'Move them to a new personal chat'}
        </Button>
        <Button size="sm" variant="outline" disabled={disabled} onClick={remove}>
          Remove Google Drive files
        </Button>
      </div>
    </Alert>
  );
}

function rowViewsForMessage(messages: ConversationMessage[], message: ConversationMessage): RowView[] {
  const source =
    message.author === 'human'
      ? message
      : messages
          .filter(
            item =>
              item.sequence <= message.sequence && (item.author === 'human' || item.tools.some(tool => tool.rowView)),
          )
          .at(-1);
  return source?.tools.flatMap(tool => (tool.status === 'completed' && tool.rowView ? [tool.rowView] : [])) ?? [];
}

function AssistantText({
  workspaceId,
  chatId,
  text,
  rowViews = [],
}: {
  workspaceId: string;
  chatId: string;
  text: string;
  rowViews?: RowView[];
}) {
  return (
    <MessageBubble variant="ghost">
      <RowViewResponse references={rowViews}>
        <GitHubChatResponse workspaceId={workspaceId} chatId={chatId}>
          {text}
        </GitHubChatResponse>
      </RowViewResponse>
    </MessageBubble>
  );
}

// Sprout's MessageActions formats its timestamps on every render; typing in the composer re-renders the whole history.
const EntryActions = memo(function EntryActions({
  text,
  author,
  createdAt,
  entry,
}: {
  text: string;
  author: ConversationMessage['author'];
  createdAt: string;
  entry: RefObject<HTMLDivElement | null>;
}) {
  return (
    <MessageActions
      text={text}
      author={author}
      createdAt={createdAt}
      hover
      html={() => {
        const parts = entry.current?.querySelectorAll('[data-slot=message-bubble]');
        return parts?.length ? [...parts].map(part => part.innerHTML).join('') : undefined;
      }}
    />
  );
});

function ConversationEntry({
  api,
  chatId,
  slug,
  message,
  rowViews,
  disabled,
  retryHandoff,
  control,
}: {
  api: ConversationApi;
  chatId: string;
  slug: string;
  message: ConversationMessage;
  rowViews: RowView[];
  disabled: boolean;
  retryHandoff: (compactionId: string) => void;
  control: (kind: 'retry' | 'cancel') => void;
}) {
  const { workspace } = workspaceRoute.useRouteContext();
  const text = message.parts.flatMap(part => (part.kind === 'text' ? [part.text] : [])).join('\n\n');
  const richPart = message.parts.find(part => part.kind === 'text' && part.content);
  const inlineReferences = new Set(
    richPart?.kind === 'text' && richPart.content
      ? chatDocumentReferences(richPart.content).map(reference => `${reference.source}:${reference.id}`)
      : [],
  );
  const googleParts = new Map(
    message.parts.flatMap(part => (part.kind === 'google-file' ? [[part.fileId, part] as const] : [])),
  );
  const skill = message.parts.find(part => part.kind === 'skill');
  const retrying = message.turn ? replyRetrying(message.turn.status, message.turn.errorCode) : null;
  const answeredBy = message.turn ? fallbackNote(message.turn.status, message.turn.errorCode) : null;
  const quiet =
    !message.turn || (['queued', 'processing', 'completed'].includes(message.turn.status) && !retrying && !answeredBy);
  const entry = useRef<HTMLDivElement>(null);
  return (
    <div className="space-y-3">
      <Message align={message.author === 'human' ? 'end' : 'start'}>
        <MessageContent ref={entry}>
          {message.author === 'assistant' && <span className="sr-only">TulipFarm said</span>}
          {message.parts.map((part, index) => {
            switch (part.kind) {
              case 'request':
              case 'approval':
              case 'approval-resolution':
                return <InteractionCard key={index} api={api} chatId={chatId} reference={part} />;
              case 'response':
                return (
                  <p key={index} className="text-sm text-muted-foreground">
                    A response was recorded. Its answer is shown on the original request card.
                  </p>
                );
              case 'attachment':
                return (
                  <ConversationAttachment key={part.attachmentId} api={api} chatId={chatId} id={part.attachmentId} />
                );
              case 'file':
                return inlineReferences.has(`tulipfarm:${part.fileId}`) ? null : (
                  <ConversationFileReference
                    key={part.fileId}
                    workspaceId={workspace.id}
                    slug={slug}
                    fileId={part.fileId}
                  />
                );
              case 'google-file':
                return inlineReferences.has(`google:${part.fileId}`) ? null : (
                  <ConversationGoogleFileReference
                    key={`google:${part.fileId}`}
                    slug={slug}
                    fileId={part.fileId}
                    name={part.name}
                    mimeType={part.mimeType}
                  />
                );
              case 'skill':
                return <SentSkill key={index} skill={part} />;
              case 'skill-use':
                return <SkillUse key={index} skill={part} />;
              case 'compact':
                return <SentCompact key={index} prompt={part.prompt} compactionId={part.compactionId} />;
              case 'compaction':
                return (
                  <CompactionStatus
                    key={part.compactionId}
                    api={api}
                    chatId={chatId}
                    part={part}
                    disabled={disabled}
                    onRetryHandoff={retryHandoff}
                  />
                );
              case 'text':
                return message.author === 'assistant' ? (
                  <AssistantText
                    key={index}
                    workspaceId={workspace.id}
                    chatId={chatId}
                    text={part.text}
                    rowViews={rowViews}
                  />
                ) : (
                  <MessageBubble key={index} variant="secondary">
                    {part.content ? (
                      <RichMessage
                        content={part.content}
                        file={reference =>
                          reference.source === 'tulipfarm' ? (
                            <ConversationFileReference workspaceId={workspace.id} slug={slug} fileId={reference.id} />
                          ) : (
                            (() => {
                              const google = googleParts.get(reference.id);
                              return google ? (
                                <ConversationGoogleFileReference
                                  slug={slug}
                                  fileId={google.fileId}
                                  name={google.name}
                                  mimeType={google.mimeType}
                                />
                              ) : null;
                            })()
                          )
                        }
                      />
                    ) : (
                      <p className="whitespace-pre-wrap text-base break-words">{part.text}</p>
                    )}
                  </MessageBubble>
                );
              default: {
                const exhaustive: never = part;
                return exhaustive;
              }
            }
          })}
          {message.turn?.mode === 'plan' && (
            <p className="text-xs text-muted-foreground">Plan only · no setup actions</p>
          )}
          {text && <EntryActions text={text} author={message.author} createdAt={message.createdAt} entry={entry} />}
          {message.turn && !quiet && (
            <MessageFooter>
              <div className="space-y-2">
                {answeredBy && <p className="text-xs text-muted-foreground">{answeredBy}</p>}
                {retrying && (
                  <p role="status" className="text-xs text-muted-foreground">
                    {retrying}
                  </p>
                )}
                {!quiet &&
                  !answeredBy &&
                  !retrying &&
                  (message.turn.status === 'failed' ? (
                    <p role="status" className="flex items-center gap-1.5 text-sm text-destructive">
                      <Danger size={14} aria-hidden="true" />
                      {turnLabels.failed}
                    </p>
                  ) : (
                    <p role="status" className="text-xs text-muted-foreground">
                      {turnLabels[message.turn.status]}
                    </p>
                  ))}
                <div className="flex flex-wrap gap-2">
                  {message.turn.errorCode === 'credits-exhausted' && (
                    <p role="alert">
                      Not enough available workspace credits for this reply. Ask a workspace admin to check credits.
                    </p>
                  )}
                  {message.turn.errorCode === 'plan-budget' && (
                    <p role="alert">The plan reached its budget. Review the plan before adding budget and resuming.</p>
                  )}
                  {message.turn.status === 'failed' && contextFailure(message.turn.errorCode) && (
                    <p role="alert">{contextFailure(message.turn.errorCode)}</p>
                  )}
                  {message.turn.status === 'failed' &&
                    !contextFailure(message.turn.errorCode) &&
                    replyFailure(message.turn.errorCode) && <p role="alert">{replyFailure(message.turn.errorCode)}</p>}
                  {message.turn.status === 'failed' && message.turn.errorCode === 'skill-unavailable' && (
                    <p role="alert">
                      {skill ? `“${skill.name}”` : 'The skill'} is no longer available, so this reply didn’t run. Ask a
                      workspace admin to enable it, then retry, or send a new message without it.
                    </p>
                  )}
                  {message.turn.status === 'failed' && (
                    <Button size="sm" variant="outline" disabled={disabled} onClick={() => control('retry')}>
                      {retryLabel(
                        message.turn.errorCode,
                        message.tools.some(tool => tool.status === 'completed'),
                        compactsOnRetry(message.turn.errorCode),
                      )}
                    </Button>
                  )}
                  {message.turn.status === 'failed' && (
                    <Button size="sm" variant="outline" disabled={disabled} onClick={() => control('cancel')}>
                      Cancel reply
                    </Button>
                  )}
                </div>
              </div>
            </MessageFooter>
          )}
        </MessageContent>
      </Message>
    </div>
  );
}

function ConversationTools({
  api,
  chatId,
  slug,
  changed,
  message,
  githubLocked,
  pickGitHub,
  correct,
}: {
  api: ConversationApi;
  chatId: string;
  slug: string;
  changed: () => Promise<void>;
  message: ConversationMessage;
  githubLocked: boolean;
  pickGitHub: (login: string) => void;
  correct: () => void;
}) {
  const { workspace, user, membershipId } = workspaceRoute.useRouteContext();
  const slack = useMemo(() => agentApi(workspace.id), [workspace.id]);
  const recordChanges = useMemo(() => recordChangesForTools(message.id, message.tools), [message.id, message.tools]);
  return (
    <section aria-label={`Activity for message ${message.sequence}`} className="space-y-3">
      {message.tools
        .flatMap(tool => (tool.status === 'completed' && tool.rowView ? [tool.rowView] : []))
        .map(reference => (
          <RowViewCard key={reference.callId} reference={reference} />
        ))}
      {recordChanges.map(change => (
        <RecordChangesCard key={change.id} change={change} />
      ))}
      {message.calendarResults.map(result => (
        <CalendarReadCard key={result.callId} result={result} />
      ))}
      {workflowResults(message.tools).map(reference => (
        <WorkflowCanvasButton
          key={`${reference.workflowId}:${reference.revision}`}
          workspaceId={workspace.id}
          reference={{ kind: 'definition', workflowId: reference.workflowId, revision: reference.revision }}
          name={reference.label}
        />
      ))}
      {message.tools
        .filter(
          tool =>
            tool.status !== 'blocked' &&
            ['slack.message.send', 'slack.thread.reply', 'slack.reaction.add'].includes(tool.tool),
        )
        .map(tool => (
          <SlackAction key={tool.id} api={slack} id={tool.id} refresh={changed} />
        ))}
      {message.tools
        .filter(
          tool =>
            tool.status === 'completed' &&
            !tool.importId &&
            (['agents.draft', 'skills.draft', 'workflows.draft'].includes(tool.tool) || tool.rowDraftId === tool.id),
        )
        .map(tool => (
          <AuthoringDraftCard key={tool.id} api={api} chatId={chatId} id={tool.id} />
        ))}
      {message.tools
        .filter(tool => tool.status === 'completed' && tool.importId)
        .map(tool => (
          <section key={tool.id} aria-label="Skill package review" className="space-y-2">
            <p className="text-sm">
              A skill package is ready for review. Open its status and review before you install it.
            </p>
            <Button
              variant="outline"
              nativeButton={false}
              render={
                <Link
                  to="/$workspaceSlug/skills/import/$importId"
                  params={{ workspaceSlug: slug, importId: tool.importId! }}
                />
              }
            >
              Review skill package
            </Button>
          </section>
        ))}
      {message.tools
        .filter(tool => tool.status === 'completed' && tool.tool === 'github.personal.account')
        .slice(-1)
        .map(tool => (
          <GitHubAccountCard
            key={tool.id}
            workspaceId={workspace.id}
            chatId={chatId}
            slug={slug}
            disabled={githubLocked}
            picked={pickGitHub}
          />
        ))}
      {message.tools
        .filter(tool => tool.status === 'completed' && tool.tool === 'github.investigation.account')
        .slice(-1)
        .map(tool => (
          <GitHubInvestigationCard
            key={tool.id}
            workspaceId={workspace.id}
            chatId={chatId}
            slug={slug}
            disabled={githubLocked}
            picked={pickGitHub}
          />
        ))}
      {message.tools
        .filter(tool => tool.images?.length)
        .map(tool => (
          <ImageCards key={`images:${tool.id}`} workspaceId={workspace.id} slug={slug} images={tool.images!} />
        ))}
      {message.tools.some(tool => tool.status === 'completed' && (tool.fileId || tool.fileIds?.length)) && (
        <section aria-label="Files created in this reply" className="flex flex-col gap-2">
          {[
            ...new Set(
              message.tools.flatMap(tool =>
                tool.status === 'completed' ? [...(tool.fileId ? [tool.fileId] : []), ...(tool.fileIds ?? [])] : [],
              ),
            ),
          ].map(fileId => (
            <ConversationFileReference key={fileId} workspaceId={workspace.id} slug={slug} fileId={fileId} created />
          ))}
        </section>
      )}
      {[...new Set(message.tools.flatMap(tool => (tool.googleProposalId ? [tool.googleProposalId] : [])))].map(
        proposalId => (
          <ChatGoogleProposal key={proposalId} workspaceId={workspace.id} proposalId={proposalId} />
        ),
      )}
      {message.tools
        .filter(tool => tool.status === 'completed' && tool.tool === 'tables.propose')
        .map(tool => (
          <TableProposalCard
            key={tool.id}
            workspaceId={workspace.id}
            chatId={chatId}
            id={tool.id}
            userId={user.id}
            membershipId={membershipId}
            order={message.sequence}
            correct={correct}
          />
        ))}
    </section>
  );
}
