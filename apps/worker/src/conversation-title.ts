import { inferChatTitle, inferenceRouteSchema, type ToolModelMeter } from '@tulipfarm/agents/inference';
import { pausedFamilyReplacement } from '@tulipfarm/agents/model-policy';
import { calculateUsageCost, reserveModelCost, usageTokenCounts } from '@tulipfarm/config';
import type { ConversationRuntime } from '@tulipfarm/conversations/runtime';
import { conversationTitleWorkSchema, createConversationTitles } from '@tulipfarm/conversations/titles';
import { recordUsage } from '@tulipfarm/extensions';
import { recordTitleGeneration, withChatMeasurements, type TitleGenerationOutcome } from '@tulipfarm/observability';
import { CreditsExhausted, reserveCredits, settleCredits } from '@tulipfarm/workspace-storage/credits';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { conversationFamilyPaused, conversationModel, type ConversationModel } from './conversation-model.ts';
import { chatTitleModel } from './conversation-activities.ts';

/** The title runs after delivery and nothing waits on it, so a slow provider gives up early instead of holding the workflow. */
export const conversationTitleTimeoutMs = 20_000;
export type ConversationTitleResult = TitleGenerationOutcome | 'retry';

class TitleUnavailable extends Error {
  constructor() {
    super('model-invalid-response');
  }
}

const transientModelFailures = new Set([
  'model-timeout',
  'model-rate-limit',
  'model-overload',
  'model-unavailable',
  'model-transport',
]);

function classify(error: unknown): { outcome: 'failed' | 'timeout'; code: string; transient: boolean } {
  if (error instanceof CreditsExhausted) return { outcome: 'failed', code: 'credit-limit', transient: false };
  if (error instanceof TitleUnavailable) return { outcome: 'failed', code: 'model-invalid-response', transient: false };
  const { name, message } = (typeof error === 'object' && error !== null ? error : {}) as {
    name?: unknown;
    message?: unknown;
  };
  if (name === 'TimeoutError' || name === 'AbortError' || message === 'model-timeout')
    return { outcome: 'timeout', code: 'timeout', transient: true };
  if ((typeof message === 'string' && transientModelFailures.has(message)) || error instanceof TypeError)
    return { outcome: 'failed', code: 'model-request-failed', transient: true };
  return { outcome: 'failed', code: 'model-request-failed', transient: false };
}

/**
 * Generates a delivered first reply's chat title, after the reply and outside its transactions. The model call is billed
 * like the chat's other calls, in its own short reserve and settle. A failure keeps the placeholder title; on a final attempt
 * it logs one warning, otherwise a transient failure asks the workflow to try again.
 */
export function conversationTitleActivity(
  runtime: ConversationRuntime,
  resolve: (family: string) => ConversationModel | null = conversationModel,
  titleModel: () => ConversationModel | undefined = chatTitleModel,
) {
  const titles = createConversationTitles(runtime);
  return async (input: unknown, attempt = 1, final = true): Promise<ConversationTitleResult> =>
    withChatMeasurements(async () => {
      const work = conversationTitleWorkSchema.parse(input);
      const started = performance.now();
      const finish = (outcome: TitleGenerationOutcome, code?: string) => {
        recordTitleGeneration(outcome, (performance.now() - started) / 1000, code);
        return outcome;
      };
      try {
        const request = await titles.request(work);
        if (!request) return finish('skipped');
        const model = titleModel() ?? (await chatModel(runtime, resolve, work.workspaceId, request.model));
        const route = inferenceRouteSchema.parse({
          ...model.route,
          timeoutMs: Math.min(model.route.timeoutMs ?? conversationTitleTimeoutMs, conversationTitleTimeoutMs),
        });
        const title = await inferChatTitle(route, request.text, titleMeter(runtime, work, model, attempt));
        if (!title) throw new TitleUnavailable();
        return finish(await titles.save(work, title));
      } catch (error) {
        const failure = classify(error);
        if (failure.transient && !final) return 'retry';
        return finish(failure.outcome, failure.code);
      }
    });
}

async function chatModel(
  runtime: ConversationRuntime,
  resolve: (family: string) => ConversationModel | null,
  workspaceId: string,
  family: string,
) {
  const replacement = conversationFamilyPaused(family)
    ? await runtime.transaction(workspaceId, commonCompatibility, tx =>
        pausedFamilyReplacement(tx, family, conversationFamilyPaused),
      )
    : null;
  const model = resolve(replacement ?? family);
  if (!model) throw new Error('conversation-model-unavailable');
  return model;
}

function titleMeter(
  runtime: ConversationRuntime,
  work: { workspaceId: string; conversationId: string; turnId: string; generation: number },
  model: ConversationModel,
  attempt: number,
): ToolModelMeter {
  return async ({ inputBytes, maxOutputTokens }) => {
    const priced = model.price;
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
    const id = `chat-title:${work.turnId}:${work.generation}:${attempt}`;
    const admitted = await runtime.transaction(work.workspaceId, commonCompatibility, tx =>
      reserveCredits(tx, {
        id,
        flowId: work.conversationId,
        modelId: priced.modelId,
        agentId: null,
        activity: 'chat',
        providerPicoUsd: reserveModelCost(quote),
        pricingRevision: quote.pricingRevision,
      }),
    );
    if (!admitted) throw new Error('model-request-not-dispatched');
    return async usage => {
      if (usage.kind !== 'known') return;
      const { kind, ...tokens } = usage;
      const cost = calculateUsageCost({ ...quote, usage: { kind, tokens } });
      if (cost.kind !== 'known') return;
      await runtime.transaction(work.workspaceId, commonCompatibility, tx =>
        settleCredits(tx, id, cost.providerPicoUsd),
      );
      void recordUsage({
        workspaceId: work.workspaceId,
        flowId: work.conversationId,
        modelId: priced.modelId,
        agentId: null,
        activity: 'chat',
        ...usageTokenCounts(tokens),
        providerPicoUsd: cost.providerPicoUsd,
        at: new Date(),
      });
    };
  };
}
