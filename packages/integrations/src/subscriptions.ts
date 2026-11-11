import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  resolveHuman,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { commonCompatibility, qualified, type createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';

/**
 * Subscription connections: a member's own ChatGPT, Claude or Copilot plan, which model calls can run on for its owner
 * and for the members, teams or whole workspace it is shared with. Each provider module keeps its own sign-in and
 * tokens; this module owns sharing and the order in which a caller's eligible plans are tried.
 */
export const subscriptionProviders = ['chatgpt', 'claude', 'copilot'] as const;
export type SubscriptionProvider = (typeof subscriptionProviders)[number];

export const subscriptionGranteeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('member'), membershipId: z.uuid() }),
  z.strictObject({ kind: z.literal('team'), teamId: z.uuid() }),
  z.strictObject({ kind: z.literal('workspace') }),
]);
export const subscriptionGrantSchema = z.strictObject({
  grantee: subscriptionGranteeSchema,
  role: z.enum(['use', 'manage']),
});
export type SubscriptionGrant = z.infer<typeof subscriptionGrantSchema>;

/** A plan a caller may use, best first. `ownerMembershipId` identifies it to its provider module. */
export type SubscriptionCandidate = {
  connectionId: string;
  ownerMembershipId: string;
  models: readonly string[];
};

export type SharedSubscription = {
  connectionId: string;
  provider: SubscriptionProvider;
  ownerMembershipId: string;
  account: string | null;
  state: 'connected' | 'plan-disabled' | 'reconnect-required' | 'signed-out';
  /** The caller owns it, administers the workspace, or holds a manage grant. */
  canShare: boolean;
  /** Present only when `canShare`. */
  grants: SubscriptionGrant[] | null;
};

export class SubscriptionError extends Error {
  constructor(readonly code: 'not-found' | 'not-connected' | 'invalid-grant') {
    super(`subscription-${code}`);
    this.name = 'SubscriptionError';
  }
}

type Runtime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
const uuid = z.uuid();
const defaultCooldownMs = 15 * 60_000;
const maxCooldownMs = 24 * 60 * 60_000;
const storedModels = z.array(z.object({ slug: z.string() }).loose()).max(200);
const candidateRow = z.object({ id: z.uuid(), owner_membership_id: z.uuid(), models: z.unknown() });
const connectionRow = z.object({
  id: z.uuid(),
  provider: z.enum(subscriptionProviders),
  owner_membership_id: z.uuid(),
  email: z.string().nullable(),
  state: z.enum(['connected', 'plan-disabled', 'reconnect-required', 'signed-out']),
  manage: z.boolean(),
});
const grantRow = z.object({
  connection_id: z.uuid(),
  membership_id: z.uuid().nullable(),
  team_id: z.uuid().nullable(),
  role: z.enum(['use', 'manage']),
});

function grantOf(row: z.infer<typeof grantRow>): SubscriptionGrant {
  const grantee: SubscriptionGrant['grantee'] = row.membership_id
    ? { kind: 'member', membershipId: row.membership_id }
    : row.team_id
      ? { kind: 'team', teamId: row.team_id }
      : { kind: 'workspace' };
  return { grantee, role: row.role };
}

function granteeKey(grantee: SubscriptionGrant['grantee']) {
  return grantee.kind === 'workspace'
    ? 'workspace'
    : grantee.kind === 'team'
      ? `team:${grantee.teamId}`
      : `member:${grantee.membershipId}`;
}

/**
 * The SQL rank of a connection for `$2` (the caller's membership, or null for memberless runs): 1 own, 2 shared with
 * the caller, 3 shared with one of the caller's teams, 4 shared with the workspace. Null when the caller can't use it.
 */
function rankSql(tx: AuthorizationTransaction) {
  const teams = qualified(tx.schema, 'tf_member_teams');
  return `MIN(CASE
    WHEN c.owner_membership_id = $2::uuid THEN 1
    WHEN g.membership_id = $2::uuid THEN 2
    WHEN g.team_id IN (SELECT team_id FROM ${teams} WHERE membership_id = $2::uuid) THEN 3
    WHEN g.grantee = 'workspace' THEN 4
  END)`;
}

