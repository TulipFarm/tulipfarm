import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createAgentTasks } from '@tulipfarm/agents/tasks';
import { createSavedAgentService } from '@tulipfarm/agents/saved-service';
import { humanReadableTableFiles } from '@tulipfarm/agents/table-sources';
import { recordQuerySchema, valuesSchema } from '@tulipfarm/tables/definition';
import { executionCompatibility } from '@tulipfarm/tables/execution';
import { createTableService } from '@tulipfarm/tables/service';
import type { createFiles } from '@tulipfarm/files';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import type { AccessTokenScope } from './access-token-secret.ts';
import type { TokenPrincipal } from './access-tokens.ts';
import { ExternalApiError, publicError } from './public-errors.ts';
import { createRecordRequests } from './table-record-requests.ts';

export { ExternalApiError };

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, 'printable ASCII without spaces');
const rowIdSchema = z.uuid();
export const createRowsSchema = z.strictObject({
  rows: z
    .array(z.strictObject({ id: rowIdSchema.optional(), values: valuesSchema }))
    .min(1)
    .max(100),
});
export const updateRowSchema = z.strictObject({ expectedToken: z.uuid(), values: valuesSchema });
export const deleteRowSchema = z.strictObject({ expectedToken: z.uuid() });
export const queryRowsSchema = recordQuerySchema;
export const runAgentSchema = z.strictObject({ text: z.string().trim().min(1).max(8000) });

/**
 * A stable UUID for one part of one client request. Retrying with the same idempotency key gives the same request
 * IDs, and so the same receipts, and also the same row IDs for rows the client did not name. IDs that outlive the
 * request (rows, files, tasks) include the member, so two members who happen to pick the same key never collide.
 */
