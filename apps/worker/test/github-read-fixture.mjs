import { randomUUID } from 'node:crypto';
import { githubFixture } from '../../../packages/github/test/fixture.mjs';
import { createGitHubReads } from '@tulipfarm/github/reads';
import { createConversations } from '@tulipfarm/conversations';
import { createConversationActivities } from '../src/conversation-activities.ts';
import { withGitHubSourceAuthorization } from '@tulipfarm/github/source-runtime';
import {
  completionReply,
  isCompletionRequest,
  anthropicChat,
  anthropicText,
  isTitleRequest,
} from './native-chat-fixture.mjs';

export async function githubChatFixture(options) {
  const f = await githubFixture(options);
  const env = {
    ANTHROPIC_API_KEY: 'synthetic-model-key',
    INTEGRATION_CREDENTIAL_KEY_ID: 'test',
    INTEGRATION_CREDENTIAL_KEY: f.keyring.keys.test,
    GITHUB_OAUTH_CLIENT_ID: f.configuration.clientId,
    GITHUB_OAUTH_CLIENT_SECRET: f.configuration.clientSecret,
    GITHUB_OAUTH_REDIRECT_URI: f.configuration.redirectUri,
  };
  const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  f.runtime = withGitHubSourceAuthorization(f.runtime);
  const originalFetch = globalThis.fetch;
  const providerCalls = [],
    modelRequests = [];
  let provider = async () => Response.json({ name: 'private-repository', description: 'Private account content' });
  let choose = () => ({ kind: 'answer', text: 'Ready. Select a GitHub account to begin.' });
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.github.com/') || String(url).startsWith('https://uploads.github.com/')) {
      providerCalls.push({ url: String(url), init });
      return provider(url, init);
    }
    if (String(url) !== 'https://api.anthropic.com/v1/messages') return originalFetch(url, init);
    const body = JSON.parse(init.body);
    if (isTitleRequest(body)) return Response.json(anthropicText('GitHub repository'));
    if (isCompletionRequest(body)) return Response.json(completionReply('anthropic'));
    modelRequests.push(body);
    return Response.json(anthropicChat(await choose(body)));
  };
  const store = createConversations(f.runtime);
  const reads = createGitHubReads({ runtime: f.runtime, accounts: f.service });
  async function chat() {
    const id = randomUUID();
    await store.create(f.one.id, f.member.userId, { chatId: id, commandId: randomUUID() });
    return id;
  }
  function decide(calls, answer = 'The selected GitHub account returned private-repository.') {
    let step = 0;
    choose = request => {
      if (step < calls.length)
        return { kind: 'tool', call: typeof calls[step] === 'function' ? calls[step++](request) : calls[step++] };
      return { kind: 'answer', text: typeof answer === 'function' ? answer(request) : answer };
    };
  }
  async function processReply(chatId, turnId) {
    return createConversationActivities(f.runtime).processConversationReply({
      workspaceId: f.one.id,
      conversationId: chatId,
      turnId,
      generation: 0,
    });
  }
  async function send(chatId, text = 'Read my repository.') {
    const sent = await store.send(f.one.id, f.member.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      model: 'claude-sonnet',
      parts: [{ kind: 'text', text }],
    });
    return { ...sent, status: await processReply(chatId, sent.turnId) };
  }
  return {
    ...f,
    store,
    reads,
    chat,
    decide,
    process: processReply,
    send,
    providerCalls,
    modelRequests,
    setProvider(value) {
      provider = value;
    },
    async close() {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await f.close();
    },
  };
}
