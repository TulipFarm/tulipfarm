/**
 * Schemas for the channel plane: identity resolution, Run creation from a channel,
 * and channel-side approval decisions. Split from `schemas.ts`, which owns the Worker
 * callback plane, so neither file carries the other's churn.
 */

export const ChannelIdentityResolveBodySchema = {
  type: "object",
  required: ["provider", "externalSubject"],
  additionalProperties: false,
  properties: {
    provider: { type: "string", minLength: 1 },
    externalSubject: { type: "string", minLength: 1 },
    externalTenantId: { type: "string", minLength: 1 },
  },
} as const;

export const ChannelIdentityResolveResponseSchema = {
  type: "object",
  required: ["linked"],
  properties: {
    linked: { type: "boolean" },
    principal: {
      type: "object",
      required: ["kind", "id"],
      properties: { kind: { type: "string" }, id: { type: "string" } },
    },
  },
} as const;

export const ChannelIdentityBindOfferBodySchema = {
  type: "object",
  required: ["provider", "externalSubject", "channelId"],
  additionalProperties: false,
  properties: {
    provider: { type: "string", minLength: 1 },
    externalSubject: { type: "string", minLength: 1 },
    externalTenantId: { type: "string", minLength: 1 },
    channelId: { type: "string", minLength: 1 },
    threadId: { type: "string" },
  },
} as const;

export const ChannelIdentityBindOfferResponseSchema = {
  type: "object",
  required: ["outcome"],
  properties: {
    outcome: { type: "string", enum: ["sent", "no_offer", "unconfigured"] },
  },
} as const;

export const ChannelRunCreateBodySchema = {
  type: "object",
  required: ["eventId", "provider", "integrationId", "routeId", "agentId", "principal", "message"],
  additionalProperties: false,
  properties: {
    eventId: { type: "string", minLength: 1 },
    provider: { type: "string", minLength: 1 },
    integrationId: { type: "string", minLength: 1 },
    routeId: { type: "string", minLength: 1 },
    agentId: { type: "string", minLength: 1 },
    principal: {
      type: "object",
      required: ["kind", "id"],
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["user", "guest"] },
        id: { type: "string" },
      },
    },
    message: {
      type: "object",
      required: ["externalAppId", "channelId", "text"],
      additionalProperties: false,
      properties: {
        externalAppId: { type: "string" },
        channelId: { type: "string" },
        threadId: { type: "string" },
        sourceMessageTs: {
          type: "string",
          description:
            "The provider id of the message that started this Run (Slack's `event.ts`). Distinct from `threadId`, which is the thread root — a reaction keyed off `threadId` lands on the wrong message for every in-thread reply.",
        },
        text: { type: "string" },
      },
    },
  },
} as const;

export const ChannelRunCreateResponseSchema = {
  type: "object",
  required: ["runId", "outcome"],
  properties: {
    runId: { type: "string" },
    outcome: { type: "string", enum: ["started", "duplicate"] },
  },
} as const;

export const ChannelRunReplyQuerySchema = {
  type: "object",
  properties: { attempt: { type: "integer", minimum: 1 } },
} as const;

export const ChannelRunReplyResponseSchema = {
  type: "object",
  required: ["status"],
  properties: {
    status: { type: "string", enum: ["succeeded", "failed", "pending"] },
    text: { type: "string" },
    agentDisplayName: { type: "string" },
    blocks: { type: "array", items: { type: "object", additionalProperties: true } },
    reason: { type: "string" },
  },
} as const;

export const ChannelRunPendingApprovalResponseSchema = {
  type: "object",
  required: ["pending"],
  properties: {
    pending: { type: "boolean" },
    approvalId: { type: "string" },
    toolName: { type: "string" },
    args: {},
  },
} as const;

export const ChannelSlackCredentialResponseSchema = {
  type: "object",
  required: ["configured"],
  properties: {
    configured: { type: "boolean" },
    botToken: { type: "string" },
    appToken: { type: "string" },
  },
} as const;

export const ChannelSlackCommandResponseCreateBodySchema = {
  type: "object",
  required: ["idempotencyKey", "responseUrl", "response"],
  additionalProperties: false,
  properties: {
    idempotencyKey: { type: "string", minLength: 1 },
    responseUrl: {
      type: "string",
      pattern: "^https://hooks\\.slack(?:-gov)?\\.com/commands/",
    },
    response: {
      type: "string",
      enum: ["starting", "unlinked", "denied", "prompt_unavailable"],
    },
  },
} as const;

export const ChannelSlackCommandResponseCreateResponseSchema = {
  type: "object",
  required: ["outcome"],
  properties: { outcome: { type: "string", enum: ["reserved", "duplicate"] } },
} as const;

export const ChannelSlackCommandResponseProcessResponseSchema = {
  type: "object",
  required: ["attempted", "delivered"],
  properties: {
    attempted: { type: "integer", minimum: 0 },
    delivered: { type: "integer", minimum: 0 },
  },
} as const;

export const ChannelSlackCommandResponseProcessQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    idempotencyKey: { type: "string", minLength: 1 },
  },
} as const;

export const ChannelApprovalDecisionParamsSchema = {
  type: "object",
  required: ["approvalId"],
  properties: { approvalId: { type: "string", minLength: 1 } },
} as const;

export const ChannelApprovalDecisionBodySchema = {
  type: "object",
  required: ["provider", "externalSubject", "decision"],
  additionalProperties: false,
  anyOf: [
    {
      properties: { provider: { not: { const: "slack" } } },
      required: ["provider"],
    },
    {
      properties: { provider: { const: "slack" } },
      required: ["provider", "externalTenantId"],
    },
  ],
  properties: {
    provider: { type: "string", minLength: 1 },
    externalSubject: { type: "string", minLength: 1 },
    externalTenantId: { type: "string", minLength: 1 },
    decision: { type: "string", enum: ["approved", "denied"] },
  },
} as const;

export const ChannelApprovalDecisionResponseSchema = {
  type: "object",
  required: ["outcome"],
  properties: {
    outcome: {
      type: "string",
      enum: ["resumed", "already_settled", "forbidden", "not_found", "unlinked"],
    },
  },
} as const;
