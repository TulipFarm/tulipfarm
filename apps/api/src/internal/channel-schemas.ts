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

export const ChannelApprovalDecisionParamsSchema = {
  type: "object",
  required: ["approvalId"],
  properties: { approvalId: { type: "string", minLength: 1 } },
} as const;

export const ChannelApprovalDecisionBodySchema = {
  type: "object",
  required: ["provider", "externalSubject", "decision"],
  additionalProperties: false,
  properties: {
    provider: { type: "string", minLength: 1 },
    externalSubject: { type: "string", minLength: 1 },
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
