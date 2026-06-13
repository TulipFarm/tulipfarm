import { generateText, type LanguageModel } from "ai";
import type { ConversationRepo } from "./conversations";

/*
 * Conversation title generation. A new chat's title is derived from the user's first message by the
 * quick LLM tier (mirrors the compaction summarizer's one-shot `generateText` in routes.ts). It is
 * best-effort and never on the turn's critical path: any failure (model not configured, timeout,
 * empty output) degrades to a truncated-prompt fallback so a chat always gets a usable label.
 */

const TITLE_PROMPT =
  "Write a short, specific title (3-6 words) for a chat that opens with the user message below. " +
  "Plain text only: no surrounding quotes, no trailing punctuation, no markdown, no preamble. " +
  "Reply with the title and nothing else.\n\nUser message:";

const MAX_TITLE_LEN = 80;
const MAX_FALLBACK_LEN = 60;

/** Collapse a raw model title into a single clean line, stripped of quotes/markdown and bounded. */
export function sanitizeTitle(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.,;:!?]+$/, "")
    .trim()
    .slice(0, MAX_TITLE_LEN)
    .trim();
}

/** Deterministic title when the model is unavailable: the first line of the prompt, bounded. */
export function fallbackTitle(firstPrompt: string): string {
  const firstLine = firstPrompt.split("\n").find((l) => l.trim().length > 0) ?? "";
  return firstLine.trim().slice(0, MAX_FALLBACK_LEN).trim() || "New chat";
}

/** Generate a title from the first user message; falls back on any failure or empty output. */
export async function buildConversationTitle(
  model: LanguageModel,
  firstPrompt: string
): Promise<string> {
  try {
    const { text } = await generateText({ model, prompt: `${TITLE_PROMPT} ${firstPrompt}` });
    return sanitizeTitle(text) || fallbackTitle(firstPrompt);
  } catch {
    return fallbackTitle(firstPrompt);
  }
}

/**
 * Detached, best-effort title generation for a freshly created conversation. Fire-and-forget from
 * the chat route (`void buildAndStoreTitle(...)`) so it never blocks the stream. `getModel` is a thunk
 * so a quick-tier-not-configured throw degrades to the truncated-prompt fallback; a persistence
 * failure is swallowed with a warning (a missing title is non-fatal).
 */
export async function buildAndStoreTitle(args: {
  repo: Pick<ConversationRepo, "setTitle">;
  getModel: () => LanguageModel;
  id: string;
  prompt: string;
  log: { warn: (obj: Record<string, unknown>, msg: string) => void };
}): Promise<void> {
  const { repo, getModel, id, prompt, log } = args;
  try {
    let title: string;
    try {
      title = await buildConversationTitle(getModel(), prompt);
    } catch {
      title = fallbackTitle(prompt);
    }
    await repo.setTitle(id, title);
  } catch (err) {
    log.warn({ err, conversationId: id }, "title persistence failed");
  }
}
