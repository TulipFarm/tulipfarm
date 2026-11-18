import type { AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';

/**
 * A member's several accounts of one plan provider. Each provider module stores its own sign-ins; these helpers keep
 * the per-member limit and record which connections chats and coding runs may use.
 */
export const maxPlanAccounts = 5;
export const planUses = ['chat', 'coding'] as const;
export type PlanUse = (typeof planUses)[number];

// Workspaces below this common migration keep one connection per provider and have no use columns.
const planAccountsVersion = 89;
export const hasPlanAccounts = (tx: object) =>
  ((tx as { commonVersion?: number }).commonVersion ?? 0) >= planAccountsVersion;

const connections = (tx: AuthorizationTransaction) => qualified(tx.schema, 'tf_subscription_connections');
export const useColumn = (use: PlanUse) => (use === 'chat' ? 'use_for_chat' : 'use_for_coding');

/** How many of the member's connections of `provider` are signed in, other than `except`. */
export async function liveAccounts(
  tx: AuthorizationTransaction,
  membershipId: string,
  provider: string,
  except: string | null = null,
) {
  const result = await tx.client.query(
    `SELECT count(*)::integer AS count FROM ${connections(tx)}
      WHERE owner_membership_id=$1 AND provider=$2 AND state<>'signed-out' AND ($3::uuid IS NULL OR id<>$3::uuid)`,
    [membershipId, provider, except],
  );
  return Number((result.rows[0] as { count: number }).count);
}

/** The generation a new connection starts at, above the member's others so no two share a credential binding. */
export async function nextGeneration(tx: AuthorizationTransaction, membershipId: string, provider: string) {
  const result = await tx.client.query(
    `SELECT COALESCE(max(generation),0)+1 AS next FROM ${connections(tx)} WHERE owner_membership_id=$1 AND provider=$2`,
    [membershipId, provider],
  );
  return Number((result.rows[0] as { next: number }).next);
}

/** Turns `connectionId` on or off for chats, coding runs or both. Other connections keep their choices. */
export async function setUses(
  tx: AuthorizationTransaction,
  connectionId: string,
  uses: { chat?: boolean | undefined; coding?: boolean | undefined },
) {
  const sets = planUses.flatMap(use =>
    uses[use] === undefined ? [] : [`${useColumn(use)}=${uses[use] ? 'true' : 'false'}`],
  );
  if (!sets.length) return;
  await tx.client.query(`UPDATE ${connections(tx)} SET ${sets.join(', ')} WHERE id=$1`, [connectionId]);
}
