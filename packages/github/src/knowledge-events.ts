import { z } from 'zod';
import { inTransaction, type SqlClient } from '@tulipfarm/workspace-storage/provisioning';
import type { GitHubKnowledgeChanges } from '@tulipfarm/knowledge/github-contracts';
import { githubEventIdSchema } from './event-contracts.ts';
import { readGitHubAppDelivery } from './event-signature.ts';

/**
 * GitHub webhooks only say which repositories changed. Knowledge never indexes webhook content: a delivery makes the
 * Knowledge sources that select one of these repositories, matched by numeric repository ID, due for a pass that
 * re-reads GitHub with the source owner's own account.
 */
export const githubKnowledgeEvents = [
  'push',
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'discussion',
  'discussion_comment',
  'repository',
  'installation',
  'installation_repositories',
] as const;
// Beyond this many repositories in one delivery, every source is treated as changed.
const repositoryLimit = 1000;
const repositoryId = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string()]).transform(String);
const repositoryRef = z.object({ id: repositoryId });
const repositoryEvent = z.object({ repository: repositoryRef });
const pushEvent = z.object({
  ref: z.string(),
  repository: repositoryRef.extend({ default_branch: z.string().optional() }),
});
const repositoryActions = ['renamed', 'deleted', 'transferred', 'privatized', 'publicized', 'edited', 'archived'];
const installationEvent = z.object({ repositories: z.array(repositoryRef).optional() });
const installationRepositoriesEvent = z.object({
  repositories_added: z.array(repositoryRef).optional(),
  repositories_removed: z.array(repositoryRef).optional(),
});
const actionSchema = z.object({ action: z.string().optional() });

export type GitHubKnowledgeTrigger =
  | ({ kind: 'changed' } & GitHubKnowledgeChanges)
  | { kind: 'ignored'; reason: string }
  | { kind: 'rejected'; reason: string };

function changed(ids: readonly string[]): GitHubKnowledgeTrigger {
  const repositories = [...new Set(ids)].filter(id => /^[1-9][0-9]{0,19}$/.test(id));
  if (!repositories.length) return { kind: 'ignored', reason: 'no-repository' };
  return repositories.length > repositoryLimit
    ? { kind: 'changed', repositories: [], all: true }
    : { kind: 'changed', repositories, all: false };
}

/** Maps one verified delivery to the repositories whose Knowledge may now be stale. */
export function githubKnowledgeTrigger(event: string, body: unknown): GitHubKnowledgeTrigger {
  if (event === 'ping') return { kind: 'ignored', reason: 'ping' };
  if (!(githubKnowledgeEvents as readonly string[]).includes(event))
    return { kind: 'ignored', reason: 'unsupported-event' };
  if (event === 'push') {
    const push = pushEvent.safeParse(body);
    if (!push.success) return { kind: 'rejected', reason: 'payload-invalid' };
    const branch = push.data.repository.default_branch;
    // Knowledge indexes only the default branch, so pushes to other branches and tags change nothing it holds.
    if (!branch || push.data.ref !== `refs/heads/${branch}`) return { kind: 'ignored', reason: 'non-default-branch' };
    return changed([push.data.repository.id]);
  }
  if (event === 'installation') {
    const installation = installationEvent.safeParse(body);
    if (!installation.success) return { kind: 'rejected', reason: 'payload-invalid' };
    return changed((installation.data.repositories ?? []).map(repository => repository.id));
  }
  if (event === 'installation_repositories') {
    const installation = installationRepositoriesEvent.safeParse(body);
    if (!installation.success) return { kind: 'rejected', reason: 'payload-invalid' };
    return changed(
      [...(installation.data.repositories_added ?? []), ...(installation.data.repositories_removed ?? [])].map(
        repository => repository.id,
      ),
    );
  }
  if (event === 'repository') {
    const action = actionSchema.safeParse(body);
    if (!action.success || !repositoryActions.includes(action.data.action ?? ''))
      return { kind: 'ignored', reason: 'unsupported-action' };
  }
  const parsed = repositoryEvent.safeParse(body);
  if (!parsed.success) return { kind: 'rejected', reason: 'payload-invalid' };
  return changed([parsed.data.repository.id]);
}

