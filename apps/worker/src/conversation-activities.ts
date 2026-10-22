import {
  createConversationExecutor,
  renewConversationReplyLease,
  replyWorkSchema,
  type ConversationReply,
  type ConversationRuntime,
  type ExternalConversationContext,
} from '@tulipfarm/conversations/runtime';
import { inferenceRouteSchema, type InferenceRoute } from '@tulipfarm/agents/inference';
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
import { mergeSources, type SourceDependency } from '@tulipfarm/conversations/results';
import { googleOperations } from './google-composition.ts';
import { integrationCredentialKeyring, createIntegrationService } from '@tulipfarm/integrations';
import { calculateUsageCost, reserveModelCost, usageTokenCounts } from '@tulipfarm/config';
import {
  conversationFamilyPaused,
  conversationModel,
  roleModel,
  type ConversationModel,
} from './conversation-model.ts';
import { pausedFamilyReplacement } from '@tulipfarm/agents/model-policy';
import { recordUsage } from '@tulipfarm/extensions';
import { CreditAttemptAlreadyDispatched, settleCredits } from '@tulipfarm/workspace-storage/credits';
import { lockAuthorization, withMcpSourceContext } from '@tulipfarm/access';
import {
  requireCurrentConversationSources,
  requireGitHubSources,
  requireGoogleSources,
  requireKnowledgeSources,
  requireResultSources,
  requireMcpSources,
} from '@tulipfarm/conversations/source-access';
import { withKnowledgeSourceAuthorization } from '@tulipfarm/knowledge';
import type { KnowledgeToolsFactory } from '@tulipfarm/agents/tools';
import { createKnowledgeTools } from './knowledge-tools-composition.ts';
import { slackActionsFromEnvironment, slackAgentSetupFromEnvironment } from '@tulipfarm/agents/slack-environment';
import type { SlackActionsFactory } from '@tulipfarm/agents/slack-actions';
import { turnRequester } from '@tulipfarm/conversations/turn-requester';
import { withGitHubSourceAuthorization } from '@tulipfarm/github/source-runtime';
import type { TableImportOptions } from '@tulipfarm/tables/imports';
import { workspaceMcpFromEnvironment } from './workspace-mcp-composition.ts';
import type { McpExecutionFactory } from '@tulipfarm/agents/mcp-runtime';
import { isMcpCall, mcpCallSchema } from '@tulipfarm/agents/mcp-contracts';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { AsyncLocalStorage } from 'node:async_hooks';
import { conversationCompactor, projectReminder } from './conversation-compactor.ts';
import type { ConversationCompactor } from '@tulipfarm/conversations/compaction';
import { withFileSources, type FileContent, type GoogleFileReader } from '@tulipfarm/conversations/file-references';
import type { FileOutputStore } from '@tulipfarm/conversations/file-outputs';
import { chatSkills } from '@tulipfarm/agents/chat-skills';
import { createReplyTextPublisher } from '@tulipfarm/conversations/event-publisher';
import { readConversationInventory } from './conversation-inventory.ts';
import { requireDraftSources } from '@tulipfarm/agents/draft-sources';
import { recordCoordinatorModelTime, reserveCoordinatorModel } from '@tulipfarm/agents/plan-runtime';

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
  }: MeteredReplyOptions = {},
): ConversationReply {
  return async ({
    model,
    messages,
    sourceMessages = messages,
    executeTool,
    readPersonalMemory,
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
    // A Slack turn linked to a member is that member's request. Every step's admission requires the same requester, so a sender
    // removed mid-turn fails the turn here, as admission would, instead of answering without their destinations and tools.
    const { requester, destinations } = await observeChatDetail('requester', async () => {
      const requester =
        slack || mcp || outputs
          ? await runtime.transaction(fence.workspaceId, commonCompatibility, tx =>
              turnRequester(tx, fence.conversationId, fence.turnId),
            )
          : null;
      const destinations =
        requester && slack ? await slack(runtime).destinations(fence.workspaceId, requester.userId) : null;
      return { requester, destinations };
    });
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
    let catalogSources: SourceDependency[] = [];
    let inventorySources: SourceDependency[] = [];
    const readWorkspaceInventory =
      externalContext || project
        ? undefined
        : async () => {
            const result = await readConversationInventory(runtime, fence);
            inventorySources = result?.sources ?? [];
            return result?.inventory;
          };
    const publisher = createReplyTextPublisher(runtime, fence);
    // Previews reach every project member before the saved answer's audience check, so project chats show only the saved answer.
    const answerText = project
      ? undefined
      : ({ step, text }: { step: number; text: string }) => publisher.update(step, text);
    const progress = ({ step, round }: { step: number; round: number }) => publisher.progress(step, round);
    const avatar =
      !externalContext && !project
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
        (call, sources, activity) =>
          executeTool(
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
          ),
        async ({ step, inputBytes, maxOutputTokens, provider, model: providerModel }) => {
          const priced = [chat, title].find(
            candidate => candidate?.route.provider === provider && candidate.route.model === providerModel,
          )?.price;
          if (!priced) throw new Error('conversation-model-unpriced');
          const maxInputTokens = inputBytes + 4096;
          if (maxInputTokens > priced.maxInputTokens) throw new Error('conversation-context-overflow');
          const quote = {
            modelId: priced.modelId,
            pricingRevision: priced.pricingRevision,
            rates: priced.rates,
            maxInputTokens,
            maxOutputTokens,
            date: new Date().toISOString().slice(0, 10),
          };
          const id = `chat:${fence.turnId}:${fence.generation}:${fence.epoch}:${step}`;
          let coordinatorAttempt: string | null = null;
          const admitted = await runtime.transaction(fence.workspaceId, commonCompatibility, async tx => {
            await observeChatDetail('authorize', async () => {
              await lockAuthorization(tx);
              await requireCurrentConversationSources(tx, fence.conversationId, fence.turnId);
              await renewConversationReplyLease(tx, fence);
              if ((mcp || readWorkspaceInventory) && !externalContext) {
                await tx.client.query(
                  `INSERT INTO ${qualified(tx.schema, 'tf_conversation_model_sources')} (turn_id,epoch,step,sources) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
                  [
                    fence.turnId,
                    fence.epoch,
                    step,
                    JSON.stringify(mergeSources([...retainedSources, ...catalogSources, ...inventorySources])),
                  ],
                );
              }
              await externalContext?.(tx, fence);
            });
            const reserved = reserveModelCost(quote);
            const reservation = await reserveCoordinatorModel(tx, fence, {
              id,
              modelId: priced.modelId,
              agentId: null,
              activity: 'chat',
              providerPicoUsd: reserved,
              pricingRevision: quote.pricingRevision,
            });
            coordinatorAttempt = reservation.attemptId;
            return reservation.admitted;
          });
          if (!admitted) throw new CreditAttemptAlreadyDispatched();
          const started = performance.now();
          return async usage => {
            const settled = await runtime.transaction(fence.workspaceId, commonCompatibility, async tx => {
              if (coordinatorAttempt)
                await recordCoordinatorModelTime(tx, id, coordinatorAttempt, performance.now() - started);
              if (usage.kind !== 'known') return null;
              const { kind, ...tokens } = usage;
              const cost = calculateUsageCost({ ...quote, usage: { kind, tokens } });
              if (cost.kind !== 'known') return null;
              await settleCredits(tx, id, cost.providerPicoUsd);
              return { tokens, providerPicoUsd: cost.providerPicoUsd };
            });
            if (settled)
              void recordUsage({
                workspaceId: fence.workspaceId,
                flowId: fence.conversationId,
                modelId: priced.modelId,
                agentId: null,
                activity: 'chat',
                ...usageTokenCounts(settled.tokens),
                providerPicoUsd: settled.providerPicoUsd,
                at: new Date(),
              });
          };
        },
        async sources => {
          await runtime.transaction(fence.workspaceId, commonCompatibility, async tx => {
            await lockAuthorization(tx);
            const actor = await requireCurrentConversationSources(tx, fence.conversationId, fence.turnId);
            if (readWorkspaceInventory)
              await requireDraftSources(
                tx,
                await turnRequester(tx, fence.conversationId, fence.turnId),
                inventorySources,
              );
            await requireGitHubSources(
              tx,
              actor ?? (await turnRequester(tx, fence.conversationId, fence.turnId)),
              sources,
            );
            await requireGoogleSources(
              tx,
              actor ?? (await turnRequester(tx, fence.conversationId, fence.turnId)),
              sources,
            );
            await requireKnowledgeSources(
              tx,
              actor ?? (await turnRequester(tx, fence.conversationId, fence.turnId)),
              sources,
            );
            await requireMcpSources(
              tx,
              actor ?? (await turnRequester(tx, fence.conversationId, fence.turnId)),
              fence.conversationId,
              sources,
            );
            if (actor) await requireResultSources(tx, actor, fence.conversationId, sources);
            await externalContext?.(tx, fence, sources);
          });
        },
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
              readPersonalMemory,
              readWorkspaceInventory,
              projectInstructions: project?.instructions,
              sources: () => mergeSources([...catalogSources, ...inventorySources]),
              catalog: async () => {
                const catalog = await mcp(runtime).catalog(
                  {
                    workspaceId: fence.workspaceId,
                    actor: requester,
                    origin: {
                      kind: 'private-chat',
                      conversationId: fence.conversationId,
                      turnId: fence.turnId,
                      stepId: fence.turnId,
                    },
                  },
                  describedHandles,
                );
                catalogSources = mergeSources([...catalogSources, ...catalog.sources]);
                return catalog.model;
              },
            }
          : {
              ...(avatar ? { avatar } : {}),
              priorCalls,
              priorToolCalls,
              earlierMessages,
              ...(answerText ? { answerText } : {}),
              progress,
              titleRoute,
              readPersonalMemory: externalContext ? undefined : readPersonalMemory,
              readWorkspaceInventory,
              projectInstructions: project?.instructions,
              sources: () => inventorySources,
            },
        retainedSources,
        sourceMessages,
      );
    } finally {
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
          compactor ?? conversationCompactor(runtime, family => conversationModel(family)),
          conversationPlanning,
        );
        return executor.process(parsed);
      }),
  };
}
import type { SkillExecutionFactory } from '@tulipfarm/agents/skill-execution';
