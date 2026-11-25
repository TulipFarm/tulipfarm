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
import { packageInstallRequest } from '@tulipfarm/conversations/layout-contracts';
import { parseChatDraft, type ChatDraft } from './editor-document';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { createPortal, flushSync } from 'react-dom';
import { newChatSearch, workspaceChatRoute, workspaceRoute } from '@/router';
import { publicPackageInstallPrompt } from '@/features/packages/public-catalog';
import { ArrowDownIcon, ChevronDownIcon, FolderIcon } from '@tulipfarm/icons';
import { Alert, AlertDescription, AlertTitle } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { ChatCanvasToggle, ChatWithCanvas } from './canvas-items';
import { CanvasProvider, useCanvas, useResultAttention, type LayoutHost } from './canvas-state';
import { NewChatDrafts, WorkflowCanvasButton, workflowCanvasItem } from './workflow-canvas';
import { useWorkflowHandoff, WorkflowHandoffNotice } from './workflow-handoff';
import type { WorkflowReference } from '@/features/workflows/workflow-detail';
import { recordChangesForTools } from './record-changes';
import { workflowResults } from './workflow-results';
import type { RowView } from '@tulipfarm/conversations/row-view';

import { ChatHeaderContext } from './header-context';
import { takeEarlyComposer } from '@/lib/early-composer';
import { Input } from '@tulipfarm/sprout/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@tulipfarm/sprout/popover';
import { Label } from '@tulipfarm/sprout/label';
import { Message, MessageBubble, MessageContent } from '@tulipfarm/sprout/message';
import { useSidebar } from '@tulipfarm/sprout/sidebar';
import { MessageActions, type MessageActionsStats } from '@tulipfarm/sprout/message-actions';
import { ToolActivity } from '@tulipfarm/sprout/tool-activity';
import { toolActivityItems, visibleActivityTools } from './tool-labels';
import { LiveNarration, StepNarration } from './step-details';
import { newestTools, reconcileLiveTools, succeeded, unclaimedToolTurns } from './live-tools';
import { useCurrentReply, useRotatingLabel, type OutgoingMessage } from './current-reply';
import { useSmoothText } from './smooth-text';
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
import { MemoryChanges } from './memory-change';
import { ConversationAccess } from './conversation-access';
import { CommandFeedback, ConversationRead } from './conversation-feedback';
import { useConversationCommand } from './conversation-state';
import { useConversationChanges, useConversationHistory } from './queries';
import { useConversationStream } from './use-conversation-stream';
import { queueRendererCalls } from './layout-calls';
import { ConversationAttachment, StagedAttachments, useConversationAttachments } from './conversation-attachments';
import { Composer } from './composer';
import { codeSessionApi } from '@/features/code-sessions/api';
import { useFlag } from '@/lib/feature-flags';
import { CodeSessionCard } from '@/features/code-sessions/CodeSessionCard';
import {
  buildCodeSessionStartInput,
  CodeAgentPicker,
  CodeSessionBar,
  CodeSessionNotice,
  defaultCodeSessionDraft,
  type CodeSessionDraftConfig,
} from '@/features/code-sessions/CodeSessionSetup';
import type { CodeModeAvailability, TurnMode } from '@tulipfarm/agents/code-session-contracts';
import { ConversationFileReference, ConversationGoogleFileReference, useRichFileMentions } from './file-mentions';
import { SentSkill, SkillUse, StagedSkill, useRichSkillPicker } from './skill-picker';
import { keywordAccounts, type RichTextEditorHandle, type RichTextValue } from '@tulipfarm/sprout/rich-text-editor';
import { emptyChatDocument } from './editor-extensions';
import { ChatKeywords, RichMessage } from './rich-message';
import { useIntegrationKeywords } from '@/features/integrations/keywords';
import { ChatModelStatus, useChatModelFor, useChatModels } from './chat-models';
import { usePlanAccount } from './plan-account';
import { BrowserActivityCard, useLiveBrowserOpening, usedBrowser } from '@/features/browser/browser-card';
import { StartingTasks } from './starting-tasks';
import { ChatPlans } from './plans';
import { ChatPackages, PackageChatProvider, useChatPackages } from '@/features/packages/chat-packages';
import { HomeWelcome } from './welcome';
import { agentApi } from '@/features/agents/api';
import { modelName } from '@/features/models/model-name';
import { skillApi } from '@/features/skills/api';
import { TableHandoffNotice, useTableHandoff } from './table-handoff';
import { SlackAction } from '@/features/agents/slack-action';
import { ApprovalDock, ApprovalDockProvider } from './approval-dock';
import { PendingQuestionsProvider, usePendingQuestion } from './pending-question';
import { McpCallReviewCard } from '@/features/workspace-mcp/call-review-card';
import { IntegrationLinks } from './integration-links';
import { UpcomingMeetings, showAllMeetingsPrompt } from './upcoming-meetings';
import { CompactionStatus, SentCompact } from './compaction';
import { ChatMaintenance } from './maintenance';
import { compactCommand, compactCommandError } from './compaction-copy';
import { ReplyFooter, turnLabels } from './reply-footer';
import { FallbackChip } from './fallback-chip';
import { fallbackStarts } from './reply-failure-copy';
import { replyStats } from './reply-stats';
import { MoveToProjectDialog, ProjectScopeSelect, useWorkspaceProjects } from '@/features/projects/project-scope';
import { Bud } from './bud';
import { useBud } from './bud-context';
import { BudPreferences } from './bud-preferences';
import './conversation.css';
import { lazyCard } from '@/components/lazy-card';

const LayoutReply = lazyCard(() => import('./layout-reply').then(module => module.LayoutReply));
const LayoutPreview = lazyCard(() => import('./layout-reply').then(module => module.LayoutPreview));
const RecordChangesCard = lazyCard(() => import('./records-canvas').then(module => module.RecordChangesCard));
const RowViewCard = lazyCard(() => import('./records-canvas').then(module => module.RowViewCard));
// An answer never shows blank while its renderer downloads.
const GitHubChatResponse = lazyCard(
  () => import('./github-download').then(module => module.GitHubChatResponse),
  ({ children }) => <p className="whitespace-pre-wrap break-words">{children}</p>,
);
const SubagentFanout = lazyCard(() => import('./subagent-fanout').then(module => module.SubagentFanout));
const InteractionCard = lazyCard(() => import('./interaction-card').then(module => module.InteractionCard));
const AuthoringDraftCard = lazyCard(() => import('./authoring-draft-card').then(module => module.AuthoringDraftCard));
const WaitingRowDraft = lazyCard(() => import('./waiting-row-draft').then(module => module.WaitingRowDraft));
const AgentDraftLink = lazyCard(() => import('./agent-draft-canvas').then(module => module.AgentDraftLink));
const FollowUpCard = lazyCard(() => import('./follow-up-card').then(module => module.FollowUpCard));
const PendingGoogleActions = lazyCard(() =>
  import('./pending-google-actions').then(module => module.PendingGoogleActions),
);
const CalendarReadCard = lazyCard(() => import('./calendar-canvas').then(module => module.CalendarReadCard));
const ChatGoogleProposal = lazyCard(() => import('./calendar-canvas').then(module => module.ChatGoogleProposal));
const IntegrationCard = lazyCard(() => import('./integration-card').then(module => module.IntegrationCard));
const GitHubAccountCard = lazyCard(() => import('./github-account-card').then(module => module.GitHubAccountCard));
const GitHubInvestigationCard = lazyCard(() =>
  import('./github-investigation-card').then(module => module.GitHubInvestigationCard),
);
const GitHubBatches = lazyCard(() => import('./github-batches').then(module => module.GitHubBatches));
const TableProposalCard = lazyCard(() => import('./table-proposal-card').then(module => module.TableProposalCard));
const ApiCallReviewCard = lazyCard(() =>
  import('@/features/api-calls/review-card').then(module => module.ApiCallReviewCard),
);
const CodingRunReviewCard = lazyCard(() =>
  import('@/features/coding-runs/review-card').then(module => module.CodingRunReviewCard),
);
const ImageCards = lazyCard(() => import('./image-cards').then(module => module.ImageCards));

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
            <PendingQuestionsProvider>
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
            </PendingQuestionsProvider>
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
/** Asks Bud to turn a suggestion from the Lessons tab into an agent draft. Nothing changes until the person approves it. */
const improveAgentPrompt = (agentId: string, suggestion: string) =>
  `Help me improve agent ${agentId}. Its earlier tasks suggest this change: "${suggestion.replace(/\s+/g, ' ').trim()}". Read the agent first, then prepare a draft with this change for my review. Keep everything else the same.`;
