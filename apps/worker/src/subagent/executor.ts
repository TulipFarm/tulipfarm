import type { ArtifactService } from "@tulipfarm/run-kernel";
import {
  type ChatExecutorOptions,
  createChatExecutor,
  type RunExecutor,
} from "@tulipfarm/turn-executor";
import { SubagentCompletionStore, subagentTurnIdentity } from "./completion";

export interface SubagentExecutorOptions {
  /**
   * The chat executor's wiring, reused verbatim apart from `host`.
   *
   * Taking the whole options object rather than re-listing its parts is deliberate: anything a
   * chat Turn is given — guardrails, budgets, checkpoints, cancellation, the distiller — a
   * sub-agent is given too, and a caller cannot forget one of them here.
   */
  readonly chat: Omit<ChatExecutorOptions, "host">;
  /** Where the answer is published, and where redelivery reads it back from. */
  readonly artifacts: Pick<ArtifactService, "read" | "publish">;
}

/**
 * Executes one ad-hoc sub-agent Run.
 *
 * This is the chat executor with its Conversation swapped out. The sub-agent's Context is still
 * assembled by the API (which is the only side that may decide what a Run may see), its Tools
 * still go through the same guarded dispatch, and it still parks on approvals and child spawns
 * through `AgentStateRunner`. The only difference is where the answer lands: an Artifact rather
 * than a Message, because a sub-agent has no Conversation to put a Message in.
 */
export function createSubagentExecutor(options: SubagentExecutorOptions): RunExecutor {
  const completion = new SubagentCompletionStore({
    artifacts: options.artifacts,
    ...(options.chat.now === undefined ? {} : { now: options.chat.now }),
  });

  return createChatExecutor({
    ...options.chat,
    host: {
      findTurn: async (runId) => subagentTurnIdentity(runId),
      findCompletion: (ref) => completion.findCompletion(ref),
      appendAssistantMessage: (input) => completion.appendAssistantMessage(input),
      completeTurn: (input) => completion.completeTurn(input),
      // A sub-agent's Tools go through the same router a chat Turn's do; `chat.tools` overrides
      // this for any deployment that hosts its own, exactly as it does for chat.
      dispatch: (call) => {
        throw new Error(`no tool dispatcher is configured for sub-agent tool "${call.name}"`);
      },
    },
  });
}
