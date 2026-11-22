import type { Client } from 'pg';

type QueryClient = Pick<Client, 'query'>;
type Memos = Map<string, Promise<unknown>>;

const transactionMemos = new WeakMap<object, Memos>();

/** Starts sharing memoized reads on `client` for one transaction. */
export function openTransactionMemos(client: object): Memos {
  const memos: Memos = new Map();
  transactionMemos.set(client, memos);
  return memos;
}

export function closeTransactionMemos(client: object, memos: Memos) {
  if (transactionMemos.get(client) === memos) transactionMemos.delete(client);
}

/**
 * Runs `read` once per key for the workspace runtime transaction (`inPipelinedTransaction`) on `client` and shares its
 * result; anywhere else, including migrations, it runs every time. Only for reads nothing in that transaction changes.
 */
export function memoizeInTransaction<T>(client: object, key: string, read: () => Promise<T>): Promise<T> {
  const memos = transactionMemos.get(client);
  if (!memos) return read();
  const known = memos.get(key);
  if (known) return known as Promise<T>;
  const pending = read();
  memos.set(key, pending);
  pending.catch(() => {
    if (memos.get(key) === pending) memos.delete(key);
  });
  return pending;
}

/**
 * Whether `relation`, a qualified name, exists. Use it only for relations that migrations create, which no request
 * creates or drops, so one answer holds for the whole transaction.
 */
export async function relationInstalled(client: QueryClient, relation: string) {
  return memoizeInTransaction(client, `relation:${relation}`, async () =>
    Boolean((await client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [relation])).rows[0]?.installed),
  );
}

/** Shares `value` under `key` for the rest of the workspace runtime transaction on `client`. */
export function rememberInTransaction<T>(client: object, key: string, value: T) {
  transactionMemos.get(client)?.set(key, Promise.resolve(value));
}

/** Whether `key` holds a memoized read or remembered value in the workspace runtime transaction on `client`. */
export function knownInTransaction(client: object, key: string) {
  return transactionMemos.get(client)?.has(key) ?? false;
}

/** Drops every memoized read whose key starts with `prefix`. */
export function forgetInTransaction(client: object, prefix: string) {
  const memos = transactionMemos.get(client);
  if (memos) for (const key of memos.keys()) if (key.startsWith(prefix)) memos.delete(key);
}

/**
 * Sends every query `issue` starts without waiting for each reply, so they cost one network round trip, and settles
 * them all. Postgres still runs them one after another, each in its own statement. `issue` must start its queries
 * without awaiting them.
 */
export async function pipelined(client: QueryClient, issue: () => Promise<unknown>[]) {
  const connection = client as { pipeline?: boolean | undefined };
  const previous = connection.pipeline;
  connection.pipeline = true;
  let pending: Promise<unknown>[];
  try {
    pending = issue();
  } catch (error) {
    connection.pipeline = previous;
    throw error;
  }
  // pg keeps handing out replies only while the flag is on, so it stays on until the last one arrives.
  const settled = await Promise.allSettled(pending);
  connection.pipeline = previous;
  return settled;
}

/**
 * Runs `tasks` side by side with every query they start pipelined, so N independent reads cost about one round trip
 * rather than N, and returns their results in order. Each task may still await its own queries one after another.
 * Use it only for reads: Postgres runs the statements in the order they arrive. On failure it throws the original
 * error rather than one caused by the transaction already being aborted.
 */
export async function pipelinedAll<const T extends readonly (() => Promise<unknown>)[]>(
  client: QueryClient,
  tasks: T,
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  type Results = { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
  if (tasks.length < 2) return (await Promise.all(tasks.map(task => task()))) as Results;
  const settled = await pipelined(client, () => tasks.map(task => task()));
  const failed = settled.filter(result => result.status === 'rejected');
  if (failed.length)
    throw (failed.find(result => (result.reason as { code?: unknown } | null)?.code !== '25P02') ?? failed[0])!.reason;
  return settled.map(result => (result as PromiseFulfilledResult<unknown>).value) as Results;
}
