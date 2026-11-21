import { z } from 'zod';
import { uuidSchema } from '@tulipfarm/access/contracts';

/** What taught a lesson. */
export const lessonKinds = ['rejection', 'approval', 'tool-failure', 'correction', 'clarification'] as const;
export type LessonKind = (typeof lessonKinds)[number];
/** What part of the agent a suggestion would change. Suggestions never apply without an approved agent draft. */
export const suggestionAreas = ['instructions', 'skills', 'tools'] as const;
export type SuggestionArea = (typeof suggestionAreas)[number];

export const agentLessonLimits = Object.freeze({
  lessons: 20,
  suggestions: 5,
  lessonCharacters: 200,
  suggestionCharacters: 300,
  /** Characters of lessons one run receives. */
  contextCharacters: 2000,
  /** Keep stores at most 8 KiB per file; stay below it with room for its own framing. */
  fileBytes: 7600,
});

const entryId = z.string().regex(/^[a-z0-9]{8,16}$/);
export const agentLessonViewSchema = z.object({
  id: entryId,
  kind: z.enum(lessonKinds),
  text: z.string(),
  confirmedAt: z.string(),
});
export const agentSuggestionViewSchema = z.object({
  id: entryId,
  area: z.enum(suggestionAreas),
  text: z.string(),
  suggestedAt: z.string(),
});
export const agentLessonsViewSchema = z.object({
  lessons: z.array(agentLessonViewSchema),
  suggestions: z.array(agentSuggestionViewSchema),
  limits: z.object({ lessons: z.number(), lessonCharacters: z.number() }),
});
export const agentLessonEditSchema = z.strictObject({
  text: z.string().trim().min(1).max(agentLessonLimits.lessonCharacters),
});
export const agentLessonParamsSchema = z.object({ workspaceId: uuidSchema, agentId: uuidSchema });
export const agentLessonEntryParamsSchema = agentLessonParamsSchema.extend({ entryId });
export type AgentLessonsView = z.infer<typeof agentLessonsViewSchema>;

export const agentLessonErrorCodes = ['not-found', 'lesson-private', 'lessons-unavailable'] as const;
