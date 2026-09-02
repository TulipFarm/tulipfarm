import { type Static, Type } from "@sinclair/typebox";

export * from "./chat-limits";

export const CONVERSATION_TURN_STATUSES = [
  "pending",
  "running",
  "start_failed",
  "succeeded",
  "failed",
] as const;

const ConversationTurnStatusSchema = Type.Unsafe<(typeof CONVERSATION_TURN_STATUSES)[number]>({
  type: "string",
  enum: [...CONVERSATION_TURN_STATUSES],
});

export const ConversationTurnSchema = Type.Object({
  id: Type.String(),
  runId: Type.Union([Type.String(), Type.Null()]),
  status: ConversationTurnStatusSchema,
});

export const ConversationDetailSchema = Type.Object({
  id: Type.String(),
  userId: Type.Union([Type.String(), Type.Null()]),
  agentId: Type.Union([Type.String(), Type.Null()]),
  model: Type.Union([Type.String(), Type.Null()]),
  title: Type.Union([Type.String(), Type.Null()]),
  starred: Type.Boolean(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  latestTurn: Type.Union([ConversationTurnSchema, Type.Null()]),
});

export type ConversationTurn = Static<typeof ConversationTurnSchema>;
export type ConversationDetail = Static<typeof ConversationDetailSchema>;
