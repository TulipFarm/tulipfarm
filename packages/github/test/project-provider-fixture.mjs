import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildSchema, graphql } from 'graphql';

export const projectSchema = buildSchema(
  gunzipSync(readFileSync(new URL('./project-schema.graphql.gz', import.meta.url))).toString(),
);
export const projectOwner = { owner: 'octocat', ownerType: 'user', ownerNodeId: 'U_123' };
export const projectTarget = { ...projectOwner, projectId: 'P_1', projectNumber: 1 };
export const draftTarget = { ...projectTarget, itemId: 'PI_1', content: { type: 'DraftIssue', id: 'DI_1' } };
export const issueContent = {
  type: 'Issue',
  id: 'I_7',
  repository: { id: 'R_42', databaseId: 42, ownerId: 'U_123', owner: 'octocat', repo: 'private' },
};
export const projectOperations = [
  { kind: 'project.create', ...projectOwner, title: 'Delivery plan' },
  {
    kind: 'project.update',
    ...projectTarget,
    title: 'Updated plan',
    shortDescription: 'Release work',
    readme: 'Exact plan',
    public: false,
  },
  ...['project.close', 'project.reopen', 'project.delete'].map(kind => ({ kind, ...projectTarget })),
  { kind: 'project.field-create', ...projectTarget, field: { dataType: 'TEXT', name: 'Notes' } },
  {
    kind: 'project.field-update',
    ...projectTarget,
    fieldId: 'F_TEXT',
    field: { dataType: 'TEXT', name: 'Updated notes' },
  },
  { kind: 'project.field-delete', ...projectTarget, fieldId: 'F_TEXT' },
  { kind: 'project.item-add', ...projectTarget, content: issueContent },
  { kind: 'project.draft-create', ...projectTarget, title: 'Draft task', body: 'Exact task.' },
  { kind: 'project.draft-update', ...draftTarget, title: 'Updated task', body: 'Updated task body.' },
  ...['project.item-archive', 'project.item-unarchive', 'project.item-delete'].map(kind => ({ kind, ...draftTarget })),
  { kind: 'project.value-set', ...draftTarget, fieldId: 'F_TEXT', value: { dataType: 'TEXT', text: 'Approved notes' } },
  { kind: 'project.value-clear', ...draftTarget, fieldId: 'F_TEXT', dataType: 'TEXT' },
];
export const fieldDefinitions = [
  ...['TEXT', 'NUMBER', 'DATE'].map(dataType => ({ dataType, name: dataType })),
  {
    dataType: 'SINGLE_SELECT',
    name: 'Status',
    singleSelectOptions: [{ name: 'Ready', description: 'Can start', color: 'GREEN' }],
  },
  {
    dataType: 'MULTI_SELECT',
    name: 'Tags',
    multiSelectOptions: [{ name: 'Release', description: 'Release task', color: 'BLUE' }],
  },
  {
    dataType: 'ITERATION',
    name: 'Sprint',
    iterationConfiguration: {
      duration: 14,
      startDate: '2026-10-02',
      iterations: [{ title: 'Sprint one', startDate: '2026-10-02', duration: 14 }],
    },
  },
];
export const fieldValues = [
  { dataType: 'TEXT', text: 'Approved notes' },
  { dataType: 'NUMBER', number: 12.5 },
  { dataType: 'DATE', date: '2026-10-02' },
  { dataType: 'SINGLE_SELECT', singleSelectOptionId: 'OPT_1' },
  { dataType: 'MULTI_SELECT', multiSelectOptionIds: ['OPT_1'] },
  { dataType: 'ITERATION', iterationId: 'ITER_1' },
];
export async function projectProviderFixture(nativeFetch = fetch) {
  const state = {
    deny: false,
    outsideDeny: false,
    repositoryDeny: false,
    lose: false,
    partial: false,
    malformed: false,
    status: null,
    afterEffect: null,
  };
  const effects = [],
    requests = [],
    schemaErrors = [];
  const page = nodes => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null }, totalCount: nodes.length });
  const user = {
    __typename: 'User',
    id: 'U_123',
    databaseId: 123,
    login: 'octocat',
    isViewer: true,
    viewerCanCreateProjects: true,
  };
  const organization = {
    __typename: 'Organization',
    id: 'O_9',
    login: 'company',
    viewerCanCreateProjects: true,
    viewerCanAdminister: true,
    viewerIsAMember: true,
  };
  const repository = {
    __typename: 'Repository',
    id: 'R_42',
    databaseId: 42,
    nameWithOwner: 'octocat/private',
    owner: user,
  };
  const projects = new Map(),
    items = new Map(),
    fields = new Map(),
    contents = new Map();
  const makeProject = (id, number, title, owner = user) => ({
    __typename: 'ProjectV2',
    id,
    number,
    title,
    owner,
    shortDescription: '',
    readme: '',
    public: false,
    closed: false,
    url: `https://github.com/users/${owner.login}/projects/${number}`,
    viewerCanUpdate: true,
    viewerCanClose: true,
    viewerCanReopen: true,
    fields: () => page([...fields.values()].filter(f => f.project.id === id)),
    items: () => page([...items.values()].filter(i => i.project.id === id)),
  });
  const makeItem = (id, project, content) => ({
    __typename: 'ProjectV2Item',
    id,
    project,
    content,
    isArchived: false,
    type:
      content.__typename === 'DraftIssue' ? 'DRAFT_ISSUE' : content.__typename === 'Issue' ? 'ISSUE' : 'PULL_REQUEST',
    updatedAt: '2026-10-02T00:00:00Z',
    values: new Map(),
    fieldValues: () => page([]),
    fieldValueByName: () => null,
  });
  const makeField = (id, project, input) => ({
    __typename:
      input.dataType === 'SINGLE_SELECT'
        ? 'ProjectV2SingleSelectField'
        : input.dataType === 'MULTI_SELECT'
          ? 'ProjectV2MultiSelectField'
          : input.dataType === 'ITERATION'
            ? 'ProjectV2IterationField'
            : 'ProjectV2Field',
    id,
    project,
    name: input.name,
    dataType: input.dataType,
    isIssueField: false,
    options: (input.singleSelectOptions ?? []).map((o, i) => ({ ...o, id: o.id ?? `OPT_${i + 1}` })),
    multiSelectOptions: (input.multiSelectOptions ?? []).map((o, i) => ({ ...o, id: o.id ?? `OPT_${i + 1}` })),
    configuration: {
      duration: input.iterationConfiguration?.duration ?? 14,
      startDay: 5,
      iterations: (input.iterationConfiguration?.iterations ?? []).map((i, n) => ({
        ...i,
        id: i.id ?? `ITER_${n + 1}`,
      })),
      completedIterations: [],
    },
  });
  const project = makeProject('P_1', 1, 'Original plan');
  projects.set(project.id, project);
  projects.set('P_2', makeProject('P_2', 2, 'Organization plan', organization));
  const draft = { __typename: 'DraftIssue', id: 'DI_1', title: 'Original task', body: 'Original body', creator: user };
  contents.set(draft.id, draft);
  contents.set('I_7', {
    __typename: 'Issue',
    id: 'I_7',
    number: 7,
    title: 'Issue seven',
    body: 'Private issue',
    url: 'https://github.com/octocat/private/issues/7',
    repository,
  });
  contents.set('PR_8', {
    __typename: 'PullRequest',
    id: 'PR_8',
    number: 8,
    title: 'Pull eight',
    body: 'Private pull',
    url: 'https://github.com/octocat/private/pull/8',
    repository,
  });
  items.set('PI_1', makeItem('PI_1', project, draft));
  items.set('PI_2', makeItem('PI_2', project, contents.get('I_7')));
  const values = item =>
    page(
      [...item.values].map(([fieldId, value]) => {
        const field = fields.get(fieldId);
        const types = {
          TEXT: 'Text',
          NUMBER: 'Number',
          DATE: 'Date',
          SINGLE_SELECT: 'SingleSelect',
          MULTI_SELECT: 'MultiSelect',
          ITERATION: 'Iteration',
        };
        return {
          __typename: `ProjectV2ItemField${types[field.dataType]}Value`,
          field,
          ...value,
          optionId: value.singleSelectOptionId,
          options: value.multiSelectOptionIds?.map(id => ({ id })),
        };
      }),
    );
  for (const item of items.values()) item.fieldValues = () => values(item);
  for (const definition of fieldDefinitions)
    fields.set(`F_${definition.dataType}`, makeField(`F_${definition.dataType}`, project, definition));
  for (const owner of [user, organization]) {
    owner.projectV2 = ({ number }) =>
      state.deny ? null : ([...projects.values()].find(p => p.number === number && p.owner.id === owner.id) ?? null);
    owner.projectsV2 = ({ first = 30 }) =>
      page([...projects.values()].filter(p => p.owner.id === owner.id).slice(0, first));
  }
  const roots = {
    user: () => (state.deny ? null : user),
    organization: () => (state.deny ? null : organization),
    node: ({ id }) =>
      state.deny
        ? null
        : id === user.id
          ? user
          : id === organization.id
            ? organization
            : state.repositoryDeny && ['I_7', 'PR_8'].includes(id)
              ? null
              : (projects.get(id) ?? fields.get(id) ?? items.get(id) ?? contents.get(id) ?? null),
  };
  const effect =
    (name, apply) =>
    ({ input }) => {
      const value = apply(input);
      effects.push({ name, input });
      return value;
    };
  Object.assign(roots, {
    createProjectV2: effect('createProjectV2', input => {
      const p = makeProject('P_3', 3, input.title, input.ownerId === organization.id ? organization : user);
      projects.set(p.id, p);
      return { projectV2: p };
    }),
    updateProjectV2: effect('updateProjectV2', input => {
      const { projectId, ...changes } = input;
      const p = projects.get(projectId);
      Object.assign(p, changes);
      return { projectV2: p };
    }),
    deleteProjectV2: effect('deleteProjectV2', input => {
      const p = projects.get(input.projectId);
      projects.delete(input.projectId);
      for (const [id, i] of items) if (i.project.id === input.projectId) items.delete(id);
      return { projectV2: p };
    }),
    createProjectV2Field: effect('createProjectV2Field', input => {
      const f = makeField('F_NEW', projects.get(input.projectId), input);
      fields.set(f.id, f);
      return { projectV2Field: f };
    }),
    updateProjectV2Field: effect('updateProjectV2Field', input => {
      const previous = fields.get(input.fieldId);
      const f = makeField(previous.id, previous.project, { ...input, dataType: previous.dataType });
      fields.set(f.id, f);
      return { projectV2Field: f };
    }),
    deleteProjectV2Field: effect('deleteProjectV2Field', input => {
      const f = fields.get(input.fieldId);
      fields.delete(input.fieldId);
      return { projectV2Field: f };
    }),
    addProjectV2ItemById: effect('addProjectV2ItemById', input => {
      const i = makeItem('PI_NEW', projects.get(input.projectId), contents.get(input.contentId));
      items.set(i.id, i);
      return { item: i };
    }),
    addProjectV2DraftIssue: effect('addProjectV2DraftIssue', input => {
      const d = { __typename: 'DraftIssue', id: 'DI_NEW', title: input.title, body: input.body, creator: user };
      contents.set(d.id, d);
      const i = makeItem('PI_NEW', projects.get(input.projectId), d);
      i.fieldValues = () => values(i);
      items.set(i.id, i);
      return { projectItem: i };
    }),
    updateProjectV2DraftIssue: effect('updateProjectV2DraftIssue', input => {
      const d = contents.get(input.draftIssueId);
      Object.assign(d, { title: input.title, body: input.body });
      return { draftIssue: d };
    }),
    archiveProjectV2Item: effect('archiveProjectV2Item', input => {
      const i = items.get(input.itemId);
      i.isArchived = true;
      return { item: i };
    }),
    unarchiveProjectV2Item: effect('unarchiveProjectV2Item', input => {
      const i = items.get(input.itemId);
      i.isArchived = false;
      return { item: i };
    }),
    deleteProjectV2Item: effect('deleteProjectV2Item', input => {
      items.delete(input.itemId);
      return { deletedItemId: input.itemId };
    }),
    updateProjectV2ItemFieldValue: effect('updateProjectV2ItemFieldValue', input => {
      const i = items.get(input.itemId);
      i.values.set(input.fieldId, input.value);
      return { projectV2Item: i };
    }),
    clearProjectV2ItemFieldValue: effect('clearProjectV2ItemFieldValue', input => {
      const i = items.get(input.itemId);
      i.values.delete(input.fieldId);
      return { projectV2Item: i };
    }),
  });
  const server = createServer(async (request, response) => {
    const reply = (value, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString(),
        body = raw ? JSON.parse(raw) : null;
      requests.push({ method: request.method, path: request.url, body });
      if (request.url === '/repos/outside/source')
        return reply({ id: 777, full_name: 'outside/source' }, state.outsideDeny ? 403 : 200);
      if (request.url === '/repos/octocat/private')
        return reply(
          {
            id: repository.databaseId,
            node_id: repository.id,
            owner: { node_id: repository.owner.id },
            full_name: repository.nameWithOwner,
          },
          state.repositoryDeny ? 403 : 200,
        );
      if (request.url === '/repos/octocat/private/issues/7')
        return reply({ id: 70, number: 7 }, state.repositoryDeny ? 403 : 200);
      if (request.url === '/repos/octocat/private/issues/7/comments') {
        effects.push({ name: 'issueComment', input: body });
        return reply({ id: 71 }, 201);
      }
      assert.equal(request.url, '/graphql');
      assert.equal(request.method, 'POST');
      const isMutation = body.query.startsWith('mutation');
      if (isMutation && state.status) return reply({}, state.status);
      const result = await graphql({
        schema: projectSchema,
        source: body.query,
        variableValues: body.variables,
        rootValue: roots,
        typeResolver: value => value.__typename,
      });
      if (result.errors) schemaErrors.push(...result.errors.map(error => error.message));
      if (isMutation) {
        await state.afterEffect?.();
        if (state.lose) {
          response.destroy();
          return;
        }
      }
      reply(
        isMutation && state.malformed
          ? { data: { result: {} } }
          : isMutation && state.partial
            ? { ...result, errors: [{ message: 'partial result' }] }
            : result,
      );
    } catch (error) {
      schemaErrors.push(String(error));
      reply({ errors: [{ message: String(error) }] }, 500);
    }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    state,
    effects,
    requests,
    schemaErrors,
    user,
    organization,
    repository,
    projects,
    items,
    fields,
    contents,
    fetcher: (url, init) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://api.github.com');
      assert.equal(init.redirect, 'error');
      return nativeFetch(`http://127.0.0.1:${server.address().port}${parsed.pathname}${parsed.search}`, init);
    },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
