import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import type { IntegrationKeyring } from '@tulipfarm/integrations';
import { inTransaction, type SqlClient } from '@tulipfarm/workspace-storage/provisioning';
import { githubEventIdSchema } from './event-contracts.ts';
import { githubEventContent } from './event-content.ts';
import type { GitHubStoredEvent } from './event-content.ts';
import { GitHubEventError, normalizeGitHubEvent } from './events.ts';
import { readGitHubAppDelivery } from './event-signature.ts';

export class GitHubInboxError extends Error {
  readonly code: 'delivery-conflict' | 'policy-conflict' | 'lease-lost';
  constructor(code: GitHubInboxError['code']) {
    super(code);
    this.code = code;
  }
}
const uuid = z.uuid().transform(value => value.toLowerCase());
const reason = z.string().regex(/^[a-z][a-z0-9-]{0,99}$/);
const receiptSchema = z.object({
  delivery_id: uuid,
  body_digest: z.string(),
  event_name: z.string(),
  status: z.enum(['pending', 'routed', 'ignored', 'rejected', 'expired']),
  reason: reason.nullable(),
  received_at: z.date(),
  expires_at: z.date(),
});
const targetSchema = z.strictObject({
  deliveryId: uuid,
  workspaceId: uuid,
  sourceId: uuid,
  generation: z.number().int().positive(),
  leaseId: uuid,
  expiresAt: z.date(),
});
const routeSchema = z.object({ workspace_id: uuid, source_id: uuid, generation: z.number().int().positive() });
export type GitHubEventLease = z.infer<typeof targetSchema>;
export type GitHubEventAuthority = GitHubEventLease &
  Pick<GitHubStoredEvent, 'installationId' | 'repositoryId' | 'ownerId' | 'ownerKind' | 'privateRepository'>;
type Pool = { connect(): Promise<SqlClient & { release(error?: Error | boolean): void }> };

