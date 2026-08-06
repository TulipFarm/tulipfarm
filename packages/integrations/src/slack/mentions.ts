/**
 * Slack renders an `@mention` in outgoing message text as an opaque `<@USERID>` token. Nothing
 * downstream (the LLM agent, resource records, other channel replies) can turn that back into a
 * name, so an unresolved mention becomes a raw Slack id wherever the agent copies it — e.g. into a
 * record's `assignee` field. Resolving mentions here, before the agent ever sees the text, means
 * the fix applies uniformly to every field or record type an agent might write the name into.
 */

export interface SlackMentionResolverPort {
  /** Resolves a Slack user id to a display name, or undefined if unknown/unavailable. */
  resolveDisplayName(userId: string): Promise<string | undefined>;
}

// The `|label` suffix is bounded (Slack ids/labels are short) so a long run of unterminated
// `<@ID|` tokens in untrusted message text can't make this scan quadratic (CodeQL: polynomial
// regex on uncontrolled input).
const MENTION_PATTERN = /<@([A-Z0-9]+)(?:\|[^>]{0,80})?>/g;

/**
 * Replaces every `<@USERID>` token with `@DisplayName`. A token whose id the resolver cannot
 * resolve is left untouched — best-effort, never blocks the message on a Slack API hiccup.
 */
export async function resolveMentionsInText(
  text: string,
  resolver: SlackMentionResolverPort
): Promise<string> {
  const ids = new Set<string>();
  for (const match of text.matchAll(MENTION_PATTERN)) {
    ids.add(match[1]);
  }
  if (ids.size === 0) return text;

  const names = new Map<string, string>();
  await Promise.all(
    Array.from(ids).map(async (id) => {
      const name = await resolver.resolveDisplayName(id);
      if (name) names.set(id, name);
    })
  );
  if (names.size === 0) return text;

  return text.replace(MENTION_PATTERN, (whole, id: string) => {
    const name = names.get(id);
    return name ? `@${name}` : whole;
  });
}
