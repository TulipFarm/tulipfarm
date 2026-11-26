import { AccessDenied, lockAuthorization } from '@tulipfarm/access';
import { readWorkspaceInventory } from '@tulipfarm/agents/tools';
import type { McpExecutionFactory, McpExecutionPort } from '@tulipfarm/agents/mcp-runtime';
import type { SlackActionsFactory } from '@tulipfarm/agents/slack-actions';
import { requireDraftSources } from '@tulipfarm/agents/draft-sources';
import { coordinatorReplyBudget, recordCoordinatorReplyTime } from '@tulipfarm/agents/plan-runtime';
import type { InferenceUsage, ToolModelMeter } from '@tulipfarm/agents/inference';
import {
  calculateUsageCost,
  isByokProvider,
  isPlanProvider,
  reserveModelCost,
  usageTokenCounts,
} from '@tulipfarm/config';
import { modelFallbackReason } from '@tulipfarm/config/model-fallback';
import {
  renewConversationReplyLease,
  type ConversationRuntime,
  type ExternalConversationContext,
  type ReplyFence,
  type ReplySettlement,
  type ReplyTransaction,
} from '@tulipfarm/conversations/runtime';
import { recoverImageHolds } from '@tulipfarm/conversations/image-outputs';
import { mergeSources, type SourceDependency } from '@tulipfarm/conversations/results';
import {
  requireCurrentConversationSources,
  requireGitHubSources,
  requireGoogleSources,
  requireKnowledgeSources,
  requireReplyMcpSources,
  requireResultSources,
} from '@tulipfarm/conversations/source-access';
import { turnRequester } from '@tulipfarm/conversations/turn-requester';
import { creditPricing, creditRates, recordUsage } from '@tulipfarm/extensions';
import { billingSource, errorSite, log, observeChatDetail } from '@tulipfarm/observability';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import {
  CreditAttemptAlreadyDispatched,
  creditUnitsForProviderCost,
  holdReplyCredits,
  providerCostAtUnits,
  recoverReplyHolds,
  settleReplyCredits,
} from '@tulipfarm/workspace-storage/credits';
import { recordModelUsage, type ModelUsageRecord } from '@tulipfarm/workspace-storage/model-usage';
import { commonCompatibility, qualified, StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { planListModel, type ConversationModel } from './conversation-model.ts';
import type { PlanFailure } from '@tulipfarm/agents/inference';
import type { ConversationInventory } from './conversation-inventory.ts';
import { keepReplyLease } from './reply-lease.ts';

type Tx = ReplyTransaction;
// The common migration that records a turn's plan connection and the plan it switched from.
const turnPlanSwitchVersion = 89;
/** The member whose accepted message started the turn. Typed as a person, so member-only tools cannot receive another actor kind. */
type Requester = Awaited<ReturnType<typeof turnRequester>>;
type Inventory = Awaited<ReturnType<typeof readWorkspaceInventory>>['inventory'];
type Catalog = Awaited<ReturnType<McpExecutionPort['catalog']>>['model'];
type Call = {
  id: string;
  modelId: string;
  pricingRevision: string;
  /** The call's worst-case charge in credit units: what its own reservation held before. */
  worst: bigint;
  /** For a call on a member's plan: the listed model's rates that value it, or null when no catalog model lists it. */
  listed: ListedModel | null;
  /** The call's worst-case plan fee in credit units, unrounded; 0 when no plan fee applies. */
  worstFee: bigint;
  started: number;
  usage?: {
    providerPicoUsd: string;
    tokens: Parameters<typeof usageTokenCounts>[0];
    /** A plan call's value at the listed model's rates, or null when it can't be worked out. */
    listPicoUsd: string | null;
  };
  /** The provider refused the request before generating anything, so the call costs nothing. */
  rejected?: boolean;
  milliseconds?: number;
  /** Who paid and what the call fell back from, for the Usage page. */
  source: Pick<ModelUsageRecord, 'modelProvider' | 'paidBy' | 'connectionId' | 'fallback'> & { providerModel: string };
};
/** The member plan a plan chat runs on now, and the plan it moved off last with why. */
export type PlanSource = () => {
  connectionId: string | null;
  switched: { from: string; failure: PlanFailure } | null;
};
type Hold = { id: string; held: bigint; calls: Call[] };
type ListedModel = NonNullable<ReturnType<typeof planListModel>>;
/** A call's worst case: its provider cost, which a plan admission checks, and its charge in credit units, plan fee included. */
type Worst = { cost: bigint; units: bigint; fee: bigint };
type Plan = { attemptId: string; remainingUnits: bigint; remainingMilliseconds: number };

/** Renews the reply's lease while model calls run. Each renewal is one short transaction. */
const leaseRenewalMilliseconds = 30_000;
/** The lease each renewal grants, as `renewConversationReplyLease` sets it by default. */
const replyLeaseMilliseconds = 60_000;
/** Room for a reply's next request to grow before it needs a top-up: tool results, the answer and the runtime reminder. */
const holdSlackBytes = 128 * 1024;
/** Tools that can change the workspace inventory the runtime reminder lists. Other tools never re-read it. */
const inventoryTools = ['tables.', 'schema.', 'agents.', 'workflows.', 'skills.'];

/** Room for tokenization to differ where a request extends the previous one, and for its replaced runtime reminder. */
const followUpSlackTokens = 4096;
/**
 * A call's most prompt tokens: every request byte as a token plus 4096. A reply round that extends the previous round
 * on the same model is bounded tighter by the tokens the provider reported for that round plus a token for every byte
 * and the image bound added since, so later rounds of a long reply need little more than their first.
 */
function promptBound(attempt: Pick<Parameters<ToolModelMeter>[0], 'inputBytes' | 'imageInputTokens' | 'previous'>) {
  const bytes = attempt.inputBytes + attempt.imageInputTokens + 4096;
  const { previous } = attempt;
  if (!previous || attempt.inputBytes < previous.inputBytes) return bytes;
  const added =
    attempt.inputBytes - previous.inputBytes + Math.max(0, attempt.imageInputTokens - previous.imageInputTokens);
  return Math.min(bytes, previous.inputTokens + added + followUpSlackTokens);
}
const units = (providerPicoUsd: string) => creditUnitsForProviderCost(BigInt(providerPicoUsd));
/** A call's worst-case provider cost at `rates`, its model's own unless given, as its own reservation quoted it. */
const quote = (
  model: ConversationModel,
  maxInputTokens: number,
  maxOutputTokens: number,
  rates: ConversationModel['price']['rates'] = model.price.rates,
) =>
  BigInt(
    reserveModelCost({
      modelId: model.price.modelId,
      pricingRevision: model.price.pricingRevision,
      rates,
      maxInputTokens,
      maxOutputTokens,
      date: new Date().toISOString().slice(0, 10),
    }),
  );
/** A plan call's value at the listed model's rates, or null when it can't be worked out. */
export function listCost(
  call: Pick<Call, 'modelId' | 'pricingRevision'>,
  listed: ListedModel,
  tokens: Parameters<typeof usageTokenCounts>[0],
) {
  try {
    const cost = calculateUsageCost({
      modelId: call.modelId,
      pricingRevision: call.pricingRevision,
      rates: listed.rates,
      maxInputTokens: Number.MAX_SAFE_INTEGER,
      maxOutputTokens: Number.MAX_SAFE_INTEGER,
      usage: { kind: 'known', tokens },
      date: new Date().toISOString().slice(0, 10),
    });
    return cost.kind === 'known' ? cost.providerPicoUsd : null;
  } catch {
    return null;
  }
}

/**
 * A plan call's fee in credit units, unrounded: `planRate` on its list value, never above its worst case. Nothing when
 * refused or when its list value can't be worked out, the whole worst case while usage is unknown.
 */
export function planFee(
  call: Pick<Call, 'worstFee' | 'rejected'> & { usage?: Pick<NonNullable<Call['usage']>, 'listPicoUsd'> },
  planRate: bigint,
) {
  if (!call.worstFee || call.rejected) return 0n;
  if (!call.usage) return call.worstFee;
  if (call.usage.listPicoUsd === null) return 0n;
  const value = planRate * BigInt(call.usage.listPicoUsd);
  return value < call.worstFee ? value : call.worstFee;
}

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
  /** For a chat on a member's plan, which plan connection each call runs on. */
  planSource?: PlanSource | undefined;
  externalContext: ExternalConversationContext | undefined;
  slack: SlackActionsFactory | undefined;
  mcp: McpExecutionFactory | null | undefined;
  outputs: boolean;
  /** Whether a caller needs the requester for something other than Slack, MCP or outputs (API approvals and secrets). */
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
  const planRate = creditRates().plan;
  const listedModels = new Map<ConversationModel, ListedModel | null>();
  /** The listed model that values a call on a member's plan, or null for a BYOK/credit call or none listed. */
  const listedFor = (model: ConversationModel) => {
    if (!isPlanProvider(model.route.provider) || isByokProvider(model.route.provider)) return null;
    if (!listedModels.has(model)) listedModels.set(model, planListModel(model.route.model));
    return listedModels.get(model)!;
  };
  /**
   * A call's worst case. A call on a member's plan costs no provider credits, but is charged the plan rate on its value
   * at the listed model's rates; with a zero rate, or no listed model, it is free.
   */
  const worstCase = (model: ConversationModel, maxInputTokens: number, maxOutputTokens: number): Worst => {
    const cost = quote(model, maxInputTokens, maxOutputTokens);
    const listed = planRate > 0n ? listedFor(model) : null;
    const fee = listed ? planRate * quote(model, maxInputTokens, maxOutputTokens, listed.rates) : 0n;
    return { cost, units: units(cost.toString()) + creditPricing().round(fee), fee };
  };
  /** A call's worst case for an estimated request size, within the model's limits. */
  const estimate = (model: ConversationModel, inputBytes: number) =>
    worstCase(model, Math.min(inputBytes + 4096, model.price.maxInputTokens), model.price.maxOutputTokens);
  // A greeting makes a reply call and a completion check; its title is billed separately after delivery. Longer replies
  // top up or roll the hold.
  const preferred = (bytes: number) => 2n * estimate(chat, bytes + holdSlackBytes).units;
  // Every request carries a 4096-token allowance, so a balance below this cannot pay for any first call.
  const minimum = estimate(chat, 0);
  const withCatalog = Boolean(input.mcp) && !externalContext;
  const modelSources = (input.mcp || input.inventory) && !externalContext;

  const local = (tx: Tx): ConversationRuntime => ({
    transaction: async (workspaceId, range, operation) => {
      if (workspaceId !== fence.workspaceId) throw new AccessDenied();
      if (tx.commonVersion < range.minimum || tx.commonVersion > range.maximum)
        throw new StorageUnavailableError('incompatible_version');
      return operation(tx);
    },
  });

  let requester: Requester | null = null;
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
  const settledCalls: Call[] = [];
  const ranTools = new Set<string>();

  const contextSources = () => mergeSources([...catalogSources, ...inventorySources]);
  const keyOf = (sources: readonly SourceDependency[]) => canonicalJson(mergeSources([...sources]));
  const fee = (call: Call) => planFee(call, planRate);
  /** An upper bound on a call's charge: its known cost, nothing when refused, or its whole reservation while usage is unknown. */
  const charge = (call: Call) =>
    (call.usage
      ? units(call.usage.providerPicoUsd) + creditPricing().round(fee(call))
      : call.rejected
        ? 0n
        : call.worst) + 1n;
  const consumed = () => (hold?.calls ?? []).reduce((total, call) => total + charge(call), 0n);
  const unflushed = () =>
    [...settledCalls, ...(hold?.calls ?? [])].reduce((total, call) => total + (call.milliseconds ?? 0), 0) -
    flushedMilliseconds;

  async function readInventory(tx: Tx, slackActor: Requester | null) {
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
    slackActor: Requester | null,
    sources: readonly SourceDependency[],
    drafts: SourceDependency[],
  ) {
    const merged = mergeSources([...sources]);
    const human = slackActor ?? (await turnRequester(tx, fence.conversationId, fence.turnId));
    if (input.inventory) await requireDraftSources(tx, human, drafts);
    await requireGitHubSources(tx, human, merged);
    await requireGoogleSources(tx, human, merged);
    await requireKnowledgeSources(tx, human, merged);
    await requireReplyMcpSources(tx, human, fence.conversationId, merged);
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
        // An unknown plan call is charged its worst-case fee, so its unknown provider cost is the plan's, nothing.
        providerPicoUsd:
          call.usage?.providerPicoUsd ??
          (call.rejected ? '0' : providerCostAtUnits(call.worst - creditPricing().round(call.worstFee))),
        feeUnits: fee(call),
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
    await recordModelUsage(
      tx,
      known.map(({ call, usage }) => usageRecord(call, usage)),
    );
    await recordTurnPlan(tx, current);
  }

  /** Keeps on the turn the plan connection that answered and the one it moved off with why, for the chat to show. */
  async function recordTurnPlan(tx: Tx, current: Hold) {
    if (tx.commonVersion < turnPlanSwitchVersion || !current.calls.some(call => call.source.paidBy === 'plan')) return;
    const source = input.planSource?.();
    if (!source?.connectionId) return;
    await tx.client.query(
      `UPDATE ${qualified(tx.schema, 'tf_conversation_turns')} SET plan_connection_used=$3,plan_switched_from=$4,plan_switch_reason=$5 WHERE id=$1 AND generation=$2`,
      [
        fence.turnId,
        fence.generation,
        source.connectionId,
        source.switched?.from ?? null,
        source.switched?.failure ?? null,
      ],
    );
  }

  /**
   * A settled call as the Usage page reads it. A plan call counts as the same model's own API: under its model id, valued
   * at its list price.
   */
  function usageRecord(call: Call, usage: NonNullable<Call['usage']>): ModelUsageRecord {
    const counts = usageTokenCounts(usage.tokens);
    let modelId = call.modelId;
    let listPicoUsd: string | null = usage.providerPicoUsd;
    if (call.source.paidBy === 'plan') {
      // A plan call whose list price can't be worked out shows no plan value.
      listPicoUsd = usage.listPicoUsd;
      if (call.listed) modelId = call.listed.modelId;
    }
    return {
      id: call.id,
      activity: 'chat',
      flowId: fence.conversationId,
      membershipId: requester?.membershipId ?? null,
      agentId: null,
      modelId,
      modelProvider: call.source.modelProvider,
      paidBy: call.source.paidBy,
      connectionId: call.source.connectionId,
      inputTokens: counts.inputTokens,
      outputTokens: counts.outputTokens,
      cachedTokens: usage.tokens.cacheRead,
      listPicoUsd,
      pricingRevision: call.pricingRevision,
      fallback: call.source.fallback,
    };
  }

  /** Who pays for a call on `model`, and what it fell back from: the chat model, or a plan the turn moved off. */
  function callSource(model: ConversationModel, attempt: Parameters<ToolModelMeter>[0]): Call['source'] {
    const plan = isPlanProvider(model.route.provider);
    const current = plan ? input.planSource?.() : undefined;
    const switched = input.planSource?.().switched ?? null;
    const onFallback = model === input.fallback && model !== chat;
    const fallback: ModelUsageRecord['fallback'] = onFallback
      ? {
          reason:
            attempt.fallbackReason ??
            (switched ? (modelFallbackReason(`${chat.route.provider}-${switched.failure}`) ?? null) : null),
          fromModel: chat.price.modelId,
          fromConnection: switched?.from ?? null,
        }
      : plan && model === chat && switched
        ? {
            reason: modelFallbackReason(`${chat.route.provider}-${switched.failure}`) ?? null,
            fromModel: chat.price.modelId,
            fromConnection: switched.from,
          }
        : null;
    return {
      modelProvider: model.route.provider,
      providerModel: model.route.model,
      paidBy: plan ? 'plan' : 'credits',
      connectionId: current?.connectionId ?? null,
      fallback,
    };
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
  async function openHold(tx: Tx, step: number, model: ConversationModel, need: Worst, bytes: number) {
    // The plan admission prices provider cost; a plan fee is checked against its remaining credits in `reserve`.
    const nextPlan = await coordinatorReplyBudget(tx, fence, need.cost);
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
      minimum: need.units,
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
  const readsInventory = input.inventory && preread === null;
  const leaseStartedAt = Date.now();
  const started = await runtime.transaction(fence.workspaceId, commonCompatibility, async tx => {
    await lockAuthorization(tx, 'read');
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
    // A refused MCP catalog leaves this reply without MCP tools rather than failing it: each MCP call checks its origin
    // again, so nothing the refusal protects becomes reachable. The refusal is still logged by `chat.detail.catalog`.
    const mcp = await observeChatDetail('catalog', () => readCatalog(tx)).catch((error: unknown) => {
      if (!(error instanceof AccessDenied)) throw error;
      log('warn', 'activity', 'call_failed', {
        operation: 'chat.catalog-skipped',
        outcome: 'blocked',
        'error.type': 'AccessDenied',
      });
      return undefined;
    });
    const sources = mergeSources([...(mcp?.sources ?? []), ...(read?.sources ?? [])]);
    const authorized = await observeChatDetail('authorize', () =>
      authorize(tx, slackActor, [...input.retainedSources, ...sources], read?.sources ?? []),
    );
    const recorded = await recordModelSources(tx, 0, mergeSources([...input.retainedSources, ...sources]));
    // Only one attempt holds a conversation's lease, so another attempt's open hold belongs to a crashed worker.
    await recoverReplyHolds(tx, fence.conversationId, chatId(0).slice(0, -1));
    // Image holds of any turn or run whose worker died settle here too, past their stale window.
    await recoverImageHolds(tx);
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

  const lease = keepReplyLease({
    renew: deadlineAt =>
      runtime.transaction(fence.workspaceId, { ...commonCompatibility, deadlineAt }, async tx => {
        await lockAuthorization(tx);
        await renewConversationReplyLease(tx, fence);
      }),
    leaseMilliseconds: replyLeaseMilliseconds,
    intervalMilliseconds: leaseRenewalMilliseconds,
    renewedAt: leaseStartedAt,
  });
  // A slow start transaction can leave the lease too close to expiry to start any model work.
  if (lease.lost !== undefined) throw lease.lost;

  /** Funds a call the hold cannot: settles what the hold paid for and opens the next hold, in one transaction. */
  async function topUp(step: number, model: ConversationModel, need: Worst, bytes: number) {
    const startedAt = Date.now();
    const result = await observeChatDetail('credit-top-up', () =>
      runtime.transaction(fence.workspaceId, commonCompatibility, async tx => {
        await lockAuthorization(tx);
        await renewConversationReplyLease(tx, fence);
        const flushed = await flushPlanTime(tx);
        await settleHold(tx, hold);
        return { opened: await openHold(tx, step, model, need, bytes), flushed };
      }),
    );
    lease.renewed(startedAt);
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
    if (lease.lost !== undefined) throw lease.lost;
    const model = [chat, input.fallback, input.completionCheck].find(
      candidate => candidate?.route.provider === attempt.provider && candidate.route.model === attempt.model,
    );
    if (!model) throw new Error('conversation-model-unpriced');
    // Request bytes bound the hold, never the context: the reply loop compacts by estimated tokens, so size never fails it.
    // Image data is left out of the bytes and bounded by the model's image token limit instead.
    const inputBound = attempt.inputBytes + attempt.imageInputTokens;
    const maxInputTokens = Math.min(promptBound(attempt), model.price.maxInputTokens);
    const worst = worstCase(model, maxInputTokens, attempt.maxOutputTokens);
    const needCost = worst.cost;
    const need = worst.units;
    const overPlan =
      plan !== null && (plan.remainingUnits < consumed() + need || plan.remainingMilliseconds <= unflushed());
    // A call on a member's own plan with no plan fee costs no credits, so any open hold funds it.
    const short = need > 0n && hold !== undefined && hold.held - consumed() < need + 1n;
    if (!hold || short || overPlan) await topUp(attempt.step, model, worst, inputBound);
    const stepId = chatId(attempt.step);
    // The first call of a hold opened for its step settles into the hold's own row, which may carry a suffix.
    const ownsHold = !hold!.calls.length && (hold!.id === stepId || hold!.id.startsWith(`${stepId}:`));
    const call: Call = {
      id: ownsHold ? hold!.id : stepId,
      modelId: model.price.modelId,
      pricingRevision: model.price.pricingRevision,
      worst: need,
      listed: listedFor(model),
      worstFee: worst.fee,
      started: performance.now(),
      source: callSource(model, attempt),
    };
    hold!.calls.push(call);
    // Sub-agent calls use their own step range; the reply's checkpoints keep following the chat's own steps.
    if (!spent) {
      lastStep = Math.max(lastStep, attempt.step);
      lastInputBytes = inputBound;
    }
    const date = new Date().toISOString().slice(0, 10);
    return async (usage: InferenceUsage, outcome?: { rejected: boolean }) => {
      call.milliseconds = performance.now() - call.started;
      if (usage.kind !== 'known') {
        if (outcome?.rejected) call.rejected = true;
        return;
      }
      const { kind, ...tokens } = usage;
      const cost = pricedUsage(
        {
          modelId: model.price.modelId,
          pricingRevision: model.price.pricingRevision,
          rates: model.price.rates,
          maxInputTokens,
          maxOutputTokens: attempt.maxOutputTokens,
          usage: { kind, tokens },
          date,
        },
        needCost,
        attempt,
      );
      if (cost.kind === 'known') {
        call.usage = {
          providerPicoUsd: cost.providerPicoUsd,
          tokens,
          listPicoUsd: call.listed ? listCost(call, call.listed, tokens) : null,
        };
        spent?.(Number(units(cost.providerPicoUsd) + creditPricing().round(fee(call))) / 1e12);
      }
    };
  };

  return {
    requester: requester as Requester | null,
    destinations: started.destinations,
    meter,
    /** The reply's meter that also reports each call's credits, for a sub-agent's running total. */
    creditMeter:
      (spent: (credits: number) => void): ToolModelMeter =>
      attempt =>
        meterWith(attempt, spent),
    /**
     * The sources of what the reply's tools and answer read from its context. The MCP catalog is left out: it is checked
     * with every model call and recorded as the call's model sources, but tool descriptions are not data from an
     * integration, so they never become a tool's or the answer's provenance.
     */
    sources: () => inventorySources,
    /** Aborted, with the storage failure as its reason, once the reply's lease is lost. */
    leaseSignal: lease.signal,
    /** Settles like the reply, or rejects with the lease's failure as soon as the lease is lost. */
    whileLeased: <T>(reply: Promise<T>) => lease.guard(reply),
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
      const startedAt = Date.now();
      const result = await observeChatDetail('checkpoint', () =>
        runtime.transaction(fence.workspaceId, commonCompatibility, async tx => {
          const refreshInventory =
            input.inventory && tools.some(tool => inventoryTools.some(prefix => tool.startsWith(prefix)));
          await lockAuthorization(tx, 'read');
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
      lease.renewed(startedAt);
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
      lease.close();
    },
  };
}

/**
 * Prices a call that already answered, so pricing never fails the reply. Usage above the route's limits is priced as
 * reported, capped at the call's held worst case. Usage that cannot be priced that way, such as a plan session's summed
 * internal calls, or a day without a price is charged the held worst case, which is nothing on a member's own plan, and
 * logged.
 */
export function pricedUsage(
  input: Omit<Parameters<typeof calculateUsageCost>[0], 'usage'> & {
    usage: { kind: 'known'; tokens: Parameters<typeof usageTokenCounts>[0] };
  },
  worstCase: bigint,
  attempt: { provider: string; model: string },
): ReturnType<typeof calculateUsageCost> {
  try {
    return calculateUsageCost(input);
  } catch (error) {
    const { tokens } = input.usage;
    // A route can report more tokens than its limits, such as reasoning tokens on top of a call cut off at the output
    // limit. Those tokens are still priced as reported, never above the call's worst case.
    const reported = (() => {
      try {
        const cost = calculateUsageCost({
          ...input,
          maxInputTokens: Number.MAX_SAFE_INTEGER,
          maxOutputTokens: Number.MAX_SAFE_INTEGER,
        });
        return cost.kind === 'known' && BigInt(cost.providerPicoUsd) <= worstCase ? cost : undefined;
      } catch {
        return undefined;
      }
    })();
    log('warn', 'activity', 'call_failed', {
      operation: 'chat.usage-cost',
      outcome: reported ? 'over_limit' : 'estimated',
      'gen_ai.provider.name': attempt.provider,
      'gen_ai.request.model': attempt.model,
      'billing.source': billingSource(attempt.provider),
      'gen_ai.usage.input_tokens': usageTokenCounts(tokens).inputTokens,
      'gen_ai.usage.output_tokens': tokens.output,
      ...(errorSite(error) ? { 'error.site': errorSite(error) } : {}),
    });
    if (reported) return reported;
    return {
      kind: 'known',
      providerPicoUsd: worstCase.toString(),
      pricingRevision: input.pricingRevision,
      modelId: input.modelId,
      date: input.date,
      promptTokensAbove: null,
    };
  }
}
