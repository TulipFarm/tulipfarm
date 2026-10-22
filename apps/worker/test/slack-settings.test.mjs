import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slackPromptSettings } from '../src/slack-composition.ts';

test('prompt delivery defaults off and requires valid server configuration', () => {
  assert.equal(slackPromptSettings({}), null);
  assert.equal(slackPromptSettings({ SLACK_LINK_PROMPTS_ENABLED: 'false' }), null);
  assert.throws(
    () => slackPromptSettings({ SLACK_LINK_PROMPTS_ENABLED: 'yes' }),
    /slack-prompts-configuration-invalid/,
  );
  assert.throws(
    () => slackPromptSettings({ SLACK_LINK_PROMPTS_ENABLED: 'true' }),
    /slack-prompts-configuration-invalid/,
  );
  assert.throws(
    () => slackPromptSettings({ SLACK_DIRECT_MESSAGES_ENABLED: 'true' }),
    /slack-prompts-configuration-invalid/,
  );
  assert.throws(
    () => slackPromptSettings({ SLACK_DIRECT_MESSAGES_ENABLED: 'yes' }),
    /slack-prompts-configuration-invalid/,
  );
});
