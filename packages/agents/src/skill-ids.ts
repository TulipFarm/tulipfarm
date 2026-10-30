import { z } from 'zod';

export const skillIdSchema = z.enum([
  'table-authoring',
  'package-install',
  'agent-authoring',
  'workspace-skill-authoring',
  'workflow-authoring',
  'word-document',
  'excel-workbook',
  'powerpoint-deck',
  'google-docs',
  'google-sheets',
  'google-slides',
  'github-investigation',
  'planning',
]);
export const skillResourceSchema = z.string().regex(/^references\/[a-z0-9][a-z0-9-]*\.md$/);
// Built-in skills always load the bundled SKILL.md. Saved agents may still hold an old numeric revision; it is accepted and ignored.
export const builtinSkillRevision = 'latest';
export const skillSelectionSchema = z.strictObject({
  id: skillIdSchema,
  revision: z.union([z.literal(builtinSkillRevision), z.string().regex(/^[1-9][0-9]*$/)]),
});
export const skillSelectionsSchema = z
  .array(skillSelectionSchema)
  .max(16)
  .refine(
    selections => new Set(selections.map(selection => selection.id)).size === selections.length,
    'Select each skill once',
  );
