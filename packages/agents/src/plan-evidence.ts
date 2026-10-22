import { z } from 'zod';
import type { HumanActor } from '@tulipfarm/access';
import { sourceDependencySchema } from '@tulipfarm/access/source-dependencies';
import { toolOutcomeStatus } from '@tulipfarm/conversations/tool-activity';
import { requireDraftSources } from './draft-sources.ts';
import { PlanGraphError, type planEvidenceSchema } from './plan-contracts.ts';
import { relation, type AgentTransaction } from './store.ts';

const receiptSchema = z.object({
  id: z.uuid(),
  tool: z.string(),
  status: z.string(),
  sources: z.array(sourceDependencySchema),
  output: z.object({ result: z.unknown(), sources: z.array(sourceDependencySchema) }).nullable(),
});
const incomplete = new Set([
  'draft',
  'blocked',
  'paused',
  'pending',
  'not-ready',
  'unavailable',
  'unsupported',
  'not-found',
  'expired',
]);
const resultSchema = z.object({
  kind: z.string().optional(),
  status: z.string().optional(),
  state: z.string().optional(),
  available: z.boolean().optional(),
  success: z.boolean().optional(),
  ok: z.boolean().optional(),
});

export function evidenceHasSuccessfulOutcome(tool: string, output: unknown) {
  if (tool.startsWith('plans.') || tool === 'present.choice' || tool.endsWith('.draft') || tool.endsWith('.propose'))
    return false;
  const result = resultSchema.safeParse(output);
  return (
    result.success &&
    toolOutcomeStatus(output) === 'completed' &&
    ![result.data.kind, result.data.status, result.data.state].some(
      value => value !== undefined && incomplete.has(value),
    ) &&
    result.data.available !== false &&
    result.data.success !== false &&
    result.data.ok !== false
  );
}

/** A claim cites durable tool output, never another model's plan or success sentence. */
export async function requirePlanEvidence(
  tx: AgentTransaction,
  actor: HumanActor,
  plan: { chatId: string; starterMembershipId: string },
  evidence: readonly z.infer<typeof planEvidenceSchema>[],
  successful = true,
  attempt?: { turnId: string; afterSequence: number },
) {
  const ids = [...new Set(evidence.map(item => item.callId))];
  if (!ids.length) return [];
  const receipts = z.array(receiptSchema).parse(
    (
      await tx.client.query(
        `
    SELECT c.id,c.tool,c.status,s.sources,s.output FROM ${relation(tx, 'tf_conversation_tool_calls')} c
    JOIN ${relation(tx, 'tf_conversation_execution_steps')} s ON s.call_id=c.id AND s.turn_id=c.turn_id
    JOIN ${relation(tx, 'tf_conversation_turns')} t ON t.id=c.turn_id AND t.conversation_id=c.conversation_id
    JOIN ${relation(tx, 'tf_conversation_messages')} m ON m.id=t.source_message_id AND m.conversation_id=t.conversation_id
    WHERE c.id=ANY($1::uuid[]) AND c.conversation_id=$2 AND m.membership_id=$3 AND m.author_kind='human'
      AND ($4::uuid IS NULL OR (c.turn_id=$4 AND c.sequence>$5))`,
        [ids, plan.chatId, plan.starterMembershipId, attempt?.turnId ?? null, attempt?.afterSequence ?? 0],
      )
    ).rows,
  );
  if (
    receipts.length !== ids.length ||
    receipts.some(
      receipt =>
        !receipt.output ||
        (successful &&
          (receipt.status !== 'completed' || !evidenceHasSuccessfulOutcome(receipt.tool, receipt.output.result))),
    )
  ) {
    throw new PlanGraphError('planning-evidence');
  }
  const sources = receipts.flatMap(receipt => [...receipt.sources, ...receipt.output!.sources]);
  await requireDraftSources(tx, actor, sources);
  return sources;
}
