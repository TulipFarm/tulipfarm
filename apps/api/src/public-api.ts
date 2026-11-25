import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { attachmentLimit } from '@tulipfarm/conversations/attachments';
import { bearerValue } from './access-token-secret.ts';
import type { AccessTokens, TokenPrincipal } from './access-tokens.ts';
import { createWindows } from './app-data-windows.ts';
import type { ExternalApi } from './external-api.ts';
import { ExternalApiError, problem, publicError, sendProblem, type Problem } from './public-errors.ts';
import {
  binaryBody,
  createRowsBody,
  createRowsResultJson,
  deleteRowBody,
  queryRowsBody,
  rowsPageJson,
  runAgentBody,
  updateRowBody,
} from './public-schemas.ts';

export { problem, publicError };

const principals = new WeakMap<FastifyRequest, TokenPrincipal>();

/** The token's principal for a request the bearer hook admitted. */
export function principalOf(request: FastifyRequest) {
  const principal = principals.get(request);
  if (!principal) throw new Error('Public request without an admitted token');
  return principal;
}

/** One request budget per token, shared by the REST API and the MCP server. */
export function createTokenLimiter(perMinute = 120) {
  return { perMinute, windows: createWindows({ max: perMinute, windowMs: 60_000 }) };
}
export type TokenLimiter = ReturnType<typeof createTokenLimiter>;

const authorizationHeaders = (request: FastifyRequest) => {
  let seen = 0;
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2)
    if (request.raw.rawHeaders[index]!.toLowerCase() === 'authorization') seen++;
  return seen;
};

/**
 * Admits a request only with a live TulipFarm access token in `Authorization: Bearer`. Cookies are never read here, and
 * a request that sends both is refused, so a browser session cannot be used through these routes and a token cannot
 * reach a session route. Each token shares one budget of `limiter.perMinute` requests a minute in this process.
 */
export function admitAccessTokens(
  routes: FastifyInstance,
  tokens: Pick<AccessTokens, 'authenticate'>,
  limiter: TokenLimiter,
  refuse: (reply: FastifyReply, status: number, body: Problem) => unknown = (reply, status, body) =>
    reply.code(status).send(body),
) {
  routes.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') return;
    const presented = bearerValue(request.headers.authorization);
    if (authorizationHeaders(request) > 1)
      return refuse(reply, 400, problem('ambiguous-credentials', 'Send one Authorization header.'));
    if (request.headers.cookie && presented)
      return refuse(reply, 400, problem('ambiguous-credentials', 'Send either a token or a session cookie, not both.'));
    if (!presented) {
      reply.header('WWW-Authenticate', 'Bearer realm="tulipfarm"');
      return refuse(
        reply,
        401,
        problem('invalid-token', 'Send a TulipFarm access token as "Authorization: Bearer tfp_…".'),
      );
    }
    const principal = await tokens.authenticate(presented);
    if (!principal) {
      reply.header('WWW-Authenticate', 'Bearer realm="tulipfarm", error="invalid_token"');
      return refuse(reply, 401, problem('invalid-token', 'This token is not valid, has expired or was revoked.'));
    }
    const wait = limiter.windows.spend(principal.tokenId);
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      reply.header('Retry-After', String(seconds));
      return refuse(
        reply,
        429,
        problem(
          'rate-limit-exceeded',
          `Each token may make ${limiter.perMinute} requests a minute across the REST API and MCP. ` +
            `Retry in ${seconds} s.`,
        ),
      );
    }
    const params = request.params as { workspaceId?: unknown } | undefined;
    // A token for one workspace sees nothing of another, not even that it exists.
    if (typeof params?.workspaceId === 'string' && params.workspaceId.toLowerCase() !== principal.workspaceId)
      return refuse(reply, 404, problem('not-found', 'This token belongs to a different workspace.'));
    principals.set(request, principal);
  });
}

const errorJson = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' } },
      required: ['code'],
    },
  },
  required: ['error'],
};
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 413, 415, 429, 500, 503].map(status => [status, errorJson]),
);
const json = (description: string) => ({ description, type: 'object', additionalProperties: true });
const tags = ['Public API'];
const uuid = { type: 'string', format: 'uuid' };
const params = (...names: string[]) => ({
  type: 'object',
  properties: Object.fromEntries(['workspaceId', ...names].map(name => [name, uuid])),
  required: ['workspaceId', ...names],
});
const idempotencyDescription =
  'Any unique printable ASCII string up to 255 characters. Retrying with the same key and the same request is ' +
  'safe and returns the original result; the same key with a different request returns 409 idempotency-conflict.';
