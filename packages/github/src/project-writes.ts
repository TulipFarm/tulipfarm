import { z } from 'zod';
import type { GitHubCredential } from './accounts.ts';
import { GitHubBatchError, type GitHubWrite } from './batch-contracts.ts';
import { graphqlData } from './discussion-writes.ts';
import { githubNodeId } from './discussion-contracts.ts';
import type { ProjectWrite } from './project-contracts.ts';

export function isProjectWrite(operation: GitHubWrite): operation is ProjectWrite {
  return operation.kind.startsWith('project.');
}
export const projectOwnerFields = '__typename ... on User { id login } ... on Organization { id login }';
export const projectIdentityFields = `id number owner { ${projectOwnerFields} }`;
const projectFields = `${projectIdentityFields} title shortDescription readme public closed`;
const repositoryFields = 'id databaseId nameWithOwner owner { id login }';
const contentFields = `__typename ... on DraftIssue { id title body creator { ... on User { databaseId } } } ... on Issue { id repository { ${repositoryFields} } } ... on PullRequest { id repository { ${repositoryFields} } }`;
const itemFields = `id isArchived project { ${projectIdentityFields} } content { ${contentFields} }`;
const valueFieldIdentity = 'field { ... on ProjectV2FieldCommon { id } }';
const valueFields = `fieldValues(first: 100) { pageInfo { hasNextPage } nodes { __typename ... on ProjectV2ItemFieldValueCommon { ${valueFieldIdentity} } ... on ProjectV2ItemFieldTextValue { text } ... on ProjectV2ItemFieldNumberValue { number } ... on ProjectV2ItemFieldDateValue { date } ... on ProjectV2ItemFieldSingleSelectValue { optionId } ... on ProjectV2ItemFieldMultiSelectValue { options { id } } ... on ProjectV2ItemFieldIterationValue { iterationId } ... on ProjectV2ItemFieldMilestoneValue { ${valueFieldIdentity} milestone { id } } ... on ProjectV2ItemFieldLabelValue { ${valueFieldIdentity} } ... on ProjectV2ItemFieldUserValue { ${valueFieldIdentity} } } }`;
const fieldFields = `__typename ... on ProjectV2FieldCommon { id name dataType isIssueField project { ${projectIdentityFields} } } ... on ProjectV2SingleSelectField { options { id name color description } } ... on ProjectV2MultiSelectField { multiSelectOptions { id name color description } } ... on ProjectV2IterationField { configuration { duration iterations { id title startDate duration } completedIterations { id title startDate duration } } }`;
const mutation = (name: string, input: string, fields: string) =>
  `mutation($input: ${input}!) { result: ${name}(input: $input) { ${fields} } }`;
