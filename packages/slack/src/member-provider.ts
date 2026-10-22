import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { z } from 'zod';
import { observeFetch } from '@tulipfarm/observability';
import { slackId, type SlackConfiguration } from './contracts.ts';
import { rotatingTokenFields, validRotation } from './credentials.ts';
import { readSlackJson, slackUserTokenProof } from './user-token.ts';

const identityClaims = z.object({
  sub: slackId,
  nonce: z.string().optional(),
  'https://slack.com/team_id': slackId,
  'https://slack.com/user_id': slackId,
});
const operationalToken = z
  .object({
    ok: z.literal(true),
    access_token: z
      .string()
      .regex(/^(?:xoxp-|xoxe\.xoxp-)[A-Za-z0-9-]+$/)
      .max(4096),
    team: z.object({ id: slackId }).optional(),
    ...rotatingTokenFields,
    is_enterprise_install: z.boolean().optional(),
  })
  .refine(validRotation);

export function memberProvider(config: SlackConfiguration, fetcher: typeof fetch = fetch) {
  const keys = createRemoteJWKSet(new URL('https://slack.com/openid/connect/keys'), {
    [customFetch]: fetcher,
    timeoutDuration: 10000,
  });
  async function exchange(
    method: 'openid.connect.token' | 'oauth.v2.user.access',
    code: string,
    redirectUri: string,
    verifier?: string,
  ) {
    return readSlackJson(
      await observeFetch(
        'slack',
        'oauth',
        fetcher,
      )(`https://slack.com/api/${method}`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
        },
        body: new URLSearchParams({
          code: z.string().min(1).max(4096).parse(code),
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          ...(verifier ? { code_verifier: verifier } : {}),
        }),
      }),
    );
  }
  async function claims(token: string) {
    const verified = await jwtVerify(token, keys, {
      issuer: 'https://slack.com',
      audience: config.clientId,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub'],
      maxTokenAge: '10 minutes',
    });
    const value = identityClaims.parse(verified.payload);
    if (value.sub !== value['https://slack.com/user_id']) throw new Error('slack-identity-mismatch');
    return value;
  }
  return {
    async identity(code: string, nonce: string) {
      if (!config.memberLinking) throw new Error('slack-linking-disabled');
      const response = z
        .object({ ok: z.literal(true), id_token: z.string().max(16384) })
        .parse(await exchange('openid.connect.token', code, config.memberLinking.identityRedirectUri));
      const value = await claims(response.id_token);
      if (value.nonce !== nonce) throw new Error('slack-nonce-mismatch');
      return { teamId: value['https://slack.com/team_id'], userId: value.sub };
    },
    async operational(code: string, verifier: string) {
      if (!config.memberLinking) throw new Error('slack-linking-disabled');
      const response = operationalToken.parse(
        await exchange('oauth.v2.user.access', code, config.memberLinking.operationalRedirectUri, verifier),
      );
      if (response.is_enterprise_install) throw new Error('slack-token-unsupported');
      const proof = await slackUserTokenProof(fetcher, response.access_token);
      if (response.team && response.team.id !== proof.teamId) throw new Error('slack-identity-mismatch');
      if (config.memberLinking.scopeApproval.userScopes.some(scope => !proof.scopes.includes(scope)))
        throw new Error('slack-scope-missing');
      return {
        ...proof,
        token: response.access_token,
        refresh_token: response.refresh_token,
        expires_in: response.expires_in,
      };
    },
  };
}