const uuid = z.uuid().transform(value => value.toLowerCase());
const receiptSchema = z.object({
  delivery_id: uuid,
  body_digest: z.string(),
  event_name: z.string(),
  status: z.enum(['pending', 'routed', 'ignored', 'rejected', 'expired']),
  reason: z.string().nullable(),
});
const changesSchema = z.strictObject({
  repositories: z.array(z.string().regex(/^[1-9][0-9]{0,19}$/)).max(repositoryLimit),
  all: z.boolean(),
});
export class GitHubKnowledgeEventConflict extends Error {
  constructor() {
    super('delivery-conflict');
  }
}
type Pool = { connect(): Promise<SqlClient & { release(error?: Error | boolean): void }> };
export type GitHubKnowledgeEventReceipt = {
  deliveryId: string;
  status: 'pending' | 'routed' | 'ignored' | 'rejected' | 'expired';
  reason: string | null;
  duplicate: boolean;
};

/**
 * Records verified deliveries in the platform GitHub event inbox, deduplicated by delivery ID. A pending delivery holds
 * only the changed repository IDs until the Knowledge dispatcher has made the matching sources due.
 */
export function createGitHubKnowledgeEvents(options: {
  pool: Pool;
  appId: string;
  signingSecret: string;
  maximumPending?: number;
  // How long an undispatched delivery stays pending. Polling covers anything that expires.
  pendingHours?: number;
}) {
  const appId = githubEventIdSchema.parse(options.appId);
  const maximumPending = z
    .number()
    .int()
    .positive()
    .max(2147483647)
    .parse(options.maximumPending ?? 10000);
  const pendingHours = z
    .number()
    .int()
    .min(1)
    .max(720)
    .parse(options.pendingHours ?? 1);
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
  const receipt = (row: z.infer<typeof receiptSchema>, duplicate: boolean): GitHubKnowledgeEventReceipt => ({
    deliveryId: row.delivery_id,
    status: row.status,
    reason: row.reason,
    duplicate,
  });
  async function accept(raw: Buffer, headers: Parameters<typeof readGitHubAppDelivery>[2]) {
    const delivery = readGitHubAppDelivery(options.signingSecret, raw, headers, appId);
    const trigger = githubKnowledgeTrigger(delivery.event, delivery.body);
    return transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`github-event-inbox:${appId}`]);
      await client.query(
        'INSERT INTO app.github_event_policy(app_id,maximum_pending) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [appId, maximumPending],
      );
      const existing = receiptSchema
        .optional()
        .parse(
          (
            await client.query(
              'SELECT delivery_id,body_digest,event_name,status,reason FROM app.github_event_deliveries WHERE app_id=$1 AND delivery_id=$2',
              [appId, delivery.deliveryId],
            )
          ).rows[0],
        );
      if (existing) {
        if (existing.body_digest !== delivery.bodyDigest || existing.event_name !== delivery.event)
          throw new GitHubKnowledgeEventConflict();
        return receipt(existing, true);
      }
      let status: 'pending' | 'ignored' | 'rejected' = trigger.kind === 'changed' ? 'pending' : trigger.kind;
      let reason = trigger.kind === 'changed' ? null : trigger.reason;
      if (status === 'pending') {
        const policy = z.object({ maximum_pending: z.number(), pending: z.number() }).parse(
          (
            await client.query(
              `SELECT p.maximum_pending,(SELECT count(*)::int FROM app.github_event_deliveries d WHERE d.app_id=p.app_id AND d.status='pending' AND d.expires_at>clock_timestamp()) AS pending
              FROM app.github_event_policy p WHERE p.app_id=$1`,
              [appId],
            )
          ).rows[0],
        );
        if (policy.pending >= policy.maximum_pending) {
          status = 'rejected';
          reason = 'capacity-exceeded';
        }
      }
      const saved = receiptSchema.parse(
        (
          await client.query(
            `INSERT INTO app.github_event_deliveries (app_id,delivery_id,body_digest,event_name,status,reason,received_at,expires_at)
            SELECT $1,$2,$3,$4,$5,$6,at,at+$7::integer*interval '1 hour' FROM (SELECT clock_timestamp() AS at) time
            RETURNING delivery_id,body_digest,event_name,status,reason`,
            [appId, delivery.deliveryId, delivery.bodyDigest, delivery.event, status, reason, pendingHours],
          )
        ).rows[0],
      );
      if (status === 'pending' && trigger.kind === 'changed')
        await client.query('INSERT INTO app.github_event_payloads(app_id,delivery_id,envelope) VALUES ($1,$2,$3)', [
          appId,
          delivery.deliveryId,
          changesSchema.parse({ repositories: trigger.repositories, all: trigger.all }),
        ]);
      return receipt(saved, false);
    });
  }
  /** Pending deliveries, oldest first. Deliveries past their expiry are closed instead; polling covers them. */
  async function pending(limit = 500) {
    const count = z.number().int().min(1).max(1000).parse(limit);
    return transaction(async client => {
      const expired = await client.query(
        `UPDATE app.github_event_deliveries SET status='expired' WHERE app_id=$1 AND status='pending' AND expires_at<=clock_timestamp() RETURNING delivery_id`,
        [appId],
      );
      if (expired.rowCount)
        await client.query('DELETE FROM app.github_event_payloads WHERE app_id=$1 AND delivery_id=ANY($2::uuid[])', [
          appId,
          expired.rows.map(row => (row as { delivery_id: string }).delivery_id),
        ]);
      const rows = z.array(z.object({ delivery_id: uuid, envelope: z.unknown() })).parse(
        (
          await client.query(
            `SELECT d.delivery_id,p.envelope FROM app.github_event_deliveries d
              JOIN app.github_event_payloads p ON p.app_id=d.app_id AND p.delivery_id=d.delivery_id
              WHERE d.app_id=$1 AND d.status='pending' ORDER BY d.expires_at,d.delivery_id LIMIT $2`,
            [appId, count],
          )
        ).rows,
      );
      // Payloads written by other GitHub event consumers are not Knowledge changes and are left for them.
      return rows.flatMap(row => {
        const changes = changesSchema.safeParse(row.envelope);
        return changes.success ? [{ deliveryId: row.delivery_id, ...changes.data }] : [];
      });
    });
  }
  /** Closes deliveries whose sources have been made due. */
  async function settle(deliveryIds: readonly string[]) {
    const ids = z.array(uuid).max(1000).parse(deliveryIds);
    if (!ids.length) return;
    await transaction(async client => {
      const routed = await client.query(
        `UPDATE app.github_event_deliveries SET status='routed' WHERE app_id=$1 AND delivery_id=ANY($2::uuid[]) AND status='pending' RETURNING delivery_id`,
        [appId, ids],
      );
      if (routed.rowCount)
        await client.query('DELETE FROM app.github_event_payloads WHERE app_id=$1 AND delivery_id=ANY($2::uuid[])', [
          appId,
          routed.rows.map(row => (row as { delivery_id: string }).delivery_id),
        ]);
    });
  }
  return { accept, pending, settle };
}
export type GitHubKnowledgeEvents = ReturnType<typeof createGitHubKnowledgeEvents>;

/** Merges pending deliveries into one set of changed repositories. */
export function mergeGitHubKnowledgeChanges(changes: readonly GitHubKnowledgeChanges[]): GitHubKnowledgeChanges {
  const repositories = [...new Set(changes.flatMap(change => [...change.repositories]))];
  const all = changes.some(change => change.all) || repositories.length > 10 * repositoryLimit;
  return { all, repositories: all ? [] : repositories };
}
