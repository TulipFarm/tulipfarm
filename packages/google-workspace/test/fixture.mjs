import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { createGoogleWorkspaceService } from '../src/service.ts';
import { googleWorkspaceScopes } from '../src/contracts.ts';

export const config = {
  clientId: 'synthetic-workspace-client',
  clientSecret: 'synthetic-workspace-secret',
  redirectUri: 'http://localhost:3001/v1/google-workspace/callback',
};
export const keyring = { activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } };
export async function googleFixture(extend) {
  const f = await conversationFixture(extend);
  const member = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
  await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    member.membershipId,
    member.userId,
  ]);
  const admin = { kind: 'human', userId: f.workspace.userId, membershipId: f.workspace.membershipId };
  const principal = { userId: member.userId, sessionId: randomUUID() };
  let time = Date.now();
  let behavior = {};
  const calls = [];
  let challenge;
  const providerFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/revoke')) return new Response('', { status: behavior.revokeStatus ?? 200 });
    if (url.endsWith('/userinfo'))
      return Response.json({
        sub: behavior.account ?? 'google-account-1',
        email: 'member@example.com',
        email_verified: true,
      });
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(init.body.get('client_id'), config.clientId);
    const refresh = init.body.get('grant_type') === 'refresh_token';
    if (!refresh)
      assert.equal(createHash('sha256').update(init.body.get('code_verifier')).digest('base64url'), challenge);
    if (behavior.wait) await behavior.wait;
    if (refresh && behavior.refreshError)
      return Response.json({ error: behavior.refreshError }, { status: behavior.refreshStatus ?? 400 });
    if (behavior.throw) throw new Error('private provider network failure');
    if (behavior.timeout) throw new DOMException('private timeout', 'TimeoutError');
    if (behavior.malformed) return new Response('private malformed response');
    return Response.json({
      access_token: refresh ? 'refreshed-private-access' : 'initial-private-access',
      token_type: 'Bearer',
      expires_in: 3600,
      ...(!refresh && !behavior.noRefresh ? { refresh_token: 'private-refresh' } : {}),
      ...(behavior.rotatedRefresh && refresh ? { refresh_token: behavior.rotatedRefresh } : {}),
      ...(!refresh || behavior.scopes ? { scope: (behavior.scopes ?? googleWorkspaceScopes).join(' ') } : {}),
      ...(behavior.refreshLifetime ? { refresh_token_expires_in: behavior.refreshLifetime } : {}),
    });
  };
  const serviceOptions = { runtime: f.runtime, config, keyring, providerFetch, now: () => time };
  const service = createGoogleWorkspaceService(serviceOptions);
  async function begin(who = principal, app) {
    const result = await service.begin(f.workspace.id, who, app);
    const url = new URL(result.authorizationUrl);
    challenge = url.searchParams.get('code_challenge');
    return { url, state: url.searchParams.get('state') };
  }
  async function connect(who = principal, app) {
    const { state } = await begin(who, app);
    return service.complete(who, { state, code: 'private-code' });
  }
  const fence = status => ({
    workspaceId: f.workspace.id,
    actor: member,
    integrationId: status.integrationId,
    generation: status.generation,
    accountId: status.accountId,
    requiredScopes: ['https://www.googleapis.com/auth/gmail.send'],
  });
  return {
    ...f,
    member,
    admin,
    principal,
    service,
    serviceOptions,
    calls,
    begin,
    connect,
    fence,
    advance(ms) {
      time += ms;
    },
    behavior(value) {
      behavior = value;
    },
    challenge(value) {
      challenge = value;
    },
  };
}
