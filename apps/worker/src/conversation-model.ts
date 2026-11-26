import { modelEnvironment } from '@tulipfarm/agents/model-environment';
import type { InferenceRoute } from '@tulipfarm/agents/inference';
import {
  comparableProviderModel,
  isPlanProvider,
  loadModelCatalog,
  type ModelCatalogRole,
  type ResolvedModel,
} from '@tulipfarm/config';

/** The resolved model a call is metered as, with the limits of its qualified route. */
export type ModelPrice = {
  familyId: string;
  modelId: string;
  pricingRevision: string;
  rates: ResolvedModel['rates'];
  maxInputTokens: number;
  maxOutputTokens: number;
};
export type ConversationModel = { route: InferenceRoute; price: ModelPrice };

/**
 * Resolves a family for chat, titles, compaction, skill review, the plan specialist and the Gmail heartbeat through the same
 * model environment as tasks and the catalog. A family the model catalog does not serve has no model.
 */
export function conversationModel(family: string, env: NodeJS.ProcessEnv = process.env): ConversationModel | null {
  const environment = modelEnvironment(env);
  const resolution = environment.resolve(family);
  const route = resolution && environment.inference(resolution);
  if (!resolution || !route) return null;
  const {
    familyId,
    modelId,
    pricingRevision,
    rates,
    route: { maxInputTokens, maxOutputTokens },
  } = resolution;
  return { route, price: { familyId, modelId, pricingRevision, rates, maxInputTokens, maxOutputTokens } };
}

/** Whether the model catalog pauses `family`. */
export function conversationFamilyPaused(family: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return modelEnvironment(env).paused(family);
}

/** The model a chat reply runs on: its family, or the default model once the catalog no longer serves that family. */
export function chatReplyModel(family: string, env: NodeJS.ProcessEnv = process.env): ConversationModel | null {
  return conversationModel(family, env) ?? conversationModel(loadModelCatalog(env).defaultModel.id, env);
}

/**
 * The model with `role` in the model catalog. Without one, the title role has no model (the chat's own model titles the
 * chat), completion checks use the active chat model, and every other role uses the default model.
 */
export function roleModel(role: ModelCatalogRole, env: NodeJS.ProcessEnv = process.env): ConversationModel | null {
  const catalog = loadModelCatalog(env);
  const model = catalog.role(role) ?? (role === 'title' || role === 'completion-check' ? null : catalog.defaultModel);
  return model ? conversationModel(model.id, env) : null;
}

/**
 * Resolves a faster, lower-cost catalog model distinct from `chat` for simple auto-routed chat turns. Returns null when
 * no strictly cheaper non-paused catalog model is available.
 */
export function fastRouteModel(
  chat: ConversationModel,
  env: NodeJS.ProcessEnv = process.env,
): ConversationModel | null {
  const baseInput = chat.price.rates[0]?.usdPerMillionTokens.input;
  if (baseInput === undefined) return null;
  const needsImageInput = Boolean(chat.route.capabilities?.imageInput);
  const candidates = [roleModel('heartbeat', env), roleModel('completion-check', env)];
  for (const candidate of candidates) {
    const candidateInput = candidate?.price.rates[0]?.usdPerMillionTokens.input;
    if (
      candidate &&
      candidateInput !== undefined &&
      candidate.price.familyId !== chat.price.familyId &&
      !conversationFamilyPaused(candidate.price.familyId, env) &&
      (!needsImageInput || Boolean(candidate.route.capabilities?.imageInput)) &&
      candidateInput < baseInput
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * The model that retries a failed chat call once: the first available model of the catalog's fallback chain for the chat
 * model (its `fallback`, that model's `fallback`, ..., then the model with the role `fallback`). Without one, failed
 * replies are not retried on another model.
 */
export function chatFallbackModel(
  chatFamily: string,
  env: NodeJS.ProcessEnv = process.env,
): ConversationModel | undefined {
  for (const model of loadModelCatalog(env).fallbacks(chatFamily)) {
    if (conversationFamilyPaused(model.id, env)) continue;
    const resolved = conversationModel(model.id, env);
    if (resolved) return resolved;
  }
  return undefined;
}

/**
 * The metered catalog model a call on a member's plan (ChatGPT, Claude or Copilot) counts as on the Usage page: one with
 * the same provider model. Its id groups the call with that model's other calls, and its list rates value the call.
 * Null when the catalog serves none, so the call keeps its plan model id and shows no plan value.
 */
export function planListModel(
  providerModel: string,
  env: NodeJS.ProcessEnv = process.env,
): { modelId: string; rates: ResolvedModel['rates'] } | null {
  const wanted = comparableProviderModel(providerModel);
  let models: ReturnType<typeof loadModelCatalog>['models'];
  try {
    models = loadModelCatalog(env).models;
  } catch {
    // A workspace that chats only on members' plans may serve no metered model at all.
    return null;
  }
  const match = models.find(
    model =>
      !isPlanProvider(model.route.provider) &&
      model.pricing !== 'unmetered' &&
      comparableProviderModel(model.route.model) === wanted,
  );
  if (!match) return null;
  return { modelId: conversationModel(match.id, env)?.price.modelId ?? match.id, rates: match.rates };
}
