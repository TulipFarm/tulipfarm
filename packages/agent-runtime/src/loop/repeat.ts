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

/**
 * What a repeated call to a side-effecting Tool carries back, in place of a second dispatch.
 *
 * Unlike `repeatedCall`, the Tool does *not* run: for a Tool flagged `sideEffecting`, a second
 * identical call is not a harmless echo the model can learn from — it is a second real message,
 * issue, or event. Refusing without dispatching is the only choice that cannot duplicate the
 * effect (#646), so the model is told plainly that nothing happened rather than being handed a
 * second copy of the first result to reason about.
 */
export function shortCircuitedRepeat(count: number): {
  readonly count: number;
  readonly note: string;
} {
  return {
    count,
    note:
      `This is call ${count} with these exact arguments in this Turn. It was NOT run — this Tool ` +
      "has a real effect each time it runs, so an exact repeat is refused rather than dispatched " +
      "again. If the earlier call already did what you needed, there is nothing left to do.",
  };
}

/** What a repeated `skill` load carries instead of the text it already sent. */
const REPEATED_SKILL_NOTE =
  "Already sent earlier in this Turn and omitted here, because a Skill cannot change mid-Turn. " +
  "Scroll back to the first result rather than loading it again.";

/**
 * Drop the text a repeated `skill` result would send twice.
 *
 * A Skill is immutable for the length of a Turn, so a second identical load returns bytes the
 * model is already holding — for a large Skill that is tens of kilobytes of context and a model
 * invocation, spent to learn nothing. The Tool still ran, so the broker still re-checked
 * authorization; only the redundant copy is dropped, and the structure around it is kept so the
 * model can still see which Skill answered and what files it carries.
 *
 * Confined to `skill` on purpose. Every other Tool reads something that may have moved since the
 * last call, and the loop has no way to know it did not.
 */
export function elideRepeatedSkillText(output: unknown): unknown {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return output;
  const record = output as Record<string, unknown>;
  const field = typeof record.body === "string" ? "body" : "content";
  if (typeof record[field] !== "string") return output;
  return { ...record, [field]: REPEATED_SKILL_NOTE, elidedRepeat: true };
}
