import { compileJsonSchema, type OimEventType } from "@tulipfarm/schema";

/** What a `response_normalize` hook is given. Nothing here can identify a credential. */
export interface NormalizationInput {
  readonly payload: unknown;
  readonly safeHeaders: Readonly<Record<string, string>>;
}

/**
 * Runs an Integration's declared hook export.
 *
 * The runner is injected so this module never decides where untrusted code executes; a caller that
 * has no sandbox can pass one that refuses.
 */
export type NormalizeHookRunner = (
  exportName: string,
  input: NormalizationInput
) => Promise<unknown>;

export type NormalizationResult =
  | { readonly kind: "normalized"; readonly event: NormalizedEvent }
  /** Retryable: the hook or the runner failed for a reason that may not recur. */
  | { readonly kind: "failed"; readonly reason: string }
  /** Terminal: the output cannot satisfy the declared contract, so retrying cannot help. */
  | { readonly kind: "rejected"; readonly reason: string };

export interface NormalizedEvent {
  readonly type: string;
  readonly payload: unknown;
}

export class NormalizationRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NormalizationRejectedError";
  }
}

const MAX_EVENT_BYTES = 256 * 1024;

type SchemaCheck = (value: unknown) => string | null;

const compiled = new WeakMap<object, SchemaCheck>();

function validatorFor(eventType: OimEventType): SchemaCheck {
  const cached = compiled.get(eventType.schema as object);
  if (cached) return cached;
  const check = compileJsonSchema(eventType.schema);
  compiled.set(eventType.schema as object, check);
  return check;
}

/**
 * Turns a verified delivery into a typed event.
 *
 * The declared schema is checked after the hook runs, not before: the hook is the untrusted part,
 * and a subscriber that trusted its output unchecked would be trusting the Integration author
 * rather than the contract they published.
 */
export async function normalizeDelivery(
  eventType: OimEventType,
  input: NormalizationInput,
  runHook?: NormalizeHookRunner
): Promise<NormalizationResult> {
  let payload = input.payload;

  if (eventType.normalize !== undefined) {
    if (!runHook) {
      return {
        kind: "failed",
        reason: `no hook runner is available to execute ${eventType.normalize}`,
      };
    }
    try {
      payload = await runHook(eventType.normalize, input);
    } catch (error) {
      return {
        kind: "failed",
        reason: `${eventType.normalize} failed: ${messageOf(error)}`,
      };
    }
  }

  if (payload === undefined) {
    return { kind: "rejected", reason: `${eventType.type} normalized to nothing` };
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    // A hook can return a cycle or a BigInt. Neither survives storage, and neither becomes valid
    // on a retry.
    return { kind: "rejected", reason: `${eventType.type} normalized to a non-serializable value` };
  }
  if (serialized === undefined) {
    return { kind: "rejected", reason: `${eventType.type} normalized to a non-serializable value` };
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_EVENT_BYTES) {
    return {
      kind: "rejected",
      reason: `${eventType.type} normalized to more than ${MAX_EVENT_BYTES} bytes`,
    };
  }

  const mismatch = validatorFor(eventType)(payload);
  if (mismatch !== null) {
    return { kind: "rejected", reason: `${eventType.type} ${mismatch}` };
  }

  return { kind: "normalized", event: { type: eventType.type, payload } };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Backoff for a retryable failure, bounded so a broken mapping cannot spin. */
export function retryDelaySeconds(attempts: number): number {
  const delay = 2 ** Math.max(0, attempts - 1) * 30;
  return Math.min(delay, 3600);
}

export const MAX_NORMALIZATION_ATTEMPTS = 5;
