import type { z } from 'zod';
import { recordIdSchema } from './record-id.ts';

export const workspaceMemberIdSchema = recordIdSchema.brand<'WorkspaceMemberId'>();
export type WorkspaceMemberId = z.infer<typeof workspaceMemberIdSchema>;
