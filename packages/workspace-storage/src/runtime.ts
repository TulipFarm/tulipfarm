import { Pool } from 'pg';
import { z } from 'zod';
import {
  inBackgroundJob,
  observeChatDetail,
  observeChatTransaction,
  observeWorkspaceConnection,
} from '@tulipfarm/observability';
import { commonTables, qualified, workspaceIdSchema, workspaceNames } from './names.ts';
import { inTransaction, resetClient, type SqlClient } from './transactions.ts';

export {
  commonTables,
  qualified,
  tableTableName,
  workspaceIdFromSchema,
  workspaceIdSchema,
  workspaceNames,
} from './names.ts';
export { afterCommit } from './transactions.ts';
export type { WorkspaceId } from './names.ts';
export type { SqlClient } from './transactions.ts';

// Readers must accept every shipped common migration; the migrations test pins this to the common/ file count.
export const commonCompatibility = Object.freeze({ minimum: 1, maximum: 15 });

export const runtimeCredentialSchema = z.object({
  workspaceId: workspaceIdSchema,
  generation: z.number().int().nonnegative(),
  connectionString: z.url().refine(value => ['postgres:', 'postgresql:'].includes(new URL(value).protocol)),
});
export type RuntimeCredential = z.infer<typeof runtimeCredentialSchema>;
const configSchema = z.object({
  maxPools: z.number().int().min(1).max(100).default(8),
  connectionsPerPool: z.number().int().min(1).max(20).default(2),
  maxConcurrentTransactions: z.number().int().min(1).default(8),
  // Most admission slots scheduled jobs may hold (default: all but one), so a request is admitted at once.
  maxBackgroundTransactions: z.number().int().min(1).optional(),
  maxQueue: z.number().int().nonnegative().default(100),
  waitTimeoutMs: z.number().int().min(1).default(5_000),
  connectionTimeoutMs: z.number().int().min(1).default(5_000),
  statementTimeoutMs: z.number().int().min(1).default(30_000),
  idleTimeoutMs: z.number().int().min(1).default(30_000),
  replicaCount: z.number().int().min(1),
  reservedConnections: z.number().int().nonnegative(),
  databaseConnectionBudget: z.number().int().min(1),
});
type Entry = {
  pool: Pool;
  workspaceId: string;
  generation: number;
  claims: number;
  idleSince: number;
  retiring: boolean;
  connections: number;
  waiters: (() => void)[];
  backgroundWaiters: (() => void)[];
};
type Waiter = { resolve: () => void; reject: (error: Error) => void };

export class StorageUnavailableError extends Error {
  readonly code:
    | 'closed'
    | 'queue_full'
    | 'wait_timeout'
    | 'pool_capacity'
    | 'stale_credential'
    | 'incompatible_version'
    | 'disabled';
  constructor(code: StorageUnavailableError['code']) {
    super(`Workspace storage unavailable (${code})`);
    this.code = code;
    this.name = 'StorageUnavailableError';
  }
}

class TransactionDeadline {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly deadlineAt: number | undefined;

  constructor(deadlineAt?: number) {
    this.deadlineAt = deadlineAt;
    const tick = () => {
      if (deadlineAt === undefined) return;
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) this.controller.abort(new StorageUnavailableError('wait_timeout'));
      else this.timer = setTimeout(tick, Math.min(remaining, 2_147_483_647));
    };
    tick();
  }

  check() {
    if (this.deadlineAt !== undefined && Date.now() >= this.deadlineAt)
      this.controller.abort(new StorageUnavailableError('wait_timeout'));
    this.signal.throwIfAborted();
  }

  async wait<T>(operation: () => Promise<T>, releaseLate?: (value: T) => void): Promise<T> {
    this.check();
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new StorageUnavailableError('wait_timeout'));
      this.signal.addEventListener('abort', abort, { once: true });
      void Promise.resolve()
        .then(() => {
          this.check();
          return operation();
        })
        .then(
          value => {
            this.signal.removeEventListener('abort', abort);
            try {
              this.check();
            } catch (error) {
              releaseLate?.(value);
              reject(error);
              return;
            }
            resolve(value);
          },
          (error: unknown) => {
            this.signal.removeEventListener('abort', abort);
            reject(this.signal.aborted ? new StorageUnavailableError('wait_timeout') : error);
          },
        );
    });
  }

  dispose() {
    clearTimeout(this.timer);
  }
}

