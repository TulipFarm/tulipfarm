import { z } from 'zod';
import {
  AccessDenied,
  SourceAuthorizationUnavailable,
  requireProtectedSource,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { conversationResultSchema } from './results.ts';
import { knowledgeActivity, type KnowledgeActivity } from './knowledge-activity.ts';

const retainedOutputSchema = z.object({ sources: conversationResultSchema.shape.sources });

export async function knowledgeActivityForHistory(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  row: { tool: string; call: unknown; output: unknown; sources: unknown; status: string },
): Promise<KnowledgeActivity | null> {
  if (row.tool !== 'knowledge.retrieve') return null;
  try {
    const retained = conversationResultSchema.shape.sources.parse(row.sources);
    const outputSources = row.output == null ? [] : retainedOutputSchema.parse(row.output).sources;
    for (const source of [...retained, ...outputSources]) await requireProtectedSource(tx, actor, source);
    return knowledgeActivity(row.tool, row.call, row.output, row.status);
  } catch (error) {
    if (error instanceof SourceAuthorizationUnavailable) return { action: null, status: 'failed', branches: [] };
    if (!(error instanceof AccessDenied) && !(error instanceof z.ZodError)) throw error;
    return { action: null, status: 'unavailable', branches: [] };
  }
}
