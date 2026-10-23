import { AccessDenied, lockAuthorization } from '@tulipfarm/access';
import { readWorkspaceInventory } from '@tulipfarm/agents/tools';
import type { McpExecutionFactory, McpExecutionPort } from '@tulipfarm/agents/mcp-runtime';
import type { SlackActionsFactory } from '@tulipfarm/agents/slack-actions';
import { requireDraftSources } from '@tulipfarm/agents/draft-sources';
import { coordinatorReplyBudget, recordCoordinatorReplyTime } from '@tulipfarm/agents/plan-runtime';
import type { InferenceUsage, ToolModelMeter } from '@tulipfarm/agents/inference';
import { calculateUsageCost, reserveModelCost, usageTokenCounts } from '@tulipfarm/config';
import {
  renewConversationReplyLease,
  type ConversationRuntime,
  type ExternalConversationContext,
  type ReplyFence,
  type ReplySettlement,
  type ReplyTransaction,
} from '@tulipfarm/conversations/runtime';
import { mergeSources, type SourceDependency } from '@tulipfarm/conversations/results';
import {
  requireCurrentConversationSources,
  requireGitHubSources,
  requireGoogleSources,
  requireKnowledgeSources,
  requireMcpSources,
  requireResultSources,
} from '@tulipfarm/conversations/source-access';
import { turnRequester } from '@tulipfarm/conversations/turn-requester';
import { recordUsage } from '@tulipfarm/extensions';
import { log, observeChatDetail } from '@tulipfarm/observability';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import {
  CreditAttemptAlreadyDispatched,
  creditUnitsForProviderCost,
  holdReplyCredits,
  providerCostAtUnits,
  recoverReplyHolds,
  settleReplyCredits,
} from '@tulipfarm/workspace-storage/credits';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import type { ConversationModel } from './conversation-model.ts';
import type { ConversationInventory } from './conversation-inventory.ts';

type Tx = ReplyTransaction;
type Actor = Awaited<ReturnType<typeof turnRequester>>;
type Inventory = Awaited<ReturnType<typeof readWorkspaceInventory>>['inventory'];
type Catalog = Awaited<ReturnType<McpExecutionPort['catalog']>>['model'];
type Call = {
  id: string;
  modelId: string;
  pricingRevision: string;
  /** The call's worst-case charge in credit units: what its own reservation held before. */
  worst: bigint;
  started: number;
  usage?: { providerPicoUsd: string; tokens: Parameters<typeof usageTokenCounts>[0] };
  /** The provider refused the request before generating anything, so the call costs nothing. */
  rejected?: boolean;
  milliseconds?: number;
};
type Hold = { id: string; held: bigint; calls: Call[] };
type Plan = { attemptId: string; remainingUnits: bigint; remainingMilliseconds: number };

/** Renews the reply's lease while model calls run. Each renewal is one short transaction. */
const leaseRenewalMilliseconds = 30_000;
/** Room for a reply's next request to grow before it needs a top-up: tool results, the answer and the runtime reminder. */
const holdSlackBytes = 128 * 1024;
/** Tools that can change the workspace inventory the runtime reminder lists. Other tools never re-read it. */
const inventoryTools = ['tables.', 'schema.', 'agents.', 'workflows.', 'skills.'];
const databaseConflict = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && (error.code === '40P01' || error.code === '40001');

const units = (providerPicoUsd: string) => creditUnitsForProviderCost(BigInt(providerPicoUsd));
/** A call's worst-case provider cost, as its own reservation quoted it. */
const quote = (model: ConversationModel, maxInputTokens: number, maxOutputTokens: number) =>
  BigInt(
    reserveModelCost({
      modelId: model.price.modelId,
      pricingRevision: model.price.pricingRevision,
      rates: model.price.rates,
      maxInputTokens,
      maxOutputTokens,
      date: new Date().toISOString().slice(0, 10),
    }),
  );
/** A call's worst case for an estimated request size, within the model's limits. */
const estimate = (model: ConversationModel, inputBytes: number, maxOutputTokens = model.price.maxOutputTokens) =>
  quote(
    model,
    Math.min(inputBytes + 4096, model.price.maxInputTokens),
    Math.min(maxOutputTokens, model.price.maxOutputTokens),
  );

