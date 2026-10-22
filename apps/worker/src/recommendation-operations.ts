import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { z } from 'zod';
import { workspaceRuntime } from '@tulipfarm/workspaces/storage';
import { recommendationConfiguration, recommendationEligibility } from '@tulipfarm/recommendations/configuration';
import { createRecommendationOperations, recommendationCursorSchema } from '@tulipfarm/recommendations/operations';

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout
      .write(`Usage: pnpm recommendations:operate <backfill|repair> --operation UUID [--workspace UUID] [--membership UUID]
  [--after-workspace UUID] [--after-member UUID] [--limit 1..100] [--pages 1..100] [--apply]
Defaults to a one-page dry run. Continue with the printed next cursor and the same operation ID.
Requires RECOMMENDATION_* configuration and workspace runtime credentials. Never calls a model.
`);
    return;
  }
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      operation: { type: 'string' },
      workspace: { type: 'string' },
      membership: { type: 'string' },
      'after-workspace': { type: 'string' },
      'after-member': { type: 'string' },
      limit: { type: 'string', default: '100' },
      pages: { type: 'string', default: '1' },
      apply: { type: 'boolean', default: false },
    },
  });
  if (positionals.length !== 1 || (values['after-member'] && !values['after-workspace']))
    throw new Error('invalid-options');
  const mode = z.enum(['backfill', 'repair']).parse(positionals[0]);
  const operationId = z.uuid().parse(values.operation);
  const workspaceId = z.uuid().optional().parse(values.workspace);
  const membershipId = z.uuid().optional().parse(values.membership);
  const limit = z.coerce.number().int().min(1).max(100).parse(values.limit);
  const pages = z.coerce.number().int().min(1).max(100).parse(values.pages);
  let after = values['after-workspace']
    ? recommendationCursorSchema.parse({
        workspaceId: values['after-workspace'],
        membershipId: values['after-member'] ?? null,
      })
    : null;
  const config = recommendationConfiguration();
  if (!config) throw new Error('recommendation-configuration-required');
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 2,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  pool.on('error', () => {
    process.stderr.write('Recommendation operation database connection failed.\n');
  });
  const runtime = workspaceRuntime(pool);
  try {
    const operation = createRecommendationOperations({ pool, runtime, eligible: recommendationEligibility(pool) });
    for (let page = 0; page < pages; page++) {
      const result = await operation.page({
        operationId,
        mode,
        apply: values.apply,
        after,
        limit,
        ...(workspaceId ? { workspaceId } : {}),
        ...(membershipId ? { membershipId } : {}),
      });
      process.stdout.write(`${JSON.stringify({ operationId, mode, dryRun: !values.apply, ...result })}\n`);
      after = result.next;
      if (!after) break;
    }
  } finally {
    await runtime.close();
    await pool.end();
  }
}

main().catch(() => {
  process.stderr.write(
    'Recommendation operation failed. Check configuration and retry with the same operation ID and cursor. No private text or credentials were printed.\n',
  );
  process.exitCode = 1;
});
