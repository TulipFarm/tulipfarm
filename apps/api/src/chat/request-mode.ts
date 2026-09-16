import type { ConversationMode } from "@tulipfarm/schema";

/** Only participant input can select Plan mode; fetched Tool content never reaches this boundary. */
export function chatRequestMode(
  content: string,
  requested?: ConversationMode | null,
  current?: ConversationMode | null
): ConversationMode | undefined {
  const packIntent =
    /\b(?:install|import|preview|adapt)\s+(?:(?:the|this|a|an)\s+)?pack\b/i.test(content) &&
    (/https?:\/\/\S+/i.test(content) || /^\s*kind:\s*Pack\s*$/m.test(content));
  const yamlPlan =
    /^\s*kind:\s*Plan\s*$/m.test(content) &&
    /^\s*apiVersion:\s*tulipfarm\.ai\/v1\s*$/m.test(content);
  if (packIntent || yamlPlan) return "plan";
  return requested ?? current ?? undefined;
}
