import { MESSAGE_METADATA_SCHEMA, MessageContentSchema } from "@tulipfarm/schema";

/**
 * A durable wait exactly as the run-kernel planned it, minus the identity the route states. The
 * Worker sends a plan rather than a registered wait because the plan is authored data — the State's
 * deadline, its approver roles, its schema — while the resume token the registration mints is a
 * capability, and that must never travel back over this hop.
 */
export const InternalRoutineWaitPlanSchema = {
  type: "object",
  required: [
    "id",
    "stateKey",
    "kind",
    "aggregation",
    "schemaRef",
    "allowedPrincipals",
    "expectedSignals",
    "quorum",
    "deadlineAt",
    "createdAt",
  ],
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    stateKey: { type: "string", minLength: 1 },
    kind: { type: "string", enum: ["approval"] },
    aggregation: { type: "string", enum: ["first", "all", "quorum", "window"] },
    schemaRef: { type: "string", minLength: 1 },
    allowedPrincipals: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
    expectedSignals: { type: "integer", minimum: 1 },
    quorum: { type: ["integer", "null"], minimum: 1 },
    deadlineAt: { type: "string", minLength: 1 },
    createdAt: { type: "string", minLength: 1 },
  },
} as const;

export const InternalRoutineApprovalResponseSchema = {
  type: "object",
  required: ["approvalId", "waitId", "decision"],
  properties: {
    approvalId: { type: "string" },
    waitId: { type: "string" },
    decision: { type: "string", enum: ["pending", "approved", "denied", "expired"] },
  },
} as const;

export const InternalTurnToolCallBodySchema = {
  type: "object",
  required: ["callId", "name"],
  additionalProperties: false,
  properties: {
    callId: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    arguments: {},
    stateId: { type: "string", minLength: 1, maxLength: 128 },
    activeSkillName: { type: "string", minLength: 1, maxLength: 64 },
    agentName: { type: "string", minLength: 1, maxLength: 128 },
  },
} as const;

export const InternalTurnAuthorityResponseSchema = {
  type: "object",
  required: ["businessId", "runId", "subject", "source", "bundleDigest"],
  properties: {
    businessId: { type: "string" },
    runId: { type: "string" },
    turn: {
      type: "object",
      required: ["id", "conversationId", "attempt"],
      properties: {
        id: { type: "string" },
        conversationId: { type: "string" },
        attempt: { type: "integer" },
      },
    },
    subject: {
      type: "object",
      required: ["kind", "id"],
      properties: { kind: { type: "string" }, id: { type: "string" } },
    },
    source: { type: "string" },
    bundleDigest: { type: "string" },
    routineId: { type: "string" },
    /** The Soul-resolved Agent this Run routes to; absent when no Soul answered for it. */
    agent: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        autonomy: { type: "string" },
        toolAllowlist: { type: "array", items: { type: "string" } },
        capabilityRestrictions: { type: "object", additionalProperties: true },
      },
    },
  },
} as const;

/** Names the Agent a Turnless Run acts as; the control plane confirms it before honouring it. */
export const InternalRunAgentQuerySchema = {
  type: "object",
  properties: { agent: { type: "string", minLength: 1, maxLength: 128 } },
} as const;

/** One Tool the acting Agent may be offered, in the shape the Agent loop exposes to the model. */
export const InternalRunAgentToolsResponseSchema = {
  type: "object",
  required: ["tools"],
  properties: {
    tools: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "description", "inputSchema"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          inputSchema: { type: "object", additionalProperties: true },
          tier: { type: "string" },
          mutating: { type: "boolean" },
        },
      },
    },
  },
} as const;

export const InternalRunParamsSchema = {
  type: "object",
  required: ["runId"],
  properties: { runId: { type: "string", minLength: 1 } },
} as const;

export const InternalTurnAttachmentParamsSchema = {
  type: "object",
  required: ["runId", "fileId"],
  properties: {
    runId: { type: "string", minLength: 1 },
    fileId: { type: "string", minLength: 1 },
  },
} as const;

export const InternalLlmConfigResponseSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export const InternalLlmConfigEmptyResponseSchema = {
  type: "null",
  description: "No LLM configuration is published.",
} as const;

export const InternalObservabilityPricingResponseSchema = {
  type: "object",
  required: ["overrides"],
  properties: {
    overrides: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["in", "out"],
        properties: { in: { type: "number" }, out: { type: "number" } },
      },
    },
  },
} as const;

