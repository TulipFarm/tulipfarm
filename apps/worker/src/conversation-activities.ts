import {
  createConversationExecutor,
  replyWorkSchema,
  type ReplyWork,
  type ConversationReply,
  type ConversationRuntime,
  type ExternalConversationContext,
} from '@tulipfarm/conversations/runtime';
import {
  inferenceRouteSchema,
  routeCapabilities,
  type InferenceRoute,
  type ToolInferenceContext,
} from '@tulipfarm/agents/inference';
import { chatTurnFiles } from './turn-files-composition.ts';
import type { AttachmentBytes } from '@tulipfarm/conversations/attachments';
import { respondToConversation } from './conversation-responder.ts';
import {
  conversationPlanning,
  createChatTools,
  discoverToolNames,
  isExternalTool,
  toolObservation,
} from '@tulipfarm/agents/tools';
import { createSubagentPool, resultCapBytes } from '@tulipfarm/agents/subagents';
import { createSubagentDelegation } from './subagent-composition.ts';
import { createSubagentStops, type SubagentStops } from './subagent-stops.ts';
import {
  observeChatStage,
  observeTool,
  observeChatDetail,
  observeChatDetailSync,
  withChatMeasurements,
} from '@tulipfarm/observability';
import { atlassianChatOperations } from './atlassian-composition.ts';
import { githubChatReads } from './github-composition.ts';
import { mergeSources } from '@tulipfarm/conversations/results';
import { googleOperations } from './google-composition.ts';
import { integrationCredentialKeyring, createIntegrationService } from '@tulipfarm/integrations';
import {
  chatFallbackModel,
  chatReplyModel,
  conversationFamilyPaused,
  conversationModel,
  roleModel,
  type ConversationModel,
} from './conversation-model.ts';
import { pausedFamilyReplacement } from '@tulipfarm/agents/model-policy';
import { withMcpSourceContext } from '@tulipfarm/access';
import { withKnowledgeSourceAuthorization } from '@tulipfarm/knowledge';
import type { ChatFiles, KnowledgeToolsFactory } from '@tulipfarm/agents/tools';
import { createKnowledgeTools } from './knowledge-tools-composition.ts';
import { slackActionsFromEnvironment, slackAgentSetupFromEnvironment } from '@tulipfarm/agents/slack-environment';
import type { SlackActionsFactory } from '@tulipfarm/agents/slack-actions';
import { withGitHubSourceAuthorization } from '@tulipfarm/github/source-runtime';
import type { TableImportOptions } from '@tulipfarm/tables/imports';
import { workspaceMcpFromEnvironment } from './workspace-mcp-composition.ts';
import type { McpExecutionFactory } from '@tulipfarm/agents/mcp-runtime';
import { isMcpCall, mcpCallSchema } from '@tulipfarm/agents/mcp-contracts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { AsyncLocalStorage } from 'node:async_hooks';
import { conversationCompactor, projectReminder } from './conversation-compactor.ts';
import type { ConversationCompactor } from '@tulipfarm/conversations/compaction';
import { compactionDefaults } from '@tulipfarm/config/compaction';
import { withFileSources, type FileContent, type GoogleFileReader } from '@tulipfarm/conversations/file-references';
import type { FileOutputStore } from '@tulipfarm/conversations/file-outputs';
import type { ImageOutputStore } from '@tulipfarm/conversations/image-outputs';
import { pinnedImageModels } from '@tulipfarm/conversations/turn-image-models';
import { pinnedImageChoice } from '@tulipfarm/agents/image-generation';
import { chatSkills } from '@tulipfarm/agents/chat-skills';
import { createReplyTextPublisher } from '@tulipfarm/conversations/event-publisher';
import { isFeatureEnabled } from '@tulipfarm/observability';
import { beginReplySession } from './reply-session.ts';
import { conversationTitleActivity } from './conversation-title.ts';
import type { ConversationTitleWork } from '@tulipfarm/conversations/titles';
import { conversationInventoryReads, type ConversationInventoryReads } from './conversation-inventory.ts';

