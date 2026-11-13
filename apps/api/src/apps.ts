import { createHash } from 'node:crypto';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  appBuildWorkflowId,
  appNameSchema,
  appSlugSchema,
  readAppRecipe,
  recipeBuilder,
  type AppBuildId,
  type AppId,
  type AppName,
  type AppSlug,
  type GitCommit,
  type MembershipId,
} from '@tulipfarm/apps';
import {
  admitPublish,
  admitRollback,
  appRecord,
  appRole,
  changeAppStop,
  claimAppName,
  createApp,
  listAppGrants,
  listAppVersions,
  promoteAppName,
  publishAppVersion,
  putAppGrant,
  readApp,
  readBuild,
  readDraft,
  readOperation,
  readRelease,
  readSourceBundles,
  readStagedChanges,
  requestBuild,
  restoreAppVersion,
  revokeAppGrant,
  setAppPublicName,
  type AppGrant,
  type AppOperation,
  type AppRecord,
  type AppRepositories,
  type AppRole,
  type AppRow,
  type AppStopKind,
  type AppTransaction,
  type AppVersionResult,
} from '@tulipfarm/apps/store';
import type { AppPublisher } from '@tulipfarm/extensions';
import { errorAttributes, isFeatureEnabled } from '@tulipfarm/observability';
import { commonCompatibility, qualified, type createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { AccessDenied } from '@tulipfarm/access';
import {
  AppRouteFailure,
  appDetailView,
  appParams,
  appSummaryView,
  approvalBody,
  buildParams,
  buildView,
  createBody,
  failure,
  failureStatus,
  filesQuery,
  grantBody,
  grantParams,
  grantView,
  nameBody,
  nameParams,
  operationParams,
  parseGrantee,
  privatePublishBody,
  privateRollbackBody,
  publicPublishBody,
  publicRollbackBody,
  publishBody,
  requestBody,
  rollbackBody,
  updateBody,
  versionView,
  workspaceParams,
} from './apps-contracts.ts';
import type { registerAuth } from './auth.ts';
import { authConfig } from './auth.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

type Runtime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;

export type AppWorkflow = 'appBuild' | 'appPublish' | 'appRollback' | 'appProjectEdge';

export type AppRouteDependencies = {
  readonly auth: { api: Pick<ReturnType<typeof registerAuth>['auth']['api'], 'getSession'> };
  readonly runtime: Runtime;
  /** The platform database, which holds the public name table. */
  readonly platform: Pick<Pool, 'query' | 'connect'>;
  /** Starts a workflow once per id; starting an id that already exists does nothing. */
  readonly start: (workflow: AppWorkflow, workflowId: string, input: Record<string, string>) => Promise<void>;
  /** The app source cache, or null when no apps bucket is configured. */
  readonly repositories: AppRepositories | null;
  readonly publisher: () => AppPublisher | undefined;
  /** The registered builder's id, which command recipes build with. */
  readonly builderId: () => string | undefined;
  /** The domain public apps are served under, or null when this server does not serve app sites. */
  readonly sitesDomain: string | null;
};

type Member = { readonly membershipId: MembershipId; readonly admin: boolean };
type Access = { readonly app: AppRecord; readonly role: AppRole | null };

/** A UUID derived from its parts, so a repeated create picks the same app and chat ids. */
function derivedId(...parts: string[]) {
  const hex = createHash('sha256').update(parts.join('\n')).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function slugFrom(title: string) {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return appSlugSchema.safeParse(base).success ? base : 'app';
}

const workflowIds = {
  build: appBuildWorkflowId,
  release: (operation: AppOperation) => `app-${operation.kind}-${operation.appId}-${operation.id}`,
  edge: (app: AppRecord) => `app-edge-${app.id}-${app.edgeVersion}`,
};

/**
 * The app routes under `/workspaces/:workspaceId/apps`. A workspace without app hosting, a non-member and a member
 * who cannot see an app all get 404; a member who can see an app but lacks the role gets 403.
 */
export function registerApps(app: FastifyInstance, dependencies: AppRouteDependencies) {
  const { runtime, platform, start } = dependencies;
  const summary = (found: AppRecord, role: AppRole | null) => appSummaryView(found, role, dependencies.sitesDomain);

  const transaction = <T>(workspaceId: string, action: (tx: AppTransaction) => Promise<T>) =>
    runtime.transaction(workspaceId, commonCompatibility, action);

  const memberOf = async (tx: AppTransaction, userId: string): Promise<Member> => {
    const { rows } = await tx.client.query(
      `SELECT id, role FROM ${qualified(tx.schema, 'tf_memberships')} WHERE user_id = $1 AND removed_at IS NULL`,
      [userId],
    );
    const row = rows[0] as { id: string; role: string } | undefined;
    if (!row) throw new AccessDenied();
    return { membershipId: row.id as MembershipId, admin: row.role === 'admin' };
  };

  /** Workspace admins see every app so they can approve and disable it. */
  const access = async (
    tx: AppTransaction,
    member: Member,
    appId: AppId,
    need: 'use' | 'edit' | 'admin',
    options: { lock?: boolean; archived?: boolean } = {},
  ): Promise<Access> => {
    const found = await readApp(tx, appId, options.lock);
    if (!found || (found.archivedAt && !options.archived)) throw failure('not-found', 'App not found');
    const role = await appRole(tx, appId, member.membershipId);
    if (!role && !member.admin) throw failure('not-found', 'App not found');
    if (need === 'edit' && role !== 'edit') throw failure('forbidden', 'You need edit access to this app');
    if (need === 'admin' && !member.admin) throw failure('forbidden', 'Only a workspace admin can do this');
    return { app: found, role };
  };

  const projectEdge = async (workspaceId: string, changed: AppRecord) => {
    if (changed.kind === 'public' && changed.publicName)
      await start('appProjectEdge', workflowIds.edge(changed), { workspaceId, appId: changed.id });
  };

  const startRelease = async (workspaceId: string, operation: AppOperation) => {
    if (operation.status === 'admitted' || operation.status === 'staging')
      await start(operation.kind === 'publish' ? 'appPublish' : 'appRollback', workflowIds.release(operation), {
        workspaceId,
        operationId: operation.id,
      });
  };

  const sourceAt = async (workspaceId: string, appId: AppId, commit: GitCommit, tx: AppTransaction) => {
    const repositories = dependencies.repositories;
    if (!repositories) throw new Error('App storage is not configured');
    const repository = await repositories.open(workspaceId, appId, commit, await readSourceBundles(tx, appId));
    return { repositories, repository };
  };

  app.register(async routes => {
    const validation = routeValidation({ target: 'openapi-3.0', missing: 'Missing app validator', invalid: e => e });
    validation.install(routes);
    const users = new WeakMap<FastifyRequest, string>();

    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== authConfig().webOrigin)
        return reply.code(403).send({ error: 'untrusted-origin' });
      const session = await dependencies.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session) return reply.code(401).send({ error: 'sign-in-required' });
      const workspace = workspaceParams.safeParse({
        workspaceId: (request.params as { workspaceId?: string }).workspaceId,
      });
      if (!workspace.success || !(await isFeatureEnabled('app-hosting', null, { id: workspace.data.workspaceId })))
        return reply.code(404).send({ error: 'not-found' });
      users.set(request, session.user.id);
    });

    routes.setErrorHandler((error, request, reply) => {
      if (error instanceof AppRouteFailure)
        return reply.code(failureStatus[error.failure.code]).send({
          failure: { name: 'AppFailure', code: error.failure.code, message: error.failure.message },
          ...(error.issues.length ? { issues: error.issues } : {}),
        });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'not-found' });
      if (requestBoundaryError(error, reply)) return;
      const code = (error as { code?: string }).code;
      if (code === '23505')
        return reply.code(409).send({
          failure: { name: 'AppFailure', code: 'name-taken', message: 'Another app already uses this address' },
        });
      request.log.error(errorAttributes(error), 'app_route_failed');
      return reply.code(503).send({ error: 'apps-unavailable' });
    });

    type Handler<P, B, Q> = (
      context: { workspaceId: string; userId: string; params: P; body: B; query: Q },
      reply: FastifyReply,
    ) => Promise<unknown>;
    const route = <P extends z.ZodType, B extends z.ZodType = z.ZodUndefined, Q extends z.ZodType = z.ZodUndefined>(
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      operationId: string,
      schemas: { params: P; body?: B; query?: Q },
      handler: Handler<z.infer<P>, z.infer<B>, z.infer<Q>>,
    ) =>
      routes.route({
        method,
        // oxlint-disable-next-line tulipfarm/product-copy -- A stable route, not user-facing copy.
        url: `/workspaces/:workspaceId/apps${path}`,
        schema: {
          operationId,
          hide: true,
          params: validation.json(schemas.params),
          ...(schemas.body ? { body: validation.json(schemas.body) } : {}),
          ...(schemas.query ? { querystring: validation.json(schemas.query) } : {}),
        },
        handler: async (request, reply) => {
          const params = request.params as z.infer<P> & { workspaceId: string };
          return handler(
            {
              workspaceId: params.workspaceId.toLowerCase(),
              userId: users.get(request)!,
              params,
              body: request.body as z.infer<B>,
              query: request.query as z.infer<Q>,
            },
            reply,
          );
        },
      });

    route('GET', '', 'listAppsV1', { params: workspaceParams }, ({ workspaceId, userId }) =>
      transaction(workspaceId, async tx => {
        const member = await memberOf(tx, userId);
        const { rows } = await tx.client.query(
          `SELECT a.*, (
             SELECT g.role FROM ${qualified(tx.schema, 'tf_app_grants')} g
             WHERE g.app_id = a.id AND (
               g.grantee = 'workspace' OR g.membership_id = $1
               OR g.team_id IN (SELECT team_id FROM ${qualified(tx.schema, 'tf_member_teams')} WHERE membership_id = $1)
             )
             ORDER BY g.role = 'edit' DESC LIMIT 1
           ) AS member_role
           FROM ${qualified(tx.schema, 'tf_apps')} a
           WHERE a.archived_at IS NULL
           ORDER BY a.created_at DESC, a.id`,
          [member.membershipId],
        );
        return {
          apps: (rows as (AppRow & { member_role: AppRole | null })[])
            .filter(row => row.member_role !== null || member.admin)
            .map(row => summary(appRecord(row), row.member_role)),
        };
      }),
    );

    route(
      'POST',
      '',
      'createAppV1',
      { params: workspaceParams, body: createBody },
      async ({ workspaceId, userId, body }, reply) => {
        const created = await transaction(workspaceId, async tx => {
          const member = await memberOf(tx, userId);
          const id = derivedId('app', member.membershipId, body.requestId) as AppId;
          const base = body.slug ?? slugFrom(body.title);
          const candidates = body.slug ? [base] : [base, ...[2, 3, 4, 5, 6, 7, 8, 9].map(n => `${base}-${n}`)];
          for (const slug of candidates) {
            const result = await createApp(tx, {
              id,
              kind: body.kind,
              slug: slug as AppSlug,
              title: body.title,
              createdBy: member.membershipId,
            });
            if (!result.ok) continue;
            await tx.client.query(
              `INSERT INTO ${qualified(tx.schema, 'tf_conversations')}
                 (id, owner_user_id, owner_membership_id, title, title_manual, app_id)
               VALUES ($1, $2, $3, $4, true, $5) ON CONFLICT (id) DO NOTHING`,
              [derivedId('app-chat', id), userId, member.membershipId, result.app.title, id],
            );
            return { app: result.app, chatId: derivedId('app-chat', id) };
          }
          throw failure('name-taken', 'Another app already uses this address');
        });
        reply.code(201);
        return { ...summary(created.app, 'edit'), chatId: created.chatId };
      },
    );

    route('GET', '/:appId', 'getAppV1', { params: appParams }, ({ workspaceId, userId, params }) =>
      transaction(workspaceId, async tx => {
        const { app: found, role } = await access(tx, await memberOf(tx, userId), params.appId, 'use');
        const draft = (await readDraft(tx, found.id))!;
        const { rows } = draft.headCommit
          ? await tx.client.query(
              `SELECT id FROM ${qualified(tx.schema, 'tf_app_builds')} WHERE app_id = $1 AND commit = $2
               ORDER BY created_at DESC, id LIMIT 1`,
              [found.id, draft.headCommit],
            )
          : { rows: [] };
        const headBuild = rows[0] ? await readBuild(tx, (rows[0] as { id: AppBuildId }).id) : null;
        const live = found.liveReleaseId ? await readRelease(tx, found.liveReleaseId) : null;
        return {
          ...appDetailView(summary(found, role), draft, headBuild, live),
          sitesDomain: dependencies.sitesDomain,
        };
      }),
    );

    route(
      'PATCH',
      '/:appId',
      'updateAppV1',
      { params: appParams, body: updateBody },
      ({ workspaceId, userId, params, body }) =>
        transaction(workspaceId, async tx => {
          const { role } = await access(tx, await memberOf(tx, userId), params.appId, 'edit', { lock: true });
          const { rows } = await tx.client.query(
            `UPDATE ${qualified(tx.schema, 'tf_apps')} SET title = COALESCE($2, title), slug = COALESCE($3, slug)
             WHERE id = $1 RETURNING *`,
            [params.appId, body.title ?? null, body.slug ?? null],
          );
          return summary(appRecord(rows[0] as AppRow), role);
        }),
    );

    route(
      'DELETE',
      '/:appId',
      'archiveAppV1',
      { params: appParams },
      async ({ workspaceId, userId, params }, reply) => {
        const archived = await transaction(workspaceId, async tx => {
          const member = await memberOf(tx, userId);
          const { app: found } = await access(tx, member, params.appId, 'edit', { lock: true, archived: true });
          if (found.archivedAt) return null;
          const { rows } = await tx.client.query(
            `UPDATE ${qualified(tx.schema, 'tf_apps')} SET archived_at = clock_timestamp(),
             disabled_at = COALESCE(disabled_at, clock_timestamp()), disabled_by = COALESCE(disabled_by, $2),
             edge_version = edge_version + 1
           WHERE id = $1 RETURNING *`,
            [found.id, member.membershipId],
          );
          return appRecord(rows[0] as AppRow);
        });
        if (archived) await projectEdge(workspaceId, archived);
        return reply.code(204).send();
      },
    );

    route('GET', '/:appId/grants', 'listAppGrantsV1', { params: appParams }, ({ workspaceId, userId, params }) =>
      transaction(workspaceId, async tx => {
        await access(tx, await memberOf(tx, userId), params.appId, 'edit');
        const grants = await listAppGrants(tx, params.appId);
        const names = await teamNames(tx, grants);
        return { grants: grants.map(grant => grantView(grant, names)) };
      }),
    );

    route(
      'PUT',
      '/:appId/grants/:grantee',
      'putAppGrantV1',
      { params: grantParams, body: grantBody },
      ({ workspaceId, userId, params, body }) =>
        transaction(workspaceId, async tx => {
          const member = await memberOf(tx, userId);
          await access(tx, member, params.appId, 'edit', { lock: true });
          const grantee = parseGrantee(params.grantee);
          if (!grantee) throw failure('not-found', 'Grantee not found');
          if (!(await granteeExists(tx, grantee))) throw failure('not-found', 'Grantee not found');
          const result = await putAppGrant(tx, {
            appId: params.appId,
            grantee,
            role: body.role,
            grantedBy: member.membershipId,
          });
          if (!result.ok) throw new AppRouteFailure(result.failure);
          return grantView(result.grant, await teamNames(tx, [result.grant]));
        }),
    );

    route(
      'DELETE',
      '/:appId/grants/:grantee',
      'revokeAppGrantV1',
      { params: grantParams },
      async ({ workspaceId, userId, params }, reply) => {
        await transaction(workspaceId, async tx => {
          await access(tx, await memberOf(tx, userId), params.appId, 'edit', { lock: true });
          const grantee = parseGrantee(params.grantee);
          if (!grantee) throw failure('not-found', 'Grantee not found');
          await revokeAppGrant(tx, params.appId, grantee);
        });
        return reply.code(204).send();
      },
    );

    route(
      'GET',
      '/:appId/files',
      'listAppFilesV1',
      { params: appParams, query: filesQuery },
      ({ workspaceId, userId, params, query }) =>
        transaction(workspaceId, async tx => {
          await access(tx, await memberOf(tx, userId), params.appId, 'edit');
          const draft = (await readDraft(tx, params.appId))!;
          const staged =
            draft.lease && !draft.lease.expired ? await readStagedChanges(tx, params.appId, draft.lease.id) : [];
          const head = draft.headCommit;
          const source = head ? await sourceAt(workspaceId, params.appId, head, tx) : null;
          if (query.path !== undefined) {
            const change = staged.find(entry => entry.path === query.path);
            const content = change
              ? change.content
              : source && head
                ? await source.repositories.file(source.repository, head, query.path)
                : null;
            if (!content) throw failure('not-found', 'File not found');
            return { path: query.path, staged: Boolean(change), ...encoded(content) };
          }
          const sizes = source && head ? await source.repositories.tree(source.repository, head) : new Map();
          const files = new Map<string, { bytes: number; staged: boolean }>();
          for (const [path, bytes] of sizes) files.set(path, { bytes, staged: false });
          for (const change of staged)
            if (change.content === null) files.delete(change.path);
            else files.set(change.path, { bytes: change.content.byteLength, staged: true });
          return {
            headCommit: head,
            files: [...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, file]) => ({ path, ...file })),
          };
        }),
    );

    route(
      'POST',
      '/:appId/builds',
      'requestAppBuildV1',
      { params: appParams, body: requestBody },
      async ({ workspaceId, userId, params }, reply) => {
        const build = await transaction(workspaceId, async tx => {
          const member = await memberOf(tx, userId);
          await access(tx, member, params.appId, 'edit');
          const head = (await readDraft(tx, params.appId))!.headCommit;
          if (!head) throw failure('not-found', 'Save a file before building the app');
          const source = await sourceAt(workspaceId, params.appId, head, tx);
          const appJson = await source.repositories.file(source.repository, head, 'app.json');
          const recipe = readAppRecipe(appJson === null ? null : Buffer.from(appJson).toString('utf8'));
          if (!recipe.ok) throw new AppRouteFailure(recipe.failure);
          const builder = recipeBuilder(recipe.recipe, dependencies.builderId());
          if (!builder) throw failure('builder-unavailable', 'This server cannot run build commands');
          return requestBuild(tx, {
            appId: params.appId,
            commit: head,
            recipe: recipe.recipe,
            builder,
            requestedBy: member.membershipId,
          });
        });
        if (build.status.status === 'queued' || build.status.status === 'running')
          await start('appBuild', workflowIds.build(build.id), { workspaceId, buildId: build.id });
        reply.code(202);
        return { buildId: build.id };
      },
    );

    route(
      'GET',
      '/:appId/builds/:buildId',
      'getAppBuildV1',
      { params: buildParams },
      ({ workspaceId, userId, params }) =>
        transaction(workspaceId, async tx => {
          await access(tx, await memberOf(tx, userId), params.appId, 'edit');
          const build = await readBuild(tx, params.buildId);
          if (!build || build.appId !== params.appId) throw failure('not-found', 'Build not found');
          return buildView(build);
        }),
    );

    route('GET', '/:appId/releases', 'listAppReleasesV1', { params: appParams }, ({ workspaceId, userId, params }) =>
      transaction(workspaceId, async tx => {
        const { app: found, role } = await access(tx, await memberOf(tx, userId), params.appId, 'use');
        if (found.kind === 'private') {
          const { generation, versions } = await listAppVersions(tx, found.id);
          return { generation, releases: versions.map(versionView) };
        }
        if (role !== 'edit') throw failure('forbidden', 'You need edit access to this app');
        const { rows } = await tx.client.query(
          `SELECT id, number, build_id, commit, staged_at, created_at FROM ${qualified(tx.schema, 'tf_app_releases')}
           WHERE app_id = $1 ORDER BY number DESC`,
          [found.id],
        );
        return {
          releases: (
            rows as {
              id: string;
              number: number;
              build_id: string;
              commit: string;
              staged_at: Date | null;
              created_at: Date;
            }[]
          ).map(row => ({
            id: row.id,
            number: row.number,
            buildId: row.build_id,
            commit: row.commit,
            staged: row.staged_at !== null,
            live: row.id === found.liveReleaseId,
            createdAt: row.created_at.toISOString(),
          })),
        };
      }),
    );

    const requirePublisher = () => {
      if (!dependencies.publisher())
        throw failure('publisher-unavailable', 'This server has no app site domain to publish to');
    };

    route(
      'POST',
      '/:appId/publish',
      'publishAppV1',
      { params: appParams, body: publishBody },
      async ({ workspaceId, userId, params, body }, reply) => {
        const result = await transaction(workspaceId, async tx => {
          const member = await memberOf(tx, userId);
          const { app: found } = await access(tx, member, params.appId, 'edit');
          if (found.kind === 'private') {
            const request = privatePublishBody.parse(body);
            return switched(
              await publishAppVersion(tx, {
                appId: found.id,
                requestId: request.requestId,
                requestedBy: member.membershipId,
                revision: request.revision,
                generation: request.generation ?? found.releaseGeneration,
              }),
            );
          }
          requirePublisher();
          return admitted(
            await admitPublish(tx, {
              appId: params.appId,
              requestId: body.requestId,
              requestedBy: member.membershipId,
              buildId: publicPublishBody.parse(body).buildId,
            }),
          );
        });
        if ('version' in result) return result;
        await startRelease(workspaceId, result);
        reply.code(202);
        return { operation: result };
      },
    );

    route(
      'POST',
      '/:appId/rollback',
      'rollbackAppV1',
      { params: appParams, body: rollbackBody },
      async ({ workspaceId, userId, params, body }, reply) => {
        const result = await transaction(workspaceId, async tx => {
          const member = await memberOf(tx, userId);
          const { app: found } = await access(tx, member, params.appId, 'edit');
          if (found.kind === 'private') {
            const request = privateRollbackBody.parse(body);
            return switched(
              await restoreAppVersion(tx, {
                appId: found.id,
                requestId: request.requestId,
                requestedBy: member.membershipId,
                versionId: request.releaseId,
                generation: request.generation ?? found.releaseGeneration,
              }),
            );
          }
          requirePublisher();
          return admitted(
            await admitRollback(tx, {
              appId: params.appId,
              requestId: body.requestId,
              requestedBy: member.membershipId,
              releaseId: publicRollbackBody.parse(body).releaseId,
            }),
          );
        });
        if ('version' in result) return result;
        await startRelease(workspaceId, result);
        reply.code(202);
        return { operation: result };
      },
    );

    route(
      'GET',
      '/:appId/operations/:operationId',
      'getAppOperationV1',
      { params: operationParams },
      ({ workspaceId, userId, params }) =>
        transaction(workspaceId, async tx => {
          await access(tx, await memberOf(tx, userId), params.appId, 'edit');
          const operation = await readOperation(tx, params.operationId);
          if (!operation || operation.appId !== params.appId) throw failure('not-found', 'Operation not found');
          return { operation };
        }),
    );

    const stop = (kind: AppStopKind, operationId: string) =>
      route(
        'POST',
        `/:appId/${kind}`,
        operationId,
        { params: appParams, body: requestBody },
        async ({ workspaceId, userId, params, body }) => {
          const changed = await transaction(workspaceId, async tx => {
            const member = await memberOf(tx, userId);
            const admin = kind === 'disable' || kind === 'enable';
            const { role } = await access(tx, member, params.appId, admin ? 'admin' : 'edit');
            const result = await changeAppStop(tx, {
              appId: params.appId,
              requestId: body.requestId,
              requestedBy: member.membershipId,
              kind,
            });
            if (!result.ok) throw new AppRouteFailure(result.failure);
            return { operation: result.operation, app: result.app, role };
          });
          await projectEdge(workspaceId, changed.app);
          return { operation: changed.operation, app: summary(changed.app, changed.role) };
        },
      );
    stop('pause', 'pauseAppV1');
    stop('resume', 'resumeAppV1');
    stop('disable', 'disableAppV1');
    stop('enable', 'enableAppV1');

    route(
      'PUT',
      '/:appId/name',
      'renameAppV1',
      { params: appParams, body: nameBody },
      async ({ workspaceId, userId, params, body }) => {
        const name = publicName(body.name);
        const rename = { appId: params.appId, requestId: body.requestId, name };
        const prepared = await transaction(workspaceId, async tx => {
          const member = await memberOf(tx, userId);
          const { app: found } = await access(tx, member, params.appId, 'edit');
          if (found.kind !== 'public') throw failure('forbidden', 'Only public apps have a public name');
          return { member, repeat: await repeatedRename(tx, member.membershipId, rename) };
        });
        const claim = { name, workspaceId, appId: params.appId };
        if (!prepared.repeat) {
          const claimed = await claimAppName(platform, claim);
          if (!claimed.ok) throw new AppRouteFailure(claimed.failure);
          await transaction(workspaceId, async tx => {
            const { app: found } = await access(tx, prepared.member, params.appId, 'edit', { lock: true });
            if (await repeatedRename(tx, prepared.member.membershipId, rename)) return;
            await setAppPublicName(tx, found.id, name);
            await insertRenameOperation(tx, found, prepared.member.membershipId, rename);
          });
        }
        const client = await platform.connect();
        let retired: AppName | null;
        let renamed;
        try {
          await client.query('BEGIN');
          // Promotions of one app are serialized and each promotes the name the workspace holds now, so the name
          // committed last ends up current whichever request reaches the platform first.
          await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('app-name:' || $1, 0))`, [params.appId]);
          renamed = await transaction(workspaceId, async tx => {
            const { app: found, role } = await access(tx, prepared.member, params.appId, 'edit');
            const operation = await requestedOperation(tx, prepared.member.membershipId, body.requestId);
            return { operation: operation!, app: found, role };
          });
          if (renamed.app.publicName !== name) throw failure('superseded', 'A later rename replaced this name');
          ({ retired } = await promoteAppName(client, claim));
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
        await projectEdge(workspaceId, renamed.app);
        const publisher = dependencies.publisher();
        if (retired && publisher)
          await publisher
            .remove({ name: retired, version: renamed.app.edgeVersion }, AbortSignal.timeout(10_000))
            .catch(error => app.log.warn(errorAttributes(error), 'app_name_route_remove_failed'));
        return { operation: renamed.operation, app: summary(renamed.app, renamed.role) };
      },
    );

    route(
      'GET',
      '/names/:name',
      'getAppNameAvailabilityV1',
      { params: nameParams },
      async ({ workspaceId, userId, params }) => {
        await transaction(workspaceId, tx => memberOf(tx, userId));
        const parsed = appNameSchema.safeParse(params.name);
        if (!parsed.success) return { name: params.name, available: false, reason: nameProblem(params.name) };
        const { rows } = await platform.query('SELECT 1 FROM app.app_hostnames WHERE name = $1', [parsed.data]);
        return rows.length
          ? { name: parsed.data, available: false, reason: 'name-taken' }
          : { name: parsed.data, available: true };
      },
    );

    route(
      'POST',
      '/:appId/approval-request',
      'requestAppApprovalV1',
      { params: appParams, body: requestBody },
      ({ workspaceId, userId, params }) =>
        transaction(workspaceId, async tx => {
          const member = await memberOf(tx, userId);
          const { app: found, role } = await access(tx, member, params.appId, 'edit', { lock: true });
          if (found.kind !== 'public') throw failure('forbidden', 'Only public apps need approval');
          if (found.approval.state === 'requested' || found.approval.state === 'approved') return summary(found, role);
          const { rows } = await tx.client.query(
            `UPDATE ${qualified(tx.schema, 'tf_apps')} SET approval_state = 'requested', approval_by = $2,
               approval_at = clock_timestamp(), monthly_limit_units = NULL
             WHERE id = $1 RETURNING *`,
            [found.id, member.membershipId],
          );
          return summary(appRecord(rows[0] as AppRow), role);
        }),
    );

    route(
      'POST',
      '/:appId/approval',
      'decideAppApprovalV1',
      { params: appParams, body: approvalBody },
      ({ workspaceId, userId, params, body }) =>
        transaction(workspaceId, async tx => {
          const member = await memberOf(tx, userId);
          const { app: found, role } = await access(tx, member, params.appId, 'admin', { lock: true });
          if (found.kind !== 'public') throw failure('forbidden', 'Only public apps need approval');
          if (body.decision === 'reject' && found.liveReleaseId)
            throw failure('forbidden', 'Disable this app before rejecting it, because it is live');
          const { rows } = await tx.client.query(
            `UPDATE ${qualified(tx.schema, 'tf_apps')} SET approval_state = $2, approval_by = $3,
               approval_at = clock_timestamp(), monthly_limit_units = $4
             WHERE id = $1 RETURNING *`,
            [
              found.id,
              body.decision === 'approve' ? 'approved' : 'rejected',
              member.membershipId,
              body.decision === 'approve' ? (body.monthlyLimitUnits ?? null) : null,
            ],
          );
          return summary(appRecord(rows[0] as AppRow), role);
        }),
    );
  });
}

function admitted(result: Awaited<ReturnType<typeof admitPublish>>) {
  if (!result.ok) throw new AppRouteFailure(result.failure);
  return result.operation;
}

/** A private app's publish or restore has already switched when it returns. */
function switched(result: AppVersionResult) {
  if (!result.ok) throw new AppRouteFailure(result.failure, result.issues);
  return { operation: result.operation, version: versionView(result.version) };
}

function nameProblem(name: string) {
  const reserved = appNameSchema.safeParse(name).error?.issues.some(issue => issue.message === 'Reserved app name');
  return reserved ? 'name-reserved' : 'name-invalid';
}

function publicName(name: string): AppName {
  const parsed = appNameSchema.safeParse(name);
  if (parsed.success) return parsed.data;
  if (nameProblem(name) === 'name-reserved') throw failure('name-reserved', 'This name is reserved');
  throw failure('name-reserved', 'Use 3 to 63 lowercase letters, digits and single hyphens');
}

function encoded(content: Uint8Array) {
  const text = new TextDecoder('utf-8', { fatal: true });
  try {
    return { encoding: 'utf8' as const, content: text.decode(content), bytes: content.byteLength };
  } catch {
    return { encoding: 'base64' as const, content: Buffer.from(content).toString('base64'), bytes: content.byteLength };
  }
}

async function teamNames(tx: AppTransaction, grants: readonly AppGrant[]) {
  const ids = grants.flatMap(grant => (grant.grantee.kind === 'team' ? [grant.grantee.teamId] : []));
  if (!ids.length) return new Map<string, string>();
  const { rows } = await tx.client.query(
    `SELECT id, name FROM ${qualified(tx.schema, 'tf_teams')} WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map((rows as { id: string; name: string }[]).map(row => [row.id, row.name]));
}

async function granteeExists(tx: AppTransaction, grantee: ReturnType<typeof parseGrantee> & object) {
  if (grantee.kind === 'workspace') return true;
  const { rows } =
    grantee.kind === 'member'
      ? await tx.client.query(
          `SELECT 1 FROM ${qualified(tx.schema, 'tf_memberships')} WHERE id = $1 AND removed_at IS NULL`,
          [grantee.membershipId],
        )
      : await tx.client.query(`SELECT 1 FROM ${qualified(tx.schema, 'tf_teams')} WHERE id = $1`, [grantee.teamId]);
  return rows.length > 0;
}

async function requestedOperation(tx: AppTransaction, requestedBy: MembershipId, requestId: string) {
  const { rows } = await tx.client.query(
    `SELECT id FROM ${qualified(tx.schema, 'tf_app_operations')} WHERE requested_by = $1 AND request_id = $2`,
    [requestedBy, requestId],
  );
  const row = rows[0] as { id: AppOperation['id'] } | undefined;
  return row ? readOperation(tx, row.id) : null;
}

type RenameRequest = { readonly appId: AppId; readonly requestId: string; readonly name: AppName };

// The operation id covers the name, so a request id reused with another name is told apart without storing the name.
const renameOperationId = (requestedBy: MembershipId, rename: RenameRequest) =>
  derivedId('app-rename', requestedBy, rename.requestId, rename.name);

async function repeatedRename(tx: AppTransaction, requestedBy: MembershipId, rename: RenameRequest) {
  const repeat = await requestedOperation(tx, requestedBy, rename.requestId);
  if (!repeat) return null;
  if (repeat.appId !== rename.appId || repeat.kind !== 'rename') throw failure('not-found', 'App not found');
  if (repeat.id !== renameOperationId(requestedBy, rename))
    throw failure('superseded', 'This request already renamed the app to another name');
  return repeat;
}

async function insertRenameOperation(
  tx: AppTransaction,
  app: AppRecord,
  requestedBy: MembershipId,
  rename: RenameRequest,
) {
  const id = renameOperationId(requestedBy, rename);
  await tx.client.query(
    `INSERT INTO ${qualified(tx.schema, 'tf_app_operations')}
       (id, app_id, request_id, requested_by, kind, generation, target_release_id, status, finished_at)
     VALUES ($1, $2, $3, $4, 'rename', $5, $6, 'switched', clock_timestamp())`,
    [id, app.id, rename.requestId, requestedBy, app.releaseGeneration, app.liveReleaseId],
  );
}
