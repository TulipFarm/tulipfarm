import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agentLessonLimits,
  fitLessonBook,
  lessonLeak,
  lessonsForContext,
  mergeLessonBook,
  parseLessonBook,
  renderLessonBook,
  sameLesson,
} from '../src/agent-lessons.ts';
import { parseLessonOutput, safeLessonOutput } from '../src/agent-lesson-learning.ts';
import { agentModelInputSchema } from '../src/model.ts';
import { runtimeReminder } from '../src/prompts.ts';
import { taskDecisionSchema } from '../src/task-approval-contracts.ts';

const runs = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const at = index => new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();

test('a lesson never reads as a new section of the file', () => {
  const book = mergeLessonBook(
    { lessons: [], suggestions: [] },
    { lessons: [{ kind: 'correction', text: '## Check the table first.' }] },
    { run: null, at: at(0) },
  );
  assert.equal(parseLessonBook(renderLessonBook(book)).lessons[0].text, 'Check the table first.');
});

test('the lesson book survives a Keep round trip and skips sections it cannot trust', () => {
  const book = mergeLessonBook(
    { lessons: [], suggestions: [] },
    {
      lessons: [{ kind: 'rejection', text: '  Ask before   changing\nmore than one row. ' }],
      suggestions: [{ area: 'tools', text: 'Add a tool that reads one row.' }],
    },
    { run: runs[0], at: at(0) },
  );
  assert.equal(book.lessons[0].text, 'Ask before changing more than one row.');
  const text = renderLessonBook(book);
  assert.deepEqual(parseLessonBook(text), book);
  assert.deepEqual(parseLessonBook(`${text}\n## broken\nno metadata here\n`), book);
  assert.deepEqual(parseLessonBook('anything else'), { lessons: [], suggestions: [] });
});

test('a repeated lesson refreshes the existing one instead of adding a duplicate', () => {
  assert.equal(sameLesson('Ask before changing rows.', 'ask before changing rows'), true);
  assert.equal(sameLesson('Ask before changing rows.', 'Never delete a table.'), false);
  let book = mergeLessonBook(
    { lessons: [], suggestions: [] },
    { lessons: [{ kind: 'rejection', text: 'Ask before changing rows.' }] },
    { run: runs[0], at: at(0) },
  );
  book = mergeLessonBook(
    book,
    { lessons: [{ kind: 'correction', text: 'Ask before changing rows' }] },
    { run: runs[1], at: at(1) },
  );
  assert.equal(book.lessons.length, 1);
  assert.equal(book.lessons[0].run, runs[1]);
  assert.equal(book.lessons[0].at, at(1));
});

test('lessons stay within their caps, the file size and the context budget, newest first', () => {
  const many = Array.from({ length: 30 }, (_, index) => ({
    id: `lesson-${index}`,
    kind: 'tool-failure',
    text: `Lesson number word${'x'.repeat(index)} ${'about checking inputs first '.repeat(6)}`.slice(0, 200),
    run: null,
    at: at(index),
  }));
  const fitted = fitLessonBook({ lessons: many, suggestions: [] });
  assert.ok(fitted.lessons.length <= agentLessonLimits.lessons);
  assert.equal(fitted.lessons[0].id, 'lesson-29');
  assert.ok(Buffer.byteLength(renderLessonBook(fitted)) <= agentLessonLimits.fileBytes);
  const context = lessonsForContext(fitted);
  assert.ok(context.length < fitted.lessons.length);
  assert.ok(context.reduce((sum, lesson) => sum + lesson.text.length, 0) <= agentLessonLimits.contextCharacters);
  assert.equal(context[0].text, fitted.lessons[0].text);
});

test('lessons that carry data from the run are dropped', () => {
  const evidence = [JSON.stringify({ reason: 'Never send anything to Priya Raman, she left Northwind.' })];
  const definition = 'Sales helper\nUpdate the Leads table for the Sales team.';
  for (const leaked of [
    'Do not email priya@example.com again.',
    'Check https://example.com before updating.',
    'Use record 3f2c1a9e-1d2b-4c3d-8e9f-0a1b2c3d4e5f for testing.',
    'Call +4420794600 first.',
    'Never write "Northwind" in a row.',
  ])
    assert.equal(lessonLeak(leaked, { evidence, definition }), 'identifier', leaked);
  assert.equal(lessonLeak('Never contact Priya about deals.', { evidence, definition }), 'private-name');
  const mention = ['Please send the summary to Priya at Globex instead.'];
  for (const leaked of [
    "Send summaries to Globex's finance lead first.",
    'Priya wants summaries sent before noon.',
    'Send summaries to Globex-wide channels.',
    'send summaries to globex first.',
  ])
    assert.equal(lessonLeak(leaked, { evidence: mention, definition }), 'private-name', leaked);
  assert.equal(lessonLeak('Please send summaries to the team instead.', { evidence: mention, definition }), null);
  assert.equal(lessonLeak('Ask before updating rows for Northwind.', { evidence, definition }), 'private-name');
  assert.equal(lessonLeak('Update the Leads table only after the Sales team agrees.', { evidence, definition }), null);
  assert.equal(lessonLeak('Ask before contacting someone who left their company.', { evidence, definition }), null);

  const output = parseLessonOutput(
    `Here you go: ${JSON.stringify({
      lessons: [
        { kind: 'rejection', text: 'Never contact Priya about deals.' },
        { kind: 'rejection', text: 'Ask before contacting someone who left their company.' },
        { kind: 'rejection', text: 'x'.repeat(201) },
      ],
      suggestions: [{ area: 'instructions', text: 'Say in the instructions to skip people who left.' }],
    })}`,
  );
  assert.deepEqual(safeLessonOutput(output, { evidence, definition }), {
    lessons: [{ kind: 'rejection', text: 'Ask before contacting someone who left their company.' }],
    suggestions: [{ area: 'instructions', text: 'Say in the instructions to skip people who left.' }],
  });
  assert.equal(parseLessonOutput('no json'), null);
  assert.deepEqual(parseLessonOutput('{"lessons":"wrong"}'), { lessons: [], suggestions: [] });
});

test('task runs see lessons as untrusted context, and only task runs carry them', () => {
  const input = {
    prompt: 'Synthetic prompt only.',
    definition: { name: 'Synthetic agent', instructions: 'Use only the allowed tools.', tools: [] },
    scope: [],
  };
  const lessons = [{ text: 'LEARNED_LESSON_CANARY' }];
  const reminder = JSON.parse(
    runtimeReminder({ kind: 'agent', input: { ...input, task: true, lessons } }).split('\n')[2],
  );
  assert.deepEqual(reminder.lessons.items, ['LEARNED_LESSON_CANARY']);
  assert.equal(reminder.lessons.grantsAuthority, false);
  assert.doesNotMatch(runtimeReminder({ kind: 'agent', input }), /LEARNED_LESSON_CANARY/);
  assert.equal(agentModelInputSchema.safeParse({ ...input, lessons }).success, false);
  assert.equal(agentModelInputSchema.safeParse({ ...input, task: true, lessons }).success, true);
});

test('only a rejection may carry a reason', () => {
  const base = { digest: 'a'.repeat(64) };
  assert.equal(
    taskDecisionSchema.safeParse({ ...base, decision: 'reject', reason: ' Too broad. ' }).data.reason,
    'Too broad.',
  );
  assert.equal(taskDecisionSchema.safeParse({ ...base, decision: 'approve', reason: 'Fine.' }).success, false);
  assert.equal(taskDecisionSchema.safeParse({ ...base, decision: 'reject', reason: 'x'.repeat(501) }).success, false);
});
