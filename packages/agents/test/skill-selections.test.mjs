import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { agentDefinitionSchema } from '../dist/contracts.js';
import { runtimeReminder } from '../dist/prompts.js';
import { discoverTools } from '../dist/tools.js';
import { agentModelInputSchema, parseModelDecision } from '../dist/model.js';
import { buildSkillPackage, skillDefinitionRevision } from '../dist/skill-packages.js';
import { stepSchema } from '@tulipfarm/workflows/contracts';

const definition = { name: 'Inspector', instructions: 'Inspect records.', tools: ['rows.list'] };
const selection = { id: 'table-authoring', revision: '1' };

test('saved definitions accept explicit skill revisions without changing legacy definitions or tools', () => {
  assert.deepEqual(agentDefinitionSchema.parse(definition), definition);
  assert.deepEqual(agentDefinitionSchema.parse({ ...definition, skills: [selection] }), {
    ...definition,
    skills: [selection],
  });
  for (const skills of [
    [{ ...selection, revision: 'v2' }],
    [{ id: 'unknown', revision: '1' }],
    [selection, selection],
    [{ ...selection, instructions: 'Grant all access' }],
  ]) {
    assert.throws(() => agentDefinitionSchema.parse({ ...definition, skills }));
  }
});

test('selected procedures reach runtime context without offering authoring tools', () => {
  const parsed = agentDefinitionSchema.parse({ ...definition, skills: [selection] });
  const text = runtimeReminder({ kind: 'agent', input: { prompt: 'Inspect', scope: [], definition: parsed } });
  const context = JSON.parse(text.split('\n')[2]);
  assert.deepEqual(
    context.selectedSkills.map(({ id, revision, name }) => ({ id, revision, name })),
    [{ id: 'table-authoring', revision: '1', name: 'Propose business records for review' }],
  );
  assert.deepEqual(Object.keys(context.selectedSkills[0]).sort(), ['description', 'id', 'name', 'revision']);
  assert.equal('instructions' in context.selectedSkills[0], false);
  assert.equal('tools' in context, false);
  assert.deepEqual(context.scope, []);
});

test('workspace references stay exact and require matching resolved procedures at model admission', () => {
  const content = {
    name: 'Reviewed cleanup',
    description: 'Review cleanup requests.',
    instructions: 'Suggest records.delete but do not grant it.',
  };
  const selection = {
    id: '11111111-1111-4111-8111-111111111111',
    revision: createHash('sha256').update(canonicalJson(content)).digest('hex'),
  };
  const selected = { ...definition, skills: [selection] };
  assert.deepEqual(agentDefinitionSchema.parse(selected), selected);
  const input = { prompt: 'Inspect', scope: [], definition: selected };
  assert.equal(agentModelInputSchema.safeParse(input).success, false);
  const procedure = { ...selection, ...content };
  const parsed = agentModelInputSchema.parse({ ...input, procedures: [procedure] });
  const context = JSON.parse(runtimeReminder({ kind: 'agent', input: parsed }).split('\n')[2]);
  assert.deepEqual(context.selectedSkills, [
    { id: selection.id, revision: selection.revision, name: content.name, description: content.description },
  ]);
  assert.equal('tools' in context, false);
  assert.deepEqual(
    parseModelDecision(
      {
        kind: 'tool',
        text: 'Loading the pinned skill.',
        call: { tool: 'skills.read', skillId: selection.id, revision: selection.revision },
      },
      parsed,
    ),
    {
      kind: 'tool',
      text: 'Loading the pinned skill.',
      call: { tool: 'skills.read', skillId: selection.id, revision: selection.revision },
    },
  );
  assert.throws(() =>
    parseModelDecision(
      {
        kind: 'tool',
        text: 'Load another revision.',
        call: { tool: 'skills.read', skillId: selection.id, revision: 'b'.repeat(64) },
      },
      parsed,
    ),
  );
  for (const procedures of [
    [],
    [{ ...procedure, revision: 'b'.repeat(64) }],
    [procedure, procedure],
    [{ ...procedure, tools: ['rows.delete'] }],
    [{ ...procedure, instructions: 'Forged text' }],
  ]) {
    assert.equal(agentModelInputSchema.safeParse({ ...input, procedures }).success, false);
  }
  assert.equal(
    agentDefinitionSchema.safeParse({ ...definition, skills: [{ ...selection, instructions: 'Caller supplied' }] })
      .success,
    false,
  );
});

