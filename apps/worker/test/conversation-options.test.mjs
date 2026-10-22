import assert from 'node:assert/strict';
import { test } from 'node:test';
import { meteredReply } from '../src/conversation-activities.ts';

const runtime = { transaction: async () => assert.fail('Reply construction must not access storage') };

function environment(t, values = {}) {
  const previous = process.env;
  process.env = { SLACK_OUTBOUND_ENABLED: 'false', KNOWLEDGE_EMBEDDINGS_ENABLED: 'false', ...values };
  t.after(() => {
    process.env = previous;
  });
}

test('reply construction preserves disabled environment defaults without accessing storage', t => {
  environment(t);
  assert.equal(typeof meteredReply(runtime), 'function');
  assert.equal(typeof meteredReply(runtime, {}), 'function');
  assert.equal(typeof meteredReply(runtime, undefined), 'function');
});

test('omitted and undefined Slack settings use the environment, but a supplied factory bypasses it', t => {
  environment(t, { SLACK_OUTBOUND_ENABLED: 'invalid' });
  assert.throws(() => meteredReply(runtime), /slack-outbound-configuration-invalid/);
  assert.throws(() => meteredReply(runtime, { slack: undefined }), /slack-outbound-configuration-invalid/);
  const slack = () => assert.fail('Slack must not be constructed until the reply runs');
  assert.equal(typeof meteredReply(runtime, { slack }), 'function');
});

test('omitted and undefined MCP settings use the environment, while null and a supplied factory bypass it', t => {
  environment(t, { WORKSPACE_MCP_DISPATCH_ENABLED: 'invalid' });
  assert.throws(() => meteredReply(runtime));
  assert.throws(() => meteredReply(runtime, { mcp: undefined }));
  assert.equal(typeof meteredReply(runtime, { mcp: null }), 'function');
  const mcp = () => assert.fail('MCP must not be constructed until the reply runs');
  assert.equal(typeof meteredReply(runtime, { mcp }), 'function');
});

test('omitted and undefined knowledge settings use the environment, but a supplied factory bypasses it', t => {
  environment(t, { KNOWLEDGE_EMBEDDINGS_ENABLED: 'invalid' });
  assert.throws(() => meteredReply(runtime), /Invalid server knowledge embeddings configuration/);
  assert.throws(
    () => meteredReply(runtime, { knowledge: undefined }),
    /Invalid server knowledge embeddings configuration/,
  );
  const knowledge = () => assert.fail('Knowledge must not be constructed until a tool runs');
  assert.equal(typeof meteredReply(runtime, { knowledge }), 'function');
});