/** Platform routes locate sources; the required worker callback and workspace admission enforce authority. */
export function createGitHubEventInbox(options: {
  pool: Pool;
  appId: string;
  signingSecret: string;
  keyring: IntegrationKeyring;
  maximumPending: number;
}) {
  const appId = githubEventIdSchema.parse(options.appId);
  const maximumPending = z.number().int().positive().max(2147483647).parse(options.maximumPending);
  const content = githubEventContent(options.keyring);
  async function transaction<T>(operation: (client: SqlClient) => Promise<T>) {
    const client = await options.pool.connect();
    let reusable = false;
    try {
      const result = await inTransaction(client, operation, { statementTimeoutMs: 5000, lockTimeoutMs: 1000 });
      reusable = true;
      return result;
    } finally {
      client.release(!reusable);
    }
  }
  const identity = (lease: GitHubEventLease) => [
    appId,
    lease.deliveryId,
    lease.workspaceId,
    lease.sourceId,
    lease.leaseId,
  ];
  function receipt(row: z.infer<typeof receiptSchema>, duplicate: boolean) {
    return {
      deliveryId: row.delivery_id,
      status: row.status,
      reason: row.reason,
      receivedAt: row.received_at,
      expiresAt: row.expires_at,
      duplicate,
    };
  }
  async function settle(client: SqlClient, deliveryId: string) {
    const changed = await client.query(
      `UPDATE app.github_event_deliveries d SET status='routed'
      WHERE app_id=$1 AND delivery_id=$2 AND status='pending'
        AND NOT EXISTS (SELECT 1 FROM app.github_event_dispatches t WHERE t.app_id=d.app_id AND t.delivery_id=d.delivery_id AND t.status='pending')
      RETURNING delivery_id`,
      [appId, deliveryId],
    );
    if (changed.rowCount)
      await client.query('DELETE FROM app.github_event_payloads WHERE app_id=$1 AND delivery_id=$2', [
        appId,
        deliveryId,
      ]);
  }
  async function accept(raw: Buffer, headers: Parameters<typeof readGitHubAppDelivery>[2]) {
    const delivery = readGitHubAppDelivery(options.signingSecret, raw, headers, appId);
    let normalized;
    try {
      normalized = normalizeGitHubEvent(delivery.event, delivery.body);
    } catch (error) {
      if (!(error instanceof GitHubEventError)) throw error;
      normalized = { kind: 'rejected' as const, reason: error.code };
    }
    const event = normalized;
    return transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`github-event-inbox:${appId}`]);
      await client.query(
        `INSERT INTO app.github_event_policy(app_id,maximum_pending) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [appId, maximumPending],
      );
      const policy = z
        .object({ maximum_pending: z.number() })
        .parse(
          (await client.query('SELECT maximum_pending FROM app.github_event_policy WHERE app_id=$1', [appId])).rows[0],
        );
      if (policy.maximum_pending !== maximumPending) throw new GitHubInboxError('policy-conflict');
      const existing = receiptSchema
        .optional()
        .parse(
          (
            await client.query('SELECT * FROM app.github_event_deliveries WHERE app_id=$1 AND delivery_id=$2', [
              appId,
              delivery.deliveryId,
            ])
          ).rows[0],
        );
      if (existing) {
        if (existing.body_digest !== delivery.bodyDigest || existing.event_name !== delivery.event)
          throw new GitHubInboxError('delivery-conflict');
        return receipt(existing, true);
      }
      let status: z.infer<typeof receiptSchema>['status'] = 'pending';
      let outcomeReason: string | null = null;
      let routes: z.infer<typeof routeSchema>[] = [];
      if (event.kind === 'ignored' || event.kind === 'rejected') {
        status = event.kind;
        outcomeReason = delivery.event === 'ping' ? 'ping' : event.reason;
        if (['installation', 'installation_repositories'].includes(delivery.event)) {
          status = 'rejected';
          outcomeReason = 'lifecycle-reconciliation-required';
        }
      } else {
        routes = z.array(routeSchema).parse(
          (
            await client.query(
              `SELECT workspace_id,source_id,generation FROM app.github_event_routes
          WHERE app_id=$1 AND installation_id=$2 AND active ORDER BY workspace_id,source_id LIMIT 1001`,
              [appId, event.installationId],
            )
          ).rows,
        );
        const pending = z.object({ count: z.number() }).parse(
          (
            await client.query(
              `SELECT count(*)::int AS count FROM app.github_event_deliveries
          WHERE app_id=$1 AND status='pending'`,
              [appId],
            )
          ).rows[0],
        );
        if (routes.length === 0) {
          status = 'ignored';
          outcomeReason = 'no-active-source';
        } else if (routes.length > 1000 || pending.count >= maximumPending) {
          status = 'rejected';
          outcomeReason = 'capacity-exceeded';
        }
      }
      const saved = receiptSchema.parse(
        (
          await client.query(
            `INSERT INTO app.github_event_deliveries
        (app_id,delivery_id,body_digest,event_name,status,reason,received_at,expires_at)
        SELECT $1,$2,$3,$4,$5,$6,at,at+interval '720 hours' FROM (SELECT clock_timestamp() AS at) time
        RETURNING *`,
            [appId, delivery.deliveryId, delivery.bodyDigest, delivery.event, status, outcomeReason],
          )
        ).rows[0],
      );
      if (status === 'pending' && (event.kind === 'event' || event.kind === 'pull-request-required')) {
        const envelope = content.encrypt(
          { appId, deliveryId: delivery.deliveryId, bodyDigest: delivery.bodyDigest, event: delivery.event },
          event,
        );
        await client.query('INSERT INTO app.github_event_payloads(app_id,delivery_id,envelope) VALUES ($1,$2,$3)', [
          appId,
          delivery.deliveryId,
          envelope,
        ]);
        await client.query(
          `INSERT INTO app.github_event_dispatches(app_id,delivery_id,installation_id,workspace_id,source_id,generation)
          SELECT $1,$2,$3,workspace_id,source_id,generation
          FROM jsonb_to_recordset($4::jsonb) AS targets(workspace_id uuid,source_id uuid,generation integer)`,
          [appId, delivery.deliveryId, event.installationId, JSON.stringify(routes)],
        );
      }
      return receipt(saved, false);
    });
  }
  async function finish(
    input: GitHubEventLease,
    outcome: { status: 'delivered' } | { status: 'blocked'; reason: string },
  ) {
    const lease = targetSchema.parse(input);
    const result = z
      .discriminatedUnion('status', [
        z.strictObject({ status: z.literal('delivered') }),
        z.strictObject({ status: z.literal('blocked'), reason }),
      ])
      .parse(outcome);
    return transaction(async client => {
      await client.query(
        'SELECT delivery_id FROM app.github_event_deliveries WHERE app_id=$1 AND delivery_id=$2 FOR UPDATE',
        [appId, lease.deliveryId],
      );
      const replay = await client.query(
        `SELECT 1 FROM app.github_event_dispatches
        WHERE app_id=$1 AND delivery_id=$2 AND workspace_id=$3 AND source_id=$4 AND completed_lease_id=$5
          AND status=$6 AND reason IS NOT DISTINCT FROM $7`,
        [...identity(lease), result.status, result.status === 'blocked' ? result.reason : null],
      );
      if (replay.rowCount) return;
      const changed = await client.query(
        `UPDATE app.github_event_dispatches SET status=$6,reason=$7,completed_lease_id=lease_id,lease_id=NULL,lease_until=NULL
        WHERE app_id=$1 AND delivery_id=$2 AND workspace_id=$3 AND source_id=$4 AND lease_id=$5
          AND status='pending' AND lease_until>clock_timestamp()
        RETURNING delivery_id`,
        [...identity(lease), result.status, result.status === 'blocked' ? result.reason : null],
      );
      if (!changed.rowCount) throw new GitHubInboxError('lease-lost');
      await settle(client, lease.deliveryId);
    });
  }
  async function claim(authorize: (source: GitHubEventAuthority) => Promise<void>) {
    const lease = await transaction(async client => {
      const selected = z
        .object({
          delivery_id: uuid,
          workspace_id: uuid,
          source_id: uuid,
          generation: z.number(),
          expires_at: z.date(),
        })
        .optional()
        .parse(
          (
            await client.query(
              `SELECT t.delivery_id,t.workspace_id,t.source_id,t.generation,d.expires_at
        FROM app.github_event_dispatches t JOIN app.github_event_deliveries d USING(app_id,delivery_id)
        JOIN app.github_event_routes r USING(app_id,installation_id,workspace_id,source_id)
        WHERE t.app_id=$1 AND t.status='pending' AND d.status='pending' AND d.expires_at>clock_timestamp()
          AND r.active AND r.generation=t.generation AND t.next_attempt_at<=clock_timestamp()
          AND (t.lease_until IS NULL OR t.lease_until<=clock_timestamp())
        ORDER BY t.next_attempt_at,t.delivery_id,t.workspace_id,t.source_id LIMIT 1 FOR UPDATE OF t SKIP LOCKED`,
              [appId],
            )
          ).rows[0],
        );
      if (!selected) return null;
      const result = {
        deliveryId: selected.delivery_id,
        workspaceId: selected.workspace_id,
        sourceId: selected.source_id,
        generation: selected.generation,
        expiresAt: selected.expires_at,
        leaseId: randomUUID(),
      };
      await client.query(
        `UPDATE app.github_event_dispatches SET lease_id=$5,lease_until=clock_timestamp()+interval '60 seconds'
        WHERE app_id=$1 AND delivery_id=$2 AND workspace_id=$3 AND source_id=$4`,
        identity(result),
      );
      return result;
    });
    if (!lease) return null;
    const event = await transaction(async client => {
      const row = z
        .object({ body_digest: z.string(), event_name: z.string(), envelope: z.unknown() })
        .optional()
        .parse(
          (
            await client.query(
              `SELECT d.body_digest,d.event_name,p.envelope FROM app.github_event_dispatches t
          JOIN app.github_event_deliveries d USING(app_id,delivery_id) JOIN app.github_event_payloads p USING(app_id,delivery_id)
          JOIN app.github_event_routes r USING(app_id,installation_id,workspace_id,source_id)
          WHERE t.app_id=$1 AND t.delivery_id=$2 AND t.workspace_id=$3 AND t.source_id=$4 AND t.lease_id=$5
            AND t.status='pending' AND t.lease_until>clock_timestamp() AND d.status='pending' AND d.expires_at>clock_timestamp()
            AND r.active AND r.generation=t.generation`,
              identity(lease),
            )
          ).rows[0],
        );
      if (!row) throw new GitHubInboxError('lease-lost');
      return content.decrypt(
        { appId, deliveryId: lease.deliveryId, bodyDigest: row.body_digest, event: row.event_name },
        row.envelope,
      );
    });
    try {
      await authorize({
        ...lease,
        installationId: event.installationId,
        repositoryId: event.repositoryId,
        ownerId: event.ownerId,
        ownerKind: event.ownerKind,
        privateRepository: event.privateRepository,
      });
    } catch (error) {
      if (!(error instanceof AccessDenied)) throw error;
      await finish(lease, { status: 'blocked', reason: 'source-access-denied' });
      return { kind: 'blocked' as const, lease };
    }
    await transaction(async client => {
      const current = await client.query(
        `SELECT 1 FROM app.github_event_dispatches t
        JOIN app.github_event_deliveries d USING(app_id,delivery_id)
        JOIN app.github_event_routes r USING(app_id,installation_id,workspace_id,source_id)
        WHERE t.app_id=$1 AND t.delivery_id=$2 AND t.workspace_id=$3 AND t.source_id=$4 AND t.lease_id=$5
          AND t.status='pending' AND t.lease_until>clock_timestamp() AND d.status='pending' AND d.expires_at>clock_timestamp()
          AND r.active AND r.generation=t.generation`,
        identity(lease),
      );
      if (!current.rowCount) throw new GitHubInboxError('lease-lost');
    });
    return { kind: 'ready' as const, lease, event };
  }
  async function defer(input: GitHubEventLease, delaySeconds: number, errorCode: string) {
    const lease = targetSchema.parse(input),
      delay = z.number().int().min(1).max(900).parse(delaySeconds),
      code = reason.parse(errorCode);
    await transaction(async client => {
      const changed = await client.query(
        `UPDATE app.github_event_dispatches SET lease_id=NULL,lease_until=NULL,
        next_attempt_at=clock_timestamp()+$6*interval '1 second',reason=$7
        WHERE app_id=$1 AND delivery_id=$2 AND workspace_id=$3 AND source_id=$4 AND lease_id=$5
          AND status='pending' AND lease_until>clock_timestamp() RETURNING delivery_id`,
        [...identity(lease), delay, code],
      );
      if (!changed.rowCount) throw new GitHubInboxError('lease-lost');
    });
  }
  async function expire(limit: number) {
    const batch = z.number().int().min(1).max(1000).parse(limit);
    return transaction(async client => {
      const rows = z.array(z.object({ delivery_id: uuid })).parse(
        (
          await client.query(
            `SELECT delivery_id FROM app.github_event_deliveries
        WHERE app_id=$1 AND status='pending' AND expires_at<=clock_timestamp()
        ORDER BY expires_at,delivery_id LIMIT $2 FOR UPDATE SKIP LOCKED`,
            [appId, batch],
          )
        ).rows,
      );
      for (const row of rows) {
        await client.query(
          `UPDATE app.github_event_dispatches SET status='expired',lease_id=NULL,lease_until=NULL
          WHERE app_id=$1 AND delivery_id=$2 AND status='pending'`,
          [appId, row.delivery_id],
        );
        await client.query('DELETE FROM app.github_event_payloads WHERE app_id=$1 AND delivery_id=$2', [
          appId,
          row.delivery_id,
        ]);
        await client.query(
          `UPDATE app.github_event_deliveries SET status='expired' WHERE app_id=$1 AND delivery_id=$2`,
          [appId, row.delivery_id],
        );
      }
      return rows.length;
    });
  }
  return { accept, claim, finish, defer, expire };
}
