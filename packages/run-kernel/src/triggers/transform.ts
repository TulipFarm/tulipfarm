import type { event as eventSchema } from "@tulipfarm/schema";
import { dotPath, type RegisteredTrigger } from "./matcher";

/**
 * Turn a matched Trigger plus its event into the command that starts a Run.
 *
 * Three invariants hold here. The Run's identity is the Trigger's declared background identity —
 * never the event's principal, so a webhook caller cannot borrow authority. The Run's input is
 * only what the Trigger mapped — an unmapped field never reaches the Routine, so a payload can
 * neither smuggle Context nor leak more than the author intended. And the idempotency key is a
 * pure function of the Trigger, its authored version, and the event's deduplication key, so a
 * redelivered event resolves to the same invocation instead of a second Run.
 */

export type TriggerBindErrorCode =
  | "event_not_verified"
  | "identity_not_declared"
  | "mapping_unresolved";

/** A binding denial. Carries only `code:subject` — never an event value. */
export class TriggerBindError extends Error {
  constructor(
    readonly code: TriggerBindErrorCode,
    readonly subject: string
  ) {
    super(`${code}:${subject}`);
    this.name = "TriggerBindError";
  }
}

export interface RunInvocation {
  readonly businessId: string;
  readonly routineRef: { readonly name: string; readonly version: string };
  readonly triggerSlug: string;
  readonly triggerVersion: number;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly backgroundIdentity: {
    readonly principalKind: string;
    readonly principalId: string;
  };
  readonly mode: "routine" | "semantic_intake";
  /** Semantic intake only: the Agent that reads the event. */
  readonly agentRef?: { readonly name: string; readonly version: string };
  /** Semantic intake only: the Run may not produce effects. */
  readonly readOnly?: true;
  readonly input: Readonly<Record<string, unknown>>;
  readonly classification: readonly string[];
  readonly correlationId?: string;
  readonly causationId: string;
}

/** Build the Run command for a matched Trigger, or fail closed. */
export function buildInvocation(
  trigger: RegisteredTrigger,
  envelope: eventSchema.EventEnvelope<Record<string, unknown>>
): RunInvocation {
  const { principalKind, principalId } = trigger.backgroundIdentity;
  if (principalKind === "" || principalId === "") {
    throw new TriggerBindError("identity_not_declared", trigger.triggerSlug);
  }
  if (trigger.requireVerified === true && envelope.verification.status !== "verified") {
    throw new TriggerBindError("event_not_verified", trigger.triggerSlug);
  }

  const input: Record<string, unknown> = {};
  for (const [key, path] of Object.entries(trigger.inputMappings ?? {})) {
    const value = dotPath(envelope.data, path);
    if (value === undefined) throw new TriggerBindError("mapping_unresolved", trigger.triggerSlug);
    input[key] = value;
  }

  const intake = trigger.semanticIntakeAgent;
  return {
    businessId: envelope.businessId,
    routineRef: trigger.routineRef,
    triggerSlug: trigger.triggerSlug,
    triggerVersion: trigger.authoredVersion,
    eventId: envelope.eventId,
    idempotencyKey: `${trigger.triggerSlug}:${trigger.authoredVersion}:${envelope.deduplicationKey}`,
    backgroundIdentity: { principalKind, principalId },
    ...(intake === undefined
      ? { mode: "routine" as const }
      : { mode: "semantic_intake" as const, agentRef: intake, readOnly: true as const }),
    input,
    classification: [...envelope.classification],
    ...(envelope.correlationId === undefined ? {} : { correlationId: envelope.correlationId }),
    causationId: envelope.eventId,
  };
}
