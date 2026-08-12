import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { SchemaRegistry, type ValidatedSchemaDocument } from "../registry";
import {
  DEFINITION_API_VERSION,
  definitionMetadataSchema,
  definitionRegistration,
  secretReferenceSchema,
} from "./common";

/**
 * Trigger definition meta-schema (SPEC §7.1, §9.2). A Trigger maps a normalized event to a
 * published Routine version. Triggers are separate from Routines so routing stays
 * deterministic and independently versioned.
 *
 * Security invariants enforced structurally:
 * - A webhook trigger cannot masquerade as a trusted provider without declaring signature
 *   verification (a `secret://` `secretRef`) — Hermes's `INSECURE_NO_AUTH` escape hatch is
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

const DST_POLICIES = ["forward_only", "skip_missing", "run_repeated"] as const;

const nonEmptyString = Type.String({ minLength: 1 });
const positiveInteger = Type.Integer({ minimum: 1 });
const ISO_DATE_TIME = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$";

const definitionRef = Type.Object(
  {
    id: Type.Optional(nonEmptyString),
    name: nonEmptyString,
    version: nonEmptyString,
  },
  { additionalProperties: false }
);

const schedulePolicy = Type.Object(
  {
    timezone: Type.Optional(nonEmptyString),
    dstPolicy: Type.Optional(
      Type.Unsafe<(typeof DST_POLICIES)[number]>({ type: "string", enum: [...DST_POLICIES] })
    ),
    missedRunPolicy: Type.Unsafe<(typeof MISSED_RUN_POLICIES)[number]>({
      type: "string",
      enum: [...MISSED_RUN_POLICIES],
    }),
    catchUpCap: Type.Optional(positiveInteger),
    overlapPolicy: Type.Unsafe<(typeof OVERLAP_POLICIES)[number]>({
      type: "string",
      enum: [...OVERLAP_POLICIES],
    }),
    jitterMs: Type.Optional(Type.Integer({ minimum: 0 })),
    startAt: Type.Optional(Type.String({ pattern: ISO_DATE_TIME })),
    endAt: Type.Optional(Type.String({ pattern: ISO_DATE_TIME })),
    calendarRef: Type.Optional(nonEmptyString),
  },
  {
    additionalProperties: false,
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
  }
);

// Fields every trigger variant shares.
const sharedSpecProps = {
  routineRef: definitionRef,
  eventType: nonEmptyString,
  eventVersion: positiveInteger,
  filter: Type.Optional(nonEmptyString),
  inputMapping: Type.Optional(Type.Unknown({ type: "object", additionalProperties: true })),
  backgroundIdentity: Type.Object(
    {
      principalKind: nonEmptyString,
      principalId: nonEmptyString,
    },
    { additionalProperties: false }
  ),
  deduplication: Type.Object(
    {
      key: nonEmptyString,
      windowMs: Type.Optional(positiveInteger),
    },
    { additionalProperties: false }
  ),
  rateLimit: Type.Optional(
    Type.Object(
      {
        maxPerMinute: positiveInteger,
      },
      { additionalProperties: false }
    )
  ),
  concurrency: Type.Optional(
    Type.Object(
      {
        key: nonEmptyString,
        policy: Type.Unsafe<(typeof CONCURRENCY_POLICIES)[number]>({
          type: "string",
          enum: [...CONCURRENCY_POLICIES],
        }),
        max: Type.Optional(positiveInteger),
      },
      { additionalProperties: false }
    )
  ),
} satisfies Record<string, TSchema>;

function variant<
  const VariantType extends TriggerType,
  const ExtraProps extends Record<string, TSchema>,
>(type: VariantType, extraProps: ExtraProps) {
  return Type.Object(
    {
      type: Type.Unsafe<VariantType>({ const: type }),
      ...sharedSpecProps,
      ...extraProps,
    },
    { additionalProperties: false }
  );
}

const specVariants = [
  variant("manual", {}),
  variant("internal_api", {}),
  variant("datetime", {
    at: Type.String({ pattern: ISO_DATE_TIME }),
    schedule: Type.Optional(schedulePolicy),
  }),
  variant("interval", {
    everyMs: positiveInteger,
    schedule: Type.Optional(schedulePolicy),
  }),
  variant("cron", {
    expression: nonEmptyString,
    timezone: Type.Optional(nonEmptyString),
    schedule: Type.Optional(schedulePolicy),
  }),
  variant("webhook", {
    provider: nonEmptyString,
    verification: Type.Object(
      {
        method: Type.Unsafe<(typeof WEBHOOK_VERIFICATION_METHODS)[number]>({
          type: "string",
          enum: [...WEBHOOK_VERIFICATION_METHODS],
        }),
        secretRef: secretReferenceSchema,
        signatureHeader: nonEmptyString,
        signingTemplate: Type.Optional(nonEmptyString),
        signatureFormat: Type.Optional(nonEmptyString),
        timestampHeader: Type.Optional(nonEmptyString),
        toleranceMs: Type.Optional(positiveInteger),
      },
      { additionalProperties: false }
    ),
  }),
  variant("integration_event", {
    provider: nonEmptyString,
    matchEventType: nonEmptyString,
    matchEventVersion: Type.Optional(positiveInteger),
  }),
  variant("form", { formRef: nonEmptyString }),
  variant("internal_event", {
    matchEventType: nonEmptyString,
    matchEventVersion: Type.Optional(positiveInteger),
  }),
] as const;

const specSchema = Type.Unsafe<Static<(typeof specVariants)[number]>>({
  oneOf: specVariants,
});

export const TriggerDefinitionSchema = Type.Object(
  {
    apiVersion: Type.Unsafe<typeof apiVersion>({ const: apiVersion }),
    kind: Type.Unsafe<typeof kind>({ const: kind }),
    metadata: definitionMetadataSchema,
    spec: specSchema,
  },
  { $id: `${apiVersion}/${kind}`, additionalProperties: false }
);

export type TriggerDefinition = Static<typeof TriggerDefinitionSchema>;
export type TriggerSpec = TriggerDefinition["spec"];
export type TriggerRef = TriggerSpec["routineRef"];

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
