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
  _generateTitle = false,
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
  const summarise = tools?.compactToolResults;
  const context = tools && {
    ...tools,
    /**
     * The summariser reads only this reply's own tool outputs, which the next model round would send anyway, and its
     * notes stay in memory for this reply. It passes the same source check as every model request first, so a Slack or
     * other external-context reply never summarises content its audience may no longer see.
     */
    ...(summarise
      ? {
          compactToolResults: async (input: Parameters<typeof summarise>[0]) => {
            sources.push(...tools.sources());
            await observeChatDetail('authorize', async () => authorizeSources?.(mergeSources(sources)));
            return summarise(input);
          },
        }
      : {}),
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
    false,
    timeZone,
    context,
    sourceMessages,
  );
  const text = widenedWebSearch ? `${answer.text}\n\nSearch coverage was widened to the past seven days.` : answer.text;
  return {
    ...answer,
    text,
    sources: mergeSources([...sources, ...(tools?.sources() ?? [])]),
  };
}