export const InternalTurnLookupResponseSchema = {
  type: "object",
  required: ["turnId", "conversationId", "attempt"],
  properties: {
    turnId: { type: "string" },
    conversationId: { type: "string" },
    attempt: { type: "integer" },
  },
} as const;

export const InternalTurnContextResponseSchema = {
  type: "object",
  required: [
    "agentId",
    "subjectId",
    "modelProfileId",
    "contextDigest",
    "guardrailDigest",
    "guardrailPolicy",
    "messages",
    "tools",
    "limits",
    "compacted",
  ],
  properties: {
    agentId: { type: "string" },
    subjectId: { type: "string" },
    modelProfileId: { type: "string" },
    // Undeclared properties are stripped on serialization, so an omission here would
    // silently drop the Agent's governance demand between API and Worker.
    modelPolicy: {
      type: "object",
      additionalProperties: false,
      properties: {
        residency: { type: "string" },
        dataRetention: { type: "string" },
        allowTraining: { type: "boolean" },
        maxLatencyMs: { type: "integer" },
        sensitive: { type: "boolean" },
      },
    },
    principal: {
      type: "object",
      required: ["kind", "id"],
      additionalProperties: false,
      properties: { kind: { type: "string" }, id: { type: "string" } },
    },
    contextDigest: { type: "string" },
    guardrailDigest: { type: "string" },
    guardrailPolicy: { type: "object", additionalProperties: true },
    messages: {
      type: "array",
      items: {
        type: "object",
        required: ["role", "content"],
        properties: { role: { type: "string" }, content: MessageContentSchema },
      },
    },
    attachments: {
      type: "array",
      items: {
        type: "object",
        required: ["fileId", "mediaType", "name"],
        additionalProperties: false,
        properties: {
          fileId: { type: "string" },
          mediaType: { type: "string" },
          name: { type: "string" },
        },
      },
    },
    tools: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "inputSchema", "tier"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          inputSchema: { type: "object", additionalProperties: true },
          tier: { type: "string" },
          mutating: { type: "boolean" },
        },
      },
    },
    limits: {
      type: "object",
      required: ["maxIterations", "maxToolCalls", "maxRepairAttempts"],
      properties: {
        maxIterations: { type: "integer" },
        maxToolCalls: { type: "integer" },
        maxRepairAttempts: { type: "integer" },
      },
    },
    compacted: { type: "boolean" },
  },
} as const;

export const InternalTurnToolResultResponseSchema = {
  type: "object",
  required: ["status"],
  properties: {
    status: {
      type: "string",
      enum: ["succeeded", "denied", "invalid_arguments", "failed", "awaiting_approval"],
    },
    output: {},
    reason: { type: "string" },
    approvalId: { type: "string" },
    connectUrl: { type: "string", minLength: 1 },
  },
} as const;

export const InternalTurnApprovalWaitParamsSchema = {
  type: "object",
  required: ["runId", "approvalId"],
  properties: {
    runId: { type: "string", minLength: 1 },
    approvalId: { type: "string", minLength: 1 },
  },
} as const;

export const InternalTurnApprovalWaitBodySchema = {
  type: "object",
  required: ["stateKey"],
  additionalProperties: false,
  properties: { stateKey: { type: "string", minLength: 1 } },
} as const;

export const InternalTurnApprovalWaitResponseSchema = {
  type: "object",
  required: ["waitId"],
  properties: { waitId: { type: "string" } },
} as const;

export const InternalTurnCompletionQuerySchema = {
  type: "object",
  required: ["attempt"],
  additionalProperties: false,
  properties: { attempt: { type: "integer", minimum: 1 } },
} as const;

export const InternalTurnCompletionResponseSchema = {
  type: "object",
  required: ["turnId", "attempt", "status", "messageId", "cursor"],
  properties: {
    turnId: { type: "string" },
    attempt: { type: "integer" },
    status: { type: "string", enum: ["succeeded", "failed"] },
    messageId: { type: ["string", "null"] },
    cursor: { type: "integer" },
  },
} as const;

export const InternalTurnCompletionEmptyResponseSchema = {
  type: "null",
  description: "This attempt has recorded no outcome yet.",
} as const;

export const InternalTurnMessageBodySchema = {
  type: "object",
  required: ["attempt", "content"],
  additionalProperties: false,
  properties: {
    attempt: { type: "integer", minimum: 1 },
    // Empty is legal: a Turn that only ran Tools still needs a Message to carry `toolCalls`.
    content: { type: "string" },
    metadata: MESSAGE_METADATA_SCHEMA,
  },
} as const;

