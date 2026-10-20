import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildSchema, parse, validate } from 'graphql';
import { discussionDocuments } from '../dist/discussion-writes.js';
import { projectDocuments } from '../dist/project-writes.js';

const url = 'https://docs.github.com/public/fpt/schema.docs.graphql';
const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
assert.equal(response.status, 200);
const text = await response.text(),
  schema = buildSchema(text);
const documents = {
  ...discussionDocuments,
  ...Object.fromEntries(Object.entries(projectDocuments).map(([name, document]) => [`projects.${name}`, document])),
};
for (const [name, document] of Object.entries(documents)) assert.deepEqual(validate(schema, parse(document)), [], name);
console.log(
  JSON.stringify(
    {
      url,
      checkedAt: new Date().toISOString(),
      sha256: createHash('sha256').update(text).digest('hex'),
      documents: Object.keys(documents),
    },
    null,
    2,
  ),
);
for (const name of [
  'UpdateProjectV2Input',
  'CreateProjectV2FieldInput',
  'UpdateProjectV2FieldInput',
  'ProjectV2FieldValue',
]) {
  const type = schema.getType(name);
  assert.ok(type);
  console.log(
    name,
    Object.fromEntries(Object.entries(type.getFields()).map(([key, field]) => [key, String(field.type)])),
  );
}
for (const [name, field, expected] of [
  ['ProjectV2ItemFieldTextValue', 'text', 'String'],
  ['ProjectV2ItemFieldNumberValue', 'number', 'Float'],
  ['ProjectV2ItemFieldDateValue', 'date', 'Date'],
  ['ProjectV2ItemFieldSingleSelectValue', 'optionId', 'String'],
  ['ProjectV2ItemFieldMultiSelectValue', 'options', '[ProjectV2MultiSelectFieldOption!]'],
  ['ProjectV2ItemFieldMilestoneValue', 'milestone', 'Milestone'],
  ['ProjectV2ItemFieldIterationValue', 'iterationId', 'String!'],
]) {
  const actual = String(schema.getType(name).getFields()[field].type);
  assert.equal(actual, expected);
  console.log(`${name}.${field}`, actual);
}
