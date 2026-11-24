import { AccessDenied, protectedSourceClosure, type HumanActor, type SourceDependency } from '@tulipfarm/access';
import { readReviewPolicy, shouldAsk, type ReviewAction } from '@tulipfarm/workspace-storage/action-review';
import { relation, type AgentStorage, type AgentTransaction } from './store.ts';
import { withHuman } from './saved-policy.ts';
import { digestJson } from '@tulipfarm/tables/canonical';

type Context = {
  workspaceId: string;
  actor: HumanActor;
  callId: string;
  origin?: {
    conversationId: string;
    turnId: string;
    sources: readonly SourceDependency[];
    files?: readonly unknown[] | undefined;
  };
};

/** Auto is opt-in at the private Bud worker composition, never a tool argument. */
export type PrivateBudReview = {
  link(workspaceId: string, kind: string, id: string): Promise<string | undefined>;
};

export function explicitCreation(text: string, kind: string) {
  // Accept a single imperative only. Questions, qualifications and previews keep their card.
  if (
    /[?;\n]/.test(text) ||
    /[.!]\s+\S/.test(text) ||
    /\b(?:not|no|never|don't|don’t|without|before|after|if|unless|until|first|later|only|just|instead|but|preview\w*|example|draft\w*|review\w*|mock\w*|simulat\w*|plan|propos\w*|approv\w*|confirm\w*|wait|hold|show|explain|hypothetical|imaginary|illustrat\w*|sketch|diagram|representation|prototype|dry.run|in.chat)\b/i.test(
      text,
    )
  )
    return false;
  return new RegExp(
    `^(?:please\\s+)?(?:create|build|make|set up)\\s+(?:(?:me|a|an|new|private|inactive)\\s+)*(?:(?!(?:of|for|to|the|how|in|on|or|and)\\b)[\\w-]+\\s+){0,3}${kind}(?:\\s+(?:named|called|for|to|with|that)\\s+[\\w '"’,-]+)?[.!]?$`,
    'i',
  ).test(text.trim());
}

async function pending(tx: AgentTransaction, chat: string, action: ReviewAction, callId: string) {
  const name = (s: string) => relation(tx, s);
  if (action === 'create-table')
    return (
      await tx.client.query(
        `SELECT 1 FROM ${name('tf_table_proposals')} p WHERE conversation_id=$1 AND
      (p.id=$2 OR (expires_at>now() AND NOT EXISTS (SELECT 1 FROM ${name('tf_table_proposal_decisions')} d WHERE d.proposal_id=p.id)
       AND NOT EXISTS (SELECT 1 FROM ${name('tf_action_review_receipts')} r WHERE r.call_id=p.id))) LIMIT 1`,
        [chat, callId],
      )
    ).rowCount;
  if (action === 'create-skill')
    return (
      await tx.client.query(
        `SELECT 1 FROM ${name('tf_skill_imports')} WHERE id=$2 OR
      (sources @> jsonb_build_array(jsonb_build_object('kind','private-conversation','conversationId',$1::text))
       AND status IN ('pending','preparing','discovered','pending-review','reviewing','ready') AND expires_at>now()) LIMIT 1`,
        [chat, callId],
      )
    ).rowCount;
  return (
    await tx.client.query(
      `SELECT 1 FROM ${name('tf_chat_authoring_drafts')} d WHERE conversation_id=$1 AND
    (id=$2 OR (proposal->>'kind'=$3 AND NOT EXISTS (SELECT 1 FROM ${name('tf_chat_authoring_decisions')} c WHERE c.draft_id=d.id))) LIMIT 1`,
      [chat, callId, action.endsWith('-row') ? 'row' : action.slice(7)],
    )
  ).rowCount;
}