const createTablePrompt =
  'Help me create a new table. Ask me what kind of rows it holds (for example, customers or invoices) and which fields I need, then propose the table for my review.';
type NewChatPrefill = {
  prompt: string;
  placeholder?: string;
  autoSend?: boolean;
  /** Typed by the person before the app loaded, so it keeps the caret instead of being selected. */
  typed?: boolean;
  skill?: { id: string; revision: string };
  workflow?: WorkflowReference;
};

function Greeting() {
  const { user, sessionId } = workspaceRoute.useRouteContext();
  return <HomeWelcome key={`${user.id}:${sessionId}`} name={user.name} />;
}

// The mobile canvas is a modal sheet: it keeps focus until it has closed, then returns focus to its opener.
function afterCanvasSheetCloses(run: () => void) {
  const deadline = performance.now() + 1000;
  const check = () => {
    const sheet = document.querySelector('.sprout-canvas-sheet')?.closest('[data-slot="sheet-viewport"]');
    if (!sheet || sheet.hasAttribute('hidden') || performance.now() > deadline) requestAnimationFrame(run);
    else requestAnimationFrame(check);
  };
  requestAnimationFrame(check);
}

/** Morphs the start screen into the new conversation where the browser supports view transitions. */
function startScreenTransition(update: () => void) {
  if (!document.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) update();
  else document.startViewTransition(() => flushSync(update));
}

function ConversationWorkspace({ api }: { api: ConversationApi }) {
  const { workspace, user } = workspaceRoute.useRouteContext();
  const searchIntent = newChatSearch.parse(Object.fromEntries(new URLSearchParams(window.location.search)));
  const models = useChatModels(
    workspace.id,
    user,
    searchIntent.intent === 'create-agent' ||
      searchIntent.intent === 'create-skill' ||
      searchIntent.intent === 'improve-agent',
  );
  const chatId = workspaceChatRoute.useParams({ shouldThrow: false })?.chatId;
  const { workspaceSlug } = workspaceRoute.useParams();
  const navigate = useNavigate();
  const headerElement = useContext(ChatHeaderContext);
  const project = useSearch({ strict: false, select: search => search.project ?? null });
  const skillIntent = {
    intent: searchIntent.intent,
    id: searchIntent.skillId,
    revision: searchIntent.skillRevision,
    version: searchIntent.skillVersion,
  };
  const intent = skillIntent.intent;
  const tableHandoff = useTableHandoff(
    workspace.id,
    intent === 'edit-table' || intent === 'add-rows' || intent === 'add-status' ? intent : null,
    searchIntent.tableId ?? null,
  );
  const workflowHandoff = useWorkflowHandoff(workspace.id, intent === 'edit-workflow', searchIntent.workflowId ?? null);
  const [early, setEarly] = useState(takeEarlyComposer);
  const prefill: NewChatPrefill | null =
    intent === 'install-package' && searchIntent.packageName && searchIntent.packageVersion
      ? {
          prompt: publicPackageInstallPrompt(searchIntent.packageName, searchIntent.packageVersion),
          autoSend: true,
        }
      : intent === 'create-agent'
        ? {
            prompt: '',
            placeholder: 'Describe the job, for example "Answer questions about my Customers table"',
            skill: { id: 'agent-authoring', revision: 'latest' },
          }
        : intent === 'create-skill'
          ? {
              prompt: '',
              placeholder: 'Describe the task, for example "Write a weekly customer update"',
              skill: { id: 'workspace-skill-authoring', revision: 'latest' },
            }
          : intent === 'improve-agent' && searchIntent.agentId && searchIntent.suggestion
            ? {
                prompt: improveAgentPrompt(searchIntent.agentId, searchIntent.suggestion),
                skill: { id: 'agent-authoring', revision: 'latest' },
              }
            : intent === 'edit-skill' && skillIntent.id && skillIntent.version
              ? {
                  prompt: `Help me edit skill ${skillIntent.id}, starting from saved version ${skillIntent.version}. Read the skill first, ask what I want to change, and preserve unrelated files. Prepare the changes for my review.`,
                }
              : intent === 'use-skill' && skillIntent.id && skillIntent.revision
                ? { prompt: '', skill: { id: skillIntent.id, revision: skillIntent.revision } }
                : intent === 'create-table'
                  ? { prompt: createTablePrompt }
                  : intent === 'create-workflow'
                    ? {
                        prompt:
                          'Help me create a workflow. Ask what should start it, which steps and agents it needs, and who should act. Use configured connected sources when needed. Prepare a workflow draft for my review, without saving or activating it.',
                      }
                    : workflowHandoff?.kind === 'ready'
                      ? { prompt: workflowHandoff.prompt, workflow: workflowHandoff.reference }
                      : tableHandoff?.kind === 'ready'
                        ? { prompt: tableHandoff.prompt }
                        : early
                          ? { prompt: early.text, autoSend: early.send, typed: true }
                          : null;
  const consumePrefill = () => {
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
  const [createdDraftId, setCreatedDraftId] = useState<string | null>(null);
  const previousChatId = useRef(chatId);
  const changes = useConversationChanges();
  const projects = useWorkspaceProjects(workspace.id);
  const draftApi = useMemo(
    () =>
      draftConversationApi(
        api,
        draftChatId,
        () => {
          setCreatedDraftId(draftChatId);
          void changes.created(draftChatId);
        },
        project,
      ),
    [api, changes, draftChatId, project],
  );
  const draft = !chatId;
  useEffect(() => {
    if (chatId) setEarly(null);
  }, [chatId]);
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
      {chatId && (
        <PendingGoogleActions
          key={`google-actions:${chatId}`}
          workspaceId={workspace.id}
          slug={workspaceSlug}
          chatId={chatId}
        />
      )}
      <CanvasProvider key={activeChatId}>
        <ApprovalDockProvider>
          <PendingQuestionsProvider>
            <ChatWithCanvas>
              <ConversationDetail
                api={activeApi}
                chatId={activeChatId}
                headerElement={headerElement}
                models={models}
                draft={draft}
                unsaved={chatId === draftChatId && createdDraftId !== draftChatId}
                draftProjectId={project}
                scope={draft ? scope : undefined}
                prefill={draft ? prefill : null}
                onPrefillApplied={prefill?.typed ? () => setEarly(null) : consumePrefill}
                notice={
                  draft && tableHandoff ? (
                    <TableHandoffNotice handoff={tableHandoff} workspaceSlug={workspaceSlug} />
                  ) : draft && workflowHandoff ? (
                    <WorkflowHandoffNotice handoff={workflowHandoff} />
                  ) : null
                }
              />
            </ChatWithCanvas>
          </PendingQuestionsProvider>
        </ApprovalDockProvider>
      </CanvasProvider>
    </section>
  );
}