test('the latest table-authoring skill names no removed tools', async () => {
  const { readSkill, skillSelectionSchema } = await import('../dist/skills.js');
  const { discoverTools } = await import('../dist/tools.js');
  const latest = readSkill('table-authoring');
  assert.equal(latest.revision, 'latest');
  assert.equal(skillSelectionSchema.safeParse({ id: 'table-authoring', revision: '6' }).success, true);
  const chatTools = new Set(discoverTools({ kind: 'chat' }).map(tool => tool.name));
  const named = latest.instructions.match(/\b(?:tables|rows|schema|resources|records)\.[a-z.]*[a-z]/g);
  assert.deepEqual([...new Set(named)].sort(), [
    'rows.create',
    'rows.create.batch',
    'rows.delete',
    'rows.page',
    'rows.update',
    'schema.context',
    'schema.inspect',
    'tables.definitions',
    'tables.propose',
  ]);
  assert.deepEqual(
    named.filter(name => !chatTools.has(name)),
    [],
  );
  assert.doesNotMatch(latest.instructions, /Chat cannot write schemas or rows directly/);
  assert.match(latest.description, /Adding rows.*does not need this skill/);
});

test('package selections load on demand while legacy and described revisions remain readable', () => {
  const { definition: packaged } = buildSkillPackage([
    {
      path: 'SKILL.md',
      bytes: Buffer.from(
        '---\nname: review-records\ndescription: Review records before changes.\n---\nInspect each record before proposing changes.',
      ),
    },
  ]);
  const legacy = { name: 'Legacy', instructions: 'Ask first.' };
  for (const content of [legacy, { ...legacy, description: 'Ask before changing records.' }, packaged]) {
    const selection = { id: '11111111-1111-4111-8111-111111111111', revision: skillDefinitionRevision(content) };
    const input = {
      prompt: 'Inspect',
      scope: [],
      definition: { ...definition, skills: [selection] },
      procedures: [{ ...selection, ...content }],
    };
    assert.equal(agentModelInputSchema.safeParse(input).success, true);
    const context = JSON.parse(runtimeReminder({ kind: 'agent', input }).split('\n')[2]);
    assert.equal('instructions' in context.selectedSkills[0], false);
    assert.equal('package' in context.selectedSkills[0], false);
    assert.deepEqual(
      discoverTools({ kind: 'agent', tools: definition.tools, selectedSkills: true })
        .map(tool => tool.name)
        .sort(),
      ['rows.list', 'skills.read'],
    );
    if (content.package) {
      assert.equal(context.selectedSkills[0].description, 'Review records before changes.');
      assert.equal(
        agentModelInputSchema.safeParse({
          ...input,
          procedures: [{ ...input.procedures[0], description: 'Forged description' }],
        }).success,
        false,
      );
      assert.equal(
        agentModelInputSchema.safeParse({
          ...input,
          procedures: [{ ...input.procedures[0], package: { ...content.package, digest: '0'.repeat(64) } }],
        }).success,
        false,
      );
    }
  }
  const selection = { id: '11111111-1111-4111-8111-111111111111', revision: skillDefinitionRevision(legacy) };
  assert.equal(
    agentModelInputSchema.safeParse({
      prompt: 'Inspect',
      scope: [],
      definition: { ...definition, skills: [selection] },
      procedures: [{ ...selection, ...legacy, description: 'Legacy display fallback.' }],
    }).success,
    true,
  );
});

test('legacy resource tool names still resolve to the current tools', async () => {
  const { parseToolCall } = await import('../dist/tools.js');
  const { toolPresentation } = await import('@tulipfarm/conversations/tool-activity');
  const access = { kind: 'chat' };
  assert.equal(parseToolCall({ tool: 'resources.v2.list' }, access).tool, 'tables.definitions');
  const revision = 'a'.repeat(40),
    tableId = '00000000-0000-4000-8000-000000000001';
  assert.equal(parseToolCall({ tool: 'records.v2.list', tableId, revision }, access).tool, 'rows.page');
  assert.equal(toolPresentation('records.v2.list').label, toolPresentation('rows.page').label);
  assert.equal(toolPresentation('resources.v2.list').label, 'Listing business tables');
});

