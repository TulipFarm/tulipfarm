import type { Client, PoolClient } from 'pg';
import { z } from 'zod';
import { observeChatDetail } from '@tulipfarm/observability';

export type SqlClient = Pick<Client, 'query'>;
export const transactionSettingsSchema = z.object({
  statementTimeoutMs: z.number().int().min(1).max(300_000).default(30_000),
  lockTimeoutMs: z.number().int().min(1).max(60_000).default(5_000),
  idleTransactionTimeoutMs: z.number().int().min(1).max(300_000).default(30_000),
});

const commitCallbacks = new WeakMap<SqlClient, (() => void)[]>();

/**
 * Runs `callback` once the inTransaction transaction on `client` commits, or drops it on rollback.
 * Outside such a transaction it runs now. Savepoint rollbacks do not drop callbacks.
 * Callback failures are swallowed: they never undo or fail the committed work.
 */
export function afterCommit(client: SqlClient, callback: () => void) {
  const callbacks = commitCallbacks.get(client);
  if (callbacks) callbacks.push(callback);
  else runCallback(callback);
}

function runCallback(callback: () => void) {
  try {
    callback();
  } catch {
    /* Post-commit side effects must not fail committed work. */
  }
}

export async function inTransaction<T>(
  client: SqlClient,
  operation: (client: SqlClient) => Promise<T>,
  settings: z.input<typeof transactionSettingsSchema> = {},
) {
  const limits = transactionSettingsSchema.parse(settings);
  await observeChatDetail('storage-begin', () => client.query('BEGIN ISOLATION LEVEL READ COMMITTED'));
  const callbacks: (() => void)[] = [];
  commitCallbacks.set(client, callbacks);
  let result: T;
  try {
    await observeChatDetail('storage-settings', () =>
      client.query(
        "SELECT set_config('search_path', 'pg_catalog', true), set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true), set_config('idle_in_transaction_session_timeout', $3, true)",
        [String(limits.statementTimeoutMs), String(limits.lockTimeoutMs), String(limits.idleTransactionTimeoutMs)],
      ),
    );
    result = await operation(client);
    await observeChatDetail('storage-commit', () => client.query('COMMIT'));
  } catch (error) {
    await observeChatDetail('storage-rollback', () => client.query('ROLLBACK')).catch(() => undefined);
    throw error;
  } finally {
    if (commitCallbacks.get(client) === callbacks) commitCallbacks.delete(client);
  }
  for (const callback of callbacks) runCallback(callback);
  return result;
}

export async function resetClient(client: PoolClient) {
  await observeChatDetail('storage-reset', () => client.query('DISCARD ALL'));
}
