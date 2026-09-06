/** Bounds and sanitises a provider response before any hook, projection, or model sees it. */

export const REDACTED_FIELD = "[redacted]";

/**
 * Field names whose value is a credential wherever it appears.
 *
 * Matched on the name rather than the value because the runtime cannot recognise an unknown
 * provider's token by shape, and a token echoed back in a `refresh_token` field is a credential
 * the Agent was never leased. `SecretLeakError` only catches the credential *this* call was lent.
 */
const CREDENTIAL_FIELD_RE =
  /(^|[_-])(secret|password|passwd|token|credential|apikey|authorization|cookie|signature|private[_-]?key)($|[_-])|^(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|set[_-]?cookie)$/i;

/** Prototype-poisoning segments. Never read from a response, never written to an output. */
const UNSAFE_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** Deeper than any response worth showing an Agent, and shallow enough to stay linear. */
const MAX_DEPTH = 32;

export function isCredentialFieldName(name: string): boolean {
  return CREDENTIAL_FIELD_RE.test(name);
}

/**
 * Returns a copy with every credential-shaped field replaced by {@link REDACTED_FIELD}.
 *
 * Runs before projection so a manifest cannot name a credential field as a projection pointer, and
 * before validation so a response schema cannot legitimise one.
 */
export function redactCredentialFields(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => redactCredentialFields(entry, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (UNSAFE_SEGMENTS.has(key)) continue;
    output[key] = isCredentialFieldName(key)
      ? REDACTED_FIELD
      : redactCredentialFields(entry, depth + 1);
  }
  return output;
}

/** Splits a JSON Pointer into its decoded reference tokens. */
export function pointerSegments(pointer: string): string[] {
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function isIndex(segment: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(segment);
}

function readPointer(value: unknown, path: readonly string[]): { found: boolean; value?: unknown } {
  let current = value;
  for (const segment of path) {
    if (UNSAFE_SEGMENTS.has(segment) || current === null || typeof current !== "object") {
      return { found: false };
    }
    if (Array.isArray(current)) {
      if (!isIndex(segment)) return { found: false };
      const index = Number(segment);
      if (index >= current.length) return { found: false };
      current = current[index];
    } else {
      if (!Object.hasOwn(current, segment)) return { found: false };
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return { found: true, value: current };
}

function writePointer(
  target: Record<string, unknown> | unknown[],
  path: readonly string[],
  value: unknown
): void {
  let current: Record<string, unknown> | unknown[] = target;
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index];
    if (segment === undefined || UNSAFE_SEGMENTS.has(segment)) return;
    const numeric = isIndex(segment);
    if (index === path.length - 1) {
      if (Array.isArray(current)) {
        if (numeric) current[Number(segment)] = value;
      } else {
        current[segment] = value;
      }
      return;
    }
    const child = isIndex(path[index + 1] ?? "") ? [] : {};
    if (Array.isArray(current)) {
      if (!numeric) return;
      const position = Number(segment);
      const existing = current[position];
      if (existing === null || typeof existing !== "object") current[position] = child;
      current = current[position] as Record<string, unknown> | unknown[];
    } else {
      const existing = current[segment];
      if (existing === null || typeof existing !== "object") current[segment] = child;
      current = current[segment] as Record<string, unknown> | unknown[];
    }
  }
}

/** Keeps only the declared pointers, preserving their shape. Unresolvable pointers are dropped. */
export function projectResponse(response: unknown, projection: readonly string[]): unknown {
  const first = pointerSegments(projection[0] ?? "/")[0] ?? "";
  const output: Record<string, unknown> | unknown[] = isIndex(first) ? [] : {};
  for (const pointer of projection) {
    const path = pointerSegments(pointer);
    const selected = readPointer(response, path);
    if (selected.found) writePointer(output, path, selected.value);
  }
  return output;
}