export function createSubscriptions(options: { runtime: Runtime }) {
  const { runtime } = options;
  const connections = (tx: AuthorizationTransaction) => qualified(tx.schema, 'tf_subscription_connections');
  const grants = (tx: AuthorizationTransaction) => qualified(tx.schema, 'tf_subscription_grants');
  const memberships = (tx: AuthorizationTransaction) => qualified(tx.schema, 'tf_memberships');

  async function authorized<T>(
    workspaceId: string,
    userId: string,
    mode: 'read' | 'write',
    operation: (tx: AuthorizationTransaction, actor: HumanActor, admin: boolean) => Promise<T>,
  ) {
    return runtime.transaction(uuid.parse(workspaceId), commonCompatibility, async tx => {
      await lockAuthorization(tx, mode);
      const actor = await resolveHuman(tx, userId);
      const member = await currentMember(tx, actor);
      return operation(tx, actor, member.role === 'admin');
    });
  }

  /** Connected plans of `provider` that `caller` may use, in the order they are tried. */
  async function eligibleIn(tx: AuthorizationTransaction, provider: SubscriptionProvider, caller: string | null) {
    const rows = await tx.client.query(
      `SELECT c.id, c.owner_membership_id, c.models, ${rankSql(tx)} AS rank
         FROM ${connections(tx)} c
         JOIN ${memberships(tx)} m ON m.id = c.owner_membership_id AND m.removed_at IS NULL
         LEFT JOIN ${grants(tx)} g ON g.connection_id = c.id
        WHERE c.provider = $1 AND c.state = 'connected'
          AND (c.cooldown_until IS NULL OR c.cooldown_until <= clock_timestamp())
        GROUP BY c.id
       HAVING ${rankSql(tx)} IS NOT NULL
        ORDER BY rank, c.last_used_at NULLS FIRST, c.id`,
      [provider, caller === null ? null : uuid.parse(caller)],
    );
    return rows.rows.map(raw => {
      const row = candidateRow.parse(raw);
      return {
        connectionId: row.id,
        ownerMembershipId: row.owner_membership_id,
        models: (storedModels.safeParse(row.models).data ?? []).map(model => model.slug),
      } satisfies SubscriptionCandidate;
    });
  }

  /** The connections visible to the actor: their own, and every one shared with them, their teams or the workspace. */
  async function visible(tx: AuthorizationTransaction, actor: HumanActor, admin: boolean) {
    const rows = await tx.client.query(
      `SELECT c.id, c.provider, c.owner_membership_id, c.email, c.state,
              (c.owner_membership_id = $1::uuid OR $2::boolean
                OR bool_or(g.role = 'manage' AND g.membership_id = $1::uuid)) AS manage
         FROM ${connections(tx)} c
         JOIN ${memberships(tx)} m ON m.id = c.owner_membership_id AND m.removed_at IS NULL
         LEFT JOIN ${grants(tx)} g ON g.connection_id = c.id
        GROUP BY c.id
       HAVING c.owner_membership_id = $1::uuid
           OR bool_or(g.membership_id = $1::uuid OR g.grantee = 'workspace'
                OR g.team_id IN (SELECT team_id FROM ${qualified(tx.schema, 'tf_member_teams')} WHERE membership_id = $1::uuid))
           OR ($2::boolean AND c.state <> 'signed-out')
        ORDER BY c.provider, c.created_at`,
      [actor.membershipId, admin],
    );
    return rows.rows.map(raw => connectionRow.parse(raw));
  }

  async function grantsOf(tx: AuthorizationTransaction, connectionIds: readonly string[]) {
    if (!connectionIds.length) return new Map<string, SubscriptionGrant[]>();
    const rows = await tx.client.query(
      `SELECT connection_id, membership_id, team_id, role FROM ${grants(tx)} WHERE connection_id = ANY($1::uuid[])
        ORDER BY created_at`,
      [connectionIds],
    );
    const byConnection = new Map<string, SubscriptionGrant[]>();
    for (const raw of rows.rows) {
      const row = grantRow.parse(raw);
      byConnection.set(row.connection_id, [...(byConnection.get(row.connection_id) ?? []), grantOf(row)]);
    }
    return byConnection;
  }

  return {
    /** For a model call: the plans `caller` may use, best first. A null caller (Slack, workflows) gets workspace shares. */
    async eligible(workspaceId: string, provider: SubscriptionProvider, caller: string | null) {
      return runtime.transaction(uuid.parse(workspaceId), commonCompatibility, tx => eligibleIn(tx, provider, caller));
    },

    /** Records that a plan answered, so ties go to the plan used least recently. */
    async markUsed(workspaceId: string, connectionId: string) {
      await runtime.transaction(uuid.parse(workspaceId), commonCompatibility, async tx => {
        await tx.client.query(`UPDATE ${connections(tx)} SET last_used_at = clock_timestamp() WHERE id = $1`, [
          uuid.parse(connectionId),
        ]);
      });
    },

    /** Skips a plan that reported its usage limit until `retryAfterMs` (15 minutes when unknown) has passed. */
    async coolDown(workspaceId: string, connectionId: string, retryAfterMs?: number) {
      const ms = Math.min(Math.max(retryAfterMs ?? defaultCooldownMs, 60_000), maxCooldownMs);
      await runtime.transaction(uuid.parse(workspaceId), commonCompatibility, async tx => {
        await tx.client.query(
          `UPDATE ${connections(tx)} SET cooldown_until = clock_timestamp() + $2 * interval '1 millisecond' WHERE id = $1`,
          [uuid.parse(connectionId), ms],
        );
      });
    },

    /** Plans the signed-in member can see, with their shares where the member may change them. */
    async list(workspaceId: string, userId: string): Promise<SharedSubscription[]> {
      return authorized(workspaceId, userId, 'read', async (tx, actor, admin) => {
        const rows = await visible(tx, actor, admin);
        const shared = await grantsOf(
          tx,
          rows.filter(row => row.manage).map(row => row.id),
        );
        return rows.map(row => ({
          connectionId: row.id,
          provider: row.provider,
          ownerMembershipId: row.owner_membership_id,
          account: row.email,
          state: row.state,
          canShare: row.manage,
          grants: row.manage ? (shared.get(row.id) ?? []) : null,
        }));
      });
    },

    /** Models of `provider` the signed-in member can pick: those of every plan they may use. */
    async models(workspaceId: string, userId: string, provider: SubscriptionProvider) {
      try {
        return await authorized(workspaceId, userId, 'read', async (tx, actor) => [
          ...new Set((await eligibleIn(tx, provider, actor.membershipId)).flatMap(candidate => candidate.models)),
        ]);
      } catch (error) {
        if (error instanceof AccessDenied) return [];
        throw error;
      }
    },

    /**
     * Replaces a connection's shares. The owner, workspace admins and members with a manage grant may change them; only
     * individual members can be given manage. Team shares need membership of the team unless the actor is an admin.
     */
    async share(workspaceId: string, userId: string, connectionId: string, next: readonly SubscriptionGrant[]) {
      const parsed = z.array(subscriptionGrantSchema).max(200).parse(next);
      const keys = parsed.map(grant => granteeKey(grant.grantee));
      if (new Set(keys).size !== keys.length) throw new SubscriptionError('invalid-grant');
      if (parsed.some(grant => grant.role === 'manage' && grant.grantee.kind !== 'member'))
        throw new SubscriptionError('invalid-grant');
      return authorized(workspaceId, userId, 'write', async (tx, actor, admin) => {
        const row = (await visible(tx, actor, admin)).find(item => item.id === uuid.parse(connectionId));
        if (!row) throw new SubscriptionError('not-found');
        if (!row.manage) throw new AccessDenied();
        if (row.state === 'signed-out') throw new SubscriptionError('not-connected');
        if (
          parsed.some(
            grant => grant.grantee.kind === 'member' && grant.grantee.membershipId === row.owner_membership_id,
          )
        )
          throw new SubscriptionError('invalid-grant');
        const before = (await grantsOf(tx, [row.id])).get(row.id) ?? [];
        const kept = new Set(before.map(grant => granteeKey(grant.grantee)));
        for (const grant of parsed) {
          if (grant.grantee.kind !== 'team' || admin || kept.has(granteeKey(grant.grantee))) continue;
          const member = await tx.client.query(
            `SELECT 1 FROM ${qualified(tx.schema, 'tf_member_teams')} WHERE membership_id = $1 AND team_id = $2`,
            [actor.membershipId, grant.grantee.teamId],
          );
          if (!member.rowCount) throw new AccessDenied();
        }
        for (const grant of parsed) {
          if (grant.grantee.kind !== 'member') continue;
          const active = await tx.client.query(
            `SELECT 1 FROM ${memberships(tx)} WHERE id = $1 AND removed_at IS NULL`,
            [grant.grantee.membershipId],
          );
          if (!active.rowCount) throw new SubscriptionError('invalid-grant');
        }
        await tx.client.query(`DELETE FROM ${grants(tx)} WHERE connection_id = $1`, [row.id]);
        for (const grant of parsed)
          await tx.client.query(
            `INSERT INTO ${grants(tx)} (connection_id, grantee, membership_id, team_id, role, granted_by)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              row.id,
              granteeKey(grant.grantee),
              grant.grantee.kind === 'member' ? grant.grantee.membershipId : null,
              grant.grantee.kind === 'team' ? grant.grantee.teamId : null,
              grant.role,
              actor.membershipId,
            ],
          );
        return parsed;
      });
    },
  };
}
export type Subscriptions = ReturnType<typeof createSubscriptions>;
