import { generateKeyPair, exportJWK, SignJWT } from 'jose';

export async function memberProviderFixture(config) {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'local-test-key', alg: 'RS256', use: 'sig' };
  const requests = [];
  const issued = new Map();
  let next = {};
  return {
    requests,
    set(value) {
      next = value;
    },
    async fetcher(url, init) {
      if (String(url) === 'https://slack.com/openid/connect/keys') return Response.json({ keys: [jwk] });
      const user = next.user ?? 'UPERSON',
        team = next.team ?? 'TONE';
      if (String(url) === 'https://slack.com/api/auth.test') {
        const token = new Headers(init.headers).get('authorization')?.replace(/^Bearer /, '');
        const owner = issued.get(token);
        if (!owner) return Response.json({ ok: false, error: 'invalid_auth' });
        return Response.json(
          {
            ok: true,
            url: 'https://example.slack.com/',
            team: 'Example',
            user: 'person',
            team_id: owner.team,
            user_id: owner.user,
          },
          { headers: { 'x-oauth-scopes': owner.scopes } },
        );
      }
      const form = new URLSearchParams(init.body);
      requests.push({ url: String(url), form });
      await next.during?.();
      if (next.deny) return Response.json({ ok: false, error: 'access_denied' });
      const jwt = await new SignJWT({
        nonce: next.nonce,
        'https://slack.com/team_id': team,
        'https://slack.com/user_id': user,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'local-test-key' })
        .setSubject(user)
        .setIssuer(next.issuer ?? 'https://slack.com')
        .setAudience(next.audience ?? config.clientId)
        .setIssuedAt()
        .setExpirationTime(next.expired ? '0 seconds' : '5 minutes')
        .sign(privateKey);
      if (String(url).endsWith('/openid.connect.token'))
        return Response.json({ ok: true, id_token: next.badSignature ? jwt.slice(0, -10) + 'AAAAAAAAAA' : jwt });
      const token = next.token ?? 'xoxp-synthetic-user-token';
      issued.set(token, { user, team, scopes: next.scopes ?? config.memberLinking.scopeApproval.userScopes.join(',') });
      // Production Slack returned no id_token or authed_user and a non-"user" token_type on 4 October 2026.
      return Response.json({
        ok: true,
        access_token: token,
        token_type: 'bearer',
        team: { id: team },
        ...(next.rotating ? { expires_in: 3600 } : {}),
      });
    },
  };
}