export const InternalTurnMessageResponseSchema = {
  type: "object",
  required: ["messageId"],
  properties: { messageId: { type: "string" } },
} as const;

/** A Surface an attempt presented; rides with the outcome so the two cannot diverge. */
const SURFACE_LINK_SCHEMA = {
  type: "object",
  required: ["artifactId", "revision"],
  additionalProperties: false,
  properties: {
    artifactId: { type: "string", minLength: 1 },
    revision: { type: "integer", minimum: 1 },
  },
} as const;

export const InternalTurnCompletionRecordBodySchema = {
  type: "object",
  required: ["attempt", "status", "cursor"],
  additionalProperties: false,
  properties: {
    attempt: { type: "integer", minimum: 1 },
    status: { type: "string", enum: ["succeeded", "failed"] },
    cursor: { type: "integer", minimum: 0 },
    messageId: { type: ["string", "null"] },
    surfaces: { type: "array", items: SURFACE_LINK_SCHEMA },
  },
} as const;

export const InternalTurnCompletionRecordResponseSchema = {
  type: "object",
  required: ["status"],
  properties: { status: { type: "string" } },
} as const;

export const InternalDeliveryDescriptionResponseSchema = {
  type: "object",
  required: ["slug", "body", "headers", "classifier", "hasThreadMapping", "env"],
  properties: {
    slug: { type: "string" },
    body: { type: "object", additionalProperties: true },
    headers: { type: "object", additionalProperties: { type: "string" } },
    classifier: {
      type: "object",
      required: ["source", "hash"],
      properties: { source: { type: "string" }, hash: { type: "string" } },
    },
    hasThreadMapping: { type: "boolean" },
    chatEnabled: { type: "boolean" },
    eventsEnabled: { type: "boolean" },
    env: { type: "object", additionalProperties: { type: "string" } },
  },
} as const;

export const InternalDeliveryChatAttachmentBodySchema = {
  type: "object",
  required: ["sender", "text", "reply"],
  additionalProperties: false,
  properties: {
    sender: { type: "string", minLength: 1 },
    text: { type: "string" },
    requireExistingThread: { type: "boolean" },
    reply: {
      type: "object",
      required: ["binding"],
      additionalProperties: false,
      properties: {
        binding: { type: "string", minLength: 1 },
        vars: { type: "object", additionalProperties: { type: "string" } },
      },
    },
  },
} as const;

export const InternalDeliveryChatAttachmentResponseSchema = {
  type: "object",
  required: ["outcome"],
  properties: {
    outcome: { type: "string", enum: ["attached", "unlinked", "ignored"] },
    turnId: { type: "string" },
    attempt: { type: "integer" },
    reason: { type: "string" },
  },
} as const;

export const InternalDeliveryEventBodySchema = {
  type: "object",
  required: ["eventType"],
  additionalProperties: false,
  properties: {
    eventType: { type: "string", minLength: 1 },
    payload: { type: "object", additionalProperties: true },
  },
} as const;

export const InternalDeliveryEventResponseSchema = {
  type: "object",
  required: ["outcome"],
  properties: {
    outcome: { type: "string", enum: ["recorded", "ignored"] },
    eventId: { type: "string" },
    reason: { type: "string" },
  },
} as const;

export const InternalDeliveryReplyBodySchema = {
  type: "object",
  required: ["attempt", "outcome", "binding"],
  additionalProperties: false,
  properties: {
    attempt: { type: "integer", minimum: 1 },
    outcome: { type: "string", enum: ["answered", "blocked", "failed"] },
    binding: { type: "string", minLength: 1 },
    vars: { type: "object", additionalProperties: { type: "string" } },
  },
} as const;

export const InternalDeliveryReplyResponseSchema = {
  type: "object",
  required: ["delivered"],
  properties: { delivered: { type: "boolean" } },
} as const;

export const InternalRoutineApprovalOpenBodySchema = {
  type: "object",
  required: ["stateKey", "stateName", "wait"],
  additionalProperties: false,
  properties: {
    stateKey: { type: "string", minLength: 1 },
    stateName: { type: "string", minLength: 1 },
    wait: InternalRoutineWaitPlanSchema,
  },
} as const;

export const InternalRoutineApprovalQuerySchema = {
  type: "object",
  required: ["stateKey"],
  additionalProperties: false,
  properties: { stateKey: { type: "string", minLength: 1 } },
} as const;

export const InternalRoutineApprovalEmptyResponseSchema = {
  type: "null",
  description: "No approval is open for this State occurrence.",
} as const;
