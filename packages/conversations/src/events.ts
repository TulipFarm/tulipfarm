import { z } from 'zod';
import { avatarSnapshotSchema } from './avatar.ts';
import { toolPresentationSchema } from './tool-activity.ts';

/** PostgreSQL channel that carries conversation notifications from every writer to every API replica. */
export const conversationEventChannel = 'tf_conversation_events';

const id = z.uuid();
const count = z.number().int().nonnegative();

/** Identifies one model request inside one reply attempt. A later identity replaces an earlier one. */
export const streamIdentitySchema = z.strictObject({ turnId: id, generation: count, epoch: count, step: count });
export type StreamIdentity = z.infer<typeof streamIdentitySchema>;

/**
 * Preview text for one model request. `text` replaces everything from `offset` onward.
 * `reset` starts the request's text over. `seq` increases with every update of one identity.
 */
export const streamTextSchema = streamIdentitySchema.extend({
  seq: count,
  offset: count,
  text: z.string(),
  reset: z.boolean(),
});
export type StreamText = z.infer<typeof streamTextSchema>;

/**
 * What a reply is doing now. `thinking`: the model is generating. `tool`: a work tool runs. `finishing`: a step after the
 * answer, such as the completion check or the title. `done`: the answer is final, though the turn may still be saving.
 */
export const replyStatusSchema = z.enum(['thinking', 'tool', 'finishing', 'done']);
export type ReplyStatus = z.infer<typeof replyStatusSchema>;

/**
 * The reply started model decision `round`. `step` orders it with preview text of the same attempt, and `seq` orders
 * statuses of one step. `tool` is the display name of the running work tool. `toolRounds` counts finished rounds of
 * work tools. Updates without `status` come from workers that only report rounds.
 */
export const streamProgressSchema = streamIdentitySchema.extend({
  round: z.number().int().positive(),
  status: replyStatusSchema.optional(),
  tool: z.string().min(1).max(64).optional(),
  toolRounds: count.optional(),
  seq: count.optional(),
});
export type StreamProgress = z.infer<typeof streamProgressSchema>;
export const streamAvatarSchema = streamIdentitySchema.extend({ seq: count, avatar: avatarSnapshotSchema });
export type StreamAvatar = z.infer<typeof streamAvatarSchema>;

/**
 * Something visible in the conversation changed. `settled` marks a turn that reached a final or waiting state.
 * `planId` names a plan of this chat whose outline changed; read that plan again.
 */
export const streamChangeSchema = z.strictObject({
  turnId: id.optional(),
  settled: z.boolean().optional(),
  planId: id.optional(),
});
export type StreamChange = z.infer<typeof streamChangeSchema>;
export const streamToolSchema = streamIdentitySchema.omit({ step: true }).extend({
  id,
  tool: z.string().max(64),
  sequence: z.number().int().positive(),
  status: z.enum(['running', 'completed', 'blocked', 'failed']),
  presentation: toolPresentationSchema,
});
export type StreamTool = z.infer<typeof streamToolSchema>;

export function applyStreamTool(state: StreamTool | undefined, update: StreamTool): StreamTool {
  if (!state) return update;
  const order = update.generation - state.generation || update.epoch - state.epoch;
  return order < 0 || (order === 0 && (state.status !== 'running' || update.status === state.status)) ? state : update;
}

/** A sub-agent's state. `timed-out` and `stopped` sub-agents ended early and returned partial output. */
export const subagentStatusSchema = z.enum(['queued', 'running', 'done', 'failed', 'timed-out', 'stopped']);
export type SubagentStatus = z.infer<typeof subagentStatusSchema>;
/**
 * One sub-agent card. `key` is stable within its `agents.delegate` call; `step` is what it is doing now. A helper
 * names the model family it runs on; a saved agent names its `agentId`, which picks its avatar.
 */
export const subagentCardSchema = z.strictObject({
  key: z.string().regex(/^a[0-9]$/),
  kind: z.enum(['saved', 'helper']),
  name: z.string().min(1).max(60),
  role: z.string().min(1).max(80),
  family: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,99}$/)
    .optional(),
  agentId: z.uuid().optional(),
  status: subagentStatusSchema,
  step: z.string().max(80).optional(),
  credits: z.number().nonnegative(),
  elapsedMs: count,
});
export type SubagentCard = z.infer<typeof subagentCardSchema>;
/** Live sub-agent cards of one `agents.delegate` call, identified by the tool call's `id`. A later `seq` replaces an earlier one. */
export const streamSubagentsSchema = streamIdentitySchema.omit({ step: true }).extend({
  id,
  seq: count,
  agents: z.array(subagentCardSchema).min(1).max(5),
});
export type StreamSubagents = z.infer<typeof streamSubagentsSchema>;
/** The result of one `agents.delegate` call: each sub-agent's final card and report, as the model and history see it. */
export const subagentResultSchema = z.object({
  agents: z
    .array(subagentCardSchema.omit({ step: true }).extend({ report: z.string() }))
    .min(1)
    .max(5),
  totalCredits: z.number().nonnegative(),
});
export type SubagentResult = z.infer<typeof subagentResultSchema>;

