import {
  createConversationExecutor,
  replyWorkSchema,
  type ConversationReply,
  type ConversationRuntime,
  type ExternalConversationContext,
} from '@tulipfarm/conversations/runtime';
import { inferenceRouteSchema, type InferenceRoute, type ToolInferenceContext } from '@tulipfarm/agents/inference';
import { respondToConversation } from './conversation-responder.ts';
import { conversationPlanning, createChatTools, isExternalTool, toolObservation } from '@tulipfarm/agents/tools';
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
  conversationFamilyPaused,
  conversationModel,
  roleModel,
  type ConversationModel,
} from './conversation-model.ts';
import { pausedFamilyReplacement } from '@tulipfarm/agents/model-policy';
import { withMcpSourceContext } from '@tulipfarm/access';
import { withKnowledgeSourceAuthorization } from '@tulipfarm/knowledge';
import type { KnowledgeToolsFactory } from '@tulipfarm/agents/tools';
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
import { withFileSources, type FileContent, type GoogleFileReader } from '@tulipfarm/conversations/file-references';
import type { FileOutputStore } from '@tulipfarm/conversations/file-outputs';
import { chatSkills } from '@tulipfarm/agents/chat-skills';
import { createReplyTextPublisher } from '@tulipfarm/conversations/event-publisher';
import { isFeatureEnabled } from '@tulipfarm/observability';
import { beginReplySession } from './reply-session.ts';
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
export type MeteredReplyOptions = {
  externalContext?: ExternalConversationContext | undefined;
  slack?: SlackActionsFactory | undefined;
  objects?: Pick<TableImportOptions, 'attachments' | 'snapshots'> | undefined;
  mcp?: McpExecutionFactory | null | undefined;
  knowledge?: KnowledgeToolsFactory | undefined;
  outputs?: FileOutputStore | undefined;
  skillExecution?: SkillExecutionFactory | undefined;
  wakePlan?: PlanWake | undefined;
  /** The inventory read context measurement already made for this attempt, reused instead of read again. */
  inventory?: ConversationInventoryReads | undefined;
};
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
    inventory,
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
    generateTitle,
    timeZone,
    priorCalls = 0,
    priorToolCalls = [],
    earlierMessages = false,
    retainedSources = [],
    describedHandles = [],
    project,
  }) => {
    // The picker offers no paused family, so one here is an existing chat or agent: it moves to the workspace fallback.
    const replacement = conversationFamilyPaused(model)
      ? await runtime.transaction(fence.workspaceId, commonCompatibility, tx =>
          pausedFamilyReplacement(tx, model, conversationFamilyPaused),
        )
      : null;
    const chat = conversationModel(replacement ?? model);
    if (!chat) throw new Error('conversation-model-unavailable');
    const validatedRoute = inferenceRouteSchema.parse(chat.route);
    const title = generateTitle ? chatTitleModel() : undefined;
    const titleRoute = title?.route;
    // A Slack turn linked to a member is that member's request. The start transaction requires the same requester, so a
    // sender removed mid-turn fails the turn there instead of answering without their destinations and tools.
    const session = await observeChatDetail('reply-start', () =>
      beginReplySession({
        runtime,
        fence,
        chat,
        title,
        externalContext,
        slack,
        mcp,
        outputs: Boolean(outputs),
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
      ...messages,
    ]);
    const publisher = createReplyTextPublisher(runtime, fence);
    // Previews reach every project member before the saved answer's audience check, so project chats show only the saved answer.
    const answerText = project
      ? undefined
      : ({ step, text }: { step: number; text: string }) => publisher.update(step, text);
    const progress: ToolInferenceContext['progress'] = update => publisher.progress(update);
    // Bud's expressions cost extra model rounds, so the avatar runs only where the bud-avatar flag is on.
    const budUser =
      externalContext || project
        ? null
        : (requester ??
          (await runtime
            .transaction(fence.workspaceId, commonCompatibility, tx =>
              turnRequester(tx, fence.conversationId, fence.turnId),
            )
            .catch(() => null)));
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
                  integrations:
                    call.tool === 'github.issue.read'
                      ? createIntegrationService({ runtime: context.runtime, keyring: integrationCredentialKeyring() })
                      : undefined,
                  atlassian: call.tool.startsWith('atlassian.') ? atlassianChatOperations(context.runtime) : undefined,
                  google: googleOperations,
                  slack,
                  github:
                    call.tool.startsWith('github.personal.') || call.tool.startsWith('github.investigation.')
                      ? githubChatReads(context.runtime)
                      : undefined,
                  objects,
                  knowledge,
                  knowledgeBudgetRuntime: runtime,
                  outputs: outputs ? { files: outputs, autonomous: !requester } : undefined,
                  skillExecution,
                  telemetryRuntime: externalContext ? 'slack' : 'chat',
                  wakePlan,
                  agentSetup: slackAgentSetupFromEnvironment(context.runtime),
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
        generateTitle,
        timeZone,
        mcp && requester && !externalContext
          ? {
              ...(avatar ? { avatar } : {}),
              priorCalls,
              priorToolCalls,
              earlierMessages,
              ...(answerText ? { answerText } : {}),
              progress,
              titleRoute,
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
              ...(answerText ? { answerText } : {}),
              progress,
              titleRoute,
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
  objects?: Pick<TableImportOptions, 'attachments' | 'snapshots'>,
  mcp: McpExecutionFactory | undefined = workspaceMcpFromEnvironment(),
  files?: FileContent & FileOutputStore,
  knowledge?: KnowledgeToolsFactory,
  compactor?: ConversationCompactor,
  skillExecution?: SkillExecutionFactory,
  wakePlan?: PlanWake,
) {
  const runtime = withFileSources(withKnowledgeSourceAuthorization(withGitHubSourceAuthorization(storage)));
  const slack = slackActionsFromEnvironment()?.(runtime);
  let google: ReturnType<typeof googleOperations> | undefined;
  const googleFiles: GoogleFileReader = {
    fileText: (...args) => (google ??= googleOperations(runtime)).fileText(...args),
  };
  return {
    processConversationReply: async (work: Parameters<ReturnType<typeof createConversationExecutor>['process']>[0]) =>
      withChatMeasurements(async () => {
        const parsed = replyWorkSchema.parse(work);
        if (mcp) await observeChatStage('recovery', () => mcp(runtime).recover(parsed.workspaceId));
        const execution = mcp ?? null;
        const inventory = compactor ? undefined : conversationInventoryReads(runtime);
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
              inventory,
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
          compactor ?? conversationCompactor(runtime, family => conversationModel(family), inventory),
          conversationPlanning,
        );
        return executor.process(parsed);
      }),
  };
}
import type { SkillExecutionFactory } from '@tulipfarm/agents/skill-execution';
