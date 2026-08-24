/** How a Turn notices the model asking the same question twice, and says so. */

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;

  // Key order is the provider's choice, not the model's meaning: the same arguments serialized two
  // ways have to produce one signature, or a repeat would never match and the count would stay at
  // one forever.
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : 1));

  const body = entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",");
  return `{${body}}`;
}

/**
 * A stable identity for one Tool call, so the same request written two ways still matches.
 *
 * The separator is a character JSON can never leave unescaped inside a string, which is what stops
 * a Tool named `a` with argument `b` from colliding with a Tool named `a\u0000b`.
 *
 * Answers `undefined` rather than throwing when the arguments cannot be walked — nesting deep
 * enough to exhaust the stack, or a `BigInt` JSON cannot carry. This runs *after* the Tool has
 * already executed, so throwing here would lose a result the Run has been charged for, in aid of
 * an annotation that is only ever advice. Losing the advice is the cheaper failure.
 */
export function callSignature(name: string, args: unknown): string | undefined {
  try {
    return `${name}\u0000${stableJson(args)}`;
  } catch {
    return undefined;
  }
}

/**
 * What a repeated call carries back to the model.
 *
 * Reported rather than served from a cache, and reported rather than refused. Serving a cached
 * answer would skip the dispatch, and with it the authorization the broker re-checks on every
 * call — the same reason a re-read File is fetched again each iteration instead of held. Refusing
 * would decide for the model that the answer cannot have changed, which the loop does not know.
 * So the Tool runs, and the repetition becomes something the model can see and act on.
 */
export function repeatedCall(count: number): { readonly count: number; readonly note: string } {
  return {
    count,
    note:
      `This is call ${count} with these exact arguments in this Turn. Nothing was reused — the ` +
      "Tool ran again and returned what you see. If it matches the earlier answer, act on it " +
      "rather than calling again.",
  };
}
