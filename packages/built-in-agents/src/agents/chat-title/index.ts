import { generateText } from "ai";
import type { BuiltInAgentModel, BuiltInAgentSpec } from "../../agent";
import { untrusted } from "../../untrusted";
import { TITLE_SYSTEM_PROMPT } from "./prompt";
import { fallbackTitle, sanitizeTitle } from "./sanitize";

/**
 * Names a new chat from the first thing the person said.
 *
 * Best-effort and never on the Turn's critical path: any failure — no model configured, a timeout,
 * empty output — degrades to a truncated-prompt fallback, so a chat always gets a usable label.
 *
 * The first user message is the most obviously attacker-reachable input in the product, and the
 * title it produces is rendered in the sidebar for everyone who can see the chat. It is fenced for
 * that reason, and bounded for the same one: an unbounded title agent is a way to spend the
 * operator's tokens by typing.
 */
export const CHAT_TITLE: BuiltInAgentSpec = {
  id: "chat_title",
  purpose: "Write a short, specific title for a chat from its first user message.",
  rung: "fast",
  // A 3-6 word title. Wide enough for a long word or two, far short of a paragraph.
  maxOutputTokens: 24,
  // The title lands whenever it lands, but a hung request must not pin a model slot indefinitely.
  timeoutMs: 10_000,
};

/** Generate a title from the first user message; falls back on any failure or empty output. */
export async function buildConversationTitle(
  model: BuiltInAgentModel,
  firstPrompt: string
): Promise<string> {
  try {
    const { text } = await generateText({
      model,
      system: TITLE_SYSTEM_PROMPT,
      prompt: untrusted("first-message", firstPrompt),
      maxOutputTokens: CHAT_TITLE.maxOutputTokens,
      abortSignal: AbortSignal.timeout(CHAT_TITLE.timeoutMs),
    });
    return sanitizeTitle(text) || fallbackTitle(firstPrompt);
  } catch {
    return fallbackTitle(firstPrompt);
  }
}

export { fallbackTitle, sanitizeTitle } from "./sanitize";
