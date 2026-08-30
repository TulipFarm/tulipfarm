import { buildConversationTitle, fallbackTitle } from "@tulipfarm/built-in-agents";
import type { LanguageModel } from "ai";
import type { ConversationRepo } from "./conversations";

/**
 * Persisting the title the `chat_title` BuiltInAgent writes.
 *
 * The naming itself lives in `@tulipfarm/built-in-agents`; what stays here is the part that needs
 * this app's repository. It is fire-and-forget by design: a model or persistence failure must not
 * block the stream a person is already watching. It writes only while the conversation is still
 * untitled, so it cannot clobber a rename the user issued while it was in flight.
 */
export async function buildAndStoreTitle(args: {
  repo: Pick<ConversationRepo, "setTitleIfUnset">;
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
    await repo.setTitleIfUnset(id, title);
  } catch (err) {
    log.warn({ err, conversationId: id }, "title persistence failed");
  }
}
