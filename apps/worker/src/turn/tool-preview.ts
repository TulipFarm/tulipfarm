import type { RunEventToolPreview } from "@tulipfarm/schema";

/** Build redacted participant previews; operator records and digests remain authoritative. */

/** Preview ceilings; the full value is fetched, not streamed. */
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 40;
const MAX_STRING_CHARS = 800;
const MAX_PREVIEW_CHARS = 8_000;

const REDACTED = "[redacted]";

/** Credential key names, matched after stripping non-alphanumerics. */
const SECRET_KEY_PATTERNS: readonly RegExp[] = [
  // Substring match catches `password_hash`, `passwordConfirmation`, and `passwd`.
  /pass(word|phrase|wd)/,
  /^pwd$/,
  /secret/,
  /token/,
  /apikey/,
  /accesskey/,
  /privatekey/,
  /credential/,
  // Match `auth`, but not ordinary `author` metadata; `authorization` still matches.
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

/** Narrow credential value shapes, so innocuous prose is not over-redacted. */
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

  // Name function/symbol values instead of letting JSON drop them silently.
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

/** Return bounded redacted preview; omit optional field for nullish values. */
export function buildToolPreview(value: unknown): RunEventToolPreview | undefined {
  if (value === null || value === undefined) return undefined;

  const state: WalkState = { redacted: [], truncated: false };
  const safe = walk(value, "", 0, state);

  let json: string;
  try {
    json = JSON.stringify(safe) ?? "null";
  } catch {
    // Fail closed if a cycle/getter survived the walk.
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
    // Re-wrap truncated JSON as a string so the payload remains parseable.
    const marker = "…[truncated]";
    // Shrink after wrapping so the encoded payload still fits the wire ceiling.
    let keep = MAX_PREVIEW_CHARS - marker.length - 2;
    let wrapped = JSON.stringify(`${json.slice(0, keep)}${marker}`);
    while (wrapped.length > MAX_PREVIEW_CHARS && keep > 0) {
      keep -= wrapped.length - MAX_PREVIEW_CHARS;
      wrapped = JSON.stringify(`${json.slice(0, Math.max(keep, 0))}${marker}`);
    }
    json = wrapped;
    truncated = true;
  }

  // Deduplicate redaction paths; presence is all a reader needs.
  const redactedPaths = [...new Set(state.redacted)].filter((path) => path.length > 0);

  return {
    json,
    ...(redactedPaths.length === 0 ? {} : { redactedPaths }),
    ...(truncated ? { truncated: true } : {}),
    ...(bytes === undefined ? {} : { bytes }),
  };
}
