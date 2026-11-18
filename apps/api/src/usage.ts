import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AccessDenied,
  WorkspaceMembershipDenied,
  currentMember,
  definitionGrantPredicate,
  lockAuthorization,
  resolveHuman,
  type AuthorizationTransaction,
} from '@tulipfarm/access';
import {
  comparableProviderModel,
  isPlanProvider,
  legacyModels,
  loadModelCatalog,
  planModelName,
  planModelNameFromId,
  planModelOfFamily,
  servedModelBundle,
} from '@tulipfarm/config';
import { creditBalance } from '@tulipfarm/workspace-storage/credits';
import { modelUsageReport, usageConnections } from '@tulipfarm/workspace-storage/model-usage';
import {
  usageQuerySchema,
  usageReportSchema,
  type UsageConnection,
  type UsageReport,
} from '@tulipfarm/workspace-storage/model-usage-contracts';
import { qualified, StorageUnavailableError, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import type { registerAuth } from './auth.ts';
import type { createPlanUsage } from './plan-usage.ts';

const maxRangeMs = 400 * 24 * 60 * 60_000;

const usageRequestSchema = z.object({
  from: z.string(),
  to: z.string(),
  group: z.string().max(100),
  filters: z.string().max(20_000).optional(),
  tz: z.string().max(64).optional(),
});

const validTimeZone = (timeZone: string | undefined) => {
  if (!timeZone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
};

/** Names for the models usage rows carry: by catalog id, served or not, by route id, and plan models. */
function modelNames(ids: readonly string[]) {
  const catalog = loadModelCatalog();
  const known = new Map<string, { name: string; vendor: string | null }>();
  for (const model of catalog.catalog.models) known.set(model.id, { name: model.name, vendor: model.vendor });
  for (const { model, bundleModel } of servedModelBundle(catalog).entries)
    known.set(bundleModel.id, { name: model.name, vendor: model.vendor });
  const labels: UsageReport['labels']['models'] = {};
  for (const id of ids) {
    const served = known.get(id) ?? catalog.model(id);
    const plan = planModelOfFamily(id);
    if (served) labels[id] = { name: served.name, vendor: served.vendor };
    else if (plan) labels[id] = { name: planModelName(plan.model), vendor: known.get(plan.model)?.vendor ?? null };
    // A model the catalog no longer lists, such as a retired one, still reads as a name rather than an id.
    else if (id !== 'unknown') labels[id] = { name: planModelNameFromId(id), vendor: null };
  }
  return labels;
}

/**
 * The catalog model one model's usage groups under, however it was paid and whichever route served it. Calls record
 * the id of the route they billed under, such as `gpt-6-sol` or `gpt-6-sol-openai`, a plan model id or a plan family
 * id; each maps to the metered catalog model with the same provider model. Ids nothing matches stay as they are.
 */
export function canonicalModels(env: NodeJS.ProcessEnv = process.env) {
  const served = loadModelCatalog(env);
  const models = served.catalog.models;
  const byProviderModel = new Map<string, string>();
  for (const model of models)
    if (model.pricing !== 'unmetered')
      for (const route of model.routes) {
        const key = comparableProviderModel(route.model);
        if (!isPlanProvider(route.provider) && !byProviderModel.has(key)) byProviderModel.set(key, model.id);
      }
  const routed = new Map<string, string>();
  for (const legacy of legacyModels) routed.set(legacy.id, legacy.familyId);
  for (const { model, bundleModel } of servedModelBundle(served).entries) routed.set(bundleModel.id, model.id);
  const providers = new Set<string>(models.flatMap(model => model.routes.map(route => route.provider)));
  const metered = (providerModel: string) => byProviderModel.get(comparableProviderModel(providerModel));
  const canonical = (id: string): string => {
    const model = models.find(candidate => candidate.id === id);
    if (model) {
      const route = model.routes[0];
      return model.pricing === 'unmetered' && route ? (metered(route.model) ?? id) : id;
    }
    const family = routed.get(id);
    if (family) return models.some(candidate => candidate.id === family) ? canonical(family) : family;
    const plan = planModelOfFamily(id);
    if (plan) return metered(plan.model) ?? id;
    // A route id whose deployment is no longer served, with its provider suffix when two routes shared a model.
    const [, base, provider] = /^(.+?)-([a-z]+)(?:-\d+)?$/.exec(id) ?? [];
    return metered(id) ?? (base && provider && providers.has(provider) ? metered(base) : undefined) ?? id;
  };
  return canonical;
}

// Admins see every agent's name. Members see names only for agents they can still read; others show unnamed.
async function agentNames(tx: AuthorizationTransaction, ids: readonly string[], reader: string | null) {
  if (!ids.length) return {};
  const predicate = reader ? `AND ${definitionGrantPredicate(tx, 'agent', 'a.id', '$2', "'read'")}` : '';
  const rows = z
    .array(z.object({ id: z.string(), display_name: z.string().nullable() }))
    .parse(
      (
        await tx.client.query(
          `SELECT a.id::text AS id,a.display_name FROM ${qualified(tx.schema, 'tf_agents')} a WHERE a.id::text = ANY($1::text[]) ${predicate}`,
          reader ? [ids, reader] : [ids],
        )
      ).rows,
    );
  return Object.fromEntries(rows.flatMap(row => (row.display_name ? [[row.id, row.display_name]] : [])));
}

/**
 * The workspace's model usage explorer: every metered call grouped, filtered and totalled as asked. Admins see every
 * member's usage; members see their own in full and other members' credit spend as one "others" total.
 */
export function registerUsage(
  app: FastifyInstance,
  dependencies: {
    runtime: WorkspaceRuntime;
    auth: ReturnType<typeof registerAuth>['auth'];
    planUsage: ReturnType<typeof createPlanUsage>;
  },
) {
  const error = { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] };
  app.get(
    '/workspaces/:workspaceId/usage',
    {
      schema: {
        operationId: 'getWorkspaceUsageV1',
        summary: 'Read model usage visible to the caller, grouped and filtered',
        tags: ['Workspace settings'],
        params: {
          type: 'object',
          properties: { workspaceId: { type: 'string', format: 'uuid' } },
          required: ['workspaceId'],
        },
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Start of the range, ISO 8601 with offset' },
            to: { type: 'string', description: 'End of the range (exclusive), ISO 8601 with offset' },
            group: { type: 'string', description: 'One or two comma-separated dimensions, such as model,paidBy' },
            filters: { type: 'string', description: 'JSON object of dimension to the values to keep' },
            tz: { type: 'string', description: 'IANA time zone days and weeks are counted in' },
          },
          required: ['from', 'to', 'group'],
        },
        response: {
          200: z.toJSONSchema(usageReportSchema),
          400: error,
          401: error,
          404: error,
          500: error,
          503: error,
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const session = await dependencies.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session) return reply.code(401).send({ error: 'sign-in-required' });
      const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
      const raw = usageRequestSchema.safeParse(request.query);
      let filters: unknown = {};
      try {
        filters = raw.data?.filters ? JSON.parse(raw.data.filters) : {};
      } catch {
        return reply.code(400).send({ error: 'invalid-usage-query' });
      }
      const parsed = raw.success
        ? usageQuerySchema.safeParse({
            from: raw.data.from,
            to: raw.data.to,
            group: raw.data.group.split(',').filter(Boolean),
            filters,
            timeZone: validTimeZone(raw.data.tz),
          })
        : null;
      const query = parsed?.success ? parsed.data : null;
      const span = query ? Date.parse(query.to) - Date.parse(query.from) : NaN;
      if (!query || !(span > 0) || span > maxRangeMs || new Set(query.group).size !== query.group.length)
        return reply.code(400).send({ error: 'invalid-usage-query' });
      try {
        const read = await dependencies.runtime.transaction(workspaceId, commonCompatibility, async tx => {
          await lockAuthorization(tx);
          const actor = await resolveHuman(tx, session.user.id);
          const admin = (await currentMember(tx, actor)).role === 'admin';
          const report = await modelUsageReport(
            tx,
            query,
            { membershipId: actor.membershipId, admin },
            canonicalModels(),
          );
          const values = (dimension: 'model' | 'agent' | 'connection') =>
            (report.options[dimension] ?? []).map(option => option.value);
          const fallbackFrom = (report.options.fallback ?? []).map(option => option.value.split('|')[1] ?? '');
          return {
            admin,
            membershipId: actor.membershipId,
            report,
            balance: await creditBalance(tx),
            agents: await agentNames(
              tx,
              values('agent').filter(id => id !== 'none'),
              admin ? null : actor.membershipId,
            ),
            connections: await usageConnections(tx, [...values('connection'), ...fallbackFrom]),
          };
        });
        const connections: Record<string, UsageConnection> = {};
        await Promise.all(
          read.connections.map(async connection => {
            const premiumRequests =
              connection.provider === 'copilot'
                ? await dependencies.planUsage.premiumRequests(workspaceId, {
                    connectionId: connection.id,
                    ownerMembershipId: connection.owner_membership_id,
                  })
                : null;
            connections[connection.id] = {
              id: connection.id,
              provider: connection.provider,
              ownerMembershipId: connection.owner_membership_id,
              plan: connection.plan,
              status: {
                status:
                  connection.state === 'reconnect-required' || connection.state === 'signed-out'
                    ? 'reconnect'
                    : connection.usage_limited_at
                      ? 'limit-reached'
                      : 'available',
                limitedAt: connection.usage_limited_at?.toISOString() ?? null,
                premiumRequests,
              },
            };
          }),
        );
        const models = read.report.options.model ?? [];
        return {
          viewer: { membershipId: read.membershipId, admin: read.admin },
          balance: read.balance,
          rows: read.report.rows,
          series: read.report.series,
          options: read.report.options,
          labels: {
            models: modelNames(models.map(option => option.value)),
            agents: read.agents,
            connections,
          },
          detailSince: read.report.detailSince,
          truncated: read.report.truncated,
        } satisfies UsageReport;
      } catch (cause) {
        if (cause instanceof WorkspaceMembershipDenied && cause.userId === session.user.id)
          return reply.code(404).send({ error: 'not-found' });
        if (cause instanceof AccessDenied) return reply.code(404).send({ error: 'workspace-not-found' });
        if (cause instanceof StorageUnavailableError) return reply.code(503).send({ error: 'usage-unavailable' });
        request.log.error({ err: cause }, 'usage read failed');
        return reply.code(500).send({ error: 'usage-read-failed' });
      }
    },
  );
}
