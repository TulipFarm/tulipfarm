import assert from 'node:assert/strict';
import test from 'node:test';
import { parse, validate } from 'graphql';
import { githubWriteSchema } from '../dist/batch-contracts.js';
import { projectDocuments } from '../dist/project-writes.js';
import { checkDeletedProjectOwner, checkProjectContent } from '../dist/project-writes.js';
import { GitHubBatchError } from '../dist/batch-contracts.js';
import { dispatchGitHubWrite, requireWriteTarget, reconcileGitHubWrite } from '../dist/write-provider.js';
import {
  projectSchema,
  projectOperations,
  projectProviderFixture,
  projectTarget,
  draftTarget,
  fieldDefinitions,
  fieldValues,
} from './project-provider-fixture.mjs';

const credential = {
  accessToken: 'synthetic-project-token',
  identity: { id: '123', login: 'octocat' },
  scopes: ['repo', 'project'],
};
test('Projects access parsing denies absent targets without concealing unrelated programming faults', async () => {
  const f = await projectProviderFixture();
  try {
    f.state.deny = true;
    await assert.rejects(
      requireWriteTarget(projectOperations[1], credential, f.fetcher),
      error => error instanceof GitHubBatchError && error.code === 'batch-conflict',
    );
    await assert.rejects(
      checkDeletedProjectOwner(projectTarget, credential, async () => ({ data: { node: null } })),
      error => error instanceof GitHubBatchError && error.code === 'batch-conflict',
    );
    await assert.rejects(
      checkProjectContent(projectOperations[8], credential, async () => ({ data: { node: null } })),
      error => error instanceof GitHubBatchError && error.code === 'batch-conflict',
    );
    const fault = new TypeError('injected programming fault');
    await assert.rejects(
      requireWriteTarget(projectOperations[1], credential, async () => {
        throw fault;
      }),
      error => error === fault,
    );
    f.state.deny = false;
    await requireWriteTarget(projectOperations[1], credential, f.fetcher);
    assert.equal(f.effects.length, 0);
  } finally {
    await f.close();
  }
});
const nullableClearValues = [
  ['TEXT', 'Text', 'text'],
  ['NUMBER', 'Number', 'number'],
  ['DATE', 'Date', 'date'],
  ['SINGLE_SELECT', 'SingleSelect', 'optionId'],
  ['MULTI_SELECT', 'MultiSelect', 'options'],
  ['MILESTONE', 'Milestone', 'milestone'],
];
for (const [dataType, type, key] of nullableClearValues)
  test(`documented nullable ${dataType} clear acknowledgement confirms only the matching identity`, async () => {
    const f = await projectProviderFixture();
    try {
      const field = f.fields.get(dataType === 'MILESTONE' ? 'F_TEXT' : `F_${dataType}`);
      field.dataType = dataType;
      const item = f.items.get('PI_1');
      item.fieldValues = () => ({
        nodes: [{ __typename: `ProjectV2ItemField${type}Value`, field, [key]: null }],
        pageInfo: { hasNextPage: false },
      });
      const operation = { kind: 'project.value-clear', ...draftTarget, fieldId: field.id, dataType };
      await requireWriteTarget(operation, credential, f.fetcher, true);
      const outcome = await dispatchGitHubWrite({
        operation,
        credential,
        fetcher: f.fetcher,
        bindings: [],
        authorize: async () => true,
      });
      assert.equal(outcome.status, 'succeeded');
      assert.equal(outcome.result.itemId, 'PI_1');
      assert.deepEqual(f.schemaErrors, []);
      item.id = 'PI_wrong';
      await assert.rejects(
        dispatchGitHubWrite({ operation, credential, fetcher: f.fetcher, bindings: [], authorize: async () => true }),
      );
      assert.equal(f.effects.length, 2);
    } finally {
      await f.close();
    }
  });
