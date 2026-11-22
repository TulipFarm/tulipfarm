import type { Client, PoolClient } from 'pg';
import { z } from 'zod';
import { observeChatDetail } from '@tulipfarm/observability';
import { closeTransactionMemos, openTransactionMemos, pipelined } from './transaction-reads.ts';

export type SqlClient = Pick<Client, 'query'>;
export const transactionSettingsSchema = z.object({
  statementTimeoutMs: z.number().int().min(1).max(300_000).default(30_000),
  lockTimeoutMs: z.number().int().min(1).max(60_000).default(5_000),
  idleTransactionTimeoutMs: z.number().int().min(1).max(300_000).default(30_000),
});

const commitCallbacks = new WeakMap<SqlClient, (() => void)[]>();

/**
 * Runs `callback` once the inTransaction transaction on `client` commits, or drops it on rollback.
 * Outside such a transaction it runs now. A savepoint rollback drops callbacks only through `afterCommitMark`.
 * Callback failures are swallowed: they never undo or fail the committed work.
 */
export function afterCommit(client: SqlClient, callback: () => void) {
  const callbacks = commitCallbacks.get(client);
  if (callbacks) callbacks.push(callback);
  else runCallback(callback);
}

/** Marks the callbacks queued so far; `drop` discards those queued after, for use on ROLLBACK TO SAVEPOINT. */
export function afterCommitMark(client: SqlClient) {
  const callbacks = commitCallbacks.get(client);
  const length = callbacks?.length ?? 0;
  return {
    drop() {
      if (callbacks && commitCallbacks.get(client) === callbacks) callbacks.length = Math.min(callbacks.length, length);
    },
  };
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

/** The value of a settled query, or its error. */
export function settledValue<T>(result: PromiseSettledResult<unknown> | undefined): T {
  if (!result) throw new Error('Missing pipelined query result');
  if (result.status === 'rejected') throw result.reason;
  return result.value as T;
}

/**
 * Same as `inTransaction` followed by `resetClient`, in fewer round trips: BEGIN, the settings and the queries `setup`
 * starts go out together, then COMMIT and DISCARD ALL go out together. `operation` gets the settled `setup` results in
 * order and checks them before it does any work.
 */
export async function inPipelinedTransaction<T>(
  client: SqlClient,
  setup: (client: SqlClient) => Promise<unknown>[],
  operation: (client: SqlClient, setup: PromiseSettledResult<unknown>[]) => Promise<T>,
  settings: z.input<typeof transactionSettingsSchema> & { transactionTimeoutMs?: number } = {},
) {
  const limits = transactionSettingsSchema.parse(settings);
  const callbacks: (() => void)[] = [];
  commitCallbacks.set(client, callbacks);
  const memos = openTransactionMemos(client);
  let result: T;
  let reset: PromiseSettledResult<unknown> | undefined;
  try {
    const started = await observeChatDetail('storage-begin', () =>
      pipelined(client, () => [
        ...(settings.transactionTimeoutMs === undefined
          ? []
          : [
              client.query("SELECT set_config('transaction_timeout', $1, false)", [
                String(settings.transactionTimeoutMs),
              ]),
            ]),
        client.query('BEGIN ISOLATION LEVEL READ COMMITTED'),
        client.query(
          "SELECT set_config('search_path', 'pg_catalog', true), set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true), set_config('idle_in_transaction_session_timeout', $3, true)",
          [String(limits.statementTimeoutMs), String(limits.lockTimeoutMs), String(limits.idleTransactionTimeoutMs)],
        ),
        ...setup(client),
      ]),
    );
    const prepared = started.splice(settings.transactionTimeoutMs === undefined ? 2 : 3);
    for (const step of started) settledValue(step);
    result = await operation(client, prepared);
    const [commit, discard] = await observeChatDetail('storage-commit', () =>
      pipelined(client, () => [client.query('COMMIT'), client.query('DISCARD ALL')]),
    );
    settledValue(commit);
    reset = discard;
  } catch (error) {
    await observeChatDetail('storage-rollback', () => client.query('ROLLBACK')).catch(() => undefined);
    throw error;
  } finally {
    if (commitCallbacks.get(client) === callbacks) commitCallbacks.delete(client);
    closeTransactionMemos(client, memos);
  }
  for (const callback of callbacks) runCallback(callback);
  settledValue(reset);
  return result;
}

export async function resetClient(client: PoolClient) {
  await observeChatDetail('storage-reset', () => client.query('DISCARD ALL'));
}
