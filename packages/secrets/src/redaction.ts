/** Redacts secrets before logs/errors/artifacts/sandbox/audit boundaries; pure last-line defense. */

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

/** Recursively detects secrets in strings, arrays, object keys, and properties; scalars do not coerce. */
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
    if (node instanceof Map) {
      return [...node].some(([key, entry]) => visit(key) || visit(entry));
    }
    if (node instanceof Set) {
      return [...node].some(visit);
    }
    if (ArrayBuffer.isView(node)) {
      const bytes = new Uint8Array(node.buffer, node.byteOffset, node.byteLength);
      return visit(new TextDecoder().decode(bytes));
    }
    if (node instanceof ArrayBuffer) {
      return visit(new TextDecoder().decode(node));
    }
    if (node instanceof Error) {
      return visit(node.message) || visit(node.stack ?? "");
    }
    return Object.entries(node).some(([key, entry]) => visit(key) || visit(entry));
  };
  return visit(value);
}

/** Returns a redacted copy of a throw while preserving Error prototypes and the original object. */
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