const idempotencyHeader = {
  type: 'object',
  properties: {
    'idempotency-key': { type: 'string', minLength: 1, maxLength: 255, description: idempotencyDescription },
  },
  required: ['idempotency-key'],
};
const security = [{ accessToken: [] }];
const doc = (operationId: string, summary: string, extra: Record<string, unknown> = {}) => ({
  operationId,
  summary,
  tags,
  security,
  ...extra,
});

/**
 * `/v1/public/workspaces/:workspaceId/…`: the stable REST API for outside tools. It is a thin adapter over
 * {@link ExternalApi}; the same calls back the MCP server.
 */
export function registerPublicApi(
  app: FastifyInstance,
  dependencies: { tokens: Pick<AccessTokens, 'authenticate'>; api: ExternalApi; limiter: TokenLimiter },
) {
  const { api } = dependencies;
  app.register(async routes => {
    admitAccessTokens(routes, dependencies.tokens, dependencies.limiter);
    routes.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) =>
      done(null, body),
    );
    // The schemas document requests; the Zod schemas in external-api.ts validate them, so the two cannot disagree.
    routes.setValidatorCompiler(() => () => true);
    routes.setErrorHandler((error, request, reply: FastifyReply) => {
      const mapped = publicError(error);
      if (mapped) return sendProblem(reply, mapped);
      request.log.error({ err: error }, 'Public API request failed');
      return reply.code(500).send(problem('internal-server-error'));
    });
    routes.setNotFoundHandler((_request, reply) =>
      reply.code(404).send(problem('not-found', 'No such endpoint. The Public API is described at /v1/docs.')),
    );
    const key = (request: FastifyRequest) => {
      const value = request.headers['idempotency-key'];
      if (typeof value !== 'string' || !value)
        throw new ExternalApiError(400, 'idempotency-key-required', 'Send an Idempotency-Key header with every write.');
      return value;
    };
    const id = (request: FastifyRequest, name: string) => {
      const value = (request.params as Record<string, string>)[name]!;
      if (!z.uuid().safeParse(value).success)
        throw new ExternalApiError(400, 'invalid-request', `${name} must be a UUID.`);
      return value;
    };
    const base = '/workspaces/:workspaceId';

    routes.get(
      `${base}/tables`,
      {
        schema: doc('publicListTablesV1', 'List the tables this token can read', {
          params: params(),
          querystring: {
            type: 'object',
            properties: {
              after: { type: 'string', maxLength: 40 },
              search: { type: 'string', maxLength: 255 },
              limit: { type: 'integer', minimum: 1, maximum: 100 },
            },
          },
          response: { 200: json('Tables and the next cursor'), ...errors },
        }),
      },
      request =>
        api.listTables(
          principalOf(request),
          z
            .object({
              after: z.uuid('expected the nextCursor from the previous page').optional(),
              search: z.string().max(255).optional(),
              limit: z.coerce.number().int().min(1).max(100).optional(),
            })
            .parse(request.query),
        ),
    );
    routes.get(
      `${base}/tables/:tableId`,
      {
        schema: doc('publicDescribeTableV1', "Read a table's fields and current revision", {
          params: params('tableId'),
          response: { 200: json('The table definition and revision'), ...errors },
        }),
      },
      request => api.describeTable(principalOf(request), id(request, 'tableId')),
    );
    routes.post(
      `${base}/tables/:tableId/rows/query`,
      {
        schema: doc(
          'publicQueryRowsV1',
          'List rows with optional filters, search, sort and cursor (`after`), up to 100 at a time',
          {
            params: params('tableId'),
            body: queryRowsBody,
            response: { 200: rowsPageJson, ...errors },
          },
        ),
      },
      request => api.queryRows(principalOf(request), id(request, 'tableId'), request.body),
    );
    routes.get(
      `${base}/tables/:tableId/rows`,
      {
        schema: doc('publicListRowsV1', 'List rows in id order. Use `after` with the previous `nextCursor`', {
          params: params('tableId'),
          querystring: {
            type: 'object',
            properties: { after: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
          },
          response: { 200: rowsPageJson, ...errors },
        }),
      },
      request => {
        const query = z
          .object({ after: z.string().max(400).optional(), limit: z.coerce.number().int().min(1).max(100).optional() })
          .parse(request.query);
        return api.queryRows(principalOf(request), id(request, 'tableId'), query);
      },
    );
    routes.get(
      `${base}/tables/:tableId/rows/:rowId`,
      {
        schema: doc('publicGetRowV1', 'Read one row with its values and current token', {
          params: params('tableId', 'rowId'),
          response: { 200: json('The row'), ...errors },
        }),
      },
      request => api.getRow(principalOf(request), id(request, 'tableId'), id(request, 'rowId')),
    );
    routes.post(
      `${base}/tables/:tableId/rows`,
      {
        schema: doc(
          'publicCreateRowsV1',
          'Create 1–100 rows. Each row may name its own UUID. Retrying with the same Idempotency-Key is safe',
          {
            params: params('tableId'),
            headers: idempotencyHeader,
            body: createRowsBody,
            response: { 200: createRowsResultJson, ...errors },
          },
        ),
      },
      request => api.createRows(principalOf(request), id(request, 'tableId'), key(request), request.body),
    );
    routes.patch(
      `${base}/tables/:tableId/rows/:rowId`,
      {
        schema: doc('publicUpdateRowV1', "Update a row's values. `expectedToken` must be the row's current token", {
          params: params('tableId', 'rowId'),
          headers: idempotencyHeader,
          body: updateRowBody,
          response: { 200: json('The updated row, with its new token'), ...errors },
        }),
      },
      request =>
        api.updateRow(principalOf(request), id(request, 'tableId'), id(request, 'rowId'), key(request), request.body),
    );
    routes.delete(
      `${base}/tables/:tableId/rows/:rowId`,
      {
        schema: doc('publicDeleteRowV1', 'Delete a row. `expectedToken` must be the row’s current token', {
          params: params('tableId', 'rowId'),
          headers: idempotencyHeader,
          body: deleteRowBody,
          response: { 200: json('The deleted row id and token'), ...errors },
        }),
      },
      request =>
        api.deleteRow(principalOf(request), id(request, 'tableId'), id(request, 'rowId'), key(request), request.body),
    );
    routes.get(
      `${base}/tables/:tableId/requests`,
      {
        schema: doc(
          'publicRowRequestStatusV1',
          'Check whether an earlier write was applied. `unknown` means not confirmed, not failed',
          {
            params: params('tableId'),
            querystring: {
              type: 'object',
              properties: {
                key: { type: 'string', minLength: 1, maxLength: 255 },
                kind: { type: 'string', enum: ['create', 'update', 'delete'] },
                index: { type: 'integer', minimum: 0, maximum: 99 },
              },
              required: ['key', 'kind'],
            },
            response: { 200: json('unknown, or applied with the result'), ...errors },
          },
        ),
      },
      request =>
        api.requestStatus(
          principalOf(request),
          id(request, 'tableId'),
          z
            .object({
              key: z.string(),
              kind: z.enum(['create', 'update', 'delete']),
              index: z.coerce.number().int().min(0).max(99).optional(),
            })
            .parse(request.query),
        ),
    );

    routes.get(
      `${base}/files`,
      {
        schema: doc('publicListFilesV1', 'List files and folders in a folder (the top level by default)', {
          params: params(),
          querystring: {
            type: 'object',
            properties: { parentId: uuid, query: { type: 'string', maxLength: 255 }, after: uuid },
          },
          response: { 200: json('Files and the next cursor'), ...errors },
        }),
      },
      request =>
        api.listFiles(
          principalOf(request),
          z
            .object({
              parentId: z.uuid().optional(),
              query: z.string().max(255).optional(),
              after: z.uuid().optional(),
            })
            .parse(request.query),
        ),
    );
    routes.get(
      `${base}/files/:fileId`,
      {
        schema: doc('publicGetFileV1', "Read a file's details", {
          params: params('fileId'),
          response: { 200: json('The file details'), ...errors },
        }),
      },
      request => api.getFile(principalOf(request), id(request, 'fileId')),
    );
    routes.get(
      `${base}/files/:fileId/content`,
      {
        schema: doc('publicDownloadFileV1', "Download a file's bytes, with the file's media type", {
          params: params('fileId'),
          produces: ['application/octet-stream', '*/*'],
          response: { 200: { description: 'The file bytes', type: 'string', format: 'binary' }, ...errors },
        }),
      },
      async (request, reply) => {
        const reader = new AbortController();
        reply.raw.once('close', () => {
          if (!reply.raw.writableFinished) reader.abort();
        });
        const result = await api.downloadFile(principalOf(request), id(request, 'fileId'), reader.signal);
        const filename = encodeURIComponent(result.name).replaceAll("'", '%27');
        const fallback = result.name.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'file';
        const mediaType = /^[\w.+-]+\/[\w.+-]+$/.test(result.mediaType ?? '')
          ? result.mediaType!
          : 'application/octet-stream';
        return reply
          .header('X-Content-Type-Options', 'nosniff')
          .header('Content-Security-Policy', "default-src 'none'; sandbox")
          .header('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${filename}`)
          .type(mediaType)
          .send(Buffer.from(result.bytes));
      },
    );
    routes.post(
      `${base}/files`,
      {
        bodyLimit: attachmentLimit,
        schema: doc(
          'publicUploadFileV1',
          'Upload a file (raw bytes, `application/octet-stream`, up to 10 MiB). Name and type go in the query',
          {
            params: params(),
            headers: idempotencyHeader,
            consumes: ['application/octet-stream'],
            body: binaryBody,
            querystring: {
              type: 'object',
              properties: {
                name: { type: 'string', minLength: 1, maxLength: 255 },
                mediaType: { type: 'string', maxLength: 127 },
                parentId: uuid,
              },
              required: ['name', 'mediaType'],
            },
            response: { 201: json('The new file details'), ...errors },
          },
        ),
      },
      async (request, reply) => {
        if (!Buffer.isBuffer(request.body))
          throw new ExternalApiError(400, 'invalid-request', 'Send the file bytes as application/octet-stream.');
        const input = z
          .object({ name: z.string(), mediaType: z.string(), parentId: z.uuid().optional() })
          .parse(request.query);
        const sender = new AbortController();
        reply.raw.once('close', () => {
          if (!reply.raw.writableFinished) sender.abort();
        });
        return reply
          .code(201)
          .send(await api.uploadFile(principalOf(request), key(request), input, request.body, sender.signal));
      },
    );

    routes.get(
      `${base}/agents`,
      {
        schema: doc('publicListAgentsV1', 'List the agents this token’s member can run', {
          params: params(),
          querystring: { type: 'object', properties: { after: uuid, search: { type: 'string', maxLength: 120 } } },
          response: { 200: json('Agents and the next cursor'), ...errors },
        }),
      },
      request =>
        api.listAgents(
          principalOf(request),
          z.object({ after: z.uuid().optional(), search: z.string().max(120).optional() }).parse(request.query),
        ),
    );
    routes.post(
      `${base}/agents/:agentId/tasks`,
      {
        schema: doc(
          'publicRunAgentV1',
          'Start a task for an agent. It runs with the agent’s own approvals and spends workspace credits',
          {
            params: params('agentId'),
            headers: idempotencyHeader,
            body: runAgentBody,
            response: { 202: json('The queued task'), ...errors },
          },
        ),
      },
      async (request, reply) =>
        reply
          .code(202)
          .send(await api.runAgent(principalOf(request), id(request, 'agentId'), key(request), request.body)),
    );
    routes.get(
      `${base}/tasks/:taskId`,
      {
        schema: doc(
          'publicGetTaskV1',
          'Read a task’s status and latest reply. `wait` (0–60 s) waits while it is still pending',
          {
            params: params('taskId'),
            querystring: { type: 'object', properties: { wait: { type: 'integer', minimum: 0, maximum: 60 } } },
            response: { 200: json('The task status and latest reply'), ...errors },
          },
        ),
      },
      async (request, reply) => {
        const { wait } = z.object({ wait: z.coerce.number().int().min(0).max(60).default(0) }).parse(request.query);
        const closed = new AbortController();
        reply.raw.once('close', () => closed.abort());
        return api.task(principalOf(request), id(request, 'taskId'), wait, closed.signal);
      },
    );
  });
}
