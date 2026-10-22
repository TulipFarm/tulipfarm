import { z } from 'zod';
import { avatarSnapshotSchema, avatarStates, bud, type AvatarSnapshot } from '@tulipfarm/conversations/results';
import type { NativeTool } from './native-tools.ts';

export const budToolName = 'bud_state';
export const budTool: NativeTool = {
  name: budToolName,
  description:
    'Update Bud, your chat avatar. Presentation only: this grants no authority and never means a business action succeeded. Use before changing activities and before your final answer.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'state'],
    properties: {
      name: { type: 'string', enum: ['Bud'] },
      state: { type: 'string', enum: [...avatarStates] },
    },
  },
};
export function budReminder(avatar: AvatarSnapshot) {
  return `Your visible chat avatar is ${JSON.stringify({ ...bud, ...avatar })}. Use bud_state to update it as you work: Thinking for planning, Searching for lookup, Reading for reviewing sources, Working for actions, Solving for calculations, Listening for a question needing the user's input, Confused when unable to proceed, Celebrating only for confirmed success, Waving for greetings, Idle when done. Other available expressions: ${avatarStates.join(', ')}. Set the latest expression before your final plain-text answer. Do not print avatar metadata or tool calls in the answer. The animation is not evidence of execution or approval. Avoid repetitive expression-only calls.`;
}
export function parseBudState(input: unknown) {
  const parsed = avatarSnapshotSchema.safeParse(input);
  return parsed.success
    ? { ok: true as const, avatar: parsed.data }
    : { ok: false as const, error: `Invalid Bud state: ${z.prettifyError(parsed.error)}` };
}