for (const mode of ['wrong-type', 'non-null', 'duplicate', 'incomplete', 'wrong-project', 'wrong-content'])
  test(`clear ${mode} acknowledgement cannot confirm success`, async () => {
    const f = await projectProviderFixture();
    try {
      const item = f.items.get('PI_1'),
        field = f.fields.get('F_TEXT');
      const value =
        mode === 'wrong-type'
          ? { __typename: 'ProjectV2ItemFieldNumberValue', field, number: null }
          : { __typename: 'ProjectV2ItemFieldTextValue', field, text: mode === 'non-null' ? '' : null };
      item.fieldValues = () => ({
        nodes: mode === 'duplicate' ? [value, value] : [value],
        pageInfo: { hasNextPage: mode === 'incomplete' },
      });
      if (mode === 'wrong-project') item.project = f.projects.get('P_2');
      if (mode === 'wrong-content') item.content = f.contents.get('I_7');
      await assert.rejects(
        dispatchGitHubWrite({
          operation: projectOperations[15],
          credential,
          fetcher: f.fetcher,
          bindings: [],
          authorize: async () => true,
        }),
      );
      assert.deepEqual(f.schemaErrors, []);
      assert.equal(f.effects.length, 1);
    } finally {
      await f.close();
    }
  });
test('actual fixed Projects documents validate against the captured official schema', () => {
  for (const [name, document] of Object.entries(projectDocuments))
    assert.deepEqual(validate(projectSchema, parse(document)), [], name);
  assert.notDeepEqual(
    validate(
      projectSchema,
      parse('mutation($input: DeleteProjectV2Input!) { deleteProjectV2(input:$input) { deletedId } }'),
    ),
    [],
  );
});
const cases = [
  ...projectOperations,
  ...fieldDefinitions.flatMap(field => [
    { kind: 'project.field-create', ...projectTarget, field },
    { kind: 'project.field-update', ...projectTarget, fieldId: `F_${field.dataType}`, field },
  ]),
  ...fieldValues.map(value => ({ kind: 'project.value-set', ...draftTarget, fieldId: `F_${value.dataType}`, value })),
  ...fieldValues.map(value => ({
    kind: 'project.value-clear',
    ...draftTarget,
    fieldId: `F_${value.dataType}`,
    dataType: value.dataType,
  })),
  { ...projectOperations[0], owner: 'company', ownerType: 'organization', ownerNodeId: 'O_9' },
  {
    ...projectOperations[1],
    owner: 'company',
    ownerType: 'organization',
    ownerNodeId: 'O_9',
    projectId: 'P_2',
    projectNumber: 2,
  },
  { ...projectOperations[8], content: { ...projectOperations[8].content, type: 'PullRequest', id: 'PR_8' } },
];
for (const original of cases)
  test(`${original.kind} ${original.field?.dataType ?? original.value?.dataType ?? original.ownerType} executes coerced variables over real HTTP`, async () => {
    const f = await projectProviderFixture(),
      operation = githubWriteSchema.parse(original);
    try {
      await requireWriteTarget(operation, credential, f.fetcher, true);
      const outcome = await dispatchGitHubWrite({
        operation,
        credential,
        fetcher: f.fetcher,
        bindings: [],
        authorize: async () => true,
      });
      assert.equal(outcome.status, 'succeeded');
      assert.equal(f.effects.length, 1);
      assert.deepEqual(f.schemaErrors, []);
      if (operation.kind === 'project.create') assert.equal(f.projects.get('P_3').title, 'Delivery plan');
      if (operation.kind === 'project.update') assert.equal(f.projects.get(operation.projectId).readme, 'Exact plan');
      if (operation.kind === 'project.delete') assert.equal(f.projects.has(operation.projectId), false);
      if (operation.kind === 'project.field-create') assert.equal(f.fields.get('F_NEW').name, operation.field.name);
      if (operation.kind === 'project.field-update')
        assert.equal(f.fields.get(operation.fieldId).name, operation.field.name);
      if (operation.kind === 'project.field-delete') assert.equal(f.fields.has(operation.fieldId), false);
      if (operation.kind === 'project.item-add') assert.equal(f.items.get('PI_NEW').content.id, operation.content.id);
      if (operation.kind === 'project.draft-create') assert.equal(f.contents.get('DI_NEW').body, 'Exact task.');
      if (operation.kind === 'project.draft-update') assert.equal(f.contents.get('DI_1').body, 'Updated task body.');
      if (operation.kind === 'project.item-delete') assert.equal(f.items.has('PI_1'), false);
      if (operation.kind === 'project.value-set') {
        const { dataType: _dataType, ...expected } = operation.value;
        assert.deepEqual(f.items.get('PI_1').values.get(operation.fieldId), expected);
      }
      if (operation.kind === 'project.value-clear')
        assert.equal(f.items.get('PI_1').values.has(operation.fieldId), false);
      assert.equal(
        (await reconcileGitHubWrite({ operation, credential, fetcher: f.fetcher, marker: 'unused' })).result,
        null,
      );
      assert.equal(f.effects.length, 1);
    } finally {
      await f.close();
    }
  });
