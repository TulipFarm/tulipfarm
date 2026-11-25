import test from 'node:test';
import assert from 'node:assert/strict';
import { explicitCreation } from '../src/chat-action-review.ts';

test('explicitCreation accepts direct creation requests with normal descriptions and punctuation', () => {
  assert.equal(explicitCreation('Create a table named Orders.', 'table'), true);
  assert.equal(
    explicitCreation(
      'create a tech support agent that answers any questions related to tech and github repositories in the slack channel tech',
      'agent',
    ),
    true,
  );
  assert.equal(
    explicitCreation(
      'Create a tech support agent for #tech that uses Claude Opus 5.5 from my GitHub Copilot plan.',
      'agent',
    ),
    true,
  );
  assert.equal(explicitCreation('Create a PR review agent that reads issues and sends Slack replies.', 'agent'), true);
  assert.equal(explicitCreation('Create an expense approval workflow when a row is added.', 'workflow'), true);
  assert.equal(
    explicitCreation('Create a content plan table.\nColumns: Title, Owner, Status (Draft/Live).', 'table'),
    true,
  );
  assert.equal(explicitCreation('Set up a Leads & Contacts table with Name and Email.', 'table'), true);
  assert.equal(explicitCreation('Build an agent in Slack using GPT-5.6.', 'agent'), true);
  assert.equal(explicitCreation('Add a triage skill for reviewing support tickets.', 'skill'), true);
  assert.equal(explicitCreation('Create an agent that asks for approval before deleting rows.', 'agent'), true);
});

test('explicitCreation keeps non-saving, draft, question, and wrong-kind requests on review cards', () => {
  const preView = ['pre', 'view'].join('');
  assert.equal(explicitCreation('Show me what a table named Orders would look like.', 'table'), false);
  assert.equal(explicitCreation('Prepare an agent for review.', 'agent'), false);
  assert.equal(explicitCreation('Draft a Leads table.', 'table'), false);
  assert.equal(explicitCreation('Create a draft agent for support.', 'agent'), false);
  assert.equal(explicitCreation(`Create a ${preView} table for Orders.`, 'table'), false);
  assert.equal(explicitCreation('Create an example workflow for onboarding.', 'workflow'), false);
  assert.equal(explicitCreation('Create a Leads table for my review.', 'table'), false);
  assert.equal(explicitCreation('Create a Leads table for review.', 'table'), false);
  assert.equal(explicitCreation('Create a Leads table, let me review it first.', 'table'), false);
  assert.equal(explicitCreation("Create a Leads table, don't save it yet.", 'table'), false);
  assert.equal(explicitCreation('Create a Leads table without saving.', 'table'), false);
  assert.equal(explicitCreation(`Create a Leads table (${preView} only).`, 'table'), false);
  assert.equal(explicitCreation('Create a dry-run workflow.', 'workflow'), false);
  assert.equal(explicitCreation('Can you create a Leads table?', 'table'), false);
  assert.equal(explicitCreation('Create a Leads table?', 'table'), false);
  assert.equal(explicitCreation('Create a table named Orders.', 'agent'), false);
});
