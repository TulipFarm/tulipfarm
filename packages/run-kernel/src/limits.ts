import { createHash } from "node:crypto";

/**
 * SPEC §9.1 limit scopes, ordered from broadest to narrowest. The order only breaks ties between
 * equal values so resolution evidence is deterministic; the narrowest *value* always wins.
 */
export const LIMIT_SCOPES = [
  "deployment",
  "role",
  "agent",
  "routine",
  "run",
  "state",
  "tool",
  "integration",
  "model",
] as const;

export type LimitScope = (typeof LIMIT_SCOPES)[number];

export const LIMIT_KEYS = [
  "wallTimeMs",
  "activeTimeMs",
  "tokens",
  "costMicros",
  "retries",
  "iterations",
  "fanOut",
  "parallelism",
  "artifactBytes",
  "resultRows",
  "networkBytes",
  "sideEffects",
] as const;

export type LimitKey = (typeof LIMIT_KEYS)[number];

export type LimitSet = Partial<Record<LimitKey, number>>;

export interface ScopedLimits {
  readonly scope: LimitScope;
  readonly limits: LimitSet;
}

export interface ResolvedLimit {
  readonly value: number;
  readonly scope: LimitScope;
}

export type ResolvedLimits = Partial<Record<LimitKey, ResolvedLimit>>;

export type LimitErrorCode = "invalid_limit" | "limit_amplification" | "invalid_target_key";

/**
 * Limit denial. The message carries only the reason code and the limit key — never the requested
 * value, the requesting principal, or any Run payload.
 */
export class LimitError extends Error {
  readonly name = "LimitError";

  constructor(
    readonly code: LimitErrorCode,
    readonly key = ""
  ) {
    super(`${code}${key ? `:${key}` : ""}`);
  }
}

function assertLimitValue(key: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new LimitError("invalid_limit", key);
}

const SCOPE_RANK: Readonly<Record<LimitScope, number>> = Object.fromEntries(
  LIMIT_SCOPES.map((scope, index) => [scope, index])
) as Record<LimitScope, number>;

/**
 * Narrowest-wins resolution over every declared scope (SPEC §9.1). An undeclared key stays
 * unbounded — a missing declaration never becomes an invented default.
 */
export function resolveLimits(scoped: readonly ScopedLimits[]): ResolvedLimits {
  const resolved: Record<string, ResolvedLimit> = {};
  for (const entry of scoped) {
    for (const [key, value] of Object.entries(entry.limits)) {
      if (value === undefined) continue;
      assertLimitValue(key, value);
      const current = resolved[key];
      const narrower =
        current === undefined ||
        value < current.value ||
        (value === current.value && SCOPE_RANK[entry.scope] > SCOPE_RANK[current.scope]);
      if (narrower) resolved[key] = { value, scope: entry.scope };
    }
  }
  return resolved as ResolvedLimits;
}

export function narrowestWins(resolved: ResolvedLimits, key: LimitKey): number | null {
  return resolved[key]?.value ?? null;
}

/**
 * Non-amplification gate (SPEC §9.1): a requested limit set may only narrow the resolved ceiling
 * or bound a key no scope bounded. An Agent can never raise a limit it operates under.
 */
export function assertNonAmplifying(resolved: ResolvedLimits, requested: LimitSet): void {
  for (const [key, value] of Object.entries(requested)) {
    if (value === undefined) continue;
    assertLimitValue(key, value);
    const ceiling = resolved[key as LimitKey];
    if (ceiling !== undefined && value > ceiling.value) {
      throw new LimitError("limit_amplification", key);
    }
  }
}

/** Sorted, length-prefixed parts make target-concurrency keys order-safe and collision-safe. */
export function deriveTargetKey(parts: Readonly<Record<string, string>>): string {
  const entries = Object.entries(parts).sort(([left], [right]) => (left < right ? -1 : 1));
  if (entries.length === 0) throw new LimitError("invalid_target_key");
  const canonical = entries
    .map(([name, value]) => `${name.length}:${name}=${value.length}:${value}`)
    .join("|");
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
