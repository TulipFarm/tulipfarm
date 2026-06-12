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
