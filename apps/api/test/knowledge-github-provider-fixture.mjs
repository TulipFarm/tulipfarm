import { randomUUID } from 'node:crypto';
import { createGitHubAccounts } from '@tulipfarm/github';
import { createGitHubCorpusProvider } from '@tulipfarm/github/corpus';
import { fakeGitHub } from '../../../packages/github/test/corpus-fixture.mjs';

// Local GitHub REST and GraphQL with per-token repository access, plus a local OAuth exchange. No live GitHub account is involved.
export function githubProviderFixture() {
  const github = fakeGitHub();
  const configuration = {
    clientId: 'fixture-client',
    clientSecret: 'fixture-secret',
    redirectUri: 'http://localhost:5173/github/callback',
    scopes: ['repo', 'read:user'],
  };
  const keyring = { activeKeyId: 'fixture', keys: { fixture: 'ef'.repeat(32) } };
  const after = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  let pending = null;
  const oauth = async url =>
    String(url).endsWith('/access_token')
      ? Response.json({ access_token: pending.token, token_type: 'bearer', scope: 'repo,read:user' })
      : Response.json({ id: pending.id, login: pending.login });
  const accounts = (runtime, defaultKnowledge) =>
    createGitHubAccounts({
      runtime,
      configuration,
      keyring,
      fetcher: oauth,
      ...(defaultKnowledge ? { defaultKnowledge } : {}),
    });
  github.addRepo({
    id: 7001,
    fullName: 'acme/handbook',
    readers: [101, 202],
    description: 'Operating handbook',
    files: {
      'README.md': '# Handbook\n\nOrchid onboarding for every team.',
      'docs/supplier.md': 'Orchid supplier contract terms.',
      'src/app.ts': 'export {}',
    },
    issues: [
      {
        number: 1,
        title: 'Orchid shipment delayed',
        body: 'Shipment details for orchid order',
        comments: [{ body: 'Confirmed orchid date', user: 'reader' }],
      },
    ],
  });
  github.addRepo({
    id: 7002,
    fullName: 'acme/leadership',
    readers: [101],
    files: { 'README.md': 'Orchid budget is confidential' },
  });
  // Connects a personal GitHub account through the existing OAuth service with a local token exchange; `defaultKnowledge` records automatic intent.
  async function connect(f, who, githubId, login, existingId, defaultKnowledge) {
    const service = accounts(f.runtime, defaultKnowledge);
    const session = randomUUID();
    const started = existingId
      ? await service.reconnect(f.workspace.id, who.id, session, existingId)
      : await service.begin(f.workspace.id, who.id, session);
    const token = github.token(githubId, login);
    pending = { token, id: githubId, login };
    const result = await service.complete(
      { code: 'fixture-code', state: new URL(started.url).searchParams.get('state') },
      session,
      who.id,
    );
    return {
      accountId: result.account.id,
      token,
      disconnect: () => service.disconnect(f.workspace.id, who.id, result.account.id),
    };
  }
  return {
    github,
    after,
    connect,
    configuration,
    keyring,
    provider: runtime =>
      createGitHubCorpusProvider({
        accounts: createGitHubAccounts({ runtime, configuration, keyring }),
        fetcher: github.fetcher,
      }),
  };
}