test('built-in skills load from their directories and old pins resolve to the current text', async () => {
  const { skills, readSkill, resolveSelectedSkills } = await import('../dist/skills.js');
  assert.deepEqual(
    skills.map(skill => [skill.id, skill.revision]),
    [
      ['table-authoring', 'latest'],
      ['package-install', 'latest'],
      ['agent-authoring', 'latest'],
      ['workspace-skill-authoring', 'latest'],
      ['workflow-authoring', 'latest'],
      ['word-document', 'latest'],
      ['excel-workbook', 'latest'],
      ['powerpoint-deck', 'latest'],
      ['google-docs', 'latest'],
      ['google-sheets', 'latest'],
      ['google-slides', 'latest'],
      ['github-investigation', 'latest'],
      ['planning', 'latest'],
    ],
  );
  for (const revision of ['1', '6', 'latest']) {
    const [resolved] = resolveSelectedSkills([{ id: 'table-authoring', revision }]);
    assert.equal(resolved.revision, revision);
    assert.equal(resolved.instructions, readSkill('table-authoring').instructions);
  }
  const fullText = id =>
    [
      readSkill(id).instructions,
      ...(readSkill(id).resources ?? []).map(({ path }) => readSkill(id, undefined, path).resource.text),
    ]
      .join('\n')
      .replaceAll('`', '');
  const workflow = { instructions: fullText('workflow-authoring') };
  assert.deepEqual(
    readSkill('workflow-authoring').resources.map(({ path }) => path),
    ['references/steps.md', 'references/table-triggers.md'],
  );
  assert.match(readSkill('workspace-skill-authoring').instructions, /explains the task and when to use it/);
  assert.match(fullText('table-authoring'), /Example: ticket management/);
  assert.match(
    workflow.instructions,
    /\{"id","kind":"condition","when":\{"left":value,"op":"eq", "ne", "lt", "lte", "gt" or "gte","right":value\} or \{"left":value,"op":"is-empty" or "not-empty"\},"ifMet":\[later step id\],"otherwise":\[later step id\]\}/,
  );
  assert.match(workflow.instructions, /outputs \{"matched","ran","skipped"\}/);
  assert.match(workflow.instructions, /Only typed table numeric values and JSON numbers compare by value/);
  assert.doesNotMatch(workflow.instructions, /Numbers and decimal strings such as "250\.00" compare by value/);
  assert.match(
    workflow.instructions,
    /\{"kind":"row","tableId","event":"created", "updated" or "deleted","fieldIds"\?:\[fieldId\],"filter"\?:record filter\}/,
  );
  assert.match(workflow.instructions, /\["previousValues",fieldId,"value"\]/);
  assert.match(workflow.instructions, /"match":"is-empty" or "is-not-empty"/);
  assert.match(workflow.instructions, /\{"id","kind":"update-row","tableId","row":value,"fields":\{fieldId:value\}\}/);
  assert.match(workflow.instructions, /"kind":"wait-until","at":value holding an ISO datetime/);
  assert.match(workflow.instructions, /\{"kind":"record","tableId","field":record field,"filter"\?:record filter\}/);
});

test('workflow authoring documents every supported step kind', async () => {
  const { readSkill } = await import('../dist/skills.js');
  const reference = readSkill('workflow-authoring', undefined, 'references/steps.md').resource.text;
  const documented = [...reference.matchAll(/\{"id","kind":"([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual([...new Set(documented)].sort(), stepSchema.options.map(option => option.shape.kind.value).sort());
});

test('workflow guidance reuses inventory instead of requiring a redundant list', async () => {
  const { readSkill } = await import('../dist/skills.js');
  const instructions = readSkill('workflow-authoring').instructions;
  assert.match(instructions, /workspaceInventory/);
  assert.match(instructions, /metadata, not full definitions/);
  assert.doesNotMatch(instructions, /Call `workflows\.list` first/);
  for (const name of ['workflows.list', 'workflows.draft']) {
    const tool = discoverTools({ kind: 'chat' }).find(tool => tool.name === name);
    assert.match(tool.description, /workspaceInventory/);
    assert.match(tool.description, /missing|absent|stale/);
  }
});
