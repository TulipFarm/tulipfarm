import { ajv, type OimEventType, type OimManifest } from "@tulipfarm/schema";
import { type OimHookPhaseRunner, runOimHookPhase } from "../oim-hooks";

export interface NormalizationInput {
  readonly payload: unknown;
  readonly safeHeaders: Readonly<Record<string, string>>;
}

export type NormalizeHookRunner = OimHookPhaseRunner;

export type NormalizationResult =
  | { readonly kind: "normalized"; readonly event: NormalizedEvent }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "rejected"; readonly reason: string };

export interface NormalizedEvent {
  readonly type: string;
  readonly payload: unknown;
}

export class WebhookClassificationError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "WebhookClassificationError";
  }
}

const MAX_EVENT_BYTES = 256 * 1024;
type SchemaCheck = (value: unknown) => string | null;
function validatorFor(eventType: OimEventType): SchemaCheck {
  const validate = ajv.compile(eventType.schema);
  return (value) =>
    validate(value)
      ? null
      : (validate.errors?.[0]?.message ?? "does not match its declared schema");
}

export async function normalizeDelivery(
  manifest: Pick<OimManifest, "hooks">,
  eventType: OimEventType,
  input: NormalizationInput,
  runner?: OimHookPhaseRunner
): Promise<NormalizationResult> {
  let payload = input.payload;
  if (eventType.normalize !== undefined) {
    try {
      const result = await runOimHookPhase({
        manifest,
        kind: "response_normalize",
        exportName: eventType.normalize,
        input,
        ...(runner === undefined ? {} : { runner }),
      });
      if (!result.executed) {
        return { kind: "failed", reason: `${eventType.normalize} is not declared` };
      }
      payload = result.value;
    } catch (error) {
      return { kind: "failed", reason: `${eventType.normalize} failed: ${messageOf(error)}` };
    }
  }

  if (payload === undefined) {
    return { kind: "rejected", reason: `${eventType.type} normalized to nothing` };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
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

export async function classifyWebhookDelivery(
  manifest: Pick<OimManifest, "hooks" | "events">,
  input: NormalizationInput,
  runner?: OimHookPhaseRunner
): Promise<OimEventType | null | undefined> {
  const result = await runOimHookPhase({
    manifest,
    kind: "webhook_classify",
    input,
    ...(runner === undefined ? {} : { runner }),
  });
  if (!result.executed) return undefined;
  if (result.value === null) return null;
  if (typeof result.value !== "string") {
    throw new WebhookClassificationError(
      "webhook_classify Hook must return an event type string or null",
      false
    );
  }
  const eventType = manifest.events?.eventTypes.find(
    (candidate) => candidate.type === result.value
  );
  if (eventType === undefined) {
    throw new WebhookClassificationError(
      `webhook_classify Hook returned undeclared event type "${result.value}"`,
      false
    );
  }
  return eventType;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function retryDelaySeconds(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts - 1) * 30, 3600);
}

export const MAX_NORMALIZATION_ATTEMPTS = 5;
