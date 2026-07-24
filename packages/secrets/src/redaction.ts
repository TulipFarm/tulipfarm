/**
 * Secret redaction for text that is about to cross a log, error, Artifact, sandbox, or audit
 * boundary (SPEC §13, §24). These helpers are the last line of defence, not the first: the Secret
 * Broker already keeps plaintext inside a single callback. They exist because callee-produced
 * strings — upstream error messages, stack frames, Tool output — can carry a Credential that the
 * caller never chose to reveal.
 *
 * Everything here is pure. Nothing is logged, stored, or reported.
 */

export const REDACTED = "[redacted]";

/** Secrets short enough to match unrelated text are still redacted; empty strings are skipped. */
function usableSecrets(secrets: Iterable<string>): string[] {
  return [...secrets].filter((secret) => secret.length > 0);
}

/** Replaces every occurrence of every secret in `text` with {@link REDACTED}. */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let output = text;
  for (const secret of usableSecrets(secrets)) {
    output = output.split(secret).join(REDACTED);
  }
  return output;
}

/**
 * True when any secret appears in `value` — inside a string, an array element, or an object key or
 * property, at any depth. Non-string scalars never match: a secret is a string, and coercing
 * numbers or symbols would only produce false positives.
 */
export function containsSecret(value: unknown, secrets: Iterable<string>): boolean {
  const needles = usableSecrets(secrets);
  if (needles.length === 0) {
    return false;
  }
  const seen = new Set<object>();
  const visit = (node: unknown): boolean => {
    if (typeof node === "string") {
      return needles.some((secret) => node.includes(secret));
    }
    if (node === null || typeof node !== "object") {
      return false;
    }
    if (seen.has(node)) {
      return false;
    }
    seen.add(node);
    if (Array.isArray(node)) {
      return node.some(visit);
    }
    if (node instanceof Error) {
      return visit(node.message) || visit(node.stack ?? "");
    }
    return Object.entries(node).some(([key, entry]) => visit(key) || visit(entry));
  };
  return visit(value);
}

/**
 * Returns a redacted copy of a thrown value. The copy keeps the original prototype so `instanceof`
 * checks and typed-error handling still work; the original object is left untouched because the
 * caller may hold other references to it. Non-`Error` throws become an `Error` with a redacted
 * message.
 */
export function redactError(thrown: unknown, secrets: Iterable<string>): Error {
  if (!(thrown instanceof Error)) {
    return new Error(redactSecrets(String(thrown), secrets));
  }
  const copy = Object.create(Object.getPrototypeOf(thrown)) as Error;
  Object.assign(copy, thrown);
  copy.name = thrown.name;
  copy.message = redactSecrets(thrown.message, secrets);
  if (thrown.stack !== undefined) {
    copy.stack = redactSecrets(thrown.stack, secrets);
  }
  return copy;
}
