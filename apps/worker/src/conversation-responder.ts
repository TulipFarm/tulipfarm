import { inferWithTools, type ToolInferenceContext } from '@tulipfarm/agents/inference';
import type { FrameworkCall } from '@tulipfarm/agents/tools';
import {
  mergeSources,
  sourceDependenciesSchema,
  type ConversationResult,
  type SourceDependency,
} from '@tulipfarm/conversations/results';
import { z } from 'zod';
import { publicWebResultSchema } from '@tulipfarm/conversations/public-web';
import { observeChatDetail } from '@tulipfarm/observability';

const toolResultSchema = z.strictObject({
  result: z.unknown(),
  sources: sourceDependenciesSchema,
  receiptId: z.uuid().optional(),
});

export async function respondToConversation(
  route: Parameters<typeof inferWithTools>[0],
  messages: Parameters<typeof inferWithTools>[1],
  execute: (call: FrameworkCall, sources: SourceDependency[], activity: string) => Promise<unknown>,
  meter?: Parameters<typeof inferWithTools>[3],
  authorizeSources?: (sources: SourceDependency[]) => Promise<void>,
  generateTitle = false,
  timeZone: string | null = null,
  tools?: ToolInferenceContext & {
    sources: () => SourceDependency[];
    /** Saves a finished tool round with every source the reply has used so far; see `beforeRound`. */
    checkpoint?: (sources: SourceDependency[]) => Promise<void>;
  },
  retainedSources: SourceDependency[] = [],
  sourceMessages?: Parameters<typeof inferWithTools>[1],
): Promise<ConversationResult> {
  const sources: SourceDependency[] = [...retainedSources];
  let widenedWebSearch = false;
  const checkpoint = tools?.checkpoint;
  const context = tools && {
    ...tools,
    ...(checkpoint
      ? {
          beforeRound: async () => {
            sources.push(...tools.sources());
            await checkpoint(mergeSources(sources));
          },
        }
      : {}),
  };
  const answer = await inferWithTools(
    route,
    messages,
    async (call, activity) => {
      sources.push(...(tools?.sources() ?? []));
      const output = await execute(call, mergeSources(sources), activity);
      const captured = toolResultSchema.safeParse(output);
      if (captured.success) {
        const web = publicWebResultSchema.safeParse(captured.data.result);
        if (web.success && (web.data.widened || (call.tool === 'web.search' && call.window === 'week')))
          widenedWebSearch = true;
        sources.push(...captured.data.sources);
        const value = captured.data.result;
        return captured.data.receiptId
          ? {
              ...(value !== null && typeof value === 'object' && !Array.isArray(value) ? value : { value }),
              toolReceipt: { callId: captured.data.receiptId },
            }
          : value;
      }
      sources.push({ kind: 'unavailable' });
      return output;
    },
    async input => {
      sources.push(...(tools?.sources() ?? []));
      await observeChatDetail('authorize', async () => authorizeSources?.(sources));
      return meter ? meter(input) : async () => {};
    },
    generateTitle,
    timeZone,
    context,
    sourceMessages,
  );
  const text = widenedWebSearch ? `${answer.text}\n\nSearch coverage was widened to the past seven days.` : answer.text;
  // Only the executor's original messages establish a title independent of enriched reply context.
  return {
    ...answer,
    ...(answer.title && sourceMessages ? { titleSource: 'user-message' as const } : {}),
    text,
    sources: mergeSources([...sources, ...(tools?.sources() ?? [])]),
  };
}
