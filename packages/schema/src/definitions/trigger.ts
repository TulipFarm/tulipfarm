import { SchemaRegistry, type ValidatedSchemaDocument } from "../registry";
import {
  DEFINITION_API_VERSION,
  type DefinitionMetadata,
  definitionMetadataSchema,
  definitionRegistration,
} from "./common";

/**
 * Trigger definition meta-schema (SPEC §7.1, §9.2). A Trigger maps a normalized event to a
 * published Routine version. Triggers are separate from Routines so routing stays
 * deterministic and independently versioned.
 *
 * Security invariants enforced structurally:
 * - A webhook trigger cannot masquerade as a trusted provider without declaring signature
 *   verification (a non-empty `secretRef`) — Hermes's `INSECURE_NO_AUTH` escape hatch is
 *   not representable (SPEC §9.2, §24).
 * - A scheduled/event Run uses an explicit `backgroundIdentity`; it never inherits an
 *   interactive user (SPEC §12).
 * - A `deduplication` key is mandatory so replay handling is deterministic (SPEC §9.2).
 * - Catch-up schedules are bounded: `catch_up_bounded` requires a `catchUpCap`.
 */

const apiVersion = DEFINITION_API_VERSION;
const kind = "Trigger";

export const TRIGGER_TYPES = [
  "manual",
  "internal_api",
  "datetime",
  "interval",
  "cron",
  "webhook",
  "integration_event",
  "form",
  "internal_event",
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const MISSED_RUN_POLICIES = ["skip", "run_once", "catch_up_bounded"] as const;
export const OVERLAP_POLICIES = ["skip", "allow", "supersede"] as const;
export const CONCURRENCY_POLICIES = [
  "serialize",
  "parallel",
  "queue",
  "coalesce",
  "reject",
  "supersede",
] as const;
export const WEBHOOK_VERIFICATION_METHODS = ["hmac_sha256", "hmac_sha1", "ed25519"] as const;

const nonEmptyString = { type: "string", minLength: 1 } as const;
const positiveInteger = { type: "integer", minimum: 1 } as const;
const ISO_DATE_TIME = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$";

const definitionRef = {
  type: "object",
  additionalProperties: false,
  required: ["name", "version"],
  properties: { id: nonEmptyString, name: nonEmptyString, version: nonEmptyString },
} as const;

const schedulePolicy = {
  type: "object",
  additionalProperties: false,
  required: ["missedRunPolicy", "overlapPolicy"],
  properties: {
    timezone: nonEmptyString,
    dstPolicy: { type: "string", enum: ["forward_only", "skip_missing", "run_repeated"] },
    missedRunPolicy: { type: "string", enum: [...MISSED_RUN_POLICIES] },
    catchUpCap: positiveInteger,
    overlapPolicy: { type: "string", enum: [...OVERLAP_POLICIES] },
    jitterMs: { type: "integer", minimum: 0 },
    startAt: { type: "string", pattern: ISO_DATE_TIME },
    endAt: { type: "string", pattern: ISO_DATE_TIME },
    calendarRef: nonEmptyString,
  },
  // Bounded catch-up: catching up on missed fires requires an explicit cap.
  if: {
    additionalProperties: true,
    properties: { missedRunPolicy: { const: "catch_up_bounded" } },
  },
  // biome-ignore lint/suspicious/noThenProperty: `then` is a JSON Schema keyword, not a thenable.
  then: {
    additionalProperties: true,
    properties: { catchUpCap: positiveInteger },
    required: ["catchUpCap"],
  },
} as const;

// Fields every trigger variant shares.
const sharedSpecProps = {
  routineRef: definitionRef,
  eventType: nonEmptyString,
  eventVersion: positiveInteger,
  filter: nonEmptyString,
  inputMapping: { type: "object", additionalProperties: true },
  backgroundIdentity: {
    type: "object",
    additionalProperties: false,
    required: ["principalKind", "principalId"],
    properties: { principalKind: nonEmptyString, principalId: nonEmptyString },
  },
  deduplication: {
    type: "object",
    additionalProperties: false,
    required: ["key"],
    properties: { key: nonEmptyString, windowMs: positiveInteger },
  },
  rateLimit: {
    type: "object",
    additionalProperties: false,
    required: ["maxPerMinute"],
    properties: { maxPerMinute: positiveInteger },
  },
  concurrency: {
    type: "object",
    additionalProperties: false,
    required: ["key", "policy"],
    properties: {
      key: nonEmptyString,
      policy: { type: "string", enum: [...CONCURRENCY_POLICIES] },
      max: positiveInteger,
    },
  },
} as const;

const sharedRequired = [
  "type",
  "routineRef",
  "eventType",
  "eventVersion",
  "backgroundIdentity",
  "deduplication",
] as const;

function variant(
  type: TriggerType,
  extraProps: Record<string, unknown>,
  extraRequired: readonly string[] = []
) {
  return {
    type: "object",
    additionalProperties: false,
    required: [...sharedRequired, ...extraRequired],
    properties: {
      type: { const: type },
      ...sharedSpecProps,
      ...extraProps,
    },
  } as const;
}

const specVariants = [
  variant("manual", {}),
  variant("internal_api", {}),
  variant(
    "datetime",
    { at: { type: "string", pattern: ISO_DATE_TIME }, schedule: schedulePolicy },
    ["at"]
  ),
  variant("interval", { everyMs: positiveInteger, schedule: schedulePolicy }, ["everyMs"]),
  variant(
    "cron",
    { expression: nonEmptyString, timezone: nonEmptyString, schedule: schedulePolicy },
    ["expression"]
  ),
  variant(
    "webhook",
    {
      verification: {
        type: "object",
        additionalProperties: false,
        required: ["method", "secretRef"],
        properties: {
          method: { type: "string", enum: [...WEBHOOK_VERIFICATION_METHODS] },
          secretRef: nonEmptyString,
        },
      },
    },
    ["verification"]
  ),
  variant(
    "integration_event",
    {
      provider: nonEmptyString,
      matchEventType: nonEmptyString,
      matchEventVersion: positiveInteger,
    },
    ["provider", "matchEventType"]
  ),
  variant("form", { formRef: nonEmptyString }, ["formRef"]),
  variant(
    "internal_event",
    { matchEventType: nonEmptyString, matchEventVersion: positiveInteger },
    ["matchEventType"]
  ),
];

export const TriggerDefinitionSchema = {
  $id: `${apiVersion}/${kind}`,
  type: "object",
  additionalProperties: false,
  required: ["apiVersion", "kind", "metadata", "spec"],
  properties: {
    apiVersion: { const: apiVersion },
    kind: { const: kind },
    metadata: definitionMetadataSchema,
    spec: { oneOf: specVariants },
  },
} as const;

export interface TriggerRef {
  id?: string;
  name: string;
  version: string;
}

export interface TriggerDefinition {
  apiVersion: typeof apiVersion;
  kind: typeof kind;
  metadata: DefinitionMetadata;
  spec: {
    type: TriggerType;
    routineRef: TriggerRef;
    eventType: string;
    eventVersion: number;
    backgroundIdentity: { principalKind: string; principalId: string };
    deduplication: { key: string; windowMs?: number };
    [key: string]: unknown;
  };
}

export interface ValidatedTriggerDocument extends ValidatedSchemaDocument {
  document: Readonly<TriggerDefinition>;
}

export const TRIGGER_DEFINITION = definitionRegistration(kind, TriggerDefinitionSchema);
export const TriggerSchemaRegistration = TRIGGER_DEFINITION;

let registry: SchemaRegistry | undefined;

/**
 * Validate a Trigger definition. Returns the canonical validated document (typed) on
 * success; throws a `SchemaContractError` subtype on failure.
 */
export function validateTriggerDefinition(document: unknown): ValidatedTriggerDocument {
  registry ??= new SchemaRegistry([TriggerSchemaRegistration]);
  return registry.validate(document) as ValidatedTriggerDocument;
}
