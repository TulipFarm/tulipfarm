export const SlackHomeBodySchema = {
  type: "object",
  required: ["integrationId", "externalTenantId", "externalAppId", "externalSubject"],
  additionalProperties: false,
  properties: {
    integrationId: { type: "string", minLength: 1 },
    externalTenantId: { type: "string", minLength: 1 },
    externalAppId: { type: "string", minLength: 1 },
    externalSubject: { type: "string", minLength: 1 },
  },
} as const;

export const SlackHomeResponseSchema = {
  type: "object",
  required: ["integrationId", "linked", "renderDigest", "view"],
  additionalProperties: false,
  properties: {
    integrationId: { type: "string", minLength: 1 },
    linked: { type: "boolean" },
    renderDigest: { type: "string", minLength: 1 },
    view: { type: "object", additionalProperties: true },
  },
} as const;