export function applyStreamSubagents(state: StreamSubagents | undefined, update: StreamSubagents): StreamSubagents {
  if (!state) return update;
  const order = update.generation - state.generation || update.epoch - state.epoch || update.seq - state.seq;
  return order <= 0 ? state : update;
}

const address = { workspaceId: id, conversationId: id };
export const conversationNotificationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), ...address, ...streamTextSchema.shape }),
  z.strictObject({ kind: z.literal('changed'), ...address, ...streamChangeSchema.shape }),
  z.strictObject({ kind: z.literal('progress'), ...address, ...streamProgressSchema.shape }),
  z.strictObject({ kind: z.literal('avatar'), ...address, ...streamAvatarSchema.shape }),
  z.strictObject({ kind: z.literal('tool'), ...address, ...streamToolSchema.shape }),
  z.strictObject({ kind: z.literal('subagents'), ...address, ...streamSubagentsSchema.shape }),
  /** Asks the worker running `id`'s sub-agents to stop one of them. API replicas ignore it. */
  z.strictObject({
    kind: z.literal('subagent-stop'),
    ...address,
    turnId: id,
    id,
    key: subagentCardSchema.shape.key,
  }),
]);
export type ConversationNotification = z.infer<typeof conversationNotificationSchema>;

/** Server-sent event names on `GET /workspaces/:workspaceId/conversations/:chatId/events`. */
export const conversationStreamEvents = {
  /** `streamTextSchema` data. Sent live, and as a reset snapshot when a client connects during a reply. */
  text: 'text',
  /** `streamChangeSchema` data. Read history again. */
  changed: 'changed',
  /** `streamProgressSchema` data. Sent live, and as a snapshot when a client connects during a reply. */
  progress: 'progress',
  avatar: 'avatar',
  tool: 'tool',
  /** `streamSubagentsSchema` data. Live sub-agent cards of a running `agents.delegate` call. */
  subagents: 'subagents',
  /** Notifications may have been missed. Read history again. */
  resync: 'resync',
} as const;

export type StreamTextState = { identity: StreamIdentity; seq: number; text: string; complete: boolean };

export function compareStreamIdentity(left: StreamIdentity, right: StreamIdentity) {
  return left.generation - right.generation || left.epoch - right.epoch || left.step - right.step;
}

/** Keeps the latest progress of a turn. An older identity, or an equal one without a later `seq`, leaves it unchanged. */
export function applyStreamProgress(state: StreamProgress | undefined, update: StreamProgress): StreamProgress {
  if (!state) return update;
  const order = compareStreamIdentity(update, state) || (update.seq ?? 0) - (state.seq ?? 0);
  return order <= 0 ? state : update;
}

export function applyStreamAvatar(state: StreamAvatar | undefined, update: StreamAvatar): StreamAvatar {
  const order = state ? compareStreamIdentity(update, state) : 1;
  return state && (order < 0 || (order === 0 && update.seq <= state.seq)) ? state : update;
}

/**
 * Applies one update to the preview text of a turn. Returns the previous state when the update is stale or a duplicate.
 * A gap (an update that starts beyond the known text) keeps the known text and marks it incomplete until a reset arrives.
 */
export function applyStreamText(state: StreamTextState | undefined, update: StreamText): StreamTextState {
  const identity = { turnId: update.turnId, generation: update.generation, epoch: update.epoch, step: update.step };
  const order = state ? compareStreamIdentity(identity, state.identity) : 1;
  if (state && order < 0) return state;
  if (!state || order > 0) {
    if (update.reset || update.offset === 0) return { identity, seq: update.seq, text: update.text, complete: true };
    return { identity, seq: update.seq, text: '', complete: false };
  }
  if (update.seq <= state.seq) return state;
  if (update.reset) return { identity, seq: update.seq, text: update.text, complete: true };
  if (!state.complete || update.offset > state.text.length) return { ...state, seq: update.seq, complete: false };
  return { identity, seq: update.seq, text: state.text.slice(0, update.offset) + update.text, complete: true };
}
