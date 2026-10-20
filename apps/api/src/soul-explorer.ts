import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  resolveHuman,
  requireTablePermission,
  SourceAuthorizationUnavailable,
} from '@tulipfarm/access';
import { requireAgentPermission } from '@tulipfarm/agents/saved-service';
import { isFeatureEnabled } from '@tulipfarm/observability';
import { qualified, StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { commonCompatibility, type WorkspaceStore } from '@tulipfarm/workspaces/storage';
import {
  readSoulFile,
  readSoulRepository,
  readSoulTree,
  type SoulExplorerSnapshot,
} from '@tulipfarm/workspaces/soul-explorer';
import {
  SoulExplorerError,
  soulFileQuerySchema,
  soulFileSchema,
  soulRepositorySchema,
  soulRevisionSchema,
  soulTreeQuerySchema,
  soulTreeSchema,
} from '@tulipfarm/workspaces/soul-explorer-contracts';
import { soulStorageConfig } from '@tulipfarm/workspaces/soul';
import type { SoulStorage } from '@tulipfarm/workspaces/soul-revisions';
import { tableNamesSchema } from '@tulipfarm/tables/names';
import { tableIdSchema } from '@tulipfarm/tables/definition';
import { tableIdentityStorageReady } from '@tulipfarm/tables/identities';
import { authenticateRoutes } from './authenticated-routes.ts';
import { authConfig, type registerAuth } from './auth.ts';
import { requestBoundaryError } from './security.ts';

const workspaceSchema = z.object({
  id: z.uuid(),
  created_by: z.uuid(),
  created_at: z.date(),
  name: z.string(),
  email: z.string(),
  soul_commit: soulRevisionSchema.nullable(),
  soul_bucket: z.string().nullable(),
  soul_key: z.string().nullable(),
});
const projectionSchema = z.object({
  workspaceId: z.uuid(),
  kind: z.enum(['table', 'agent']),
  id: z.uuid(),
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  tableNames: tableNamesSchema.optional(),
});
type Eligibility = (workspace: z.infer<typeof workspaceSchema>, userId: string) => Promise<boolean>;
type Store = { pool: Pick<Pool, 'query'>; runtime: WorkspaceStore['runtime'] };

export function createSoulExplorerService(store: Store, storage: () => SoulStorage, enabled: Eligibility) {
  async function snapshot(workspaceId: string, userId: string): Promise<SoulExplorerSnapshot> {
    return store.runtime.transaction(workspaceId, commonCompatibility, async tx => {
      await lockAuthorization(tx, 'read');
      const actor = await resolveHuman(tx, userId);
      if ((await currentMember(tx, actor)).role !== 'admin') throw new AccessDenied();
      const raw = (
        await store.pool.query(
          `SELECT w.id,w.created_by,w.created_at,w.name,w.soul_commit,w.soul_bucket,w.soul_key,u.email
        FROM app.workspaces w JOIN app.workspace_storage s ON s.workspace_id=w.id AND s.stage='ready'
        JOIN app.users u ON u.id=$2 WHERE w.id=$1`,
          [workspaceId, userId],
        )
      ).rows[0];
      if (!raw) throw new AccessDenied();
      const workspace = workspaceSchema.parse(raw);
      if (!(await enabled(workspace, userId))) throw new AccessDenied();
      const table = (name: string) => qualified(tx.schema, name);
      const head = z
        .object({ revision: soulRevisionSchema.nullable() })
        .parse((await tx.client.query(`SELECT revision FROM ${table('tf_soul_head')} WHERE id=1`)).rows[0]).revision;
      if (!head || !workspace.soul_bucket || !workspace.soul_key || !workspace.soul_commit)
        throw new SoulExplorerError('soul-not-ready', 503);
      const receipt = z
        .object({ bundle_key: z.string(), bundle_sha256: z.string().regex(/^[a-f0-9]{64}$/) })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT bundle_key,bundle_sha256 FROM ${table('tf_soul_revisions')} WHERE revision=$1`,
              [head],
            )
          ).rows[0],
        );
      if (!receipt && head !== workspace.soul_commit) throw new SoulExplorerError('soul-unavailable', 503);
      const files = new Map<string, string>();
      const named = await tableIdentityStorageReady(tx);
      const candidates = z
        .array(
          z.object({
            id: z.uuid(),
            kind: z.enum(['table', 'agent']),
            projection: z.unknown(),
            table_name: z.string().nullable(),
          }),
        )
        .parse(
          (
            await tx.client.query(`
        SELECT a.id,'agent' AS kind,s.projection,NULL::text AS table_name FROM ${table('tf_agents')} a
          JOIN ${table('tf_agent_saved_revisions')} s ON s.agent_id=a.id AND s.soul_revision=a.saved_revision
          WHERE a.deleted_at IS NULL
        UNION ALL
        SELECT saved.id,'table' AS kind,saved.projection,saved.table_name FROM (
          SELECT DISTINCT ON (e.table_id) e.table_id AS id,${named ? 'COALESCE(f.projection,e.projection)' : 'e.projection'} AS projection,
            ${named ? 'n.name' : 'NULL::text'} AS table_name
          FROM ${table('tf_table_executions')} e
          JOIN ${table('tf_soul_revisions')} r ON r.revision=e.revision
          LEFT JOIN ${table('tf_table_catalog')} c ON c.id=e.table_id
          ${
            named
              ? `LEFT JOIN ${table('tf_table_soul_files')} f ON f.table_id=e.table_id
          LEFT JOIN ${table('tf_table_names')} n ON n.table_id=e.table_id`
              : ''
          }
          WHERE e.projection IS NOT NULL AND (c.target_revision=e.revision OR c.id IS NULL)
          ORDER BY e.table_id,r.accepted_at DESC,r.revision DESC
        ) saved
        LIMIT 10001`)
          ).rows,
        );
      if (candidates.length > 10000) throw new SoulExplorerError('soul-unavailable', 503);
      for (const candidate of candidates) {
        try {
          if (candidate.kind === 'agent') await requireAgentPermission(tx, actor, candidate.id, 'read');
          else await requireTablePermission(tx, actor, candidate.id, 'table.schema.manage');
        } catch (error) {
          if (error instanceof AccessDenied) continue;
          throw error;
        }
        const projection = projectionSchema.parse(candidate.projection);
        const name = projection.tableNames?.[tableIdSchema.parse(candidate.id)];
        if (projection.tableNames && (candidate.kind !== 'table' || !name || name !== candidate.table_name))
          throw new SoulExplorerError('soul-unavailable', 503);
        const path = `${candidate.kind === 'agent' ? 'agents' : 'tables'}/${name ?? candidate.id}.json`;
        if (
          projection.workspaceId !== workspaceId ||
          projection.id !== candidate.id ||
          projection.kind !== candidate.kind ||
          projection.path !== path
        ) {
          throw new SoulExplorerError('soul-unavailable', 503);
        }
        try {
          for (const id of Object.keys(projection.tableNames ?? {})) {
            if (id !== candidate.id) await requireTablePermission(tx, actor, id, 'table.row.read');
          }
        } catch (error) {
          if (error instanceof AccessDenied) continue;
          throw error;
        }
        files.set(path, projection.sha256);
      }
      return {
        seed: { workspaceId, createdBy: workspace.created_by, createdAt: workspace.created_at.toISOString() },
        pointer: receipt
          ? { commit: head, bucket: workspace.soul_bucket, key: receipt.bundle_key, sha256: receipt.bundle_sha256 }
          : { commit: head, bucket: workspace.soul_bucket, key: workspace.soul_key },
        files,
      };
    });
  }
  let active = 0;
  async function read<T>(
    workspaceId: string,
    userId: string,
    operation: (storage: SoulStorage, selected: SoulExplorerSnapshot) => Promise<T>,
  ) {
    if (active >= 2) throw new SoulExplorerError('soul-unavailable', 503);
    active++;
    try {
      const selected = await snapshot(workspaceId, userId);
      const result = await operation(storage(), selected);
      const current = await snapshot(workspaceId, userId);
      if (current.pointer.commit !== selected.pointer.commit) throw new SoulExplorerError('soul-revision-changed', 409);
      if (
        current.files.size !== selected.files.size ||
        [...selected.files].some(([path, digest]) => current.files.get(path) !== digest)
      ) {
        throw new SoulExplorerError('soul-revision-changed', 409);
      }
      return result;
    } finally {
      active--;
    }
  }
  return {
    repository: (workspaceId: string, userId: string) => read(workspaceId, userId, readSoulRepository),
    tree: (workspaceId: string, userId: string, input: z.input<typeof soulTreeQuerySchema>) =>
      read(workspaceId, userId, (storage, selected) => readSoulTree(storage, selected, input)),
    file: (workspaceId: string, userId: string, input: z.input<typeof soulFileQuerySchema>) =>
      read(workspaceId, userId, (storage, selected) => readSoulFile(storage, selected, input)),
  };
}

export function registerSoulExplorer(
  app: FastifyInstance,
  dependencies: Store & {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    storage?: SoulStorage;
    enabled?: Eligibility;
  },
) {
  let storage = dependencies.storage;
  const service = createSoulExplorerService(
    dependencies,
    () => (storage ??= soulStorageConfig('read')),
    dependencies.enabled ??
      ((workspace, userId) =>
        isFeatureEnabled(
          'soul-repository-explorer',
          { id: userId, email: workspace.email },
          { id: workspace.id, name: workspace.name },
        )),
  );
  app.addHook('onClose', async () => {
    storage?.client.destroy();
  });
  app.register(async routes => {
    const user = authenticateRoutes(routes, dependencies.auth, {
      origin: () => authConfig().webOrigin,
      userSchema: z.uuid(),
    });
    routes.setErrorHandler((error, request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'soul-not-found' });
      if (error instanceof SoulExplorerError && error.status !== 503)
        return reply.code(error.status).send({ error: error.code });
      if (typeof error === 'object' && error !== null && 'validation' in error)
        return reply.code(400).send({ error: 'invalid-request' });
      const code = error instanceof SoulExplorerError ? error.code : 'soul-unavailable';
      const dependency =
        error instanceof StorageUnavailableError
          ? 'workspace-storage'
          : error instanceof SourceAuthorizationUnavailable
            ? 'source-authorization'
            : 'soul';
      app.log.error({ requestId: request.id, code, dependency }, 'Soul repository read failed');
      return reply.code(503).send({ error: code });
    });
    const params = z.object({ workspaceId: z.uuid() });
    const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'openapi-3.0', io: 'input' });
    const errorResponse = json(z.object({ error: z.string() }));
    const errors = {
      400: errorResponse,
      401: errorResponse,
      403: errorResponse,
      404: errorResponse,
      409: errorResponse,
      503: errorResponse,
    };
    const base = '/workspaces/:workspaceId/soul';
    routes.get(
      `${base}/snapshot`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'getSoulSnapshotV1',
          summary: 'Read all authorized files at one current accepted Soul revision',
          tags: ['Workspace settings'],
          params: json(params),
          response: { 200: json(soulRepositorySchema), ...errors },
        },
      },
      request => service.repository(params.parse(request.params).workspaceId, user(request)),
    );
    routes.get(
      `${base}/tree`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'getSoulTreeV1',
          summary: 'List authorized files at the current accepted Soul revision',
          tags: ['Workspace settings'],
          params: json(params),
          querystring: json(soulTreeQuerySchema),
          response: { 200: json(soulTreeSchema), ...errors },
        },
      },
      (request, reply) => {
        const input = soulTreeQuerySchema.safeParse(request.query);
        if (!input.success) return reply.code(400).send({ error: 'invalid-request' });
        return service.tree(params.parse(request.params).workspaceId, user(request), input.data);
      },
    );
    routes.get(
      `${base}/file`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'getSoulFileV1',
          summary: 'Read one authorized Soul file without editing it',
          tags: ['Workspace settings'],
          params: json(params),
          querystring: json(soulFileQuerySchema),
          response: { 200: json(soulFileSchema), ...errors },
        },
      },
      (request, reply) => {
        const input = soulFileQuerySchema.safeParse(request.query);
        if (!input.success) return reply.code(400).send({ error: 'invalid-request' });
        return service.file(params.parse(request.params).workspaceId, user(request), input.data);
      },
    );
  });
}
