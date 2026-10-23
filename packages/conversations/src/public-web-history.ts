import { z } from 'zod';
import {
  AccessDenied,
  requireProtectedSource,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { conversationResultSchema } from './results.ts';
import { publicWebReceipt, type publicWebReceiptSchema } from './public-web.ts';
import { requireRetainedToolSources } from './source-access.ts';

const retainedOutputSchema = z.object({ sources: conversationResultSchema.shape.sources });

export async function publicWebReceiptForHistory(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  row: { tool: string; call: unknown; output: unknown; sources: unknown; status: string },
): Promise<z.infer<typeof publicWebReceiptSchema> | null> {
  if (row.tool !== 'web.fetch' && row.tool !== 'web.search') return null;
  try {
    const opaque = await requireRetainedToolSources(
      tx,
      actor,
      conversationResultSchema.shape.sources.parse(row.sources),
    );
    const outputSources = row.output == null ? [] : retainedOutputSchema.parse(row.output).sources;
    for (const source of outputSources) await requireProtectedSource(tx, actor, source);
    const receipt = publicWebReceipt(row.tool, row.call, row.output, row.status);
    return receipt && opaque ? { status: receipt.status, urls: [], failedUrls: [], widened: receipt.widened } : receipt;
  } catch (error) {
    if (!(error instanceof AccessDenied) && !(error instanceof z.ZodError)) throw error;
    return { status: 'failed', urls: [], failedUrls: [], widened: false };
  }
}