export const projectDocuments = {
  owner:
    'query($id: ID!) { node(id: $id) { __typename ... on User { id login databaseId isViewer viewerCanCreateProjects } ... on Organization { id login viewerCanCreateProjects viewerCanAdminister viewerIsAMember } } }',
  project: `query($id: ID!) { node(id: $id) { ... on ProjectV2 { ${projectFields} viewerCanUpdate viewerCanClose viewerCanReopen } } }`,
  field: `query($id: ID!) { node(id: $id) { ${fieldFields} } }`,
  item: `query($id: ID!) { node(id: $id) { ... on ProjectV2Item { ${itemFields} } } }`,
  content: `query($id: ID!) { node(id: $id) { ${contentFields} } }`,
  drafts: `query($id: ID!) { node(id: $id) { ... on ProjectV2 { ${projectIdentityFields} items(last: 30) { nodes { ${itemFields} } } } } }`,
  'project.create': mutation('createProjectV2', 'CreateProjectV2Input', `projectV2 { ${projectFields} }`),
  'project.update': mutation('updateProjectV2', 'UpdateProjectV2Input', `projectV2 { ${projectFields} }`),
  'project.close': mutation('updateProjectV2', 'UpdateProjectV2Input', `projectV2 { ${projectFields} }`),
  'project.reopen': mutation('updateProjectV2', 'UpdateProjectV2Input', `projectV2 { ${projectFields} }`),
  'project.delete': mutation('deleteProjectV2', 'DeleteProjectV2Input', 'projectV2 { id }'),
  'project.field-create': mutation(
    'createProjectV2Field',
    'CreateProjectV2FieldInput',
    `projectV2Field { ${fieldFields} }`,
  ),
  'project.field-update': mutation(
    'updateProjectV2Field',
    'UpdateProjectV2FieldInput',
    `projectV2Field { ${fieldFields} }`,
  ),
  'project.field-delete': mutation(
    'deleteProjectV2Field',
    'DeleteProjectV2FieldInput',
    'projectV2Field { ... on ProjectV2FieldCommon { id } }',
  ),
  'project.item-add': mutation('addProjectV2ItemById', 'AddProjectV2ItemByIdInput', `item { ${itemFields} }`),
  'project.draft-create': mutation(
    'addProjectV2DraftIssue',
    'AddProjectV2DraftIssueInput',
    `projectItem { ${itemFields} }`,
  ),
  'project.draft-update': mutation(
    'updateProjectV2DraftIssue',
    'UpdateProjectV2DraftIssueInput',
    'draftIssue { id title body }',
  ),
  'project.item-archive': mutation('archiveProjectV2Item', 'ArchiveProjectV2ItemInput', `item { ${itemFields} }`),
  'project.item-unarchive': mutation('unarchiveProjectV2Item', 'UnarchiveProjectV2ItemInput', `item { ${itemFields} }`),
  'project.item-delete': mutation('deleteProjectV2Item', 'DeleteProjectV2ItemInput', 'deletedItemId'),
  'project.value-set': mutation(
    'updateProjectV2ItemFieldValue',
    'UpdateProjectV2ItemFieldValueInput',
    `projectV2Item { ${itemFields} ${valueFields} }`,
  ),
  'project.value-clear': mutation(
    'clearProjectV2ItemFieldValue',
    'ClearProjectV2ItemFieldValueInput',
    `projectV2Item { ${itemFields} ${valueFields} }`,
  ),
};
export function projectRequest(operation: ProjectWrite) {
  let input;
  switch (operation.kind) {
    case 'project.create':
      input = { ownerId: operation.ownerNodeId, title: operation.title };
      break;
    case 'project.update':
      input = {
        projectId: operation.projectId,
        title: operation.title,
        shortDescription: operation.shortDescription,
        readme: operation.readme,
        public: operation.public,
      };
      break;
    case 'project.close':
    case 'project.reopen':
      input = { projectId: operation.projectId, closed: operation.kind === 'project.close' };
      break;
    case 'project.delete':
      input = { projectId: operation.projectId };
      break;
    case 'project.field-create':
      input = { projectId: operation.projectId, ...operation.field };
      break;
    case 'project.field-update': {
      const { dataType: _dataType, ...field } = operation.field;
      input = { fieldId: operation.fieldId, ...field };
      break;
    }
    case 'project.field-delete':
      input = { fieldId: operation.fieldId };
      break;
    case 'project.item-add':
      input = { projectId: operation.projectId, contentId: operation.content.id };
      break;
    case 'project.draft-create':
      input = { projectId: operation.projectId, title: operation.title, body: operation.body };
      break;
    case 'project.draft-update':
      input = { draftIssueId: operation.content.id, title: operation.title, body: operation.body };
      break;
    case 'project.item-archive':
    case 'project.item-unarchive':
    case 'project.item-delete':
      input = { projectId: operation.projectId, itemId: operation.itemId };
      break;
    case 'project.value-set': {
      const { dataType: _dataType, ...value } = operation.value;
      input = { projectId: operation.projectId, itemId: operation.itemId, fieldId: operation.fieldId, value };
      break;
    }
    case 'project.value-clear':
      input = { projectId: operation.projectId, itemId: operation.itemId, fieldId: operation.fieldId };
      break;
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
  return { path: '/graphql', method: 'POST', body: { query: projectDocuments[operation.kind], variables: { input } } };
}
const ownerSchema = z.object({ __typename: z.enum(['User', 'Organization']), id: githubNodeId, login: z.string() });
const identitySchema = z.object({ id: githubNodeId, number: z.number().int().positive(), owner: ownerSchema });
function parseProjectAccess<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new GitHubBatchError('batch-conflict');
  return parsed.data;
}
function ownerIdentity(operation: Pick<ProjectWrite, 'owner' | 'ownerType' | 'ownerNodeId'>, value: unknown) {
  const owner = parseProjectAccess(ownerSchema, value);
  if (
    owner.id !== operation.ownerNodeId ||
    owner.__typename.toLowerCase() !== operation.ownerType ||
    owner.login.toLowerCase() !== operation.owner.toLowerCase()
  )
    throw new GitHubBatchError('batch-conflict');
}
export function projectIdentity(operation: Exclude<ProjectWrite, { kind: 'project.create' }>, value: unknown) {
  const project = parseProjectAccess(identitySchema, value);
  ownerIdentity(operation, project.owner);
  if (project.id !== operation.projectId || project.number !== operation.projectNumber)
    throw new GitHubBatchError('batch-conflict');
  return project;
}
function contentIdentity(expected: Extract<ProjectWrite, { content: unknown }>['content'], value: unknown) {
  const content = parseProjectAccess(
    z.object({ __typename: z.literal(expected.type), id: z.literal(expected.id) }).passthrough(),
    value,
  );
  if (expected.type !== 'DraftIssue') {
    const repository = parseProjectAccess(
      z.object({
        id: z.literal(expected.repository.id),
        databaseId: z.literal(expected.repository.databaseId),
        nameWithOwner: z.string(),
        owner: z.object({ id: z.literal(expected.repository.ownerId), login: z.string() }),
      }),
      content.repository,
    );
    if (
      repository.nameWithOwner.toLowerCase() !==
        `${expected.repository.owner}/${expected.repository.repo}`.toLowerCase() ||
      repository.owner.login.toLowerCase() !== expected.repository.owner.toLowerCase()
    )
      throw new GitHubBatchError('batch-conflict');
  }
}
const fieldSchema = z
  .object({
    id: githubNodeId,
    name: z.string(),
    dataType: z.string(),
    isIssueField: z.boolean(),
    project: identitySchema,
  })
  .passthrough();
