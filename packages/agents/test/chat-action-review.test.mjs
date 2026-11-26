import test from 'node:test';
import assert from 'node:assert/strict';
import { chatDraftConfirmation, explicitCreation } from '../src/chat-action-review.ts';

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

test('chatDraftConfirmation accepts explicit save and activate replies', () => {
  assert.equal(chatDraftConfirmation('create it', 'save'), true);
  assert.equal(chatDraftConfirmation('create it', 'activate'), true);
  assert.equal(chatDraftConfirmation('Yes, go ahead and create and activate it.', 'activate'), true);
  assert.equal(chatDraftConfirmation('Looks good, activate it.', 'activate'), true);
  assert.equal(chatDraftConfirmation('Save as draft', 'save'), true);
  assert.equal(chatDraftConfirmation('Save it as a draft without activating.', 'save'), true);
  assert.equal(chatDraftConfirmation('Apply it.', 'save'), true);
});

test('chatDraftConfirmation rejects questions, negations, draft-only activations, and unrelated messages', () => {
  assert.equal(chatDraftConfirmation('Should I create it?', 'save'), false);
  assert.equal(chatDraftConfirmation('Create it?', 'activate'), false);
  assert.equal(chatDraftConfirmation("Don't create it.", 'save'), false);
  assert.equal(chatDraftConfirmation('No, wait.', 'save'), false);
  assert.equal(chatDraftConfirmation('Save it.', 'activate'), false);
  assert.equal(chatDraftConfirmation('Yes, save this agent.', 'activate'), false);
  assert.equal(chatDraftConfirmation('Save it.', 'save'), true);
  assert.equal(chatDraftConfirmation('Yes, save this agent.', 'save'), true);
  assert.equal(chatDraftConfirmation('Save as draft', 'activate'), false);
  assert.equal(chatDraftConfirmation('Save it as a draft, keep it inactive.', 'activate'), false);
  assert.equal(chatDraftConfirmation("Create it, don't activate it yet.", 'activate'), false);
  assert.equal(chatDraftConfirmation("Create it, don't activate it yet.", 'save'), true);
  assert.equal(chatDraftConfirmation('Okay, now summarize my inbox.', 'save'), false);
  assert.equal(chatDraftConfirmation('Okay, now summarize my inbox.', 'activate'), false);
  assert.equal(chatDraftConfirmation('Sure, let us move on to the Q4 deck.', 'save'), false);
  assert.equal(chatDraftConfirmation('Perfect, thanks. Next check the logs.', 'activate'), false);
  assert.equal(chatDraftConfirmation('I already approved the budget yesterday.', 'save'), false);
  assert.equal(chatDraftConfirmation('Yes.', 'save'), true);
  assert.equal(chatDraftConfirmation('Yes, please.', 'activate'), true);
  assert.equal(chatDraftConfirmation('Sounds good!', 'activate'), true);
  assert.equal(chatDraftConfirmation('What repositories does it watch.', 'save'), false);
  assert.equal(chatDraftConfirmation('Let me review it first.', 'save'), false);
});

test('chatDraftConfirmation accepts dismissal and modification requests only for dismiss', () => {
  assert.equal(chatDraftConfirmation('Cancel that.', 'dismiss'), true);
  assert.equal(chatDraftConfirmation('Nevermind, drop it.', 'dismiss'), true);
  assert.equal(chatDraftConfirmation('Change the trigger to PRs only instead.', 'dismiss'), true);
  assert.equal(chatDraftConfirmation('Change the trigger to PRs only instead.', 'save'), false);
  assert.equal(chatDraftConfirmation('Yes, create it.', 'dismiss'), false);
});
