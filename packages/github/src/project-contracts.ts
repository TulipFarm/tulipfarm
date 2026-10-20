import { z } from 'zod';
import { githubNodeId } from './discussion-contracts.ts';

const name = z.string().min(1).max(256);
const optionId = z.string().min(1).max(256);
const date = z.iso.date();
const owner = {
  owner: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/),
  ownerType: z.enum(['user', 'organization']),
  ownerNodeId: githubNodeId,
};
const project = { ...owner, projectId: githubNodeId, projectNumber: z.number().int().positive().max(2147483647) };
const option = z.strictObject({
  id: optionId.optional(),
  name,
  color: z.enum(['GRAY', 'BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'RED', 'PINK', 'PURPLE']),
  description: z.string().max(1024),
});
const options = z
  .array(option)
  .max(50)
  .refine(
    values =>
      new Set(values.map(value => value.name)).size === values.length &&
      new Set(values.flatMap(value => (value.id ? [value.id] : []))).size === values.filter(value => value.id).length,
    'Duplicate options',
  );
const iterationConfiguration = z.strictObject({
  duration: z.number().int().positive().max(365),
  startDate: date,
  iterations: z
    .array(
      z.strictObject({
        id: optionId.optional(),
        title: name,
        startDate: date,
        duration: z.number().int().positive().max(365),
      }),
    )
    .max(50),
});
export const projectFieldDefinition = z.discriminatedUnion('dataType', [
  z.strictObject({ dataType: z.enum(['TEXT', 'NUMBER', 'DATE']), name }),
  z.strictObject({ dataType: z.literal('SINGLE_SELECT'), name, singleSelectOptions: options }),
  z.strictObject({ dataType: z.literal('MULTI_SELECT'), name, multiSelectOptions: options }),
  z.strictObject({ dataType: z.literal('ITERATION'), name, iterationConfiguration }),
]);
const draftContent = z.strictObject({ type: z.literal('DraftIssue'), id: githubNodeId });
const repositoryContent = z.strictObject({
  type: z.enum(['Issue', 'PullRequest']),
  id: githubNodeId,
  repository: z.strictObject({
    id: githubNodeId,
    databaseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    ownerId: githubNodeId,
    owner: owner.owner,
    repo: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),
  }),
});
export const projectContent = z.discriminatedUnion('type', [draftContent, repositoryContent]);
const item = { ...project, itemId: githubNodeId, content: projectContent };
const value = z.discriminatedUnion('dataType', [
  z.strictObject({ dataType: z.literal('TEXT'), text: z.string().max(16000) }),
  z.strictObject({ dataType: z.literal('NUMBER'), number: z.number().finite() }),
  z.strictObject({ dataType: z.literal('DATE'), date }),
  z.strictObject({ dataType: z.literal('SINGLE_SELECT'), singleSelectOptionId: optionId }),
  z.strictObject({
    dataType: z.literal('MULTI_SELECT'),
    multiSelectOptionIds: z
      .array(optionId)
      .max(50)
      .refine(ids => new Set(ids).size === ids.length),
  }),
  z.strictObject({ dataType: z.literal('ITERATION'), iterationId: optionId }),
]);
export const projectWriteSchemas = [
  z.strictObject({ kind: z.literal('project.create'), ...owner, title: name }),
  z.strictObject({
    kind: z.literal('project.update'),
    ...project,
    title: name,
    shortDescription: z.string().max(1024),
    readme: z.string().max(16000),
    public: z.boolean(),
  }),
  z.strictObject({ kind: z.enum(['project.close', 'project.reopen', 'project.delete']), ...project }),
  z
    .strictObject({ kind: z.literal('project.field-create'), ...project, field: projectFieldDefinition })
    .refine(operation => {
      const field = operation.field;
      return field.dataType === 'SINGLE_SELECT'
        ? field.singleSelectOptions.every(option => option.id === undefined)
        : field.dataType === 'MULTI_SELECT'
          ? field.multiSelectOptions.every(option => option.id === undefined)
          : field.dataType === 'ITERATION'
            ? field.iterationConfiguration.iterations.every(iteration => iteration.id === undefined)
            : true;
    }, 'New fields cannot reuse another field option or iteration identity'),
  z.strictObject({
    kind: z.literal('project.field-update'),
    ...project,
    fieldId: githubNodeId,
    field: projectFieldDefinition,
  }),
  z.strictObject({ kind: z.literal('project.field-delete'), ...project, fieldId: githubNodeId }),
  z.strictObject({ kind: z.literal('project.item-add'), ...project, content: repositoryContent }),
  z.strictObject({ kind: z.literal('project.draft-create'), ...project, title: name, body: z.string().max(16000) }),
  z.strictObject({
    kind: z.literal('project.draft-update'),
    ...item,
    content: draftContent,
    title: name,
    body: z.string().max(16000),
  }),
  z.strictObject({ kind: z.enum(['project.item-archive', 'project.item-unarchive', 'project.item-delete']), ...item }),
  z.strictObject({ kind: z.literal('project.value-set'), ...item, fieldId: githubNodeId, value }),
  z.strictObject({
    kind: z.literal('project.value-clear'),
    ...item,
    fieldId: githubNodeId,
    dataType: z.enum([
      'TEXT',
      'NUMBER',
      'DATE',
      'SINGLE_SELECT',
      'MULTI_SELECT',
      'ITERATION',
      'ASSIGNEES',
      'LABELS',
      'MILESTONE',
    ]),
  }),
] as const;
export type ProjectWrite = z.infer<(typeof projectWriteSchemas)[number]>;
