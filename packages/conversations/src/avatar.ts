import { z } from 'zod';

export const avatarStates = [
  'Idle',
  'Blinking',
  'Thinking',
  'Working',
  'Waving',
  'Solving',
  'Listening',
  'Breathing',
  'Reading',
  'Searching',
  'Sleeping',
  'Nodding',
  'Confused',
  'Celebrating',
] as const;
export const avatarStateSchema = z.enum(avatarStates);
export type AvatarState = z.infer<typeof avatarStateSchema>;
export const bud = { name: 'Bud', character: 'Bud', color: 'Sage', view: 'head' } as const;
export const avatarSnapshotSchema = z.strictObject({ name: z.literal('Bud'), state: avatarStateSchema });
export type AvatarSnapshot = z.infer<typeof avatarSnapshotSchema>;
