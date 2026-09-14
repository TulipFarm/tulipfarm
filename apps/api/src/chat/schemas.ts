import { ConversationModeSchema } from "@tulipfarm/schema";

export const ConversationSummarySchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: ["string", "null"] },
    mode: { anyOf: [ConversationModeSchema, { type: "null" }] },
    agentId: { type: ["string", "null"] },
    starred: { type: "boolean" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: ["id", "title", "mode", "agentId", "starred", "createdAt", "updatedAt"],
} as const;

export const MessageSchema = {
  type: "object",
  properties: {
    _id: { type: "string" },
    conversationId: { type: "string" },
    role: { type: "string", enum: ["system", "user", "assistant", "tool", "summary"] },
    content: {
      oneOf: [
        { type: "string" },
        {
          type: "array",
          items: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["type", "text"],
                properties: { type: { const: "text" }, text: { type: "string" } },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["type", "fileId", "mediaType", "name"],
                properties: {
                  type: { const: "file" },
                  fileId: { type: "string" },
                  mediaType: { type: "string" },
                  name: { type: "string" },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["type", "toolCallId", "toolName", "args"],
                properties: {
                  type: { const: "tool-call" },
                  toolCallId: { type: "string" },
                  toolName: { type: "string" },
                  args: {},
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["type", "toolCallId", "toolName", "result"],
                properties: {
                  type: { const: "tool-result" },
                  toolCallId: { type: "string" },
                  toolName: { type: "string" },
                  result: {},
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["type", "artifactId", "revision"],
                properties: {
                  type: { const: "surface" },
                  artifactId: { type: "string" },
                  revision: { type: "integer", minimum: 1 },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["type", "message"],
                properties: {
                  type: { const: "surface-unavailable" },
                  message: { const: "Legacy presentation unavailable" },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["type", "fileId", "name"],
                properties: {
                  type: { const: "file-unavailable" },
                  fileId: { type: "string" },
                  name: { type: "string" },
                },
              },
            ],
          },
        },
      ],
    },
    metadata: { type: "object", additionalProperties: true },
    createdAt: { type: "string" },
  },
  required: ["_id", "conversationId", "role", "content", "createdAt"],
} as const;