export async function fenceWorkspaceAccess(client: SqlClient, workspaceId: string, exclusive = false) {
  const installed = await client.query(
    "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname = 'workspace_access'",
  );
  if (!installed.rowCount) return;
  const result = await client.query('SELECT app.workspace_access($1::uuid, $2::boolean) AS allowed', [
    workspaceId,
    exclusive,
  ]);
  if (!z.object({ allowed: z.boolean() }).parse(result.rows[0]).allowed) throw new StorageUnavailableError('disabled');
}

export function createWorkspaceRuntime(
  options: z.input<typeof configSchema> & {
    resolveCredential: (workspaceId: string, signal: AbortSignal) => Promise<RuntimeCredential>;
    /** Whether the calling work is a scheduled job; such work yields admission and pool connections to requests. */
    background?: () => boolean;
  },
) {
  const config = configSchema.parse(options);
  if (
    config.maxPools * config.connectionsPerPool * config.replicaCount + config.reservedConnections >
    config.databaseConnectionBudget
  )
    throw new Error('Workspace pools exceed the deployment connection budget');
  const isBackground = options.background ?? inBackgroundJob;
  const maxBackground = Math.min(
    config.maxConcurrentTransactions,
    config.maxBackgroundTransactions ?? Math.max(1, config.maxConcurrentTransactions - 1),
  );
  const entries = new Map<string, Entry>();
  const generations = new Map<string, number>();
  const queue: Waiter[] = [];
  const backgroundQueue: Waiter[] = [];
  const closing = new Set<Promise<void>>();
  let active = 0;
  let activeBackground = 0;
  let closed = false;
  let shutdownResolve: (() => void) | undefined;

  function remove(entry: Entry) {
    entries.delete(`${entry.workspaceId}:${entry.generation}`);
    const end = entry.pool.end();
    closing.add(end);
    void end.finally(() => closing.delete(end));
    return end;
  }

  const eviction = setInterval(
    () => {
      for (const entry of entries.values()) {
        if (!entry.claims && (entry.retiring || Date.now() - entry.idleSince >= config.idleTimeoutMs))
          void remove(entry);
      }
    },
    Math.min(config.idleTimeoutMs, 1_000),
  );
  eviction.unref();

  function admissible(background: boolean) {
    return active < config.maxConcurrentTransactions && (!background || activeBackground < maxBackground);
  }

  function take(background: boolean) {
    active++;
    if (background) activeBackground++;
  }

  function admit(deadline: TransactionDeadline, background: boolean): Promise<void> {
    deadline.check();
    if (closed) return Promise.reject(new StorageUnavailableError('closed'));
    // Requests skip ahead of queued jobs; a job admits only while nothing waits ahead of it.
    if (admissible(background) && (background ? !queue.length && !backgroundQueue.length : !queue.length)) {
      take(background);
      return Promise.resolve();
    }
    // Queued jobs never fill the queue for requests.
    if ((background ? queue.length + backgroundQueue.length : queue.length) >= config.maxQueue)
      return Promise.reject(new StorageUnavailableError('queue_full'));
    const waiting = background ? backgroundQueue : queue;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        deadline.signal.removeEventListener('abort', abort);
        const index = waiting.indexOf(waiter);
        if (index >= 0) waiting.splice(index, 1);
      };
      const waiter: Waiter = {
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: error => {
          cleanup();
          reject(error);
        },
      };
      const abort = () => waiter.reject(new StorageUnavailableError('wait_timeout'));
      const timer = setTimeout(abort, config.waitTimeoutMs);
      deadline.signal.addEventListener('abort', abort, { once: true });
      waiting.push(waiter);
    });
  }

  function releaseAdmission(background: boolean) {
    active--;
    if (background) activeBackground--;
    while (active < config.maxConcurrentTransactions) {
      const waiting = queue.length ? queue : backgroundQueue.length && admissible(true) ? backgroundQueue : undefined;
      const waiter = waiting?.shift();
      if (!waiter) break;
      take(waiting === backgroundQueue);
      waiter.resolve();
    }
    if (closed && !active) shutdownResolve?.();
  }

  function acquireConnection(entry: Entry, deadline: TransactionDeadline, background: boolean) {
    if (entry.connections < config.connectionsPerPool && !entry.waiters.length && !entry.backgroundWaiters.length) {
      entry.connections++;
      return Promise.resolve();
    }
    const waiting = background ? entry.backgroundWaiters : entry.waiters;
    return deadline.wait(
      () =>
        new Promise<void>((resolve, reject) => {
          const grant = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            const index = waiting.indexOf(grant);
            if (index >= 0) waiting.splice(index, 1);
            reject(new StorageUnavailableError('wait_timeout'));
          }, config.connectionTimeoutMs);
          waiting.push(grant);
        }),
      () => releaseConnection(entry),
    );
  }

  // pg queues checkouts first come, first served; this gate hands a freed connection to a waiting request before a job.
  function releaseConnection(entry: Entry) {
    const next = entry.waiters.shift() ?? entry.backgroundWaiters.shift();
    if (next) next();
    else entry.connections--;
  }

  async function credentialFor(workspaceId: string, deadline: TransactionDeadline) {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await deadline.wait(() =>
        Promise.race([
          options.resolveCredential(workspaceId, AbortSignal.any([controller.signal, deadline.signal])),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              reject(new StorageUnavailableError('wait_timeout'));
              controller.abort();
            }, config.connectionTimeoutMs);
          }),
        ]),
      );
      const credential = runtimeCredentialSchema.parse(value);
      const names = workspaceNames(workspaceId);
      const url = new URL(credential.connectionString);
      if (credential.workspaceId !== workspaceId || decodeURIComponent(url.username) !== names.runtime)
        throw new Error('Runtime credential does not match the workspace login');
      if (url.searchParams.has('user') || url.searchParams.has('options'))
        throw new Error('Runtime credential contains a role or session override');
      const latest = generations.get(workspaceId);
      if (latest !== undefined && credential.generation < latest) throw new StorageUnavailableError('stale_credential');
      generations.set(workspaceId, credential.generation);
      for (const entry of entries.values()) {
        if (entry.workspaceId === workspaceId && entry.generation !== credential.generation) entry.retiring = true;
      }
      return credential;
    } finally {
      clearTimeout(timeout);
    }
  }

  let claimQueue = Promise.resolve();
  function claim(credential: RuntimeCredential, deadline: TransactionDeadline) {
    const previous = claimQueue;
    const result = deadline.wait(() => previous.then(() => claimPool(credential, deadline)), releaseClaim);
    claimQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function claimPool(credential: RuntimeCredential, deadline: TransactionDeadline) {
    deadline.check();
    const key = `${credential.workspaceId}:${credential.generation}`;
    const cached = entries.get(key);
    if (cached && !cached.retiring) {
      cached.claims++;
      return cached;
    }
    for (const entry of entries.values()) {
      if (!entry.claims && entry.retiring) await deadline.wait(() => remove(entry));
    }
    if (entries.size >= config.maxPools) {
      const idle = [...entries.values()].filter(entry => !entry.claims).sort((a, b) => a.idleSince - b.idleSince)[0];
      if (!idle) throw new StorageUnavailableError('pool_capacity');
      await deadline.wait(() => remove(idle));
    }
    await deadline.wait(() => Promise.all(closing));
    deadline.check();
    if (credential.generation !== generations.get(credential.workspaceId))
      throw new StorageUnavailableError('stale_credential');
    const pool = new Pool({
      connectionString: credential.connectionString,
      max: config.connectionsPerPool,
      connectionTimeoutMillis: config.connectionTimeoutMs,
      idleTimeoutMillis: config.idleTimeoutMs,
      statement_timeout: config.statementTimeoutMs,
      options: '-c search_path=pg_catalog',
    });
    pool.on('error', () => undefined);
    const entry: Entry = {
      pool,
      workspaceId: credential.workspaceId,
      generation: credential.generation,
      claims: 1,
      idleSince: Date.now(),
      retiring: false,
      connections: 0,
      waiters: [],
      backgroundWaiters: [],
    };
    entries.set(key, entry);
    return entry;
  }

  function releaseClaim(entry: Entry) {
    entry.claims--;
    entry.idleSince = Date.now();
  }

  function transaction<T>(
    workspaceIdInput: string,
    compatibility: { minimum: number; maximum: number; access?: 'exclusive'; deadlineAt?: number },
    operation: (transaction: {
      client: SqlClient;
      schema: string;
      workspaceId: string;
      commonVersion: number;
    }) => Promise<T>,
  ): Promise<T> {
    return observeChatTransaction(() => runTransaction(workspaceIdInput, compatibility, operation));
  }

  async function runTransaction<T>(
    workspaceIdInput: string,
    compatibility: { minimum: number; maximum: number; access?: 'exclusive'; deadlineAt?: number },
    operation: (transaction: {
      client: SqlClient;
      schema: string;
      workspaceId: string;
      commonVersion: number;
    }) => Promise<T>,
  ) {
    const workspaceId = workspaceIdSchema.parse(workspaceIdInput);
    const versions = z
      .object({
        minimum: z.number().int().nonnegative(),
        maximum: z.number().int().nonnegative(),
        deadlineAt: z.number().int().optional(),
      })
      .refine(({ minimum, maximum }) => maximum >= minimum)
      .parse(compatibility);
    const deadline = new TransactionDeadline(versions.deadlineAt);
    const background = isBackground();
    let admitted = false;
    let pooled = false;
    let entry: Entry | undefined;
    try {
      await observeChatDetail('storage-admission', () => admit(deadline, background));
      admitted = true;
      const credential = await observeChatDetail('storage-credentials', () => credentialFor(workspaceId, deadline));
      entry = await observeChatDetail('storage-pool', () => claim(credential, deadline));
      const pool = entry.pool;
      const claimed = entry;
      const client = await observeWorkspaceConnection('wait', () =>
        observeChatDetail('storage-connect', async () => {
          await acquireConnection(claimed, deadline, background);
          pooled = true;
          return deadline.wait(
            () => pool.connect(),
            late => late.release(true),
          );
        }),
      );
      return await observeWorkspaceConnection('hold', async () => {
        let destroy = false;
        const onError = () => undefined;
        client.on('error', onError);
        try {
          if (versions.deadlineAt !== undefined) {
            const remaining = Math.min(2_147_483_647, Math.max(1, versions.deadlineAt - Date.now()));
            await observeChatDetail('storage-settings', () =>
              deadline.wait(() =>
                client.query("SELECT set_config('transaction_timeout', $1, false)", [String(remaining)]),
              ),
            );
          }
          const result = await deadline.wait(() =>
            inTransaction(
              client,
              async connection => {
                const identity = z
                  .object({ session_user: z.string(), current_user: z.string() })
                  .parse(
                    (
                      await observeChatDetail('storage-identity', () =>
                        connection.query('SELECT session_user, current_user'),
                      )
                    ).rows[0],
                  );
                const names = workspaceNames(workspaceId);
                if (identity.session_user !== names.runtime || identity.current_user !== names.runtime)
                  throw new Error('Runtime login identity mismatch');
                await observeChatDetail('storage-fence', () =>
                  fenceWorkspaceAccess(connection, workspaceId, compatibility.access === 'exclusive'),
                );
                const version = z
                  .object({ version: z.number().int() })
                  .parse(
                    (
                      await observeChatDetail('storage-version', () =>
                        connection.query(
                          `SELECT count(*)::integer AS version FROM ${qualified(names.schema, commonTables.migrations)}`,
                        ),
                      )
                    ).rows[0],
                  ).version;
                if (version < versions.minimum || version > versions.maximum)
                  throw new StorageUnavailableError('incompatible_version');
                deadline.check();
                return observeChatDetail('storage-operation', () =>
                  operation({ client: connection, schema: names.schema, workspaceId, commonVersion: version }),
                );
              },
              { statementTimeoutMs: config.statementTimeoutMs },
            ),
          );
          await deadline.wait(() => resetClient(client));
          return result;
        } catch (error) {
          destroy = true;
          if (versions.deadlineAt !== undefined && error instanceof Error && 'code' in error && error.code === '25P04')
            throw new StorageUnavailableError('wait_timeout');
          throw error;
        } finally {
          client.release(destroy);
          client.removeListener('error', onError);
        }
      });
    } finally {
      try {
        if (entry) {
          if (pooled) releaseConnection(entry);
          releaseClaim(entry);
          if (!entry.claims && entry.retiring) {
            const removal = remove(entry);
            await deadline.wait(() => removal);
          }
        }
      } finally {
        if (admitted) releaseAdmission(background);
        deadline.dispose();
      }
    }
  }

  let shutdown: Promise<void> | undefined;
  function close() {
    if (shutdown) return shutdown;
    closed = true;
    clearInterval(eviction);
    for (const waiter of [...queue.splice(0), ...backgroundQueue.splice(0)])
      waiter.reject(new StorageUnavailableError('closed'));
    shutdown = (async () => {
      if (active)
        await new Promise<void>(resolve => {
          shutdownResolve = resolve;
        });
      await Promise.all([...entries.values()].map(remove));
      await Promise.all(closing);
    })();
    return shutdown;
  }

  return {
    transaction,
    close,
    stats: () => ({
      pools: entries.size,
      activeTransactions: active,
      activeBackgroundTransactions: activeBackground,
      queuedTransactions: queue.length + backgroundQueue.length,
      queuedBackgroundTransactions: backgroundQueue.length,
      connections: [...entries.values()].reduce((total, entry) => total + entry.pool.totalCount, 0),
    }),
  };
}
