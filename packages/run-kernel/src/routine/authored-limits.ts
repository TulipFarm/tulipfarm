import type { routine as routineSchema } from "@tulipfarm/schema";
import { usdToCostMicros } from "../budgets";
import { LimitError, type LimitKey, type LimitSet } from "../limits";

/**
 * Authors and the runtime spell three limits differently, and one of the three differs in unit as
 * well: `costUsd` is USD, `costMicros` is micro-USD. The table below is the only place the two
 * vocabularies meet, and `satisfies Record<AuthoredLimitKey, ...>` makes them meet exhaustively —
 * add a key to the authored schema, or remove one, and this file stops compiling.
 */

type AuthoredLimits = NonNullable<routineSchema.RoutineSpec["limits"]>;

type AuthoredLimitKey = keyof AuthoredLimits;

interface AuthoredLimitMapping {
  readonly key: LimitKey;
  readonly toRuntimeValue: (authored: number) => number;
}

const sameUnit = (authored: number): number => authored;

const AUTHORED_LIMIT_MAPPINGS = {
  wallClockMs: { key: "wallTimeMs", toRuntimeValue: sameUnit },
  activeMs: { key: "activeTimeMs", toRuntimeValue: sameUnit },
  costUsd: { key: "costMicros", toRuntimeValue: usdToCostMicros },
  tokens: { key: "tokens", toRuntimeValue: sameUnit },
  iterations: { key: "iterations", toRuntimeValue: sameUnit },
  fanOut: { key: "fanOut", toRuntimeValue: sameUnit },
  parallelism: { key: "parallelism", toRuntimeValue: sameUnit },
  artifactBytes: { key: "artifactBytes", toRuntimeValue: sameUnit },
  resultRows: { key: "resultRows", toRuntimeValue: sameUnit },
  networkBytes: { key: "networkBytes", toRuntimeValue: sameUnit },
  sideEffects: { key: "sideEffects", toRuntimeValue: sameUnit },
} satisfies Record<AuthoredLimitKey, AuthoredLimitMapping>;

const MAPPING_BY_AUTHORED_KEY: ReadonlyMap<string, AuthoredLimitMapping> = new Map(
  Object.entries(AUTHORED_LIMIT_MAPPINGS)
);

/**
 * Translates an authored `limits` block into the runtime `LimitSet`.
 *
 * A limit is a safety control, so every rejection here is a refusal rather than a skip: an
 * unrecognised key or a value the runtime cannot enforce fails the compile instead of quietly
 * producing a set with a missing ceiling.
 *
 * @throws {LimitError} `invalid_limit` for an unknown authored key, a non-numeric or negative
 * value, or a value that does not convert to a safe integer.
 */
export function mapAuthoredLimits(authored: Readonly<Record<string, unknown>>): LimitSet {
  const limits: LimitSet = {};
  for (const [authoredKey, value] of Object.entries(authored)) {
    if (value === undefined) continue;
    const mapping = MAPPING_BY_AUTHORED_KEY.get(authoredKey);
    if (mapping === undefined) throw new LimitError("invalid_limit", authoredKey);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new LimitError("invalid_limit", mapping.key);
    }
    const runtimeValue = mapping.toRuntimeValue(value);
    if (!Number.isSafeInteger(runtimeValue) || runtimeValue < 0) {
      throw new LimitError("invalid_limit", mapping.key);
    }
    limits[mapping.key] = runtimeValue;
  }
  return limits;
}
