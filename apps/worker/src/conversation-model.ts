import { modelEnvironment } from '@tulipfarm/agents/model-environment';
import type { InferenceRoute } from '@tulipfarm/agents/inference';
import { loadModelCatalog, type ModelCatalogRole, type ResolvedModel } from '@tulipfarm/config';

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
 * The model with the catalog role `fallback`, which retries a failed chat call once. Without one, or when it is paused
 * or is the chat's own model, failed replies are not retried on another model.
 */
export function chatFallbackModel(
  chatFamily: string,
  env: NodeJS.ProcessEnv = process.env,
): ConversationModel | undefined {
  const model = loadModelCatalog(env).role('fallback');
  if (!model || model.id === chatFamily || conversationFamilyPaused(model.id, env)) return undefined;
  return conversationModel(model.id, env) ?? undefined;
}
