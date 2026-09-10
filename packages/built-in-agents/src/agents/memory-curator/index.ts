import type { ModelRequirements, ModelRequirementsPolicy } from "@tulipfarm/agent-runtime";
import { generateText } from "ai";
import {
  type BuiltInAgentModel,
  type BuiltInAgentSpec,
  builtInAgentRequirements,
} from "../../agent";
import { type MemoryCurationInput, memoryCuratorPrompt, memoryCuratorSystemPrompt } from "./prompt";

/**
 * Maintains one person's Memory Document once an hour, from what they themselves typed.
 *
 * It reads only `role='user'` text. Assistant text is not shown to it, and that is a security
 * decision rather than a token saving: assistant text echoes whatever a Tool or an Integration
 * returned, so a hostile support email or web page would otherwise get a sentence in front of the
 * model that decides what this person is durably known for.
 *
 * The whole document comes back rewritten, which is what makes "do not churn" a prompt rule rather
 * than a mechanism. The mechanisms sit on the other side: the caller parses, budget-checks and
 * merges before anything reaches storage, and a reply that will not fit is discarded rather than
 * truncated.
 */
export const MEMORY_CURATOR: BuiltInAgentSpec = {
  id: "memory_curator",
  purpose: "Rewrite one person's Memory Document from what they said since it was last curated.",
  // Consolidation, not reasoning. A stronger rung buys rewording of lines that were already right.
  rung: "fast",
  // 20 000 characters is roughly 5 000 tokens. Headroom for the reply, not licence to grow.
  maxOutputTokens: 8_000,
  // Runs on an hourly sweep with nobody waiting, but must not outlive its own tick.
  timeoutMs: 90_000,
};

/**
 * Runs the Curator and returns the document it produced, verbatim.
 *
 * Returns `undefined` on any failure — no model configured, a timeout, an empty reply. A failed
 * hour must leave the stored document exactly as it was, so there is no fallback text here: the
 * caller records the failure and retries the same window next hour.
 */
export async function curateMemory(
  model: BuiltInAgentModel,
  input: MemoryCurationInput
): Promise<string | undefined> {
  try {
    const { text } = await generateText({
      model,
      system: memoryCuratorSystemPrompt(input),
      prompt: memoryCuratorPrompt(input),
      maxOutputTokens: MEMORY_CURATOR.maxOutputTokens,
      abortSignal: AbortSignal.timeout(MEMORY_CURATOR.timeoutMs),
    });
    const document = stripCodeFence(text);
    return document.length === 0 ? undefined : document;
  } catch {
    return undefined;
  }
}

/**
 * What the Curator needs of a model, defaulting to sensitive.
 *
 * It reads one person's whole durable memory, so the constraint holds whether or not the Turns it
 * derives from were themselves marked sensitive: the document aggregates them, and an aggregate is
 * never less sensitive than its parts. `sensitive` keeps provider-side caching off.
 */
export function memoryCuratorRequirements(
  promptChars: number,
  policy: ModelRequirementsPolicy = {}
): ModelRequirements {
  return builtInAgentRequirements({ sensitive: true, ...policy }, MEMORY_CURATOR, promptChars);
}

const FENCED = /^```(?:markdown|md)?\n([\s\S]*?)\n?```$/;

/**
 * Unwraps a reply the model wrapped in a code fence despite being told not to.
 *
 * Cheap to do and expensive to skip: a fenced reply parses to a document whose every heading is
 * inside a code block, which the parser drops, which reads downstream as "the model returned an
 * empty memory" and would overwrite a good document with nothing.
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  return (FENCED.exec(trimmed)?.[1] ?? trimmed).trim();
}

export {
  type MemoryCurationInput,
  memoryCuratorPrompt,
  memoryCuratorSystemPrompt,
} from "./prompt";