/** The first-turn title is short, so it uses the title role's family. Without a model for it, the title uses the chat model. */
export function chatTitleModel(env: NodeJS.ProcessEnv = process.env): ConversationModel | undefined {
  const model = roleModel('title', env);
  return model
    ? { route: { ...model.route, maxOutputTokens: Math.min(256, model.price.maxOutputTokens) }, price: model.price }
    : undefined;
}
export function chatTitleRoute(env: NodeJS.ProcessEnv = process.env): InferenceRoute | undefined {
  return chatTitleModel(env)?.route;
}

/** Starts a changed plan's scheduler at once instead of waiting for the recovery sweep. */
export type PlanWake = (workspaceId: string, planId: string) => Promise<unknown>;
/** Starts a task at once instead of waiting for the recovery sweep. */
export type TaskWake = (workspaceId: string, taskId: string) => Promise<unknown>;
let sharedSubagentStops: SubagentStops | undefined;
export type MeteredReplyOptions = {
  externalContext?: ExternalConversationContext | undefined;
  slack?: SlackActionsFactory | undefined;
  objects?: Pick<TableImportOptions, 'attachments' | 'snapshots'> | undefined;
  mcp?: McpExecutionFactory | null | undefined;
  knowledge?: KnowledgeToolsFactory | undefined;
  /** Files publication; with `read`, chat may also generate images into it. */
  outputs?: (FileOutputStore & Partial<Pick<ImageOutputStore, 'read'>>) | undefined;
  skillExecution?: SkillExecutionFactory | undefined;
  wakePlan?: PlanWake | undefined;
  wakeTask?: TaskWake | undefined;
  /** Delivers per-card Stop requests to running sub-agents. */
  subagentStops?: SubagentStops | undefined;
  /** The inventory read context measurement already made for this attempt, reused instead of read again. */
  inventory?: ConversationInventoryReads | undefined;
  /** Summarises a long reply's older tool results. Without it, they are cut to stubs that can be reread. */
  compactor?: ConversationCompactor | undefined;
  /** Reads this chat's files for `files.read` when the turn used the images reader. */
  chatFiles?: Omit<ChatFiles, 'imageInput'> | undefined;
};
/** A paused family's replacement may not read images that the pinned family would have. */
function withoutImages(messages: Parameters<ConversationReply>[0]['messages']) {
  return messages.map(message =>
    'text' in message
      ? message
      : {
          role: message.role,
          text: message.content
            .map(part =>
              part.type === 'text'
                ? part.text
                : '[An image here was left out: the model answering cannot read images.]',
            )
            .join(''),
        },
  );
}

