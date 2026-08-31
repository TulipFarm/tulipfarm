/** Decode Slack `<@USERID>` mentions before agents can copy opaque ids into records. */

export interface SlackMentionResolverPort {
  /** Resolves a Slack user id to a display name, or undefined if unknown/unavailable. */
  resolveDisplayName(userId: string): Promise<string | undefined>;
}

// The `|label` suffix is bounded (Slack ids/labels are short) so a long run of unterminated
// `<@ID|` tokens in untrusted message text can't make this scan quadratic (CodeQL: polynomial
// regex on uncontrolled input).
const MENTION_PATTERN = /<@([A-Z0-9]+)(?:\|[^>]{0,80})?>/g;

/** Best-effort `<@USERID>` to `@DisplayName`; unresolved ids stay unchanged. */
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

export interface SlackUserLookupPort {
  /** Resolves a plain `@name` token (as typed, case-insensitive) to a Slack user id, or undefined
   * if unknown/ambiguous/unavailable. */
  resolveUserId(name: string): Promise<string | undefined>;
}

// Matches prose `@name`, never Slack's existing `<@ID>`/`<@ID|label>` tokens.
const PLAIN_MENTION_PATTERN = /(?<=^|[\s(])@([A-Za-z0-9][\w.'-]{0,79})(?=[\s.,!?;:)]|$)/g;

/** Best-effort prose `@name` to Slack `<@USERID>`; unresolved names stay unchanged. */
export async function encodeMentionsInText(
  text: string,
  resolver: SlackUserLookupPort
): Promise<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(PLAIN_MENTION_PATTERN)) {
    names.add(match[1]);
  }
  if (names.size === 0) return text;

  const ids = new Map<string, string>();
  await Promise.all(
    Array.from(names).map(async (name) => {
      const id = await resolver.resolveUserId(name);
      if (id) ids.set(name, id);
    })
  );
  if (ids.size === 0) return text;

  return text.replace(PLAIN_MENTION_PATTERN, (whole, name: string) => {
    const id = ids.get(name);
    return id ? `<@${id}>` : whole;
  });
}

// Matches a bare Slack channel or user id sitting as a standalone token in prose — e.g. an id
// pulled straight from routine/integration config and interpolated into the agent's output text.
// Excludes ids already inside `<#ID>`/`<@ID|label>` mention syntax (lookbehind rules out the `<`,
// `@`, `#` that precede an id there; lookahead rules out the trailing `>` or `|`) and ids inside
// backtick code spans. Channel ids start with C/G/D (public/private/DM, matching `isChannelId` in
// tool-adapter.ts); user ids start with U. Both require a word boundary so an id embedded in a
// longer alphanumeric token is left alone.
const RAW_ID_PATTERN = /(?<![<@#`\w])([CGD][A-Z0-9]{8,}|U[A-Z0-9]{8,})(?![>|\w`])/g;

/**
 * Wraps bare Slack channel/user ids (as opposed to prose `@name`, handled by
 * {@link encodeMentionsInText}) in `<#ID>`/`<@ID>` mention syntax, so Slack renders them as
 * `#channel-name`/`@person` instead of printing the raw id. Ids already in mention syntax, or
 * inside a code span, are left untouched.
 */
export function encodeRawIdsInText(text: string): string {
  return text.replace(RAW_ID_PATTERN, (whole, id: string) => {
    const sigil = id.startsWith("U") ? "@" : "#";
    return `<${sigil}${id}>`;
  });
}
