import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import { SchemaValidationError, type SchemaValidationIssue } from "../errors";

/** Normalized event envelope; `verified` events must include a verification method. */

const APversion = "tulipfarm.ai/v1";
const KIND = "EventEnvelope";

export const EVENT_VERIFICATION_STATUSES = ["verified", "unverified", "failed"] as const;
export type EventVerificationStatus = (typeof EVENT_VERIFICATION_STATUSES)[number];

// Pattern-based ISO date-time keeps Ajv strict mode free of ajv-formats.
const ISO_DATE_TIME = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$";

const nonEmptyString = { type: "string", minLength: 1 } as const;
const optionalString = { type: "string" } as const;

export interface EventEnvelope<T = unknown> {
  eventId: string;
  type: string;
  version: number;
  occurredAt: string;
  receivedAt: string;
  businessId: string;
  source: {
    provider: string;
    integrationId?: string;
    externalTenantId?: string;
    deliveryId?: string;
  };
  principal: { kind: string; internalId?: string; externalId?: string };
  record: { type?: string; id?: string; version?: string };
  deduplicationKey: string;
  correlationId?: string;
  causationId?: string;
  classification: string[];
  data: T;
  rawArtifactId?: string;
  rawPayloadHash?: string;
  verification: { status: EventVerificationStatus; method?: string };
}

export const EventEnvelopeSchema = {
  $id: `${APversion}/${KIND}`,
  type: "object",
  additionalProperties: false,
  required: [
    "eventId",
    "type",
    "version",
    "occurredAt",
    "receivedAt",
    "businessId",
    "source",
    "principal",
    "record",
    "deduplicationKey",
    "classification",
    "data",
    "verification",
  ],
  properties: {
    eventId: nonEmptyString,
    type: nonEmptyString,
    version: { type: "integer", minimum: 1 },
    occurredAt: { type: "string", pattern: ISO_DATE_TIME },
    receivedAt: { type: "string", pattern: ISO_DATE_TIME },
    businessId: nonEmptyString,
    source: {
      type: "object",
      additionalProperties: false,
      required: ["provider"],
      properties: {
        provider: nonEmptyString,
        integrationId: nonEmptyString,
        externalTenantId: nonEmptyString,
        deliveryId: nonEmptyString,
      },
    },
    principal: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: nonEmptyString,
        internalId: nonEmptyString,
        externalId: nonEmptyString,
      },
    },
    record: {
      type: "object",
      additionalProperties: false,
      properties: { type: optionalString, id: optionalString, version: optionalString },
    },
    deduplicationKey: nonEmptyString,
    correlationId: nonEmptyString,
    causationId: nonEmptyString,
    classification: { type: "array", items: { type: "string" } },
    data: {},
    rawArtifactId: nonEmptyString,
    rawPayloadHash: nonEmptyString,
    verification: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: { type: "string", enum: [...EVENT_VERIFICATION_STATUSES] },
        method: { type: "string", minLength: 1 },
      },
      // A verified event must prove how it was verified — reject raw-provider masquerading.
      if: { additionalProperties: true, properties: { status: { const: "verified" } } },
      // biome-ignore lint/suspicious/noThenProperty: `then` is a JSON Schema keyword, not a thenable.
      then: {
        additionalProperties: true,
        properties: { method: { type: "string", minLength: 1 } },
        required: ["method"],
      },
    },
  },
} as const;

function toIssues(errors: ErrorObject[] | null | undefined): SchemaValidationIssue[] {
  return (errors ?? [])
    .map((error) => ({
      keyword: error.keyword,
      message: error.message ?? "validation failed",
      path: error.instancePath,
    }))
    .sort((left, right) => {
      const leftKey = `${left.path}\u0000${left.keyword}\u0000${left.message}`;
      const rightKey = `${right.path}\u0000${right.keyword}\u0000${right.message}`;
      if (leftKey < rightKey) return -1;
      if (leftKey > rightKey) return 1;
      return 0;
    });
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validator: ValidateFunction = ajv.compile(EventEnvelopeSchema);

/** Validate a normalized event envelope; errors contain safe, value-free issues. */
export function validateEventEnvelope<T = unknown>(envelope: unknown): EventEnvelope<T> {
  if (!validator(envelope)) {
    throw new SchemaValidationError(APversion, KIND, toIssues(validator.errors));
  }
  return envelope as EventEnvelope<T>;
}