export function meteredReply(
  runtime: ConversationRuntime,
  {
    externalContext,
    slack = slackActionsFromEnvironment(),
    objects,
    mcp = workspaceMcpFromEnvironment(),
    knowledge = createKnowledgeTools({ runtime }),
    outputs,
    skillExecution,
    wakePlan,
    wakeTask,
    subagentStops = (sharedSubagentStops ??= createSubagentStops()),
    inventory,
    compactor,
    chatFiles,
  }: MeteredReplyOptions = {},
): ConversationReply {
  return async ({
    model,
    messages,
    sourceMessages = messages,
    executeTool,
    readPersonalMemory,
    personalMemory,
    settle,
    fence,
    timeZone,
    priorCalls = 0,
    priorToolCalls = [],
    earlierMessages = false,
    chatFiles: chatFilesOffered = false,
    retainedSources = [],
    describedHandles = [],
    project,
    compactionPolicy,
  }) => {
    // The picker offers no paused family, so one here is an existing chat or agent: it moves to the workspace fallback.
    const replacement = conversationFamilyPaused(model)
      ? await runtime.transaction(fence.workspaceId, commonCompatibility, tx =>
          pausedFamilyReplacement(tx, model, conversationFamilyPaused),
        )
      : null;
    const chat = chatReplyModel(replacement ?? model);
    if (!chat) throw new Error('conversation-model-unavailable');
    const validatedRoute = inferenceRouteSchema.parse(chat.route);
    const fallback = chatFallbackModel(chat.price.familyId);
    const completionCheck = roleModel('completion-check') ?? undefined;
    const replyContext = {
      context: {
        window: chat.price.maxInputTokens,
        triggerPercent: compactionPolicy?.triggerPercent ?? compactionDefaults.triggerPercent,
        targetPercent: compactionPolicy?.targetPercent ?? compactionDefaults.targetPercent,
      },
      ...(compactor && compactionPolicy?.automatic && compactionPolicy.families.length
        ? {
            compactToolResults: async ({ round, system, text }: { round: number; system: string; text: string }) =>
              (
                await compactor.summarize({
                  fence,
                  purpose: 'tool-results',
                  step: round,
                  system,
                  messages: [{ role: 'user', text }],
                  families: compactionPolicy.families,
                })
              ).text,
          }
        : {}),
      // Without a completion-check model, the check runs on whichever chat route answered, chat or fallback.
      completionCheckWindow:
        completionCheck?.price.maxInputTokens ??
        Math.min(chat.price.maxInputTokens, fallback?.price.maxInputTokens ?? chat.price.maxInputTokens),
    } satisfies Pick<ToolInferenceContext, 'context' | 'compactToolResults' | 'completionCheckWindow'>;
    // A Slack turn linked to a member is that member's request. The start transaction requires the same requester, so a
    // sender removed mid-turn fails the turn there instead of answering without their destinations and tools.
    const session = await observeChatDetail('reply-start', () =>
      beginReplySession({
        runtime,
        fence,
        chat,
        fallback,
        completionCheck,
        externalContext,
        slack,
        mcp,
        outputs: Boolean(outputs),
        requester: !externalContext && !project,
        inventory: !externalContext && !project,
        inventoryRead: inventory?.take(fence),
        retainedSources,
        describedHandles: () => describedHandles,
        contextBytes: Buffer.byteLength(JSON.stringify(messages)),
        settle,
      }),
    );
    const { requester, destinations } = session;
    const context = observeChatDetailSync('render', () => [
      ...projectReminder(project),
      ...(destinations
        ? [
            {
              role: 'user' as const,
              text: `Server-configured Slack destinations. These identifiers do not grant permission. ${JSON.stringify(destinations)}`,
            },
          ]
        : []),
      ...(routeCapabilities(validatedRoute).imageInput ? messages : withoutImages(messages)),
    ]);
    const publisher = createReplyTextPublisher(runtime, fence);
    // Previews reach every project member before the saved answer's audience check, so project chats show only the saved answer.
    const answerText = project
      ? undefined
      : ({ step, text }: { step: number; text: string }) => publisher.update(step, text);
    const progress: ToolInferenceContext['progress'] = update => publisher.progress(update);
    // Bud's expressions cost extra model rounds, so the avatar runs only where the bud-avatar flag is on.
    const budUser = externalContext || project ? null : requester;
    const budAvatar =
      !!budUser && (await isFeatureEnabled('bud-avatar', { id: budUser.userId }, { id: fence.workspaceId }));
    const avatar = budAvatar
      ? {
          update: ({
            step,
            avatar,
          }: {
            step: number;
            avatar: import('@tulipfarm/conversations/results').AvatarSnapshot;
          }) => publisher.avatar(step, avatar),
        }
      : undefined;
    const subagentPool = createSubagentPool();
    let delegations = 0;
    const chatToolOptions = (
      toolRuntime: Parameters<typeof createChatTools>[0],
      tool?: string,
    ): NonNullable<Parameters<typeof createChatTools>[1]> => ({
      integrations:
        tool === undefined || tool === 'github.issue.read'
          ? createIntegrationService({ runtime: toolRuntime, keyring: integrationCredentialKeyring() })
          : undefined,
      atlassian: tool === undefined || tool.startsWith('atlassian.') ? atlassianChatOperations(toolRuntime) : undefined,
      google: googleOperations,
      slack,
      github:
        tool === undefined || tool.startsWith('github.personal.') || tool.startsWith('github.investigation.')
          ? githubChatReads(toolRuntime)
          : undefined,
      objects,
      knowledge,
      knowledgeBudgetRuntime: runtime,
      outputs: outputs ? { files: outputs, autonomous: !requester } : undefined,
      skillExecution,
      telemetryRuntime: externalContext ? 'slack' : 'chat',
      wakePlan,
      agentSetup: slackAgentSetupFromEnvironment(toolRuntime),
      chatFiles: chatFiles && { ...chatFiles, imageInput: routeCapabilities(validatedRoute).imageInput },
      images:
        outputs?.read && chatFiles
          ? {
              files: { ...outputs, read: outputs.read },
              attachments: chatFiles.turnFiles.attachments,
              autonomous: !requester,
              choose: async (tx, turnId) =>
                pinnedImageChoice(tx, await pinnedImageModels(tx, turnId, model, chatFiles.turnFiles)),
            }
          : undefined,
    });
    try {
      return await respondToConversation(
        { ...validatedRoute, maxOutputTokens: chat.price.maxOutputTokens },
        context,
        async (call, sources, activity) => {
          session.toolRan(call.tool);
          await session.beforeTool();
          return executeTool(
            call.tool,
            isExternalTool(call.tool),
            async context => {
              if (isMcpCall(call)) {
                const output = await observeTool(
                  call.tool,
                  externalContext ? 'slack' : 'chat',
                  async () => {
                    if (!mcp) throw new Error('mcp-unavailable');
                    return mcp(context.runtime).execute(
                      {
                        workspaceId: context.workspaceId,
                        actor: context.actor,
                        origin: {
                          kind: 'private-chat',
                          conversationId: context.origin.conversationId,
                          turnId: context.origin.turnId,
                          stepId: context.callId,
                        },
                      },
                      context.callId,
                      call,
                    );
                  },
                  output => toolObservation(output.result, call.tool),
                );
                if (call.tool === 'mcp.describe') describedHandles = [call.handle];
                return { ...output, receiptId: context.callId };
              }
              const invoke = () =>
                createChatTools(context.runtime, {
                  ...chatToolOptions(context.runtime, call.tool),
                  subagents:
                    call.tool === 'agents.delegate'
                      ? createSubagentDelegation({
                          runtime: context.runtime,
                          route: { ...validatedRoute, maxOutputTokens: chat.price.maxOutputTokens },
                          family: chat.price.familyId,
                          meter: session.creditMeter,
                          tools: createChatTools(context.runtime, chatToolOptions(context.runtime)),
                          offered: new Set(discoverToolNames({ kind: 'chat', earlierMessages })),
                          pool: subagentPool,
                          // The report leaves room for the result's envelope inside the reply's tool-result cap.
                          resultBytes: resultCapBytes(replyContext.context.window) - 1024,
                          sequence: delegations++,
                          publish: project ? undefined : (id, cards) => publisher.subagents(id, cards),
                          stops: subagentStops,
                          wakeTask,
                        })
                      : undefined,
                }).invokeWithSources(
                  {
                    ...context,
                    origin: { ...context.origin, sources: mergeSources([...context.origin.sources, ...sources]) },
                  },
                  call,
                );
              const withSources = await context.runtime.transaction(fence.workspaceId, commonCompatibility, tx =>
                withMcpSourceContext(tx, [...context.origin.sources, ...sources], async () =>
                  AsyncLocalStorage.snapshot(),
                ),
              );
              return { ...(await withSources(invoke)), receiptId: context.callId };
            },
            sources,
            call,
            activity,
          );
        },
        session.meter,
        session.authorizeSources,
        false,
        timeZone,
        mcp && requester && !externalContext
          ? {
              ...(avatar ? { avatar } : {}),
              priorCalls,
              priorToolCalls,
              earlierMessages,
              chatFiles: chatFilesOffered && Boolean(chatFiles),
              ...(answerText ? { answerText } : {}),
              progress,
              ...replyContext,
              completionCheck: completionCheck?.route,
              ...(fallback
                ? {
                    fallback: {
                      route: { ...fallback.route, maxOutputTokens: fallback.price.maxOutputTokens },
                      label: fallback.price.familyId,
                    },
                  }
                : {}),
              readPersonalMemory: personalMemory ?? readPersonalMemory,
              readWorkspaceInventory: session.readWorkspaceInventory,
              projectInstructions: project?.instructions,
              sources: session.sources,
              checkpoint: session.checkpoint,
              ...(session.catalog ? { catalog: session.catalog } : {}),
            }
          : {
              ...(avatar ? { avatar } : {}),
              priorCalls,
              priorToolCalls,
              earlierMessages,
              chatFiles: chatFilesOffered && Boolean(chatFiles),
              ...(answerText ? { answerText } : {}),
              progress,
              ...replyContext,
              completionCheck: completionCheck?.route,
              ...(fallback
                ? {
                    fallback: {
                      route: { ...fallback.route, maxOutputTokens: fallback.price.maxOutputTokens },
                      label: fallback.price.familyId,
                    },
                  }
                : {}),
              readPersonalMemory: externalContext ? undefined : (personalMemory ?? readPersonalMemory),
              readWorkspaceInventory: session.readWorkspaceInventory,
              projectInstructions: project?.instructions,
              sources: session.sources,
              checkpoint: session.checkpoint,
            },
        retainedSources,
        sourceMessages,
      );
    } finally {
      session.close();
      await observeChatDetail('publisher-close', () => publisher.close());
    }
  };
}

