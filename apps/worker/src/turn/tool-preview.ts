import type { RunEventToolPreview } from "@tulipfarm/schema";

/**
 * Builds the readable companion to a Tool call's `argsDigest`.
 *
 * The digest was protecting something real: Tool arguments and Tool output routinely carry the
 * protected data the call operates on, and the participant stream is read by whoever is in the
 * conversation. So a preview is built by subtraction, not by selection — the whole value is walked
 * and anything that looks like credential material is replaced, rather than a short allowlist of
 * "safe" fields being copied out. A field nobody anticipated is therefore included by default and
 * a secret nobody anticipated is still caught by the value scan.
 *
 * Nothing here is a substitute for the operator-audience record. `tool.dispatched` still holds the
 * verbatim arguments, and `argsDigest` still hashes them, so redaction cannot quietly rewrite what
 * the audit says was called.
 */

/** Depth, breadth and size ceilings. A preview is a summary; the full value is fetched, not streamed. */
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 40;
const MAX_STRING_CHARS = 800;
const MAX_PREVIEW_CHARS = 8_000;

const REDACTED = "[redacted]";

/**
 * Key names whose values are credential material regardless of what they contain. Matched on a
 * normalized key (non-alphanumerics stripped) so `api_key`, `apiKey` and `API-KEY` are one rule.
 */
const SECRET_KEY_PATTERNS: readonly RegExp[] = [
  // Substring matches, not suffix matches: `password_hash`, `passwordConfirmation` and `passwd`
  // are all credential material, and a rule anchored to the end of the key misses every one.
  /pass(word|phrase|wd)/,
  /^pwd$/,
  /secret/,
  /token/,
  /apikey/,
  /accesskey/,
  /privatekey/,
  /credential/,
  // `auth` anywhere, except the `author` family, which is ordinary metadata on GitHub and Slack
  // payloads. `authorization` is still matched because its `or` is followed by `ization`.
  /auth(?!or(?!ization))/,
  /session/,
  /cookie/,
  /signature/,
  /^otp/,
  /^pin$/,
  /pincode/,
  /clientsecret/,
  /refreshtoken/,
  /bearer/,
];

/**
 * Value shapes that are credential material wherever they appear, so a secret passed under an
 * innocuous key is still caught. Deliberately narrow: these match structured credentials, not
 * ordinary prose, because over-matching would redact the very content that makes a preview useful.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  // JWTs.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/,
  // Common vendor key prefixes (GitHub, Slack, Stripe, OpenAI, AWS, Google).
  /\b(?:gh[pousr]_|xox[abposr]-|sk-|pk_live_|rk_live_|AKIA|ASIA|AIza)[A-Za-z0-9_-]{8,}/,
  // PEM private key blocks.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // `Authorization: Bearer <token>` embedded in a string.
  /\bBearer\s+[A-Za-z0-9._-]{16,}/i,
];

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function joinPath(base: string, segment: string): string {
  return base.length === 0 ? segment : `${base}.${segment}`;
}

interface WalkState {
  readonly redacted: string[];
  truncated: boolean;
}

function walk(value: unknown, path: string, depth: number, state: WalkState): unknown {
  if (value === null || value === undefined) return null;

  if (typeof value === "string") {
    if (isSecretValue(value)) {
      state.redacted.push(path);
      return REDACTED;
    }
    if (value.length > MAX_STRING_CHARS) {
      state.truncated = true;
      return `${value.slice(0, MAX_STRING_CHARS)}…`;
    }
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();

  // A function or symbol in a Tool argument is not data a reader can act on, and JSON would drop
  // it silently. Naming it is more honest than an absent key.
  if (typeof value === "function" || typeof value === "symbol") return "[unserializable]";

  if (depth >= MAX_DEPTH) {
    state.truncated = true;
    return "[depth limit]";
  }

  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY_ITEMS);
    if (value.length > kept.length) state.truncated = true;
    return kept.map((item, index) => walk(item, `${path}[${index}]`, depth + 1, state));
  }

  if (value instanceof Date) return value.toISOString();

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const kept = entries.slice(0, MAX_OBJECT_KEYS);
    if (entries.length > kept.length) state.truncated = true;

    const out: Record<string, unknown> = {};
    for (const [key, child] of kept) {
      const childPath = joinPath(path, key);
      if (isSecretKey(key)) {
        state.redacted.push(childPath);
        out[key] = REDACTED;
        continue;
      }
      out[key] = walk(child, childPath, depth + 1, state);
    }
    return out;
  }

  return "[unserializable]";
}

/**
 * Produces a bounded, redacted preview of one Tool value.
 *
 * Returns `undefined` for a value that carries nothing to show (`null`/`undefined`), so a caller
 * omits the field rather than emitting an empty preview — the run-event schemas are
 * `additionalProperties: false` and an optional field must be absent, not present and empty.
 */
export function buildToolPreview(value: unknown): RunEventToolPreview | undefined {
  if (value === null || value === undefined) return undefined;

  const state: WalkState = { redacted: [], truncated: false };
  const safe = walk(value, "", 0, state);

  let json: string;
  try {
    json = JSON.stringify(safe) ?? "null";
  } catch {
    // A cycle or a throwing getter survived the walk. Failing closed keeps a malformed value from
    // becoming an unbounded string on a durable stream.
    return { json: '"[unserializable]"', truncated: true };
  }

  let bytes: number | undefined;
  try {
    bytes = JSON.stringify(value)?.length;
  } catch {
    bytes = undefined;
  }

  let truncated = state.truncated;
  if (json.length > MAX_PREVIEW_CHARS) {
    // Slicing serialized JSON cuts mid-token and leaves a blob nothing can parse, which made the
    // whole row unreadable. Re-wrap the kept prefix as a JSON string so the payload stays valid
    // and the reader still sees the beginning of the value alongside the truncation notice.
    const marker = "…[truncated]";
    // The re-wrap adds quotes, the marker, and escapes for any quote or backslash in the prefix.
    // Shrink until the encoded result fits, so the ceiling holds on the wire, not just the input.
    let keep = MAX_PREVIEW_CHARS - marker.length - 2;
    let wrapped = JSON.stringify(`${json.slice(0, keep)}${marker}`);
    while (wrapped.length > MAX_PREVIEW_CHARS && keep > 0) {
      keep -= wrapped.length - MAX_PREVIEW_CHARS;
      wrapped = JSON.stringify(`${json.slice(0, Math.max(keep, 0))}${marker}`);
    }
    json = wrapped;
    truncated = true;
  }

  // Duplicate paths add nothing and grow the row; a reader only needs to know a path was withheld.
  const redactedPaths = [...new Set(state.redacted)].filter((path) => path.length > 0);

  return {
    json,
    ...(redactedPaths.length === 0 ? {} : { redactedPaths }),
    ...(truncated ? { truncated: true } : {}),
    ...(bytes === undefined ? {} : { bytes }),
  };
}
