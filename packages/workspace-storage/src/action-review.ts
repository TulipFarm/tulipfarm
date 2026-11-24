import { qualified } from './names.ts';
import type { SqlClient } from './transactions.ts';
import {
  reviewActionSchema,
  reviewPolicySchema,
  type ReviewAction,
  type ReviewPolicy,
} from './action-review-contracts.ts';
export {
  reviewActionSchema,
  reviewPolicySchema,
  type ReviewAction,
  type ReviewPolicy,
} from './action-review-contracts.ts';

/** Holds a shared row lock until the caller's effect commits, fencing concurrent policy changes. */
export async function readReviewPolicy(tx: {
  client: SqlClient;
  schema: string;
  commonVersion?: number;
}): Promise<ReviewPolicy> {
  // The locked migration ledger proves pre-113 workspaces cannot have a saved policy.
  if (
    tx.commonVersion !== undefined &&
    Number.isInteger(tx.commonVersion) &&
    tx.commonVersion >= 1 &&
    tx.commonVersion < 113
  )
    return { mode: 'legacy', revision: 0, rule: null, interpretation: null, actions: [] };
  const result = await tx.client.query(
    `SELECT mode, revision, rule, interpretation, actions FROM ${qualified(tx.schema, 'tf_action_review')} WHERE id = 1 FOR SHARE`,
  );
  const parsed = reviewPolicySchema.safeParse(result.rows[0]);
  if (!parsed.success) throw new Error('Invalid workspace action review policy');
  const policy = parsed.data;
  if (
    policy.mode === 'ask'
      ? !policy.rule || !policy.interpretation || !policy.actions.length
      : policy.rule !== null || policy.interpretation !== null || policy.actions.length !== 0
  )
    throw new Error('Inconsistent workspace action review policy');
  return policy;
}

/** Only the workspace review gate; all other approval and permission checks still apply. */
export function shouldAsk(policy: ReviewPolicy, action: ReviewAction) {
  reviewActionSchema.parse(action);
  switch (policy.mode) {
    case 'auto':
      return false;
    case 'ask':
      return policy.actions.includes(action);
    case 'legacy':
      return !['create-row', 'update-row', 'delete-row'].includes(action);
    default:
      throw new Error('Invalid workspace action review mode');
  }
}
