import { type Static, Type } from "@sinclair/typebox";

/**
 * Longest title a Chat may carry. Shared so the API's rename schema and every UI that offers a
 * rename enforce the same ceiling — a client-side `maxLength` that disagreed with the route would
 * turn a typo into a 400 the user cannot see the cause of.
 */
export const CHAT_TITLE_MAX_LENGTH = 200;

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
