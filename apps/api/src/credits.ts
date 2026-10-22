import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  definitionGrantPredicate,
  lockAuthorization,
  resolveHuman,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { creditSummary } from '@tulipfarm/workspace-storage/credits';
import { creditSummarySchema, type CreditSummary } from '@tulipfarm/workspace-storage/credits-contracts';
import { qualified, StorageUnavailableError, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import type { registerAuth } from './auth.ts';

// A flow is the caller's when they own the chat or task, requested the delegated agent run,
// sponsored the scheduled run, or own the Gmail heartbeat item. Shared agents do not make
// another person's flows visible.
async function ownFlowIds(tx: AuthorizationTransaction, actor: HumanActor) {
  const owners = [
    `EXISTS (SELECT 1 FROM ${qualified(tx.schema, 'tf_conversations')} c WHERE c.id::text=u.flow_id AND c.owner_membership_id=$1 AND c.owner_user_id=$2)`,
    `EXISTS (SELECT 1 FROM ${qualified(tx.schema, 'tf_agent_runs')} r WHERE r.id::text=u.flow_id AND r.kind='delegated' AND r.membership_id=$1 AND r.user_id=$2)`,
  ];
  owners.push(
    `EXISTS (SELECT 1 FROM ${qualified(tx.schema, 'tf_agent_tasks')} t WHERE t.flow_id::text=u.flow_id AND t.owner_membership_id=$1 AND t.owner_user_id=$2)`,
  );
  owners.push(
    `EXISTS (SELECT 1 FROM ${qualified(tx.schema, 'tf_agent_runs')} r WHERE r.id::text=u.flow_id AND r.kind='scheduled' AND r.sponsor_membership_id=$1)`,
  );
  owners.push(
    `EXISTS (SELECT 1 FROM ${qualified(tx.schema, 'tf_google_heartbeat_items')} h WHERE h.id::text=u.flow_id AND h.membership_id=$1 AND h.user_id=$2)`,
  );
  owners.push(
    `EXISTS (SELECT 1 FROM ${qualified(tx.schema, 'tf_table_query_translations')} q WHERE q.billing_flow_id=u.flow_id AND q.membership_id=$1 AND q.user_id=$2)`,
  );
  const rows = z
    .array(z.object({ flow_id: z.string() }))
    .parse(
      (
        await tx.client.query(
          `SELECT DISTINCT u.flow_id FROM ${qualified(tx.schema, 'tf_credit_usage')} u WHERE ${owners.join(' OR ')}`,
          [actor.membershipId, actor.userId],
        )
      ).rows,
    );
  return rows.map(row => row.flow_id);
}

// Admins see every agent name. Members see usage from their own flows, with agent names only for
// agents they can still read; other agents fold into the unnamed row.
async function namedUsage(
  tx: AuthorizationTransaction,
  summary: CreditSummary,
  reader?: HumanActor,
): Promise<CreditSummary> {
  const used = [
    ...new Set([...summary.breakdown, ...summary.series].flatMap(row => (row.agentId ? [row.agentId] : []))),
  ];
  const predicate = reader ? `AND ${definitionGrantPredicate(tx, 'agent', 'a.id', '$2', "'read'")}` : '';
  const agents = z
    .array(z.object({ id: z.string(), display_name: z.string().nullable() }))
    .parse(
      (
        await tx.client.query(
          `SELECT a.id::text AS id,a.display_name FROM ${qualified(tx.schema, 'tf_agents')} a WHERE a.id::text = ANY($1::text[]) ${predicate}`,
          reader ? [used, reader.membershipId] : [used],
        )
      ).rows,
    );
  const names = new Map(agents.map(agent => [agent.id, agent.display_name]));
  const name = <Row extends { agentId: string | null }>(row: Row) =>
    row.agentId && names.has(row.agentId)
      ? { ...row, agentName: names.get(row.agentId) ?? null }
      : { ...row, agentId: null, agentName: null };
  const breakdown = new Map<string, CreditSummary['breakdown'][number]>();
  for (const row of summary.breakdown.map(name)) {
    const key = JSON.stringify([row.modelId, row.agentId, row.activity]);
    const previous = breakdown.get(key);
    breakdown.set(
      key,
      previous ? { ...previous, credits: previous.credits + row.credits, calls: previous.calls + row.calls } : row,
    );
  }
  const series = new Map<string, CreditSummary['series'][number]>();
  for (const row of summary.series.map(name)) {
    const key = JSON.stringify([row.date, row.modelId, row.agentId, row.activity]);
    const previous = series.get(key);
    series.set(
      key,
      previous ? { ...previous, credits: previous.credits + row.credits, calls: previous.calls + row.calls } : row,
    );
  }
  return { ...summary, breakdown: [...breakdown.values()], series: [...series.values()] };
}

export function registerCredits(
  app: FastifyInstance,
  dependencies: { runtime: WorkspaceRuntime; auth: ReturnType<typeof registerAuth>['auth'] },
) {
  const error = { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] };
  app.get(
    '/workspaces/:workspaceId/credits',
    {
      schema: {
        operationId: 'getWorkspaceCreditsV1',
        summary: 'Read the workspace credit balance and 30 days of usage visible to the caller',
        tags: ['Workspace settings'],
        params: {
          type: 'object',
          properties: { workspaceId: { type: 'string', format: 'uuid' } },
          required: ['workspaceId'],
        },
        response: {
          200: z.toJSONSchema(creditSummarySchema),
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
      try {
        return await dependencies.runtime.transaction(workspaceId, commonCompatibility, async tx => {
          await lockAuthorization(tx);
          const actor = await resolveHuman(tx, session.user.id);
          if ((await currentMember(tx, actor)).role === 'admin')
            return namedUsage(tx, await creditSummary(tx, { kind: 'workspace' }));
          return namedUsage(
            tx,
            await creditSummary(tx, { kind: 'personal', flowIds: await ownFlowIds(tx, actor) }),
            actor,
          );
        });
      } catch (cause) {
        if (cause instanceof AccessDenied) return reply.code(404).send({ error: 'workspace-not-found' });
        if (cause instanceof StorageUnavailableError) return reply.code(503).send({ error: 'credits-unavailable' });
        return reply.code(500).send({ error: 'credits-read-failed' });
      }
    },
  );
}
