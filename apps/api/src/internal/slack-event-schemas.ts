const nonEmptyString = { type: "string", minLength: 1 } as const;

export const SlackEventBodySchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["externalAppId", "event"],
      properties: {
        externalAppId: nonEmptyString,
        event: {
          type: "object",
          additionalProperties: true,
          required: [
            "name",
            "version",
            "integrationId",
            "externalTenantId",
            "providerEventId",
            "occurredAt",
            "deduplicationKey",
            "classification",
            "untrustedPayload",
          ],
          properties: {
            name: nonEmptyString,
            version: { const: 1 },
            integrationId: nonEmptyString,
            externalTenantId: nonEmptyString,
            providerEventId: nonEmptyString,
            occurredAt: nonEmptyString,
            deduplicationKey: nonEmptyString,
            classification: {
              type: "array",
              items: { type: "string", enum: ["untrusted.external"] },
              minItems: 1,
              maxItems: 1,
            },
            untrustedPayload: { type: "object", additionalProperties: true },
          },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["externalAppId", "failure"],
      properties: {
        externalAppId: nonEmptyString,
        failure: {
          type: "object",
          additionalProperties: false,
          required: [
            "integrationId",
            "externalTenantId",
            "providerEventId",
            "sourceEventType",
            "issues",
          ],
          properties: {
            integrationId: nonEmptyString,
            externalTenantId: nonEmptyString,
            providerEventId: nonEmptyString,
            sourceEventType: nonEmptyString,
            occurredAt: nonEmptyString,
            issues: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["path", "keyword", "message"],
                properties: {
                  path: { type: "string" },
                  keyword: nonEmptyString,
                  message: nonEmptyString,
                },
              },
            },
          },
        },
      },
    },
  ],
} as const;

export const SlackEventResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "eventId"],
  properties: {
    outcome: { type: "string", enum: ["recorded", "failed"] },
    eventId: nonEmptyString,
  },
} as const;

export const SlackEventDispatchParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["eventId"],
  properties: {
    eventId: nonEmptyString,
  },
} as const;

export const SlackEventDispatchResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome"],
  properties: {
    outcome: { type: "string", enum: ["dispatched", "ignored"] },
  },
} as const;