/**
 * One reply's database work. The start transaction reads what every round reuses (requester, Slack destinations,
 * the MCP catalog and the workspace inventory), authorizes them, and holds credits for the whole reply. Model
 * calls then meter against the hold in memory, with no transaction open while a model runs. A finished tool round
 * saves its progress in one checkpoint transaction, which re-reads only what that round's tools could change. The
 * executor's final transaction settles the hold, so a greeting makes one start read and one end write.
 *
 * Every hold, top-up and settlement runs under the workspace credit lock, and a hold never exceeds the gate's
 * available balance, so concurrent replies cannot overdraw it. State in memory changes only after its transaction
 * commits, so a rolled-back top-up leaves the previous hold for the final settlement.
 */
export async function beginReplySession(input: {
  runtime: ConversationRuntime;
  fence: ReplyFence;
  chat: ConversationModel;
  /** The model a failed chat call may retry on once; its calls are billed as that model. */
  fallback?: ConversationModel | undefined;
  /** The optional completion-check role's calls are authorized and billed like chat calls. */
  completionCheck?: ConversationModel | undefined;
  externalContext: ExternalConversationContext | undefined;
  slack: SlackActionsFactory | undefined;
  mcp: McpExecutionFactory | null | undefined;
  outputs: boolean;
  /** Whether a caller needs the requester for something other than Slack, MCP or outputs (the bud-avatar flag). */
  requester: boolean;
  inventory: boolean;
  /** This attempt's inventory read from context measurement. Without one, the start transaction reads it. */
  inventoryRead?: Promise<ConversationInventory> | undefined;
  retainedSources: readonly SourceDependency[];
  describedHandles: () => readonly string[];
  contextBytes: number;
  settle: ((settlement: ReplySettlement) => void) | undefined;
}) {
  const { runtime, fence, chat, externalContext } = input;
  const chatId = (step: number) => `chat:${fence.turnId}:${fence.generation}:${fence.epoch}:${step}`;
  // A greeting makes a reply call and a completion check; its title is billed separately after delivery. Longer replies
  // top up or roll the hold.
  const preferred = (bytes: number) => 2n * units(estimate(chat, bytes + holdSlackBytes).toString());
  // Every request carries a 4096-token allowance, so a balance below this cannot pay for any first call.
  const minimum = estimate(chat, 0);
  const withCatalog = Boolean(input.mcp) && !externalContext;
  const modelSources = (input.mcp || input.inventory) && !externalContext;

  const local = (tx: Tx): ConversationRuntime => ({
    transaction: async (workspaceId, range, operation) => {
      if (workspaceId !== fence.workspaceId || tx.commonVersion < range.minimum || tx.commonVersion > range.maximum)
        throw new AccessDenied();
      return operation(tx);
    },
  });

  let requester: Actor | null = null;
  let inventory: Inventory | undefined;
  let inventorySources: SourceDependency[] = [];
  let catalog: Catalog | undefined;
  let catalogSources: SourceDependency[] = [];
  let authorizedKey: string | undefined;
  let modelSourcesKey: string | undefined;
  let plan: Plan | null = null;
  let hold: Hold | undefined;
  let flushedMilliseconds = 0;
  let lastStep = -1;
  let lastInputBytes = input.contextBytes;
  let holds = 0;
  let lost: unknown;
  const settledCalls: Call[] = [];
  const ranTools = new Set<string>();

  const contextSources = () => mergeSources([...catalogSources, ...inventorySources]);
  const keyOf = (sources: readonly SourceDependency[]) => canonicalJson(mergeSources([...sources]));
  /** An upper bound on a call's charge: its known cost, nothing when refused, or its whole reservation while usage is unknown. */
  const charge = (call: Call) =>
    (call.usage ? units(call.usage.providerPicoUsd) : call.rejected ? 0n : call.worst) + 1n;
  const consumed = () => (hold?.calls ?? []).reduce((total, call) => total + charge(call), 0n);
  const unflushed = () =>
    [...settledCalls, ...(hold?.calls ?? [])].reduce((total, call) => total + (call.milliseconds ?? 0), 0) -
    flushedMilliseconds;

  async function readInventory(tx: Tx, slackActor: Actor | null) {
    const row = (
      await tx.client.query(
        `SELECT project_id,EXISTS(SELECT 1 FROM ${qualified(tx.schema, 'tf_slack_default_turns')} WHERE conversation_id=$1) AS external FROM ${qualified(tx.schema, 'tf_conversations')} WHERE id=$1`,
        [fence.conversationId],
      )
    ).rows[0];
    if (!row) throw new AccessDenied();
    if (slackActor || row.external || row.project_id) return { inventory: undefined, sources: [] };
    return readWorkspaceInventory(
      local(tx),
      fence.workspaceId,
      requester ?? (await turnRequester(tx, fence.conversationId, fence.turnId)),
    );
  }

  async function readCatalog(tx: Tx) {
    if (!input.mcp || !requester || externalContext) return undefined;
    return input.mcp(local(tx)).catalog(
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
      input.describedHandles(),
    );
  }

  /** The source checks each model call used to run in its own transaction. */
  async function authorize(
    tx: Tx,
    slackActor: Actor | null,
    sources: readonly SourceDependency[],
    drafts: SourceDependency[],
  ) {
    const merged = mergeSources([...sources]);
    const human = slackActor ?? (await turnRequester(tx, fence.conversationId, fence.turnId));
    if (input.inventory) await requireDraftSources(tx, human, drafts);
    await requireGitHubSources(tx, human, merged);
    await requireGoogleSources(tx, human, merged);
    await requireKnowledgeSources(tx, human, merged);
    await requireMcpSources(tx, human, fence.conversationId, merged);
    if (slackActor) await requireResultSources(tx, slackActor, fence.conversationId, merged);
    await externalContext?.(tx, fence, merged);
    return canonicalJson(merged);
  }

  async function recordModelSources(tx: Tx, step: number, sources: SourceDependency[]) {
    if (!modelSources) return modelSourcesKey;
    const key = canonicalJson(sources);
    if (key === modelSourcesKey) return key;
    await tx.client.query(
      `INSERT INTO ${qualified(tx.schema, 'tf_conversation_model_sources')} (turn_id,epoch,step,sources) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [fence.turnId, fence.epoch, step, JSON.stringify(sources)],
    );
    return key;
  }

  /** Writes the hold's calls. Unknown or unreported usage settles at the call's reservation, as before. */
  async function settleHold(tx: Tx, current: Hold | undefined) {
    if (!current) return;
    const known = current.calls.flatMap(call => (call.usage ? [{ call, usage: call.usage }] : []));
    for (const call of current.calls)
      if (!call.usage && !call.rejected)
        log('warn', 'activity', 'call_failed', {
          operation: 'chat.credit-usage',
          'error.type': 'usage-unknown',
          'gen_ai.request.model': call.modelId,
        });
    await settleReplyCredits(
      tx,
      current.id,
      current.calls.map(call => ({
        id: call.id,
        modelId: call.modelId,
        pricingRevision: call.pricingRevision,
        providerPicoUsd: call.usage?.providerPicoUsd ?? (call.rejected ? '0' : providerCostAtUnits(call.worst)),
        planMilliseconds: plan && call.milliseconds !== undefined ? Math.ceil(call.milliseconds) : null,
      })),
      () => {
        for (const { call, usage } of known)
          void recordUsage({
            workspaceId: fence.workspaceId,
            flowId: fence.conversationId,
            modelId: call.modelId,
            agentId: null,
            activity: 'chat',
            ...usageTokenCounts(usage.tokens),
            providerPicoUsd: usage.providerPicoUsd,
            at: new Date(),
          });
      },
    );
  }

  async function flushPlanTime(tx: Tx) {
    const pending = unflushed();
    if (plan && pending > 0) await recordCoordinatorReplyTime(tx, plan.attemptId, pending);
    return pending;
  }

  /**
   * Opens the hold that funds the reply from `step`, admitting the plan as that call's reservation did. Its id is
   * the call's id, so the call reuses its row. Throws {@link CreditsExhausted} before the model is called.
   */
  async function openHold(tx: Tx, step: number, model: ConversationModel, needCost: bigint, bytes: number) {
    const need = units(needCost.toString());
    const nextPlan = await coordinatorReplyBudget(tx, fence, needCost);
    let wanted = preferred(bytes);
    if (nextPlan && nextPlan.remainingUnits < wanted) wanted = nextPlan.remainingUnits;
    // A hold that funded no call keeps its row, so the next hold for the same call needs its own id.
    const id = hold && !hold.calls.length && hold.id === chatId(step) ? `${chatId(step)}:${holds}` : chatId(step);
    const held = await holdReplyCredits(tx, {
      id,
      flowId: fence.conversationId,
      modelId: model.price.modelId,
      activity: 'chat',
      pricingRevision: model.price.pricingRevision,
      minimum: need,
      preferred: wanted,
      planAttemptId: nextPlan?.attemptId ?? null,
    });
    if (held === null) throw new CreditAttemptAlreadyDispatched();
    return { hold: { id, held, calls: [] } as Hold, plan: nextPlan };
  }

  /** Commits what a transaction settled and opened. Nothing changes in memory if the transaction rolled back. */
  function committed(next: { hold: Hold; plan: Plan | null }, flushed: number) {
    if (hold) settledCalls.push(...hold.calls);
    flushedMilliseconds += flushed;
    hold = next.hold;
    plan = next.plan;
    holds++;
  }

  const preread = input.inventory && input.inventoryRead ? await input.inventoryRead.catch(() => null) : null;
  // Listing the inventory takes the workspace write lock, so the start transaction takes it first only when it reads it.
  const readsInventory = input.inventory && preread === null;
  const started = await runtime.transaction(fence.workspaceId, commonCompatibility, async tx => {
    await lockAuthorization(tx, readsInventory ? 'write' : 'read');
    const slackActor = await requireCurrentConversationSources(tx, fence.conversationId, fence.turnId);
    await renewConversationReplyLease(tx, fence);
    requester =
      input.slack || input.mcp || input.outputs || input.requester
        ? await turnRequester(tx, fence.conversationId, fence.turnId)
        : null;
    const destinations =
      requester && input.slack ? await input.slack(local(tx)).destinations(fence.workspaceId, requester.userId) : null;
    const read = readsInventory
      ? await observeChatDetail('inventory', () => readInventory(tx, slackActor))
      : input.inventory
        ? (preread ?? { inventory: undefined, sources: [] })
        : undefined;
    const mcp = await observeChatDetail('catalog', () => readCatalog(tx));
    const sources = mergeSources([...(mcp?.sources ?? []), ...(read?.sources ?? [])]);
    const authorized = await observeChatDetail('authorize', () =>
      authorize(tx, slackActor, [...input.retainedSources, ...sources], read?.sources ?? []),
    );
    const recorded = await recordModelSources(tx, 0, mergeSources([...input.retainedSources, ...sources]));
    // Only one attempt holds a conversation's lease, so another attempt's open hold belongs to a crashed worker.
    await recoverReplyHolds(tx, fence.conversationId, chatId(0).slice(0, -1));
    const bytes =
      input.contextBytes +
      Buffer.byteLength(JSON.stringify([destinations, read?.inventory ?? null, mcp?.model ?? null]));
    const opened = await openHold(tx, 0, chat, minimum, bytes);
    return { destinations, read, mcp, authorized, recorded, opened };
  });
  inventory = started.read?.inventory;
  inventorySources = started.read?.sources ?? [];
  catalog = started.mcp?.model;
  catalogSources = started.mcp?.sources ?? [];
  authorizedKey = started.authorized;
  modelSourcesKey = started.recorded;
  committed(started.opened, 0);
  // The executor runs this inside its final transaction for the attempt, so it must not change state in memory.
  input.settle?.(async tx => {
    await flushPlanTime(tx);
    await settleHold(tx, hold);
  });

  // Renewal is idempotent and only locks the reply's own rows, so a serialization or deadlock failure retries
  // instead of ending the reply.
  const renewOnce = () =>
    runtime.transaction(fence.workspaceId, commonCompatibility, async tx => {
      await lockAuthorization(tx);
      await renewConversationReplyLease(tx, fence);
    });
  const renewal = setInterval(() => {
    void (async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await renewOnce();
        } catch (error) {
          if (attempt < 3 && databaseConflict(error)) continue;
          lost ??= error;
          return;
        }
      }
    })();
  }, leaseRenewalMilliseconds);
  renewal.unref();

  /** Funds a call the hold cannot: settles what the hold paid for and opens the next hold, in one transaction. */
  async function topUp(step: number, model: ConversationModel, needCost: bigint, bytes: number) {
    const result = await observeChatDetail('credit-top-up', () =>
      runtime.transaction(fence.workspaceId, commonCompatibility, async tx => {
        await lockAuthorization(tx);
        await renewConversationReplyLease(tx, fence);
        const flushed = await flushPlanTime(tx);
        await settleHold(tx, hold);
        return { opened: await openHold(tx, step, model, needCost, bytes), flushed };
      }),
    );
    committed(result.opened, result.flushed);
  }

  // Sub-agents reserve from the same hold at once; one reservation and top-up runs at a time.
  let reserving: Promise<unknown> = Promise.resolve();
  const meter: ToolModelMeter = attempt => meterWith(attempt);
  const meterWith = (attempt: Parameters<ToolModelMeter>[0], spent?: (credits: number) => void) => {
    const reserved = reserving.then(() => reserve(attempt, spent));
    reserving = reserved.catch(() => {});
    return reserved;
  };
  const reserve = async (attempt: Parameters<ToolModelMeter>[0], spent?: (credits: number) => void) => {
    if (lost) throw lost instanceof AccessDenied ? lost : new AccessDenied();
    const model = [chat, input.fallback, input.completionCheck].find(
      candidate => candidate?.route.provider === attempt.provider && candidate.route.model === attempt.model,
    );
    if (!model) throw new Error('conversation-model-unpriced');
    // Request bytes bound the hold, never the context: the reply loop compacts by estimated tokens, so size never fails it.
    const maxInputTokens = Math.min(attempt.inputBytes + 4096, model.price.maxInputTokens);
    const needCost = quote(model, maxInputTokens, attempt.maxOutputTokens);
    const need = units(needCost.toString());
    const overPlan =
      plan !== null && (plan.remainingUnits < consumed() + need || plan.remainingMilliseconds <= unflushed());
    if (!hold || hold.held - consumed() < need + 1n || overPlan)
      await topUp(attempt.step, model, needCost, attempt.inputBytes);
    const call: Call = {
      id: chatId(attempt.step),
      modelId: model.price.modelId,
      pricingRevision: model.price.pricingRevision,
      worst: need,
      started: performance.now(),
    };
    hold!.calls.push(call);
    // Sub-agent calls use their own step range; the reply's checkpoints keep following the chat's own steps.
    if (!spent) {
      lastStep = Math.max(lastStep, attempt.step);
      lastInputBytes = attempt.inputBytes;
    }
    const date = new Date().toISOString().slice(0, 10);
    return async (usage: InferenceUsage, outcome?: { rejected: boolean }) => {
      call.milliseconds = performance.now() - call.started;
      if (usage.kind !== 'known') {
        if (outcome?.rejected) call.rejected = true;
        return;
      }
      const { kind, ...tokens } = usage;
      const cost = calculateUsageCost({
        modelId: model.price.modelId,
        pricingRevision: model.price.pricingRevision,
        rates: model.price.rates,
        maxInputTokens,
        maxOutputTokens: attempt.maxOutputTokens,
        usage: { kind, tokens },
        date,
      });
      if (cost.kind === 'known') {
        call.usage = { providerPicoUsd: cost.providerPicoUsd, tokens };
        spent?.(Number(units(cost.providerPicoUsd)) / 1e12);
      }
    };
  };

  return {
    requester: requester as Actor | null,
    destinations: started.destinations,
    meter,
    /** The reply's meter that also reports each call's credits, for a sub-agent's running total. */
    creditMeter:
      (spent: (credits: number) => void): ToolModelMeter =>
      attempt =>
        meterWith(attempt, spent),
    sources: contextSources,
    readWorkspaceInventory: input.inventory ? async () => inventory : undefined,
    catalog: withCatalog && requester ? async () => catalog : undefined,
    /** Records a tool that ran, so the next checkpoint saves its round and refreshes only what it could change. */
    toolRan(tool: string) {
      ranTools.add(tool);
    },
    /**
     * A plan's tool admission reads the attempt's model time. The reply keeps that time in memory, so it writes it
     * first only when the time alone would refuse the tool, as admission refused it before.
     */
    async beforeTool() {
      if (!plan || unflushed() <= 0 || plan.remainingMilliseconds > unflushed()) return;
      const flushed = await runtime.transaction(fence.workspaceId, commonCompatibility, async tx => {
        await lockAuthorization(tx);
        return flushPlanTime(tx);
      });
      flushedMilliseconds += flushed;
      if (plan) plan = { ...plan, remainingMilliseconds: plan.remainingMilliseconds - flushed };
    },
    /**
     * Saves a finished tool round in one transaction: renews the lease, re-reads the inventory or catalog only when
     * a tool that ran could have changed it, authorizes the round's sources and settles the calls so far.
     */
    async checkpoint(sources: readonly SourceDependency[]) {
      if (!ranTools.size) return;
      const tools = [...ranTools];
      const step = lastStep + 1;
      const result = await observeChatDetail('checkpoint', () =>
        runtime.transaction(fence.workspaceId, commonCompatibility, async tx => {
          const refreshInventory =
            input.inventory && tools.some(tool => inventoryTools.some(prefix => tool.startsWith(prefix)));
          await lockAuthorization(tx, refreshInventory ? 'write' : 'read');
          const slackActor = await requireCurrentConversationSources(tx, fence.conversationId, fence.turnId);
          await renewConversationReplyLease(tx, fence);
          const read = refreshInventory ? await readInventory(tx, slackActor) : undefined;
          const mcp = tools.some(tool => tool.startsWith('mcp.')) ? await readCatalog(tx) : undefined;
          const nextInventorySources = read ? read.sources : inventorySources;
          const nextCatalogSources = mcp ? mergeSources([...catalogSources, ...mcp.sources]) : catalogSources;
          const context = mergeSources([...nextCatalogSources, ...nextInventorySources]);
          const authorized = await authorize(tx, slackActor, [...sources, ...context], nextInventorySources);
          const recorded = await recordModelSources(tx, step, mergeSources([...input.retainedSources, ...context]));
          const flushed = await flushPlanTime(tx);
          await settleHold(tx, hold);
          const opened = await openHold(tx, step, chat, minimum, lastInputBytes);
          return { read, mcp, nextCatalogSources, authorized, recorded, flushed, opened };
        }),
      );
      ranTools.clear();
      if (result.read) {
        inventory = result.read.inventory;
        inventorySources = result.read.sources;
      }
      if (result.mcp) catalog = result.mcp.model;
      catalogSources = result.nextCatalogSources;
      authorizedKey = result.authorized;
      modelSourcesKey = result.recorded;
      committed(result.opened, result.flushed);
    },
    /** Authorizes a model call's sources. The start or a checkpoint already authorized an unchanged set. */
    async authorizeSources(sources: readonly SourceDependency[]) {
      const all = [...sources, ...contextSources()];
      if (keyOf(all) === authorizedKey) return;
      const result = await runtime.transaction(fence.workspaceId, commonCompatibility, async tx => {
        await lockAuthorization(tx);
        const slackActor = await requireCurrentConversationSources(tx, fence.conversationId, fence.turnId);
        const authorized = await authorize(tx, slackActor, all, inventorySources);
        const recorded = await recordModelSources(
          tx,
          lastStep + 1,
          mergeSources([...input.retainedSources, ...contextSources()]),
        );
        return { authorized, recorded };
      });
      authorizedKey = result.authorized;
      modelSourcesKey = result.recorded;
    },
    close() {
      clearInterval(renewal);
    },
  };
}
