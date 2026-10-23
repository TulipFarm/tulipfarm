import { z } from 'zod';

/** Workspace Knowledge settings. `canManage` is true for admins of a workspace whose storage holds the settings. */
export const knowledgeSettingsSchema = z.strictObject({ mediaRecognition: z.boolean(), canManage: z.boolean() });
export const knowledgeSettingsUpdateSchema = z.strictObject({ mediaRecognition: z.boolean() });
export type KnowledgeSettings = z.infer<typeof knowledgeSettingsSchema>;