export function derivedId(...parts: string[]) {
  const hex = createHash('sha256')
    .update(JSON.stringify(['tulipfarm-public-v1', ...parts]))
    .digest('hex');
  // RFC 9562 version 8 (custom) with the RFC variant bits.
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Postgres `timestamptz` text or an ISO string, as ISO 8601. */
function iso(value: string) {
  const parsed = Date.parse(value.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}
const count = (value: unknown) => (value === null || value === undefined ? null : Number(value));

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

/**
 * What a token can do, shared by the REST routes and the MCP tools so the two cannot drift. Every method acts as the
 * token's member through the same services the web app uses; this layer adds only the token's scopes and table list.
 */
export function createExternalApi(dependencies: {
  runtime: WorkspaceRuntime;
  files: ReturnType<typeof createFiles> | null;
  wakeTask: (workspaceId: string, taskId: string) => Promise<void>;
  claimMcpSelection?: Parameters<typeof createAgentTasks>[1];
  /** The web app's origin, for links a person opens to approve or follow a task. */
  appOrigin: string;
  workspaceSlug: (workspaceId: string) => Promise<string | null>;
}) {
  const { runtime } = dependencies;
  const tables = createTableService(runtime, { readableFiles: humanReadableTableFiles }, executionCompatibility);
  const recordRequests = createRecordRequests(runtime);
  const agents = createSavedAgentService(runtime);
  const tasks = createAgentTasks(runtime, dependencies.claimMcpSelection);

  const scope = (principal: TokenPrincipal, needed: AccessTokenScope) => {
    if (!principal.scopes.has(needed))
      throw new ExternalApiError(403, 'insufficient-scope', `This token needs the ${needed} scope.`);
  };
  const tableAllowed = (principal: TokenPrincipal, tableId: string) =>
    principal.tableIds === null || principal.tableIds.has(tableId.toLowerCase());
  const table = (principal: TokenPrincipal, tableId: string) => {
    if (!rowIdSchema.safeParse(tableId).success || !tableAllowed(principal, tableId))
      throw new ExternalApiError(404, 'not-found');
    return tableId.toLowerCase();
  };
  const files = () => {
    if (!dependencies.files) throw new ExternalApiError(404, 'files-unavailable');
    return dependencies.files;
  };
  const revision = async (principal: TokenPrincipal, tableId: string) =>
    (await tables.describe(principal.workspaceId, principal.userId, { tableId })).revision;

  /**
   * A task's status and its latest agent message. With `waitSeconds`, waits up to that long (at most 60) while the
   * task is still pending. A task that needs approval stops at `waiting-approval`; only a person in the app can
   * approve it, so the result links there.
   */
  async function task(principal: TokenPrincipal, taskId: string, waitSeconds = 0, signal?: AbortSignal) {
    scope(principal, 'agents:run');
    const id = rowIdSchema.parse(taskId);
    const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), 60) * 1000;
    let summary = await tasks.read(principal.workspaceId, principal.userId, id);
    while (summary.status === 'pending' && Date.now() < deadline && !signal?.aborted) {
      await sleep(Math.min(1000, deadline - Date.now()), signal);
      summary = await tasks.read(principal.workspaceId, principal.userId, id);
    }
    let reply: string | null = null;
    for (let after = -1, pages = 0; pages < 20; pages++) {
      const history = await tasks.history(principal.workspaceId, principal.userId, id, { after, limit: 100 });
      reply = history.messages.filter(message => message.role === 'agent').at(-1)?.text ?? reply;
      if (history.nextCursor === null) break;
      after = history.nextCursor;
    }
    const slug = await dependencies.workspaceSlug(principal.workspaceId);
    return {
      id: summary.id,
      agentId: summary.agentId,
      status: summary.status,
      pauseReason: summary.pauseReason ?? null,
      failureReason: summary.failureReason ?? null,
      reply,
      createdAt: iso(summary.createdAt),
      creditsCharged: count(summary.cost.chargedCreditUnits),
      appUrl: slug ? `${dependencies.appOrigin}/${slug}/agent-tasks/${summary.id}` : null,
    };
  }

  return {
    scope,

    async listTables(
      principal: TokenPrincipal,
      input: { after?: string | undefined; search?: string | undefined; limit?: number | undefined },
    ) {
      scope(principal, 'tables:read');
      const page = await tables.definitions(principal.workspaceId, principal.userId, {
        ...(input.after ? { after: input.after } : {}),
        ...(input.search ? { search: input.search } : {}),
        limit: input.limit ?? 50,
      });
      return {
        tables: page.tables
          .filter(entry => tableAllowed(principal, entry.id))
          .map(entry => ({
            id: entry.id,
            name: entry.definition.label,
            revision: entry.revision,
            rowCount: count(entry.recordCount),
          })),
        nextCursor: page.nextCursor,
      };
    },

    async describeTable(principal: TokenPrincipal, tableId: string) {
      scope(principal, 'tables:read');
      const described = await tables.describe(principal.workspaceId, principal.userId, {
        tableId: table(principal, tableId),
      });
      return { id: described.id, revision: described.revision, definition: described.definition };
    },

    async queryRows(principal: TokenPrincipal, tableId: string, query: unknown) {
      scope(principal, 'tables:read');
      const id = table(principal, tableId);
      const parsed = queryRowsSchema.parse(query ?? {});
      const page = await tables.listPage(principal.workspaceId, principal.userId, {
        tableId: id,
        revision: await revision(principal, id),
        query: parsed,
      });
      return { rows: page.records, total: count(page.total), nextCursor: page.nextCursor };
    },

    async getRow(principal: TokenPrincipal, tableId: string, rowId: string) {
      scope(principal, 'tables:read');
      const id = table(principal, tableId);
      const recordId = rowIdSchema.parse(rowId);
      const row = await tables.read(principal.workspaceId, principal.userId, {
        tableId: id,
        revision: await revision(principal, id),
        recordId,
      });
      if (!row) throw new ExternalApiError(404, 'not-found');
      return row;
    },

    /**
     * Creates up to 100 rows, each as its own idempotent request, so a retry with the same key replays every row
     * that was written and writes only the ones that were not. A row's outcome never depends on the others, except
     * that reusing a key for different rows is refused as a whole: rows are written in order, so the first row that
     * differs from the earlier request comes before any row that request did not have, and nothing new is written.
     */
    async createRows(principal: TokenPrincipal, tableId: string, key: string, input: unknown) {
      scope(principal, 'tables:write');
      const id = table(principal, tableId);
      const idempotencyKey = idempotencyKeySchema.parse(key);
      const { rows } = createRowsSchema.parse(input);
      const current = await revision(principal, id);
      const results = [];
      for (const [index, row] of rows.entries()) {
        const requestId = derivedId('create', id, idempotencyKey, String(index));
        const recordId = row.id ?? derivedId('row', principal.userId, id, idempotencyKey, String(index));
        try {
          const result = await recordRequests.mutate(principal.workspaceId, principal.userId, {
            requestId,
            mutation: { kind: 'create', tableId: id, revision: current, recordId, values: row.values },
          });
          results.push({ status: 'created' as const, row: result });
        } catch (error) {
          if ((error as { code?: unknown } | null)?.code === 'idempotency-conflict')
            throw new ExternalApiError(
              409,
              'idempotency-conflict',
              `Row ${index} differs from the earlier request with this Idempotency-Key. Reuse a key only to retry ` +
                'the identical request; use a new key for new rows.',
            );
          results.push({ status: 'failed' as const, id: recordId, error: rowError(error) });
        }
      }
      return { results };
    },

    async updateRow(principal: TokenPrincipal, tableId: string, rowId: string, key: string, input: unknown) {
      scope(principal, 'tables:write');
      const id = table(principal, tableId);
      const recordId = rowIdSchema.parse(rowId);
      const body = updateRowSchema.parse(input);
      return recordRequests.mutate(principal.workspaceId, principal.userId, {
        requestId: derivedId('update', id, idempotencyKeySchema.parse(key)),
        mutation: {
          kind: 'update',
          tableId: id,
          revision: await revision(principal, id),
          recordId,
          expectedToken: body.expectedToken,
          values: body.values,
        },
      });
    },

    async deleteRow(principal: TokenPrincipal, tableId: string, rowId: string, key: string, input: unknown) {
      scope(principal, 'tables:write');
      const id = table(principal, tableId);
      const recordId = rowIdSchema.parse(rowId);
      const body = deleteRowSchema.parse(input);
      return recordRequests.mutate(principal.workspaceId, principal.userId, {
        requestId: derivedId('delete', id, idempotencyKeySchema.parse(key)),
        mutation: {
          kind: 'delete',
          tableId: id,
          revision: await revision(principal, id),
          recordId,
          expectedToken: body.expectedToken,
        },
      });
    },

    /** Whether an earlier write with this key was applied. `index` names one row of a create. */
    async requestStatus(
      principal: TokenPrincipal,
      tableId: string,
      input: { key: string; kind: 'create' | 'update' | 'delete'; index?: number | undefined },
    ) {
      scope(principal, 'tables:write');
      const id = table(principal, tableId);
      const key = idempotencyKeySchema.parse(input.key);
      const parts = input.kind === 'create' ? ['create', id, key, String(input.index ?? 0)] : [input.kind, id, key];
      return recordRequests.status(principal.workspaceId, principal.userId, id, derivedId(...parts));
    },

    async listFiles(
      principal: TokenPrincipal,
      input: { parentId?: string | null | undefined; query?: string | undefined; after?: string | undefined },
    ) {
      scope(principal, 'files:read');
      const { next, ...page } = await files().list(principal.workspaceId, principal.userId, {
        parentId: input.parentId ?? null,
        query: input.query ?? '',
        trash: false,
        ...(input.after ? { after: input.after } : {}),
      });
      return { ...page, nextCursor: next };
    },

    async getFile(principal: TokenPrincipal, fileId: string) {
      scope(principal, 'files:read');
      return files().read(principal.workspaceId, principal.userId, rowIdSchema.parse(fileId));
    },

    async downloadFile(principal: TokenPrincipal, fileId: string, signal: AbortSignal) {
      scope(principal, 'files:read');
      return files().download(principal.workspaceId, principal.userId, rowIdSchema.parse(fileId), signal);
    },

    /** Uploads a new file. The ID comes from the idempotency key, so a retried upload cannot make a second copy. */
    async uploadFile(
      principal: TokenPrincipal,
      key: string,
      input: { name: string; mediaType: string; parentId?: string | null | undefined },
      bytes: Buffer,
      signal: AbortSignal,
    ) {
      scope(principal, 'files:write');
      if (bytes.length === 0)
        throw new ExternalApiError(400, 'empty-file', 'The file is empty. Send 1 byte to 10 MiB.');
      const fileId = derivedId('file', principal.userId, idempotencyKeySchema.parse(key));
      return files().upload(
        principal.workspaceId,
        principal.userId,
        fileId,
        { name: input.name, mediaType: input.mediaType, parentId: input.parentId ?? null },
        bytes,
        signal,
      );
    },

    async listAgents(principal: TokenPrincipal, input: { after?: string | undefined; search?: string | undefined }) {
      scope(principal, 'agents:run');
      const page = await agents.list(principal.workspaceId, principal.userId, {
        ...(input.after ? { after: input.after } : {}),
        ...(input.search ? { search: input.search } : {}),
        limit: 50,
      });
      return { agents: page.agents.map(agent => ({ id: agent.id, name: agent.name })), nextCursor: page.nextCursor };
    },

    /** Queues a task for an agent, as the token's member and paid from the workspace's credits. */
    async runAgent(principal: TokenPrincipal, agentId: string, key: string, input: unknown) {
      scope(principal, 'agents:run');
      const { text } = runAgentSchema.parse(input);
      const id = rowIdSchema.parse(agentId);
      const receipt = await tasks.start(principal.workspaceId, principal.userId, {
        requestId: derivedId('task', principal.userId, id, idempotencyKeySchema.parse(key)),
        agentId: id,
        text,
      });
      await dependencies.wakeTask(principal.workspaceId, receipt.id);
      return task(principal, receipt.id, 0);
    },

    task,
  };
}
export type ExternalApi = ReturnType<typeof createExternalApi>;

/**
 * A failed row's code, message and field. Only errors this API maps are described; anything else is a bare
 * `write-failed`, so no detail that could carry another row's data reaches the caller.
 */
function rowError(error: unknown) {
  const mapped = publicError(error);
  return mapped && mapped.status < 500
    ? mapped.body.error
    : { code: 'write-failed', message: 'This row could not be written.' };
}