export async function policyWrite(
  runtime: AgentStorage,
  privateBud: PrivateBudReview | undefined,
  context: Context,
  action: ReviewAction,
  input: unknown,
  write?: (bound: AgentStorage, tx: AgentTransaction, revision: number) => Promise<Record<string, unknown> | null>,
): Promise<{ result: Record<string, unknown> } | { review: true } | { eligible: true } | null> {
  const { actor, origin, workspaceId, callId } = context;
  if (!privateBud || !origin) return null;
  const row = action.endsWith('-row');
  const untrusted = (source: SourceDependency) =>
    ![
      'private-conversation',
      'table',
      'table-schema',
      'table-rows',
      'agent-definition',
      'workspace-skill',
      'creation-team',
    ].includes(source.kind) ||
    (source.kind === 'private-conversation' && source.conversationId !== origin.conversationId);
  if (!row && (origin.files?.length || origin.sources.some(untrusted))) return null;
  return withHuman(runtime, workspaceId, actor, 'write', async tx => {
    if (tx.commonVersion < 113) return null;
    const policy = await readReviewPolicy(tx);
    if (policy.mode === 'legacy') return null;
    const name = (s: string) => relation(tx, s);
    const turn = (
      await tx.client.query<{ text: string }>(
        `SELECT string_agg(p.text,' ' ORDER BY p.ordinal) AS text
      FROM ${name('tf_conversations')} c JOIN ${name('tf_conversation_turns')} t ON t.conversation_id=c.id
      JOIN ${name('tf_conversation_messages')} m ON m.id=t.source_message_id AND m.conversation_id=c.id AND m.sequence=t.accepted_sequence
      JOIN ${name('tf_conversation_parts')} p ON p.message_id=m.id AND p.kind='text'
      WHERE c.id=$1 AND c.kind='private' AND c.project_id IS NULL AND c.owner_membership_id=$3 AND c.owner_user_id=$4
      AND c.app_id IS NULL AND c.deleted_at IS NULL
      AND t.id=$2 AND t.status NOT IN ('completed','blocked','cancelled','failed') AND NOT COALESCE((to_jsonb(t)->>'planning_mode')::boolean,false)
      AND m.author_kind='human' AND m.membership_id=$3 AND NOT EXISTS (SELECT 1 FROM ${name('tf_slack_dm_roots')} WHERE conversation_id=c.id)
      AND NOT EXISTS (SELECT 1 FROM ${name('tf_slack_default_turns')} WHERE conversation_id=c.id)
      GROUP BY t.id`,
        [origin.conversationId, origin.turnId, actor.membershipId, actor.userId],
      )
    ).rows[0];
    if (!turn?.text) return null;
    const receipts = name('tf_action_review_receipts');
    const inputDigest = await digestJson(input);
    const old = (
      await tx.client.query(
        `SELECT call_id,input_digest,result FROM ${receipts} WHERE turn_id=$1 AND action=$2 AND (call_id=$3 OR NOT $4)`,
        [origin.turnId, action, callId, row],
      )
    ).rows[0];
    if (old) {
      if (old.input_digest === inputDigest) return { result: old.result };
      if (old.call_id === callId) return { result: { error: 'idempotency-conflict' } };
      return { review: true };
    }
    if (shouldAsk(policy, action)) return { review: true };
    if (!row) {
      if (!explicitCreation(turn.text, action.slice(7))) return null;
      if (
        (
          await protectedSourceClosure(tx, [
            { kind: 'private-conversation', conversationId: origin.conversationId },
            ...origin.sources,
          ])
        ).some(untrusted)
      )
        return { review: true };
      if (await pending(tx, origin.conversationId, action, callId)) return { review: true };
      if (
        (
          await tx.client.query(
            `SELECT 1 FROM ${name('tf_conversation_tool_calls')} WHERE conversation_id=$1 AND tool IN ('skills.import','skills.import.status','skills.import.select') LIMIT 1`,
            [origin.conversationId],
          )
        ).rowCount
      )
        return { review: true };
    }
    if (!write) return { eligible: true };
    const bound: AgentStorage = {
      transaction: async (ws, range, fn) => {
        if (ws !== workspaceId || tx.commonVersion < range.minimum || tx.commonVersion > range.maximum)
          throw new AccessDenied();
        return fn({ ...tx, workspaceId });
      },
    };
    const result = await write(bound, tx, policy.revision);
    if (!result) return null;
    await tx.client.query(
      `INSERT INTO ${receipts} (call_id,turn_id,conversation_id,action,revision,result,input_digest) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        callId,
        origin.turnId,
        origin.conversationId,
        action,
        policy.revision,
        row ? { status: 'applied', decision: 'workspace-policy' } : result,
        inputDigest,
      ],
    );
    return { result };
  });
}
