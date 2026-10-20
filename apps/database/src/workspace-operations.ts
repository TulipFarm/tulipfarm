import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { z } from 'zod';
import { Client, Connection } from '@temporalio/client';
import { disposableDatabase } from './workspace-operations-recovery.ts';
import { teardownDisposableWorkspace, workspaceOperationStatus } from './workspace-operations-lifecycle.ts';
import { createWorkspaceTeardownLifecycle } from './workspace-operations-adapter.ts';

const help = `Usage: pnpm workspace:operations <status|teardown> --workspace UUID
  teardown: --operation UUID
Requires WORKSPACE_PROVISIONING_DATABASE_URL pointing to an explicit disposable local database.
`;

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(help);
    return;
  }
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      workspace: { type: 'string' },
      operation: { type: 'string' },
    },
  });
  const command = z.enum(['status', 'teardown']).parse(positionals[0]);
  if (positionals.length !== 1) throw new Error('invalid-command');
  const allowed = command === 'teardown' ? ['workspace', 'operation'] : ['workspace'];
  if (Object.keys(values).some(key => !allowed.includes(key))) throw new Error('unexpected-option');
  const workspaceId = z.uuid().toLowerCase().parse(values.workspace);
  const connectionString = disposableDatabase(z.url().parse(process.env.WORKSPACE_PROVISIONING_DATABASE_URL)).href;
  const pool = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
    options: '-c search_path=pg_catalog',
  });
  pool.on('error', () => undefined);
  let connection: Connection | undefined;
  try {
    const operator = z
      .object({ operator: z.string() })
      .parse((await pool.query('SELECT session_user AS operator')).rows[0]).operator;
    let result: unknown;
    if (command === 'status') result = await workspaceOperationStatus(pool, workspaceId);
    else {
      const operationId = z.uuid().parse(values.operation);
      const address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
      if (!/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(address)) throw new Error('local-temporal-required');
      connection = await Connection.connect({ address });
      const temporal = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });
      result = await teardownDisposableWorkspace({
        connectionString,
        workspaceId,
        operatorId: operator,
        lifecycle: createWorkspaceTeardownLifecycle({ pool, temporal, operationId }),
      });
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await connection?.close();
    await pool.end();
  }
}

main().catch(() => {
  process.stderr.write(
    'Workspace operation failed. Check scoped status and retry; no credentials or record values were printed.\n',
  );
  process.exitCode = 1;
});