test('strict Projects actions reject arbitrary documents variables URLs and mismatched value types', () => {
  for (const key of ['query', 'url', 'variables', 'clientMutationId'])
    assert.equal(githubWriteSchema.safeParse({ ...projectOperations[0], [key]: 'arbitrary' }).success, false);
  for (const key of ['ownerNodeId', 'ownerType', 'projectId', 'projectNumber']) {
    const action = { ...projectOperations[1] };
    delete action[key];
    assert.equal(githubWriteSchema.safeParse(action).success, false);
  }
  for (const value of [
    { dataType: 'NUMBER', text: '12' },
    { dataType: 'DATE', date: '2026-02-30' },
    { dataType: 'TEXT', text: 'x', number: 2 },
  ])
    assert.equal(githubWriteSchema.safeParse({ ...projectOperations[14], value }).success, false);
});
for (const mode of ['partial', 'malformed', 'lose'])
  test(`${mode} result after a Projects effect cannot become success`, async () => {
    const f = await projectProviderFixture();
    try {
      f.state[mode] = true;
      await assert.rejects(
        dispatchGitHubWrite({
          operation: projectOperations[0],
          credential,
          fetcher: f.fetcher,
          bindings: [],
          authorize: async () => true,
        }),
      );
      assert.equal(f.effects.length, 1);
      assert.equal(f.projects.get('P_3').title, 'Delivery plan');
    } finally {
      await f.close();
    }
  });
test('nested project field item content and repository identities and current rights are checked', async () => {
  const f = await projectProviderFixture();
  try {
    for (const patch of [
      { ownerNodeId: 'U_123' },
      { ownerType: 'user' },
      { projectId: 'P_2' },
      { projectNumber: 2 },
      { itemId: 'PI_2' },
      { fieldId: 'F_NUMBER' },
      { content: { type: 'DraftIssue', id: 'DI_other' } },
    ])
      await assert.rejects(requireWriteTarget({ ...projectOperations[14], ...patch }, credential, f.fetcher, true));
    await assert.rejects(
      requireWriteTarget(
        { ...projectOperations[0], owner: 'octocat', ownerType: 'user', ownerNodeId: 'U_123' },
        credential,
        f.fetcher,
        true,
      ),
      error => error instanceof GitHubBatchError && error.code === 'batch-conflict',
    );
    await assert.rejects(
      requireWriteTarget(
        {
          ...projectOperations[8],
          content: {
            ...projectOperations[8].content,
            repository: { ...projectOperations[8].content.repository, id: 'R_wrong' },
          },
        },
        credential,
        f.fetcher,
        true,
      ),
    );
    f.projects.get('P_1').viewerCanUpdate = false;
    await assert.rejects(requireWriteTarget(projectOperations[1], credential, f.fetcher, true));
    await requireWriteTarget(projectOperations[2], credential, f.fetcher, true);
    f.projects.get('P_1').viewerCanClose = false;
    await assert.rejects(requireWriteTarget(projectOperations[2], credential, f.fetcher, true));
    assert.equal(f.effects.length, 0);
  } finally {
    await f.close();
  }
});
