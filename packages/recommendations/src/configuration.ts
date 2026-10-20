import type { Pool } from 'pg';
import { z } from 'zod';

const positivePicoUsd = z.string().regex(/^[1-9]\d{0,29}$/);
const configurationSchema = z.object({
  databaseUrl: z.url(),
  family: z.string().min(1),
  inputBytes: z.coerce.number().int().min(1).max(512_000),
  outputTokens: z.coerce.number().int().min(1).max(4096),
  timeoutMs: z.coerce.number().int().min(1).max(45_000),
  concurrency: z.coerce.number().int().min(1).max(32),
  maximumPicoUsd: positivePicoUsd,
  workspacePicoUsd: positivePicoUsd,
  platformPicoUsd: positivePicoUsd,
  periodSeconds: z.coerce.number().int().min(1).max(31_536_000),
});

export function recommendationConfiguration(env: NodeJS.ProcessEnv = process.env) {
  if (!Object.keys(env).some(key => key.startsWith('RECOMMENDATION_') && env[key])) return null;
  const result = configurationSchema.safeParse({
    databaseUrl: env.RECOMMENDATION_DATABASE_URL,
    family: env.RECOMMENDATION_MODEL_FAMILY,
    inputBytes: env.RECOMMENDATION_MAX_INPUT_BYTES,
    outputTokens: env.RECOMMENDATION_MAX_OUTPUT_TOKENS,
    timeoutMs: env.RECOMMENDATION_TIMEOUT_MS,
    concurrency: env.RECOMMENDATION_CONCURRENCY,
    maximumPicoUsd: env.RECOMMENDATION_MAX_RUN_PICO_USD,
    workspacePicoUsd: env.RECOMMENDATION_WORKSPACE_PICO_USD,
    platformPicoUsd: env.RECOMMENDATION_PLATFORM_PICO_USD,
    periodSeconds: env.RECOMMENDATION_PERIOD_SECONDS,
  });
  if (!result.success) throw new Error('recommendation-configuration-invalid');
  return result.data;
}

export function recommendationEligibility(pool: Pick<Pool, 'query'>) {
  return async (workspaceId: string, userId: string) => {
    const row = z
      .object({ id: z.string(), email: z.string(), name: z.string() })
      .optional()
      .parse(
        (
          await pool.query(
            `SELECT u.id,u.email,w.name FROM app.users u CROSS JOIN app.workspaces w
        JOIN app.workspace_storage s ON s.workspace_id=w.id AND s.stage='ready'
        WHERE u.id=$1 AND w.id=$2`,
            [userId, workspaceId],
          )
        ).rows[0],
      );
    return row !== undefined;
  };
}
