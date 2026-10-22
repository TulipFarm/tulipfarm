import { z } from 'zod';
import { modelFamilies, modelPricing, modelRoleDefault, modelRoleFamilies } from '@tulipfarm/config';

export const guideLimits = {
  messageCharacters: 1200,
  historyBytes: 8000,
  modelInputBytes: 16_000,
  outputTokens: 800,
  classifierTokens: 96,
  responseBytes: 128_000,
  timeoutMs: 45_000,
  dailyBudgetMicroUsd: 10_000_000,
  concurrent: 8,
} as const;

/**
 * The per-turn budget of the public-guide role's family, priced from the effective catalog. Without an enabled guide
 * family, the catalog's first public-guide family prices it; the guide is off then anyway.
 */
export function guideBudget(env: NodeJS.ProcessEnv = process.env) {
  const familyId = modelRoleDefault('public-guide', env)?.familyId ?? modelRoleFamilies('public-guide')[0]?.id;
  const modelId = modelFamilies.find(family => family.id === familyId)?.currentModelId;
  const prices = modelPricing.models.find(model => model.id === modelId)?.rates;
  if (!prices?.length) return { turnMicroUsd: 0, dailyTurns: 0 };
  // UTF-8 bytes bound text tokens; reserve overhead for message framing. Never refund an attempted turn.
  const turnMicroUsd = Math.ceil(
    2 * (guideLimits.modelInputBytes + 1024) * Math.max(...prices.map(rate => rate.usdPerMillionTokens.input)) +
      (guideLimits.outputTokens + guideLimits.classifierTokens) *
        Math.max(...prices.map(rate => rate.usdPerMillionTokens.output)),
  );
  // An unmetered family costs nothing, so only the turn cap applies.
  const dailyTurns = turnMicroUsd ? Math.min(2000, Math.floor(guideLimits.dailyBudgetMicroUsd / turnMicroUsd)) : 2000;
  return { turnMicroUsd, dailyTurns };
}
export const { turnMicroUsd: guideTurnMicroUsd, dailyTurns: guideDailyTurns } = guideBudget();

export function publicGuideOrigins(env: NodeJS.ProcessEnv = process.env) {
  const origins = (env.PUBLIC_GUIDE_ORIGINS ?? 'http://localhost:5100,http://127.0.0.1:5100')
    .split(',')
    .map(value => value.trim());
  return z
    .array(
      z.url().refine(value => {
        const url = new URL(value);
        return (
          url.origin === value &&
          (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
        );
      }),
    )
    .min(1)
    .parse(origins);
}

export const guideMessageSchema = z.strictObject({
  message: z.string().trim().min(1).max(guideLimits.messageCharacters),
  conversation: z.string().max(16_000).optional(),
});
export type GuideMessage = { role: 'user' | 'assistant'; content: string };
