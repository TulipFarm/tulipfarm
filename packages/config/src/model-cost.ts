import { z } from 'zod';
import { parseModelResolution } from './model-bundle.ts';
import { modelPriceSchema } from './model-continuity.ts';
import { modelTokenUsageSchema, modelUsageSchema } from './model-usage.ts';

export { modelTokenUsageSchema, modelUsageSchema };

/** Prompt and completion token counts of known usage, as reported to usage sinks. */
export function usageTokenCounts(tokens: z.infer<typeof modelTokenUsageSchema>) {
  return {
    inputTokens: tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.cacheWrite5m + tokens.cacheWrite1h,
    outputTokens: tokens.output,
  };
}

function picoUsdPerToken(usdPerMillionTokens: number): bigint {
  const text = String(usdPerMillionTokens);
  if (!/^\d+(\.\d{1,6})?$/.test(text)) throw new Error('Unsupported price precision');
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

export function calculateModelCost(input: {
  resolution: unknown;
  usage: unknown;
  date: string;
  trustedBundle?: unknown;
}) {
  const resolution = parseModelResolution(input.resolution, input.trustedBundle);
  return calculateUsageCost({
    ...input,
    modelId: resolution.modelId,
    pricingRevision: resolution.pricingRevision,
    rates: resolution.rates,
    maxInputTokens: resolution.route.maxInputTokens,
    maxOutputTokens: resolution.route.maxOutputTokens,
  });
}

export function calculateUsageCost(input: {
  modelId: string;
  pricingRevision: string;
  rates: readonly z.infer<typeof modelPriceSchema>[];
  maxInputTokens: number;
  maxOutputTokens: number;
  usage: unknown;
  date: string;
}) {
  const usage = modelUsageSchema.parse(input.usage);
  const date = z.iso.date().parse(input.date);
  if (usage.kind === 'unknown') return { kind: 'unknown' as const, reason: usage.reason };
  const { tokens } = usage;
  const prompt =
    BigInt(tokens.input) +
    BigInt(tokens.cacheRead) +
    BigInt(tokens.cacheWrite) +
    BigInt(tokens.cacheWrite5m) +
    BigInt(tokens.cacheWrite1h);
  if (prompt > BigInt(input.maxInputTokens) || tokens.output > input.maxOutputTokens)
    throw new Error('Usage exceeds qualified route limits');
  const applicable = input.rates
    .filter(
      rate =>
        (rate.validFrom === null || date >= rate.validFrom) &&
        (rate.validUntilExclusive === null || date < rate.validUntilExclusive) &&
        (rate.promptTokensAbove === null || prompt > BigInt(rate.promptTokensAbove)),
    )
    .sort((a, b) => (b.promptTokensAbove ?? -1) - (a.promptTokensAbove ?? -1));
  const selected = applicable[0];
  if (!selected || applicable[1]?.promptTokensAbove === selected.promptTokensAbove)
    throw new Error('Ambiguous or missing price');
  let cost = 0n;
  for (const category of modelTokenUsageSchema.keyof().options) {
    const count = tokens[category];
    if (count === 0) continue;
    const rate = selected.usdPerMillionTokens[category];
    if (rate === undefined) throw new Error(`Unpriced usage category ${category}`);
    cost += BigInt(count) * picoUsdPerToken(rate);
  }
  return {
    kind: 'known' as const,
    providerPicoUsd: cost.toString(),
    pricingRevision: input.pricingRevision,
    modelId: input.modelId,
    date,
    promptTokensAbove: selected.promptTokensAbove,
  };
}

export function reserveModelCost(input: Omit<Parameters<typeof calculateUsageCost>[0], 'usage'>): string {
  let maximum = 0n;
  const bounds = new Set([
    input.maxInputTokens,
    ...input.rates.flatMap(rate =>
      rate.promptTokensAbove === null ? [] : [Math.min(input.maxInputTokens, rate.promptTokensAbove)],
    ),
  ]);
  for (const prompt of bounds)
    for (const category of ['input', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h'] as const) {
      if (!input.rates.some(rate => rate.usdPerMillionTokens[category] !== undefined)) continue;
      const cost = calculateUsageCost({
        ...input,
        usage: {
          kind: 'known',
          tokens: {
            input: 0,
            output: input.maxOutputTokens,
            cacheRead: 0,
            cacheWrite: 0,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
            [category]: prompt,
          },
        },
      });
      if (cost.kind === 'known' && BigInt(cost.providerPicoUsd) > maximum) maximum = BigInt(cost.providerPicoUsd);
    }
  return maximum.toString();
}
