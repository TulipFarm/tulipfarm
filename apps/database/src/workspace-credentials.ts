import { Pool } from 'pg';
import { z } from 'zod';
import {
  rotateWorkspaceCredentials,
  disableWorkspace,
  WorkspaceOperatorConflict,
} from '@tulipfarm/workspaces/operators';

async function run() {
  const [kind, workspaceId, operationId, expectedGeneration, ...extra] = process.argv.slice(2);
  if (
    extra.length ||
    !['rotate-passwords', 'rotate-keys', 'disable'].includes(kind ?? '') ||
    !workspaceId ||
    !operationId ||
    (kind === 'disable' ? expectedGeneration !== undefined : expectedGeneration === undefined)
  ) {
    throw new Error(
      'Usage: pnpm workspace:credentials <rotate-passwords|rotate-keys> <workspace-id> <operation-id> <expected-generation>, or disable <workspace-id> <operation-id>',
    );
  }
  if (process.env.WORKSPACE_STORAGE_CAPABILITY !== 'isolated-v1')
    throw new Error('Operator commands require isolated-v1');
  const connectionString = z.url().parse(process.env.WORKSPACE_PROVISIONING_DATABASE_URL);
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  pool.on('error', () => undefined);
  try {
    const result =
      kind === 'disable'
        ? await disableWorkspace(pool, workspaceId, operationId)
        : await rotateWorkspaceCredentials(pool, {
            kind: z.enum(['rotate-passwords', 'rotate-keys']).parse(kind),
            workspaceId,
            operationId,
            expectedGeneration: z.coerce.number().int().positive().parse(expectedGeneration),
          });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await pool.end();
  }
}

run().catch(error => {
  process.stderr.write(
    `${error instanceof WorkspaceOperatorConflict ? error.message : 'Workspace operator command failed. Verify configuration and retry the same operation ID.'}\n`,
  );
  process.exitCode = 1;
});