function ConversationDetail({
  api,
  chatId,
  headerElement,
  models: workspaceModels,
  draft = false,
  unsaved = false,
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
  /** A new chat whose first send has not created it on the server yet, so it has nothing else to read. */
  unsaved?: boolean;
  draftProjectId?: string | null;
  scope?: ((disabled: boolean) => ReactNode) | undefined;
  prefill?: NewChatPrefill | null;
  onPrefillApplied?: () => void;
  notice?: ReactNode;
  persistent?: boolean;
  visible?: boolean;
  compact?: boolean;
}) {
  const questionPending = usePendingQuestion();
  const { workspace, membership } = workspaceRoute.useRouteContext();
  const admin = membership?.role === 'admin';
  const [moving, setMoving] = useState(false);
  const projects = useWorkspaceProjects(workspace.id);
  const navigate = useNavigate();
  const { workspaceSlug } = workspaceRoute.useParams();
  const integrations = useIntegrationKeywords(workspace.id, workspaceSlug, draft ? undefined : chatId, {
    id: chatId,
    draft,
  });
  const [pages, setPages] = useState(1);
  const stream = useConversationStream(api, chatId, !draft);
  useEffect(() => {
    for (const [messageId, calls] of stream.layoutCalls ?? []) queueRendererCalls(messageId, calls);
  }, [stream.layoutCalls]);
  const modelFamilies = workspaceModels.state.kind === 'ready' ? workspaceModels.state.data.families : noModelFamilies;
  const read = useConversationHistory(api, chatId, pages, stream);
  const savedData = read.state.kind === 'ready' ? read.state.data : null;
  const models = useChatModelFor(workspaceModels, draft ? null : (savedData?.chat.model ?? null), chatId);
  const planAccount = usePlanAccount(workspace.id, models.model?.plan);
  const packages = useChatPackages(
    workspace.id,
    chatId,
    !draft && !unsaved,
    savedData && !savedData.chat.projectId
      ? savedData.messages
          .filter(message => message.author === 'human')
          .map(message => message.parts.flatMap(part => (part.kind === 'text' ? [part.text] : [])).join(''))
      : [],
    savedData?.messages.flatMap(message =>
      message.parts.flatMap(part => (part.kind === 'layout' ? [part.layout] : [])),
    ) ?? [],
  );
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
  const [mode, setMode] = useState<TurnMode>('normal');
  const manualModeForChat = useRef<string | null>(null);
  const codeSessionsEnabled = useFlag('code-sessions');
  const codeApi = useMemo(() => codeSessionApi(workspace.id), [workspace.id]);
  const [codeAvailability, setCodeAvailability] = useState<CodeModeAvailability | null>(null);
  const [codeAvailabilityLoading, setCodeAvailabilityLoading] = useState(false);
  const [codeDraft, setCodeDraft] = useState<CodeSessionDraftConfig>(() => defaultCodeSessionDraft(null));
  useEffect(() => {
    if (!codeSessionsEnabled || draft || sharedChat || compact) return;
    if (manualModeForChat.current === chatId) {
      void codeApi.setTurnMode(chatId, mode).catch(() => undefined);
      return;
    }
    const controller = new AbortController();
    void codeApi
      .getTurnMode(chatId, controller.signal)
      .then(res => {
        if (manualModeForChat.current !== chatId) setMode(res.mode);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [codeApi, codeSessionsEnabled, chatId, draft, sharedChat, compact, mode]);
  useEffect(() => {
    if (!codeSessionsEnabled || mode !== 'code' || sharedChat || compact) return;
    const controller = new AbortController();
    setCodeAvailabilityLoading(true);
    void codeApi
      .availability(controller.signal)
      .then(avail => {
        setCodeAvailability(avail);
        setCodeDraft(current => (current.repository.trim() ? current : defaultCodeSessionDraft(avail)));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!controller.signal.aborted) setCodeAvailabilityLoading(false);
      });
    return () => controller.abort();
  }, [codeApi, codeSessionsEnabled, mode, sharedChat, compact]);
  const handleModeChange = useCallback(
    (next: TurnMode) => {
      manualModeForChat.current = chatId;
      setMode(next);
      if (codeSessionsEnabled && !draft && !sharedChat) {
        void codeApi.setTurnMode(chatId, next).catch(() => undefined);
      }
    },
    [codeApi, codeSessionsEnabled, chatId, draft, sharedChat],
  );
  const contentResult = parseChatDraft(content);
  const validContent = contentResult.success ? contentResult.data : null;
  const text = validContent ? chatDocumentText(validContent) : '';
  const composerInput = useRef<RichTextEditorHandle>(null);
  const canvas = useCanvas();
  useLiveBrowserOpening(workspace.id, chatId, activityTools, privateChat && !compact);
  const { setOpen: setNavigationOpen } = useSidebar();
  const canvasWasOpen = useRef(canvas.open);
  const navigationCollapsedFor = useRef<string | null>(null);
  useEffect(() => {
    const opening = canvas.open && !canvasWasOpen.current;
    canvasWasOpen.current = canvas.open;
    // The first time Canvas opens in a chat, the navigation makes room for it; the user can reopen it.
    if (!opening || compact || !visible || navigationCollapsedFor.current === chatId) return;
    navigationCollapsedFor.current = chatId;
    setNavigationOpen(false);
  }, [canvas.open, chatId, compact, visible, setNavigationOpen]);
  const appliedComposer = useRef<string | null>(null);
  const appliedPrefill = useRef(false);
  // A link can open a new chat before its editor shows the prompt, so wait for it. Selecting the prompt lets the
  // person send it as is, or type their own message over it instead of after it.
  const selectPrefill = (prompt: string, typed = false, frames = 10) =>
    requestAnimationFrame(() => {
      const editor = composerInput.current?.editor();
      if (editor && editor.state.doc.textContent === prompt)
        (typed ? editor.chain().focus('end') : editor.chain().focus().selectAll()).run();
      else if (frames > 1) selectPrefill(prompt, typed, frames - 1);
      else composerInput.current?.focus();
    });
  const [skillHandoffError, setSkillHandoffError] = useState('');
  const [composerPlaceholder, setComposerPlaceholder] = useState(prefill?.placeholder);
  useEffect(() => {
    if (!prefill || prefill.skill || prefill.autoSend) {
      appliedPrefill.current = false;
      return;
    }
    if (!appliedPrefill.current) {
      appliedPrefill.current = true;
      // A link's request that arrives after the person started typing, such as a slow table handoff, never joins their text.
      if (!text.trim()) {
        setContent(textDocument(prefill.prompt));
        selectPrefill(prefill.prompt, prefill.typed);
      }
      onPrefillApplied?.();
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
    setContent(current => {
      const existing = current.doc.content ?? [];
      const blank = existing.every(node => node.type === 'paragraph' && !node.content?.length);
      return {
        ...current,
        doc: { ...current.doc, content: [...paragraphs, ...(request.caretAtPrompt && blank ? [] : existing)] },
      };
    });
    const focusPrompt = () => {
      const editor = composerInput.current?.editor();
      const prompt = editor?.state.doc.firstChild;
      if (editor && prompt)
        editor
          .chain()
          .focus()
          .setTextSelection(prompt.nodeSize - 1)
          .run();
      else composerInput.current?.focus();
    };
    const focus = request.caretAtPrompt ? focusPrompt : () => composerInput.current?.focus();
    if (window.matchMedia('(max-width: 767px)').matches) {
      canvas.setOpen(false);
      afterCanvasSheetCloses(focus);
    }
    // The editor takes the new draft on its next render; place the caret after that.
    else if (request.caretAtPrompt) requestAnimationFrame(focus);
    else focus();
    canvas.consumeComposer(request.id);
  }, [canvas.composerRequest, canvas.consumeComposer]);
  const skills = useRichSkillPicker(workspace.id, composerInput, privateChat || (draft && !sharedChat));
  useEffect(() => {
    if (!prefill?.skill || sharedChat) return;
    const selected = prefill.skill,
      controller = new AbortController();
    if (selected.id === 'agent-authoring' || selected.id === 'workspace-skill-authoring') {
      skills.stage({
        skillId: selected.id,
        revision: selected.revision,
        name: selected.id === 'agent-authoring' ? 'Set up an agent for review' : 'Create a reusable skill',
      });
      setComposerPlaceholder(prefill.placeholder);
      if (!text.trim()) selectPrefill('');
      onPrefillApplied?.();
      return () => controller.abort();
    }
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
          onPrefillApplied?.();
        },
        () => {
          if (!controller.signal.aborted) {
            setSkillHandoffError('Could not load the selected skill. Return to Skills and try again.');
            onPrefillApplied?.();
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
  // Once saved history has the message, the server copy replaces the optimistic one for good.
  if (outgoing && data?.messages.some(message => message.id === outgoing.id)) setOutgoing(null);
  const posting = useRef(false);
  const sentPrefill = useRef(false);
  const sendNavigation = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const timelineContent = useRef<HTMLDivElement>(null);
  const followLatest = useRef<'following' | 'scrolled' | 'inspecting'>('following');
  const olderScrollHeight = useRef<number | null>(null);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [unseenUpdates, setUnseenUpdates] = useState(false);
  // The start screen reads from the top, so it never follows the latest message.
  const startScreen = useRef(false);
  const pinnedTop = useRef<number | null>(null);
  const pinLatest = (element: HTMLElement) => {
    if (startScreen.current) return;
    element.scrollTop = element.scrollHeight;
    pinnedTop.current = element.scrollTop;
  };
  // Toggling activity holds the view in place, except opening the live activity at latest, which keeps following.
  const inspectActivity = (live: boolean) => {
    const element = timeline.current;
    if (!live || !element || !nearLatest(element)) followLatest.current = 'inspecting';
  };
  const syncLatest = (element: HTMLElement) => {
    const near = startScreen.current || nearLatest(element);
    setAwayFromLatest(!near);
    if (near) setUnseenUpdates(false);
  };
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
  const write = useConversationCommand(api, (command, recoveredPages) => {
    if (command.kind === 'send') {
      if (recoveredPages) setPages(value => Math.max(value, recoveredPages));
      if (command.model) models.sent();
      setContent(emptyRichDocument());
      uploads.clear();
      mentions.clear();
      skills.clear();
      setComposerPlaceholder(undefined);
    }
    if (command.kind === 'rename') setEditing(null);
    read.restart();
    stream.retry();
    setRefreshed(true);
  });
  const uncertainSend =
    write.state.kind === 'uncertain' && write.state.command.kind === 'send' ? write.state.command : null;
  const recoveredSend =
    uncertainSend && data?.messages.some(message => message.id === uncertainSend.messageId)
      ? uncertainSend.messageId
      : null;
  useEffect(() => {
    if (recoveredSend) void write.recover();
  }, [recoveredSend]);
  const submit = (...args: Parameters<typeof write.submit>) => {
    setRefreshed(false);
    void write.submit(...args);
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
  const packageSend =
    !sharedChat &&
    mode !== 'plan' &&
    mode !== 'code' &&
    !staged &&
    !!validContent &&
    !!packageInstallRequest([{ kind: 'text', text, content: validContent }], mode);
  const codeStartInput = mode === 'code' ? buildCodeSessionStartInput(codeDraft) : null;
  const codeSendReady = mode === 'code' && codeStartInput !== null && !codeAvailability?.unavailableReason;
  const sendAvailable = mode === 'code' ? codeSendReady : (models.usable && !!models.model) || packageSend;
  useEffect(() => {
    if (!draft || !prefill?.autoSend || sentPrefill.current || locked) return;
    const content = textDocument(prefill.prompt);
    if (
      !(models.usable && models.model) &&
      !(!sharedChat && packageInstallRequest([{ kind: 'text', text: prefill.prompt, content }], mode))
    )
      return;
    sentPrefill.current = true;
    post(content, [{ kind: 'text', text: prefill.prompt, content }], null, []);
  }, [draft, prefill, locked, models.usable, models.model, sharedChat, mode]);
  function send() {
    if (locked || !validContent || !canSend || !sendAvailable) return;
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
  function sendLayoutAction(replyId: string, action: Parameters<LayoutHost['send']>[1]) {
    if (draft || locked || posting.current || !models.usable) return;
    posting.current = true;
    const sentMessageId = crypto.randomUUID();
    setOutgoing({
      id: sentMessageId,
      content: textDocument(action.userMessage),
      references: [],
      skill: null,
      at: Date.now(),
    });
    followLatest.current = 'following';
    setRefreshed(false);
    void write
      .submit({
        kind: 'layout-action',
        chatId,
        commandId: crypto.randomUUID(),
        replyId,
        sentMessageId,
        surfaceId: replyId,
        ...action,
      })
      .finally(() => {
        posting.current = false;
      });
  }
  const layoutActions = useRef({ send: sendLayoutAction, api, chatId });
  layoutActions.current = { send: sendLayoutAction, api, chatId };
  const answeredLayouts = (data?.messages ?? [])
    .flatMap(message => message.parts.flatMap(part => (part.kind === 'layout-action' ? [part.action.messageId] : [])))
    .join(',');
  const replyRunning = !!data?.messages.some(
    message => message.turn && ['queued', 'processing', 'waiting', 'reconciling'].includes(message.turn.status),
  );
  const layoutsLocked =
    draft ||
    locked ||
    replyRunning ||
    !models.usable ||
    !data ||
    data.chat.isClosed ||
    !!(
      data.chat.projectId &&
      projects.state.kind === 'ready' &&
      projects.state.data.find(item => item.id === data.chat.projectId)?.archived
    );
  const { setLayoutHost } = canvas;
  useEffect(() => {
    const answered = new Set(answeredLayouts.split(','));
    setLayoutHost({
      send: (replyId, action) => layoutActions.current.send(replyId, action),
      lookup: (replyId, call) =>
        layoutActions.current.api.layoutFunction(
          layoutActions.current.chatId,
          replyId,
          call,
          AbortSignal.timeout(15000),
        ),
      readOnly: replyId => layoutsLocked || answered.has(replyId),
    });
  }, [answeredLayouts, layoutsLocked, setLayoutHost]);
  useEffect(() => () => setLayoutHost(null), [setLayoutHost]);
  function post(
    shown: ChatDocument,
    parts: ConversationPart[],
    skill: SkillReference | null = null,
    references = mentions.references,
  ) {
    const packageRequest = !sharedChat && packageInstallRequest(parts, mode);
    const codePayload = mode === 'code' ? buildCodeSessionStartInput(codeDraft) : null;
    if (
      (!codePayload && !packageRequest && (!models.usable || !models.model)) ||
      (mode === 'code' && !codePayload) ||
      locked ||
      posting.current
    )
      return;
    posting.current = true;
    const messageId = crypto.randomUUID();
    // Each integration chip keeps naming the account the message was sent with, even after a later switch.
    const accounts = Object.fromEntries(
      Object.entries(keywordAccounts(shown.doc as RichTextValue, integrations.keywords)).map(([id, account]) => [
        id,
        integrations.keywords.find(keyword => keyword.id === id)?.accounts?.find(option => option.id === account)
          ?.label ?? account,
      ]),
    );
    if (Object.keys(accounts).length) {
      shown = { ...shown, accounts };
      parts = parts.map(part =>
        part.kind === 'text' && part.content ? { ...part, content: { ...part.content, accounts } } : part,
      );
    }
    if (draft) {
      sendNavigation.current = true;
      void navigate({
        to: '/$workspaceSlug/chat/$chatId',
        params: { workspaceSlug, chatId },
        replace: prefill?.autoSend === true,
      }).finally(() => {
        sendNavigation.current = false;
      });
    }
    const outgoingMessage = {
      id: messageId,
      content: structuredClone(shown),
      references: [...references],
      skill,
      at: Date.now(),
    };
    if (startScreen.current) startScreenTransition(() => setOutgoing(outgoingMessage));
    else setOutgoing(outgoingMessage);
    followLatest.current = 'following';
    setRefreshed(false);
    void write
      .submit({
        kind: 'send',
        chatId,
        commandId: crypto.randomUUID(),
        messageId,
        ...(models.model ? { model: models.model.id } : {}),
        ...(models.model?.plan && planAccount?.value ? { planConnectionId: planAccount.value } : {}),
        parts,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        mode,
        ...(codePayload ? { code: codePayload } : {}),
      })
      .then(() => (draft ? integrations.applyDraft(chatId).catch(() => undefined) : undefined))
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
            <FolderIcon size="md" aria-hidden="true" />
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
  const {
    pending,
    waiting,
    pendingQueued,
    queuedMessages,
    queueLabel,
    unconfirmed,
    replyAfter,
    draftSent,
    turn,
    thinking,
    narration,
    savedNarration,
    answerText,
    layoutJson,
    activity,
    status,
    stalledTurn,
    slowTurn,
  } = useCurrentReply({
    messages: data?.messages,
    outgoing,
    command: write.state,
    stream,
  });
  // The saved copy of a just-sent message keeps the optimistic row's key, so the Thinking row is not remounted.
  const sentId = useRef<string | null>(null);
  if (pending) sentId.current = pending.id;
  const stopReply = turn
    ? () =>
        submit({
          kind: 'cancel',
          chatId,
          commandId: crypto.randomUUID(),
          turnId: turn.id,
          expectedGeneration: turn.generation,
        })
    : undefined;
  const currentTool = activityTools.find(tool => (tool.activityStatus ?? tool.status) === 'running');
  const baseActivityLabel =
    currentTool && !status
      ? currentTool.activity?.trim() || currentTool.presentation?.label || toolActivityItems([currentTool])[0]?.label
      : thinking
        ? activity.label
        : null;
  const activityLabel = useRotatingLabel(baseActivityLabel);
  // A reply resumed by an answer continues below the question, so its progress shows there, not above it.
  const continuesBelow = !!turn && replyContinuesBelow(data?.messages ?? [], turn.id);
  // The answer first renders when the reply ends, so its lazy parts load while the live text streams.
  const live = !!narration;
  useEffect(() => {
    if (live) void GitHubChatResponse.preload();
  }, [live]);
  const empty = data?.messages.length === 0 && !pending && incomingTurns.length === 0 && !packages.active;
  // Typing re-renders this component, so saved entries get stable props and skip rendering again.
  const commands: { retryHandoff: (compactionId: string) => void; control: ControlTurn } = {
    retryHandoff: compactionId => {
      if (!locked && models.usable) post(textDocument('Retry handoff'), [{ kind: 'compact', compactionId }], null, []);
    },
    control: (message, kind) => {
      if (message.turn)
        submit({
          kind,
          chatId,
          commandId: crypto.randomUUID(),
          turnId: message.turn.id,
          expectedGeneration: message.turn.generation,
        });
    },
  };
  const entryCommands = useRef(commands);
  entryCommands.current = commands;
  const retryHandoff = useCallback((compactionId: string) => entryCommands.current.retryHandoff(compactionId), []);
  const controlEntry = useCallback<ControlTurn>((message, kind) => entryCommands.current.control(message, kind), []);
  const entryModelName = useCallback((id: string) => modelName(modelFamilies, id), [modelFamilies]);
  const fallbackControls = useMemo<FallbackControls>(
    () => ({
      currentModel: models.model?.id,
      canSwitchTo: id => models.choices.some(choice => choice.id === id && !choice.disabled),
      switchModel: models.select,
    }),
    [models.model?.id, models.choices, models.select],
  );
  startScreen.current = !compact && empty;
  const latestId = pending?.id ?? data?.messages.at(-1)?.id;
  const firstId = data?.messages.at(0)?.id;
  useLayoutEffect(() => {
    const element = timeline.current;
    if (!element) return;
    if (olderScrollHeight.current !== null) {
      element.scrollTop += element.scrollHeight - olderScrollHeight.current;
      olderScrollHeight.current = null;
    } else if (followLatest.current === 'following') pinLatest(element);
  }, [latestId, firstId, thinking]);
  useLayoutEffect(() => {
    const element = timeline.current;
    const content = timelineContent.current;
    if (!element || !content) return;
    // The timeline also resizes when the keyboard opens or the footer grows, without firing a scroll.
    const observer = new ResizeObserver(() => {
      if (olderScrollHeight.current !== null) return;
      if (followLatest.current === 'following') pinLatest(element);
      else syncLatest(element);
    });
    observer.observe(content);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // The live reply renders after the replying turn's saved messages, so a message sent meanwhile stays below it.
  const liveReply = (messages: ConversationMessage[], at: number) =>
    layoutJson && turn ? (
      <li key="live-reply" aria-busy={!read.uncertain}>
        <span className="sr-only">TulipFarm said</span>
        <LayoutPreview chatId={chatId} turnId={turn.id} json={layoutJson} />
      </li>
    ) : answerText ? (
      <li key="live-reply" aria-busy={!read.uncertain}>
        <Message align="start">
          <MessageContent>
            <span className="sr-only">TulipFarm said</span>
            <AssistantText
              workspaceId={workspace.id}
              chatId={chatId}
              text={answerText}
              streaming={!read.uncertain}
              rowViews={entryDetails(messages, modelFamilies).rowViews[at] ?? []}
            />
          </MessageContent>
        </Message>
        {!waiting && !pendingQueued && !turn && !incomingTurns.length && (
          <ToolActivity
            key="activity"
            variant="transcript"
            items={[]}
            active={thinking && !read.uncertain}
            activityLabel={activityLabel}
          />
        )}
      </li>
    ) : (
      thinking &&
      !read.uncertain && (
        <li key="live-reply" aria-busy="true" className="space-y-2">
          {continuesBelow && <ToolActivity variant="transcript" items={[]} active activityLabel={activityLabel} />}
          {continuesBelow && <LiveNarration text={narration} saved={savedNarration} />}
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
    );
  const trailingReply = (messages: ConversationMessage[]) =>
    replyAfter === null ? liveReply(messages, messages.length - 1) : null;
  return (
    <ChatKeywords value={integrations.keywords}>
      <div className="flex min-h-0 flex-1 flex-col">
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
            ((!!text && !(prefill?.prompt && text === prefill.prompt && !staged)) ||
              staged ||
              !!editing ||
              write.state.kind === 'sending' ||
              write.state.kind === 'uncertain')
          }
          allowNavigation={sendNavigation}
        />
        {!compact &&
          headerElement &&
          createPortal(
            <>
              {!empty && !sharedChat && (draft || data) && <Bud />}
              {data ? (
                <>
                  <h1
                    ref={heading}
                    tabIndex={-1}
                    title={data.chat.title}
                    className="min-w-0 flex-1 truncate text-sm font-medium outline-none"
                  >
                    <TypedText text={data.chat.title} animate={!data.chat.titleManual && data.chat.titleRevision > 1} />
                  </h1>
                  {!draft && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button size="icon-sm" variant="ghost" aria-label="Chat actions" title="Chat actions" />
                        }
                      >
                        <ChevronDownIcon size="md" aria-hidden="true" />
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
                            submit(
                              {
                                kind: 'archive',
                                chatId,
                                commandId: crypto.randomUUID(),
                                archived: !data.chat.archived,
                              },
                              data.chat,
                            )
                          }
                        >
                          {data.chat.archived ? 'Restore chat' : 'Archive chat'}
                        </DropdownMenuItem>
                        {!data.chat.archived && (
                          <DropdownMenuItem
                            disabled={locked}
                            onClick={() =>
                              submit(
                                {
                                  kind: 'pin',
                                  chatId,
                                  commandId: crypto.randomUUID(),
                                  pinned: !data.chat.pinned,
                                },
                                data.chat,
                              )
                            }
                          >
                            {data.chat.pinned ? 'Unpin chat' : 'Pin chat'}
                          </DropdownMenuItem>
                        )}
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
              : `conversation-timeline min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 sm:px-6 ${empty ? 'overflow-x-clip' : ''} ${visible ? 'chat-timeline-transition' : ''}`
          }
          onScroll={event => {
            const element = event.currentTarget;
            // Pinning fires its scroll event a frame later, after the content may have grown again.
            if (followLatest.current === 'following' && element.scrollTop === pinnedTop.current) pinLatest(element);
            else if (followLatest.current !== 'inspecting' && !startScreen.current)
              followLatest.current = nearLatest(element) ? 'following' : 'scrolled';
            syncLatest(element);
          }}
        >
          <div
            ref={timelineContent}
            className={
              compact
                ? 'w-full space-y-3 py-3'
                : empty
                  ? 'mx-auto w-full max-w-3xl space-y-8 pt-8 pb-6 sm:pt-16'
                  : 'mx-auto w-full max-w-3xl space-y-6 py-6 sm:py-8'
            }
          >
            {data?.chat.archived && (
              <p role="status" className="text-sm text-muted-foreground">
                This chat is archived. Messages stay saved and any active reply finishes.
              </p>
            )}
            {editing && (
              <form
                className="space-y-2 rounded-lg border p-4"
                onSubmit={event => {
                  event.preventDefault();
                  if (!locked && !titleValidation)
                    submit(
                      {
                        kind: 'rename',
                        chatId,
                        commandId: crypto.randomUUID(),
                        title: editing.title.trim(),
                        expectedRevision: editing.titleRevision,
                      },
                      data?.chat,
                    );
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
                      <Greeting />
                    )
                  ) : (
                    <PackageChatProvider
                      value={{
                        packages,
                        chatId,
                        disabled: history.chat.isClosed || projectArchived,
                        foreground: visible && !compact,
                      }}
                    >
                      <ol aria-label="Messages" className={compact ? 'space-y-3' : 'space-y-8'}>
                        {[
                          ...history.messages.flatMap((message, index) => {
                            const live = index === replyAfter ? liveReply(history.messages, index) : null;
                            const next = history.messages[index + 1];
                            // A turn's activity and its reply read as one block, so they sit as close as the
                            // activity lines do; separate exchanges keep the list's wider gap.
                            const answered =
                              message.author === 'human' &&
                              !!message.turn &&
                              (live
                                ? true
                                : index === history.messages.length - 1
                                  ? !pending && !incomingTurns.length && !!trailingReply(history.messages)
                                  : next?.author === 'assistant' && !answerOnly(next));
                            return [
                              answerOnly(message) ? null : (
                                <li
                                  key={
                                    message.id === sentId.current
                                      ? 'pending'
                                      : message.turn
                                        ? `turn:${message.turn.id}`
                                        : message.id
                                  }
                                  className={answered ? 'mb-3 space-y-3' : 'space-y-3'}
                                >
                                  <ConversationEntry
                                    api={api}
                                    chatId={chatId}
                                    slug={workspaceSlug}
                                    message={message}
                                    latest={index === history.messages.length - 1}
                                    rowViews={entryDetails(history.messages, modelFamilies).rowViews[index]!}
                                    stats={entryDetails(history.messages, modelFamilies).stats[index]}
                                    modelName={entryModelName}
                                    fallbackTurn={entryDetails(history.messages, modelFamilies).fallbacks.get(
                                      message.id,
                                    )}
                                    fallbackControls={
                                      entryDetails(history.messages, modelFamilies).fallbacks.has(message.id)
                                        ? fallbackControls
                                        : undefined
                                    }
                                    disabled={locked}
                                    retryHandoff={retryHandoff}
                                    control={controlEntry}
                                  />
                                  {queuedMessages.includes(message) && message.turn && (
                                    <div className="flex flex-col items-end gap-2">
                                      <p role="status" className="text-sm text-muted-foreground">
                                        {queueLabel}
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
                                            turnId: message.turn!.id,
                                            expectedGeneration: message.turn!.generation,
                                          })
                                        }
                                      >
                                        Remove queued message
                                      </Button>
                                    </div>
                                  )}
                                  <ToolActivity
                                    key="activity"
                                    variant="transcript"
                                    items={toolActivityItems(message.tools, { admin })}
                                    active={
                                      thinking &&
                                      !read.uncertain &&
                                      !!turn &&
                                      message.turn?.id === turn.id &&
                                      !continuesBelow
                                    }
                                    activityLabel={
                                      message.turn?.id === turn?.id && !continuesBelow ? activityLabel : undefined
                                    }
                                    onToggle={() => inspectActivity(thinking && !!turn && message.turn?.id === turn.id)}
                                  />
                                  <MemoryChanges tools={message.tools} />
                                  {message.turn?.id === turn?.id && !continuesBelow && (
                                    <LiveNarration text={narration} saved={savedNarration} />
                                  )}
                                  {message.turn?.status === 'waiting' &&
                                    (() => {
                                      const note = message.tools.filter(tool => tool.narration).at(-1)?.narration;
                                      return note ? <StepNarration text={note} /> : null;
                                    })()}
                                  {message.parts.map((part, index) =>
                                    part.kind === 'request' ? (
                                      <InteractionCard key={index} api={api} chatId={chatId} reference={part} />
                                    ) : null,
                                  )}
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
                                        item =>
                                          item.turn &&
                                          !['completed', 'cancelled', 'blocked'].includes(item.turn.status),
                                      )
                                    }
                                    pickGitHub={pickGitHub}
                                    correct={() => composerInput.current?.focus()}
                                  />
                                  {message.turn?.status === 'cancelled' &&
                                    !history.messages.some(item => item.stoppedTurnId === message.turn?.id) && (
                                      <Message align="start">
                                        <MessageContent>
                                          <p className="text-xs text-muted-foreground">{turnLabels.cancelled}</p>
                                        </MessageContent>
                                      </Message>
                                    )}
                                </li>
                              ),
                              live,
                            ];
                          }),
                          pending ? (
                            <li
                              key="pending"
                              className={`space-y-3 ${trailingReply(history.messages) && !incomingTurns.length ? 'mb-3' : ''} ${!compact && visible ? 'chat-sent-transition' : ''}`.trim()}
                            >
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
                                              candidate =>
                                                candidate.source === 'google' && candidate.id === reference.id,
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
                                  {waiting && (
                                    <p className="self-end text-xs text-muted-foreground">Sending when ready</p>
                                  )}
                                  {pendingQueued && (
                                    <p role="status" className="self-end text-sm text-muted-foreground">
                                      {queueLabel}
                                    </p>
                                  )}
                                  {unconfirmed && (
                                    <p className="self-end text-xs text-muted-foreground">
                                      {write.state.kind === 'uncertain' && write.state.unsent
                                        ? 'Not sent'
                                        : 'Not confirmed sent'}
                                    </p>
                                  )}
                                </MessageContent>
                              </Message>
                              {!waiting && !pendingQueued && !turn && !incomingTurns.length && (
                                <ToolActivity
                                  key="activity"
                                  variant="transcript"
                                  items={[]}
                                  active={thinking && !read.uncertain}
                                  activityLabel={activityLabel}
                                />
                              )}
                            </li>
                          ) : null,
                          ...incomingTurns.map(incoming => (
                            <li key={`turn:${incoming.id}`}>
                              <ToolActivity
                                key="activity"
                                variant="transcript"
                                items={toolActivityItems(incoming.tools, { admin })}
                                active={thinking && !read.uncertain}
                                activityLabel={activityLabel}
                                onToggle={() => inspectActivity(thinking)}
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
                        {trailingReply(history.messages)}
                        {read.uncertain && (
                          <li>
                            <Alert>
                              <AlertDescription>We couldn't confirm whether this reply finished.</AlertDescription>
                              <div className="mt-2 flex flex-wrap gap-2">
                                <Button
                                  variant="outline"
                                  disabled={read.state.kind === 'ready' && read.state.refreshing}
                                  onClick={() => {
                                    stream.retry();
                                    read.retryStatus();
                                  }}
                                >
                                  Retry
                                </Button>
                                {stopReply && (text || staged) && (
                                  <Button variant="outline" disabled={locked} onClick={stopReply}>
                                    Stop reply
                                  </Button>
                                )}
                              </div>
                            </Alert>
                          </li>
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
                    </PackageChatProvider>
                  )}
                  {!draft && !empty && history.chat.isClosed && (
                    <ChatMaintenance api={api} chatId={chatId} disabled={locked} />
                  )}
                  {!draft && (
                    <ChatPackages
                      packages={packages}
                      chatId={chatId}
                      disabled={history.chat.isClosed || projectArchived}
                      foreground={visible && !compact}
                    />
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
                    <NewChatDrafts
                      workspaceId={workspace.id}
                      chatId={chatId}
                      tools={history.messages.flatMap(message => message.tools)}
                      foreground={visible && !compact}
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
            {!compact && empty && (
              <StartingTasks
                disabled={
                  locked || !models.usable || (!!text && !(prefill?.prompt && text === prefill.prompt)) || staged
                }
                disabledReason={
                  !models.usable
                    ? 'Waiting for an available AI model before starting a prompt.'
                    : (!!text && !(prefill?.prompt && text === prefill.prompt)) || staged
                      ? 'Clear your current draft to use a suggested prompt.'
                      : null
                }
                onChoose={prompt => {
                  const canReplaceDraft = !text || (!!prefill?.prompt && text === prefill.prompt);
                  if (!locked && models.usable && canReplaceDraft && !staged)
                    post(textDocument(prompt), [{ kind: 'text', text: prompt }]);
                }}
              />
            )}
            {draft && empty && (
              <UpcomingMeetings
                workspaceId={workspace.id}
                disabled={locked || !models.usable || !!text || staged}
                onShowAll={() => {
                  if (!locked && models.usable && !text && !staged)
                    post(textDocument(showAllMeetingsPrompt), [{ kind: 'text', text: showAllMeetingsPrompt }]);
                }}
              />
            )}
            {!draft && data?.hasGitHubProposals && (
              <GitHubBatches
                workspaceId={workspace.id}
                chatId={chatId}
                revision={JSON.stringify(
                  data.messages.map(message => [message.id, message.turn?.status, message.tools]),
                )}
              />
            )}
          </div>
        </div>
        <footer
          className={
            compact
              ? 'relative shrink-0 px-3 pb-3'
              : `relative shrink-0 px-3 pt-2 pb-3 sm:px-6 sm:pb-2 ${visible ? 'chat-composer-transition' : ''}`
          }
        >
          {awayFromLatest && (
            <div className="pointer-events-none absolute inset-x-0 bottom-full flex justify-center pb-2 *:pointer-events-auto">
              <Button
                size={unseenUpdates ? 'sm' : 'icon-sm'}
                variant="outline"
                aria-label="Jump to latest"
                title="Jump to latest"
                onClick={() => {
                  const element = timeline.current;
                  if (element) pinLatest(element);
                  followLatest.current = 'following';
                  setAwayFromLatest(false);
                  setUnseenUpdates(false);
                }}
              >
                <ArrowDownIcon size="sm" aria-hidden="true" />
                {unseenUpdates && 'New updates'}
              </Button>
            </div>
          )}
          <div className="mx-auto w-full max-w-3xl space-y-3">
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
              </div>
              <Composer
                compact={compact}
                minRows={1}
                inputRef={composerInput}
                content={draftSent ? emptyRichDocument() : content}
                onContentChange={setContent}
                onSend={send}
                canSend={!locked && canSend && sendAvailable}
                placeholder={
                  compact ? 'Reply…' : empty ? (composerPlaceholder ?? 'What would you like to get done?') : 'Reply…'
                }
                mode={!sharedChat && !compact ? { value: mode, onChange: handleModeChange } : undefined}
                codeHeader={
                  !sharedChat && !compact && mode === 'code' ? (
                    <CodeSessionBar
                      workspaceId={workspace.id}
                      workspaceSlug={workspaceSlug}
                      availability={codeAvailability}
                      draft={codeDraft}
                      onChange={setCodeDraft}
                      disabled={write.locked || projectArchived}
                    />
                  ) : undefined
                }
                sendDisabledReason={
                  !sharedChat && !compact && mode === 'code'
                    ? !codeStartInput
                      ? 'Select a repository to start a code session'
                      : (codeAvailability?.unavailableReason ?? undefined)
                    : undefined
                }
                codeNotice={
                  !sharedChat && !compact && mode === 'code' ? (
                    <CodeSessionNotice
                      workspaceSlug={workspaceSlug}
                      availability={codeAvailability}
                      loading={codeAvailabilityLoading}
                      codingAgent={codeDraft.codingAgent}
                    />
                  ) : undefined
                }
                codeAgentPicker={
                  !sharedChat && !compact && mode === 'code' ? (
                    <CodeAgentPicker
                      value={codeDraft.codingAgent}
                      availability={codeAvailability}
                      onChange={codingAgent => setCodeDraft(current => ({ ...current, codingAgent }))}
                      disabled={write.locked || projectArchived}
                    />
                  ) : undefined
                }
                scope={draft && empty ? scope : projectSharingScope}
                onStop={!text && !staged ? stopReply : undefined}
                disabled={write.locked || projectArchived}
                sending={write.state.kind === 'sending'}
                validation={validation}
                onFiles={uploads.add}
                integrations={{
                  keywords: integrations.keywords,
                  onConnect: integrations.connect,
                  onAccountChange: integrations.switchAccount,
                }}
                attachments={
                  !draftSent && (staged || uploads.error || mentions.notice) ? (
                    <div className="space-y-2">
                      {skills.staged && (
                        <StagedSkill skill={skills.staged} disabled={write.locked} onRemove={skills.remove} />
                      )}
                      <StagedAttachments
                        uploads={uploads}
                        disabled={write.locked}
                        reading={{
                          imageInput: modelFamilies.find(family => family.id === models.model?.id)?.imageInput ?? null,
                        }}
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
                planAccount={planAccount}
              />
            </div>
            <ChatModelStatus
              catalog={models}
              slug={workspaceSlug}
              quiet={commandFailed || (read.state.kind === 'ready' && !!read.state.error)}
            />
            {!compact && (
              <p className="-mt-1.5 hidden text-center text-xs text-muted-foreground sm:block">
                TulipFarm can make mistakes. Check important details.
              </p>
            )}
          </div>
        </footer>
      </div>
    </ChatKeywords>
  );
}

const nearLatest = (element: HTMLElement) => element.scrollHeight - element.scrollTop - element.clientHeight < 80;

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

// The answer already shows on its request card, so a message holding only that answer adds nothing.
/** Whether a question the reply asked is shown after the message that owns the reply. */
export function replyContinuesBelow(messages: ConversationMessage[], turnId: string) {
  const index = messages.findIndex(message => message.turn?.id === turnId);
  return index >= 0 && messages.slice(index + 1).some(message => message.parts.some(part => part.kind === 'request'));
}

function answerOnly(message: ConversationMessage) {
  return (
    !message.turn &&
    message.tools.length === 0 &&
    message.calendarResults.length === 0 &&
    message.parts.length > 0 &&
    message.parts.every(part => part.kind === 'response')
  );
}

type ModelFamilies = Parameters<typeof replyStats>[2];
const noModelFamilies: never[] = [];
type ControlTurn = (message: ConversationMessage, kind: 'retry' | 'cancel') => void;
type FallbackControls = Pick<Parameters<typeof FallbackChip>[0], 'currentModel' | 'canSwitchTo' | 'switchModel'>;

// Each entry's row views and reply stats stay the same objects while the history does, so entries can skip rendering.
const entryDetailsCache = new WeakMap<
  ConversationMessage[],
  {
    families: ModelFamilies;
    rowViews: RowView[][];
    stats: (MessageActionsStats | undefined)[];
    fallbacks: ReturnType<typeof fallbackStarts>;
  }
>();
function entryDetails(messages: ConversationMessage[], families: ModelFamilies) {
  const cached = entryDetailsCache.get(messages);
  if (cached?.families === families) return cached;
  const details = {
    families,
    rowViews: messages.map(message => rowViewsForMessage(messages, message)),
    stats: messages.map((_, index) => replyStats(messages, index, families)),
    fallbacks: fallbackStarts(messages),
  };
  entryDetailsCache.set(messages, details);
  return details;
}

function rowViewsForMessage(messages: ConversationMessage[], message: ConversationMessage): RowView[] {
  const source =
    message.author === 'human'
      ? message
      : messages
          .slice(0, messages.indexOf(message) + 1)
          .filter(item => item.author === 'human' || item.tools.some(tool => tool.rowView))
          .at(-1);
  return source?.tools.flatMap(tool => (tool.status === 'completed' && tool.rowView ? [tool.rowView] : [])) ?? [];
}

function AssistantText({
  workspaceId,
  chatId,
  text,
  rowViews = [],
  streaming = false,
}: {
  workspaceId: string;
  chatId: string;
  text: string;
  rowViews?: RowView[];
  streaming?: boolean;
}) {
  const shown = useSmoothText(text, streaming);
  return (
    <MessageBubble variant="ghost">
      <GitHubChatResponse
        workspaceId={workspaceId}
        chatId={chatId}
        streaming={streaming}
        boundedTables={rowViews.length > 0}
      >
        {shown}
      </GitHubChatResponse>
    </MessageBubble>
  );
}

// Sprout's MessageActions formats its timestamps on every render; typing in the composer re-renders the whole history.
const EntryActions = memo(function EntryActions({
  text,
  author,
  createdAt,
  stats,
  entry,
}: {
  text: string;
  author: ConversationMessage['author'];
  createdAt: string;
  stats: MessageActionsStats | undefined;
  entry: RefObject<HTMLDivElement | null>;
}) {
  return (
    <MessageActions
      text={text}
      author={author}
      createdAt={createdAt}
      stats={stats}
      hover
      html={() => {
        const parts = entry.current?.querySelectorAll('[data-slot=message-bubble]');
        return parts?.length ? [...parts].map(part => part.innerHTML).join('') : undefined;
      }}
    />
  );
});

function layoutValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return value.toLocaleString();
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(layoutValue).join(', ');
  return JSON.stringify(value);
}

/** The values a person sent with a button in a reply's layout, listed under the words the button sent. */
function SentLayoutValues({
  context,
  labels = {},
}: {
  context: Record<string, unknown>;
  labels?: Record<string, string> | undefined;
}) {
  const entries = Object.entries(context);
  if (!entries.length) return null;
  return (
    <dl className="space-y-1 text-xs text-muted-foreground">
      {entries.map(([key, value]) => (
        <div key={key} className="flex min-w-0 gap-3">
          <dt className="shrink-0 font-medium">{key.replace(/[_-]+/g, ' ')}</dt>
          <dd className="min-w-0 break-words">{labels[key] ?? layoutValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

const ConversationEntry = memo(function ConversationEntry({
  api,
  chatId,
  slug,
  message,
  latest,
  rowViews,
  disabled,
  retryHandoff,
  control,
  stats,
  modelName,
  fallbackTurn,
  fallbackControls,
}: {
  fallbackTurn?: NonNullable<ConversationMessage['turn']> | undefined;
  fallbackControls?: FallbackControls | undefined;
  api: ConversationApi;
  chatId: string;
  slug: string;
  message: ConversationMessage;
  latest: boolean;
  rowViews: RowView[];
  disabled: boolean;
  retryHandoff: (compactionId: string) => void;
  control: ControlTurn;
  stats?: MessageActionsStats | undefined;
  modelName: (id: string) => string;
}) {
  const { workspace } = workspaceRoute.useRouteContext();
  const text = message.parts
    .flatMap(part => (part.kind === 'text' || part.kind === 'layout' ? [part.text] : []))
    .join('\n\n');
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
  const entry = useRef<HTMLDivElement>(null);
  const controlTurn = useCallback((kind: 'retry' | 'cancel') => control(message, kind), [control, message]);
  if (message.parts.every(part => part.kind === 'request' || part.kind === 'response')) return null;
  return (
    <div className="space-y-3">
      {fallbackTurn && fallbackControls && (
        <FallbackChip
          turn={fallbackTurn}
          answeredAt={message.createdAt}
          modelName={modelName}
          slug={slug}
          currentModel={fallbackControls.currentModel}
          canSwitchTo={fallbackControls.canSwitchTo}
          switchModel={fallbackControls.switchModel}
        />
      )}
      <Message align={message.author === 'human' ? 'end' : 'start'}>
        <MessageContent ref={entry}>
          {message.author === 'assistant' && <span className="sr-only">TulipFarm said</span>}
          {message.parts.map((part, index) => {
            switch (part.kind) {
              case 'request':
                return null;
              case 'approval':
              case 'approval-resolution':
                return <InteractionCard key={index} api={api} chatId={chatId} reference={part} />;
              case 'response':
                return null;
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
              case 'layout':
                return (
                  <LayoutReply
                    key={index}
                    chatId={chatId}
                    messageId={message.id}
                    latest={latest}
                    text={part.text}
                    value={part.layout}
                  />
                );
              case 'layout-action':
                return <SentLayoutValues key={index} context={part.action.context} labels={part.action.labels} />;
              case 'text':
                return message.followUp ? (
                  <MessageBubble key={index} variant="secondary">
                    <p className="whitespace-pre-wrap break-words">
                      <span aria-hidden>⏰ </span>
                      <span className="font-medium">Follow-up:</span> {message.followUp.instruction}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Scheduled {new Date(message.followUp.requestedAt).toLocaleString()}
                    </p>
                  </MessageBubble>
                ) : message.author === 'assistant' ? (
                  <AssistantText
                    key={index}
                    workspaceId={workspace.id}
                    chatId={chatId}
                    text={part.text}
                    rowViews={rowViews}
                  />
                ) : (
                  <MessageBubble key={index} variant="secondary">
                    <RichMessage
                      content={part.content}
                      text={part.text}
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
                  </MessageBubble>
                );
              case 'code-session':
                return (
                  <CodeSessionCard
                    key={`code-session-${part.sessionId}-${index}`}
                    workspaceId={workspace.id}
                    workspaceSlug={slug}
                    sessionId={part.sessionId}
                  />
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
          {message.stoppedTurnId && <p className="text-xs text-muted-foreground">{turnLabels.cancelled}</p>}
          {text && (
            <EntryActions
              text={text}
              author={message.author}
              createdAt={message.createdAt}
              stats={stats}
              entry={entry}
            />
          )}
          {message.turn && (
            <ReplyFooter
              turn={message.turn}
              tools={message.tools}
              skillName={skill?.name}
              disabled={disabled}
              control={controlTurn}
              workspaceSlug={slug}
            />
          )}
        </MessageContent>
      </Message>
    </div>
  );
});

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
          <SlackAction key={tool.id} api={slack} id={tool.id} refresh={changed} running={tool.status === 'running'} />
        ))}
      {message.tools
        .filter(tool => tool.status === 'completed' && tool.followUpId)
        .map(tool => (
          <FollowUpCard key={tool.id} api={api} chatId={chatId} id={tool.followUpId!} />
        ))}
      {message.tools
        .filter(
          tool =>
            succeeded(tool) &&
            !tool.importId &&
            !tool.memoryChange &&
            ([
              'agents.draft',
              'skills.draft',
              'workflows.draft',
              'workflows.archive',
              'workflows.restore',
              'agents.archive',
              'agents.restore',
              'skills.archive',
              'skills.restore',
              'projects.draft',
              'files.rename',
              'files.move',
              'files.trash',
              'files.restore',
              'files.share',
              'knowledge.add',
              'knowledge.update',
              'knowledge.remove',
              'memory.edit',
              'memory.forget',
            ].includes(tool.tool) ||
              tool.rowDraftId === tool.id),
        )
        .map(tool =>
          tool.tool === 'agents.draft' ? (
            <AgentDraftLink key={tool.id} api={api} workspaceId={workspace.id} chatId={chatId} id={tool.id} />
          ) : (
            <AuthoringDraftCard key={tool.id} api={api} chatId={chatId} id={tool.id} />
          ),
        )}
      {[
        ...new Map(
          message.tools
            .flatMap(tool => (tool.waitingRowDraft ? [tool.waitingRowDraft] : []))
            .map(draft => [draft.id, draft]),
        ).values(),
      ].map(draft => (
        <WaitingRowDraft key={`waiting:${draft.id}`} api={api} chatId={chatId} draft={draft} />
      ))}
      {message.tools
        .filter(tool => tool.status === 'completed' && tool.integration)
        .map(tool => (
          <IntegrationCard key={tool.id} workspaceId={workspace.id} slug={workspace.slug} card={tool.integration!} />
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
        .filter(tool => tool.tool === 'api.request' && tool.api?.review)
        .map(tool => (
          <ApiCallReviewCard key={`api:${tool.id}`} workspaceId={workspace.id} callId={tool.id} />
        ))}
      {message.tools
        .filter(tool => tool.tool === 'mcp.call' && tool.activityStatus === 'waiting')
        .map(tool => (
          <McpCallReviewCard key={`mcp:${tool.id}`} workspaceId={workspace.id} actionId={tool.id} onSettled={changed} />
        ))}
      {message.tools
        .filter(tool => tool.tool === 'coding.run' && tool.codingRun)
        .map(tool => (
          <CodingRunReviewCard
            key={`coding:${tool.id}`}
            workspaceId={workspace.id}
            runId={tool.id}
            onSettled={changed}
          />
        ))}
      {usedBrowser(message.tools) && <BrowserActivityCard workspaceId={workspace.id} chatId={chatId} />}
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
