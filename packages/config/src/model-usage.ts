// Kept free of the effective catalog so browser code can validate usage without Node built-ins.
import { z } from 'zod';

const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const modelTokenUsageSchema = z.strictObject({
  input: tokenCount,
  output: tokenCount,
  cacheRead: tokenCount,
  cacheWrite: tokenCount,
  cacheWrite5m: tokenCount,
  cacheWrite1h: tokenCount,
});
export const modelUsageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('known'), tokens: modelTokenUsageSchema }),
  z.strictObject({ kind: z.literal('unknown'), reason: z.enum(['missing', 'abandoned', 'invalid']) }),
]);