const itemSchema = z.object({ id: githubNodeId, project: identitySchema, isArchived: z.boolean(), content: z.json() });
type Read = (query: string, variables: Record<string, string>) => Promise<unknown>;
export async function checkDeletedProjectOwner(
  operation: Pick<ProjectWrite, 'owner' | 'ownerType' | 'ownerNodeId'>,
  credential: GitHubCredential,
  read: Read,
) {
  if (!credential.scopes.includes('project')) throw new GitHubBatchError('batch-conflict');
  const owner = graphqlData(await read(projectDocuments.owner, { id: operation.ownerNodeId })).node;
  ownerIdentity(operation, owner);
  if (operation.ownerType === 'user')
    parseProjectAccess(
      z.object({
        isViewer: z.literal(true),
        databaseId: z.number().refine(id => String(id) === credential.identity.id),
      }),
      owner,
    );
  else parseProjectAccess(z.object({ viewerCanAdminister: z.literal(true) }), owner);
}
export async function checkProjectContent(operation: ProjectWrite, credential: GitHubCredential, read: Read) {
  if ('content' in operation && operation.content.type !== 'DraftIssue') {
    if (!credential.scopes.includes('repo')) throw new GitHubBatchError('batch-conflict');
    contentIdentity(
      operation.content,
      graphqlData(await read(projectDocuments.content, { id: operation.content.id })).node,
    );
  }
}
export async function checkProjectTarget(
  operation: ProjectWrite,
  credential: GitHubCredential,
  read: Read,
  dispatch: boolean,
) {
  if (!credential.scopes.includes('project')) throw new GitHubBatchError('batch-conflict');
  const node = async (query: string, id: string) => graphqlData(await read(query, { id })).node;
  const owner = await node(projectDocuments.owner, operation.ownerNodeId);
  ownerIdentity(operation, owner);
  if (operation.kind === 'project.create') {
    if (dispatch) {
      parseProjectAccess(z.object({ viewerCanCreateProjects: z.literal(true) }), owner);
      if (operation.ownerType === 'user')
        parseProjectAccess(
          z.object({
            isViewer: z.literal(true),
            databaseId: z.number().refine(id => String(id) === credential.identity.id),
          }),
          owner,
        );
    }
    return;
  }
  const project = await node(projectDocuments.project, operation.projectId);
  projectIdentity(operation, project);
  await checkProjectContent(operation, credential, read);
  if (!dispatch) return;
  const permission =
    operation.kind === 'project.close'
      ? 'viewerCanClose'
      : operation.kind === 'project.reopen'
        ? 'viewerCanReopen'
        : 'viewerCanUpdate';
  parseProjectAccess(z.object({ [permission]: z.literal(true) }), project);
  if ('content' in operation && operation.content.type === 'DraftIssue') {
    contentIdentity(operation.content, await node(projectDocuments.content, operation.content.id));
  }
  if ('itemId' in operation) {
    const item = parseProjectAccess(itemSchema, await node(projectDocuments.item, operation.itemId));
    projectIdentity(operation, item.project);
    if (item.id !== operation.itemId) throw new GitHubBatchError('batch-conflict');
    contentIdentity(operation.content, item.content);
  }
  if ('fieldId' in operation) {
    const field = parseProjectAccess(fieldSchema, await node(projectDocuments.field, operation.fieldId));
    projectIdentity(operation, field.project);
    if (field.id !== operation.fieldId || field.isIssueField) throw new GitHubBatchError('batch-conflict');
    const dataType =
      'field' in operation
        ? operation.field.dataType
        : 'value' in operation
          ? operation.value.dataType
          : 'dataType' in operation
            ? operation.dataType
            : field.dataType;
    if (field.dataType !== dataType) throw new GitHubBatchError('batch-conflict');
    if (operation.kind === 'project.field-update') {
      const definition = operation.field;
      if (definition.dataType === 'SINGLE_SELECT' || definition.dataType === 'MULTI_SELECT') {
        const key = definition.dataType === 'SINGLE_SELECT' ? 'options' : 'multiSelectOptions';
        const previous = z.array(z.object({ id: z.string() })).parse(field[key]);
        const next =
          definition.dataType === 'SINGLE_SELECT' ? definition.singleSelectOptions : definition.multiSelectOptions;
        if (next.some(option => option.id && !previous.some(old => old.id === option.id)))
          throw new GitHubBatchError('batch-conflict');
      }
      if (definition.dataType === 'ITERATION') {
        const previous = z
          .object({
            iterations: z.array(z.object({ id: z.string() })),
            completedIterations: z.array(z.object({ id: z.string() })),
          })
          .parse(field.configuration);
        if (
          definition.iterationConfiguration.iterations.some(
            iteration =>
              iteration.id &&
              ![...previous.iterations, ...previous.completedIterations].some(old => old.id === iteration.id),
          )
        )
          throw new GitHubBatchError('batch-conflict');
      }
    }
    const selected = operation.kind === 'project.value-set' ? operation.value : null;
    if (selected?.dataType === 'SINGLE_SELECT' || selected?.dataType === 'MULTI_SELECT') {
      const choices = z
        .array(z.object({ id: z.string() }))
        .parse(field[selected.dataType === 'SINGLE_SELECT' ? 'options' : 'multiSelectOptions']);
      const ids =
        selected.dataType === 'SINGLE_SELECT' ? [selected.singleSelectOptionId] : selected.multiSelectOptionIds;
      if (ids.some(id => !choices.some(option => option.id === id))) throw new GitHubBatchError('batch-conflict');
    }
    if (selected?.dataType === 'ITERATION') {
      const configuration = z
        .object({
          iterations: z.array(z.object({ id: z.string() })),
          completedIterations: z.array(z.object({ id: z.string() })),
        })
        .parse(field.configuration);
      if (
        ![...configuration.iterations, ...configuration.completedIterations].some(
          iteration => iteration.id === selected.iterationId,
        )
      )
        throw new GitHubBatchError('batch-conflict');
    }
  }
}
export function projectResult(operation: ProjectWrite, value: unknown) {
  const result = z.record(z.string(), z.json()).parse(graphqlData(value).result);
  const owner = { ownerNodeId: operation.ownerNodeId };
  if (operation.kind === 'project.create') {
    const project = identitySchema.extend({ title: z.literal(operation.title) }).parse(result.projectV2);
    ownerIdentity(operation, project.owner);
    return { ...owner, projectId: project.id, projectNumber: project.number };
  }
  const base = { ...owner, projectId: operation.projectId, projectNumber: operation.projectNumber };
  if (operation.kind === 'project.delete') {
    z.object({ id: z.literal(operation.projectId) }).parse(result.projectV2);
    return { ...base, deleted: true };
  }
  if (
    operation.kind === 'project.update' ||
    operation.kind === 'project.close' ||
    operation.kind === 'project.reopen'
  ) {
    projectIdentity(operation, result.projectV2);
    if (operation.kind === 'project.update')
      z.object({
        title: z.literal(operation.title),
        shortDescription: z.literal(operation.shortDescription),
        readme: z.literal(operation.readme),
        public: z.literal(operation.public),
      }).parse(result.projectV2);
    else z.object({ closed: z.literal(operation.kind === 'project.close') }).parse(result.projectV2);
    return base;
  }
  if (operation.kind === 'project.field-delete') {
    z.object({ id: z.literal(operation.fieldId) }).parse(result.projectV2Field);
    return { ...base, fieldId: operation.fieldId, deleted: true };
  }
  if (operation.kind === 'project.field-create' || operation.kind === 'project.field-update') {
    const field = fieldSchema.parse(result.projectV2Field);
    projectIdentity(operation, field.project);
    if (
      field.name !== operation.field.name ||
      field.dataType !== operation.field.dataType ||
      (operation.kind === 'project.field-update' && field.id !== operation.fieldId)
    )
      throw new GitHubBatchError('batch-unavailable');
    const definition = operation.field;
    if (definition.dataType === 'SINGLE_SELECT' || definition.dataType === 'MULTI_SELECT') {
      const actual = z
        .array(z.object({ id: z.string(), name: z.string(), color: z.string(), description: z.string() }))
        .parse(field[definition.dataType === 'SINGLE_SELECT' ? 'options' : 'multiSelectOptions']);
      const expected =
        definition.dataType === 'SINGLE_SELECT' ? definition.singleSelectOptions : definition.multiSelectOptions;
      if (
        actual.length !== expected.length ||
        expected.some((option, index) => {
          const item = actual[index];
          return (
            !item ||
            item.name !== option.name ||
            item.color !== option.color ||
            item.description !== option.description ||
            (option.id !== undefined && item.id !== option.id)
          );
        })
      )
        throw new GitHubBatchError('batch-unavailable');
    }
    if (definition.dataType === 'ITERATION') {
      const actual = z
        .object({
          duration: z.literal(definition.iterationConfiguration.duration),
          iterations: z.array(
            z.object({ id: z.string(), title: z.string(), startDate: z.string(), duration: z.number() }),
          ),
          completedIterations: z.array(
            z.object({ id: z.string(), title: z.string(), startDate: z.string(), duration: z.number() }),
          ),
        })
        .parse(field.configuration);
      const iterations = [...actual.iterations, ...actual.completedIterations];
      if (
        iterations.length !== definition.iterationConfiguration.iterations.length ||
        definition.iterationConfiguration.iterations.some(
          expected =>
            !iterations.some(
              item =>
                item.title === expected.title &&
                item.startDate === expected.startDate &&
                item.duration === expected.duration &&
                (expected.id === undefined || item.id === expected.id),
            ),
        )
      )
        throw new GitHubBatchError('batch-unavailable');
    }
    return { ...base, fieldId: field.id, dataType: field.dataType };
  }
  if (operation.kind === 'project.item-delete') {
    z.literal(operation.itemId).parse(result.deletedItemId);
    return { ...base, itemId: operation.itemId, deleted: true };
  }
  if (operation.kind === 'project.draft-update') {
    z.object({
      id: z.literal(operation.content.id),
      title: z.literal(operation.title),
      body: z.literal(operation.body),
    }).parse(result.draftIssue);
    return { ...base, itemId: operation.itemId, contentId: operation.content.id };
  }
  const item = itemSchema.parse(
    result[
      operation.kind === 'project.draft-create'
        ? 'projectItem'
        : operation.kind === 'project.value-set' || operation.kind === 'project.value-clear'
          ? 'projectV2Item'
          : 'item'
    ],
  );
  projectIdentity(operation, item.project);
  if ('itemId' in operation && item.id !== operation.itemId) throw new GitHubBatchError('batch-unavailable');
  if ('content' in operation) contentIdentity(operation.content, item.content);
  if (operation.kind === 'project.item-archive' || operation.kind === 'project.item-unarchive')
    z.literal(operation.kind === 'project.item-archive').parse(item.isArchived);
  const content = z.object({ id: githubNodeId }).parse(item.content);
  if (operation.kind === 'project.draft-create')
    z.object({
      __typename: z.literal('DraftIssue'),
      title: z.literal(operation.title),
      body: z.literal(operation.body),
    }).parse(item.content);
  if (operation.kind === 'project.value-set' || operation.kind === 'project.value-clear') {
    const values = z
      .object({
        fieldValues: z.object({
          pageInfo: z.object({ hasNextPage: z.literal(false) }),
          nodes: z.array(z.object({ field: z.object({ id: githubNodeId }) }).passthrough()).max(100),
        }),
      })
      .parse(result.projectV2Item)
      .fieldValues.nodes.filter(value => value.field.id === operation.fieldId);
    if (operation.kind === 'project.value-clear') {
      if (values.length > 1) throw new GitHubBatchError('batch-unavailable');
      if (values.length === 1) {
        switch (operation.dataType) {
          case 'TEXT':
            z.object({ __typename: z.literal('ProjectV2ItemFieldTextValue'), text: z.null() }).parse(values[0]);
            break;
          case 'NUMBER':
            z.object({ __typename: z.literal('ProjectV2ItemFieldNumberValue'), number: z.null() }).parse(values[0]);
            break;
          case 'DATE':
            z.object({ __typename: z.literal('ProjectV2ItemFieldDateValue'), date: z.null() }).parse(values[0]);
            break;
          case 'SINGLE_SELECT':
            z.object({ __typename: z.literal('ProjectV2ItemFieldSingleSelectValue'), optionId: z.null() }).parse(
              values[0],
            );
            break;
          case 'MULTI_SELECT':
            z.object({ __typename: z.literal('ProjectV2ItemFieldMultiSelectValue'), options: z.null() }).parse(
              values[0],
            );
            break;
          case 'MILESTONE':
            z.object({ __typename: z.literal('ProjectV2ItemFieldMilestoneValue'), milestone: z.null() }).parse(
              values[0],
            );
            break;
          case 'ITERATION':
          case 'ASSIGNEES':
          case 'LABELS':
            throw new GitHubBatchError('batch-unavailable');
          default: {
            const exhaustive: never = operation.dataType;
            return exhaustive;
          }
        }
      }
    } else {
      if (values.length !== 1) throw new GitHubBatchError('batch-unavailable');
      const value = operation.value;
      switch (value.dataType) {
        case 'TEXT':
          z.object({ __typename: z.literal('ProjectV2ItemFieldTextValue'), text: z.literal(value.text) }).parse(
            values[0],
          );
          break;
        case 'NUMBER':
          z.object({ __typename: z.literal('ProjectV2ItemFieldNumberValue'), number: z.literal(value.number) }).parse(
            values[0],
          );
          break;
        case 'DATE':
          z.object({ __typename: z.literal('ProjectV2ItemFieldDateValue'), date: z.literal(value.date) }).parse(
            values[0],
          );
          break;
        case 'SINGLE_SELECT':
          z.object({
            __typename: z.literal('ProjectV2ItemFieldSingleSelectValue'),
            optionId: z.literal(value.singleSelectOptionId),
          }).parse(values[0]);
          break;
        case 'ITERATION':
          z.object({
            __typename: z.literal('ProjectV2ItemFieldIterationValue'),
            iterationId: z.literal(value.iterationId),
          }).parse(values[0]);
          break;
        case 'MULTI_SELECT': {
          const actual = z
            .object({
              __typename: z.literal('ProjectV2ItemFieldMultiSelectValue'),
              options: z.array(z.object({ id: z.string() })),
            })
            .parse(values[0]);
          const ids = new Set(actual.options.map(option => option.id));
          if (
            ids.size !== actual.options.length ||
            ids.size !== value.multiSelectOptionIds.length ||
            value.multiSelectOptionIds.some(id => !ids.has(id))
          )
            throw new GitHubBatchError('batch-unavailable');
          break;
        }
        default: {
          const exhaustive: never = value;
          return exhaustive;
        }
      }
    }
  }
  return { ...base, itemId: item.id, contentId: content.id };
}
export async function recoverProject(
  operation: ProjectWrite,
  credential: GitHubCredential,
  marker: string,
  read: Read,
) {
  if (!credential.scopes.includes('project')) throw new GitHubBatchError('batch-conflict');
  if (operation.kind !== 'project.draft-create' || !marker || !operation.body.includes(marker)) {
    graphqlData(
      await read(operation.kind === 'project.create' ? projectDocuments.owner : projectDocuments.project, {
        id: operation.kind === 'project.create' ? operation.ownerNodeId : operation.projectId,
      }),
    );
    return null;
  }
  const project = z
    .object({ items: z.object({ nodes: z.array(itemSchema).max(30) }) })
    .passthrough()
    .parse(graphqlData(await read(projectDocuments.drafts, { id: operation.projectId })).node);
  projectIdentity(operation, project);
  const candidates = project.items.nodes.filter(
    item =>
      z
        .object({
          __typename: z.literal('DraftIssue'),
          body: z.literal(operation.body),
          title: z.literal(operation.title),
          creator: z.object({ databaseId: z.number().refine(id => String(id) === credential.identity.id) }),
        })
        .safeParse(item.content).success,
  );
  if (candidates.length !== 1) return null;
  return projectResult(operation, { data: { result: { projectItem: candidates[0] } } });
}