export function createConversationActivities(
  storage: ConversationRuntime,
  conversationReply?: ConversationReply,
  objects?: Pick<TableImportOptions, 'snapshots'> & { attachments: AttachmentBytes },
  mcp: McpExecutionFactory | undefined = workspaceMcpFromEnvironment(),
  files?: FileContent & ImageOutputStore,
  knowledge?: KnowledgeToolsFactory,
  compactor?: ConversationCompactor,
  skillExecution?: SkillExecutionFactory,
  wakePlan?: PlanWake,
  wakeTask?: TaskWake,
) {
  const runtime = withFileSources(withKnowledgeSourceAuthorization(withGitHubSourceAuthorization(storage)));
  const slack = slackActionsFromEnvironment()?.(runtime);
  let google: ReturnType<typeof googleOperations> | undefined;
  const googleFiles: GoogleFileReader = {
    fileText: (...args) => (google ??= googleOperations(runtime)).fileText(...args),
    fileDocument: (...args) => (google ??= googleOperations(runtime)).fileDocument(...args),
  };
  const turnFiles = objects ? chatTurnFiles(runtime, objects) : undefined;
  const generateTitle = conversationTitleActivity(storage);
  const run = <T>(
    work: unknown,
    process: (executor: ReturnType<typeof createConversationExecutor>, work: ReplyWork) => Promise<T>,
  ) =>
    withChatMeasurements(async () => {
      const parsed = replyWorkSchema.parse(work);
      if (mcp) await observeChatStage('recovery', () => mcp(runtime).recover(parsed.workspaceId));
      const execution = mcp ?? null;
      const inventory = compactor ? undefined : conversationInventoryReads(runtime);
      const effectiveCompactor =
        compactor ?? conversationCompactor(runtime, family => conversationModel(family), inventory);
      const executor = createConversationExecutor(
        runtime,
        conversationReply ??
          meteredReply(runtime, {
            objects,
            mcp: execution,
            knowledge: knowledge ?? createKnowledgeTools({ runtime: storage }),
            outputs: files,
            skillExecution,
            wakePlan,
            wakeTask,
            inventory,
            compactor: effectiveCompactor,
            chatFiles: turnFiles ? { files, google: googleFiles, turnFiles } : undefined,
          }),
        undefined,
        slack?.resumeConversation,
        execution
          ? (context, call) =>
              execution(context.runtime).execute(
                {
                  workspaceId: context.workspaceId,
                  actor: context.actor,
                  origin: {
                    kind: 'private-chat',
                    conversationId: context.origin.conversationId,
                    turnId: context.origin.turnId,
                    stepId: context.callId,
                  },
                },
                context.callId,
                mcpCallSchema.parse(call),
              )
          : undefined,
        files,
        googleFiles,
        chatSkills,
        effectiveCompactor,
        conversationPlanning,
        turnFiles,
      );
      return process(executor, parsed);
    });
  return {
    processConversationReply: (work: Parameters<ReturnType<typeof createConversationExecutor>['process']>[0]) =>
      run(work, (executor, parsed) => executor.process(parsed)),
    /** Delivers the reply and reports, without waiting on it, whether the chat still needs its first generated title. */
    deliverConversationReply: (work: ReplyWork) => run(work, (executor, parsed) => executor.processReply(parsed)),
    generateConversationTitle: ({
      attempt,
      final,
      ...work
    }: ConversationTitleWork & { attempt: number; final: boolean }) => generateTitle(work, attempt, final),
  };
}
import type { SkillExecutionFactory } from '@tulipfarm/agents/skill-execution';
