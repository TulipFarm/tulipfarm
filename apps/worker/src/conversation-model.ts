import { modelEnvironment } from '@tulipfarm/agents/model-environment';
import type { InferenceRoute } from '@tulipfarm/agents/inference';
import { modelRoleDefault, type ModelRole, type ResolvedModel } from '@tulipfarm/config';

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
 * effective model environment as tasks and the catalog. A family outside `MODEL_FAMILIES` has no model.
 */
export function conversationModel(family: string, env: NodeJS.ProcessEnv = process.env): ConversationModel | null {
  const environment = modelEnvironment(env);
  const resolution = environment?.resolve(family);
  const route = resolution && environment?.inference(resolution);
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

/** The model of the family that fills `role` (its setting, else the effective catalog), or null when it has none. */
export function roleModel(role: ModelRole, env: NodeJS.ProcessEnv = process.env): ConversationModel | null {
  const family = modelRoleDefault(role, env)?.familyId;
  return family ? conversationModel(family, env) : null;
}
