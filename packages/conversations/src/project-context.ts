import { z } from 'zod';

export const projectSourceSchema = z.strictObject({
  id: z.uuid(),
  revisionId: z.uuid(),
  title: z.string(),
  content: z.string(),
  pinned: z.boolean(),
});
export const projectContextInputSchema = z.strictObject({
  projectId: z.uuid(),
  revision: z.number().int().nonnegative(),
  instructions: z.string(),
  files: z.array(projectSourceSchema),
  unavailable: z.array(z.strictObject({ id: z.uuid(), revisionId: z.uuid(), title: z.string() })).default([]),
});
export const projectPassageSchema = projectSourceSchema.extend({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});
export const projectContextSchema = projectContextInputSchema.extend({ files: z.array(projectPassageSchema) });
export type ProjectContext = z.infer<typeof projectContextSchema>;

export class RequiredProjectContextTooLarge extends Error {
  constructor() {
    super('required-context-too-large');
  }
}

/** Project sources for the runtime reminder. The project instructions go to the system prompt instead. */
export function projectContextReminder(context: ProjectContext) {
  return JSON.stringify({
    projectId: context.projectId,
    revision: context.revision,
    sources: context.files.map(file => ({
      title: file.title,
      citation: `#project-source=${file.revisionId}`,
      inclusion: file.pinned ? 'full' : 'passage',
      start: file.start,
      end: file.end,
      content: file.content,
    })),
    ...(context.unavailable.length
      ? {
          unavailableSources: context.unavailable.map(file => ({
            title: file.title,
            status: 'source unavailable',
            note: 'Its source file was removed or is no longer shared with everyone in this project. Its content is not included.',
          })),
        }
      : {}),
  });
}

export function selectProjectContext(
  input: z.input<typeof projectContextInputSchema>,
  query: string,
  maximumBytes: number,
): ProjectContext {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new RangeError('Invalid project context budget');
  const words = new Set(query.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []);
  const ordered = [...input.files].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const context: ProjectContext = {
    ...input,
    unavailable: input.unavailable ?? [],
    files: ordered.filter(file => file.pinned).map(file => ({ ...file, start: 0, end: file.content.length })),
  };
  const fits = () => Buffer.byteLength(projectContextReminder(context)) <= maximumBytes;
  if (!fits()) throw new RequiredProjectContextTooLarge();
  const passages = ordered
    .filter(file => !file.pinned)
    .flatMap(file => {
      const chunks = [];
      for (let start = 0; start < file.content.length;) {
        let end = Math.min(start + 3000, file.content.length);
        const last = file.content.charCodeAt(end - 1);
        if (end < file.content.length && last >= 0xd800 && last <= 0xdbff) end--;
        if (/^[\p{L}\p{N}_]/u.test(file.content.slice(end, end + 2))) {
          const trailingWord = /[\p{L}\p{N}_]+$/u.exec(file.content.slice(start, end));
          if (trailingWord && trailingWord.index > 0) end = start + trailingWord.index;
        }
        const content = file.content.slice(start, end);
        const score = [...words].filter(word => content.toLowerCase().includes(word)).length;
        if (score > 0) chunks.push({ passage: { ...file, content, start, end }, score });
        start = end;
      }
      return chunks;
    })
    .sort((left, right) => right.score - left.score);
  let selected = 0;
  for (const { passage } of passages) {
    if (selected === 8) break;
    context.files.push(passage);
    if (fits()) selected++;
    else context.files.pop();
  }
  return context;
}
