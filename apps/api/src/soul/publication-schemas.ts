export const NullableStringSchema = {
  type: ["string", "null"],
} as const;

export const NullableDateTimeSchema = {
  type: ["string", "null"],
  format: "date-time",
} as const;

export const SoulPublicationStageSchema = {
  type: "string",
  enum: ["committed", "projected", "stored", "active"],
} as const;

export const SoulPublicationSchema = {
  type: "object",
  properties: {
    changesetId: { type: "string" },
    businessId: { type: "string" },
    commitSha: { type: "string" },
    digest: { type: "string" },
    stage: SoulPublicationStageSchema,
    publicationSequence: { type: ["number", "null"] },
    actorPrincipalId: { type: "string" },
    createdAt: NullableDateTimeSchema,
    attempts: { type: "number" },
    nextAttemptAt: NullableDateTimeSchema,
    failureCode: NullableStringSchema,
    deadLetteredAt: NullableDateTimeSchema,
    deadLetterReason: NullableStringSchema,
  },
  required: [
    "changesetId",
    "businessId",
    "commitSha",
    "digest",
    "stage",
    "publicationSequence",
    "actorPrincipalId",
    "createdAt",
    "attempts",
    "nextAttemptAt",
    "failureCode",
    "deadLetteredAt",
    "deadLetterReason",
  ],
} as const;

export const SoulPublicationActivationSchema = {
  type: "object",
  properties: {
    businessId: { type: "string" },
    activationSequence: { type: "number" },
    digest: { type: "string" },
    changesetId: { type: "string" },
    activatedAt: { type: "string", format: "date-time" },
    activatedByPrincipalId: { type: "string" },
  },
  required: [
    "businessId",
    "activationSequence",
    "digest",
    "changesetId",
    "activatedAt",
    "activatedByPrincipalId",
  ],
} as const;

export const SoulActiveBundleSchema = {
  type: "object",
  properties: {
    digest: { type: "string" },
    activatedAt: NullableDateTimeSchema,
    activatedByPrincipalId: NullableStringSchema,
  },
  required: ["digest", "activatedAt", "activatedByPrincipalId"],
} as const;

export const SoulPublicationPageSchema = {
  type: "object",
  properties: {
    publications: { type: "array", items: SoulPublicationSchema },
    nextCursor: NullableStringSchema,
  },
  required: ["publications", "nextCursor"],
} as const;

export const SoulPublicationListQuerystringSchema = {
  type: "object",
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100 },
    cursor: { type: "string" },
    changesetId: { type: "string" },
    stage: SoulPublicationStageSchema,
    digest: { type: "string" },
    deadLettered: { type: "boolean" },
  },
} as const;

export const SoulPublicationDeadLetterListQuerystringSchema = {
  type: "object",
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100 },
    cursor: { type: "string" },
  },
} as const;

export const SoulPublicationChangesetParamsSchema = {
  type: "object",
  required: ["changesetId"],
  properties: {
    changesetId: { type: "string", minLength: 1 },
  },
} as const;

export const SoulActiveBundleQuerystringSchema = {
  type: "object",
  properties: {
    historyLimit: { type: "integer", minimum: 1, maximum: 100 },
  },
} as const;

export const SoulActiveBundleResponseSchema = {
  type: "object",
  properties: {
    active: { anyOf: [SoulActiveBundleSchema, { type: "null" }] },
    history: { type: "array", items: SoulPublicationActivationSchema },
  },
  required: ["active", "history"],
} as const;

export const SoulActiveBundleRollbackBodySchema = {
  type: "object",
  required: ["digest", "reason"],
  additionalProperties: false,
  properties: {
    digest: { type: "string", minLength: 1 },
    reason: { type: "string", minLength: 1, maxLength: 1000 },
  },
} as const;

export const SoulActiveBundleRollbackResponseSchema = {
  type: "object",
  properties: {
    activated: { type: "boolean" },
    previousDigest: NullableStringSchema,
    digest: { type: "string" },
    changesetId: { type: "string" },
  },
  required: ["activated", "previousDigest", "digest", "changesetId"],
} as const;
