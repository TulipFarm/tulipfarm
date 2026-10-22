import { createHash } from 'node:crypto';
import { observeFetch } from '@tulipfarm/observability';
import { z } from 'zod';
import {
  AccountError,
  oauthConfigurationSchema,
  tableSchema,
  tokenResponseSchema,
  type AccountConfigurations,
  type AccountProtocol,
  type OAuthConfiguration,
} from './account-contracts.ts';

const protocols = {
  'atlassian-mcp': {
    authorize: 'https://mcp.atlassian.com/v1/authorize',
    token: 'https://mcp.atlassian.com/v1/token',
    pkce: true,
  },
  'atlassian-rest': {
    authorize: 'https://auth.atlassian.com/authorize',
    token: 'https://auth.atlassian.com/oauth/token',
    pkce: false,
  },
  trello: {
    authorize: 'https://auth.atlassian.com/authorize',
    token: 'https://auth.atlassian.com/oauth/token',
    pkce: true,
  },
};
export function accountConfigurations(env: NodeJS.ProcessEnv = process.env): AccountConfigurations {
  const configurations: AccountConfigurations = {};
  for (const [protocol, prefix] of [
    ['atlassian-mcp', 'ATLASSIAN_MCP'],
    ['atlassian-rest', 'ATLASSIAN_REST'],
    ['trello', 'TRELLO'],
  ] as const) {
    const parsed = oauthConfigurationSchema.safeParse({
      clientId: env[`${prefix}_CLIENT_ID`],
      clientSecret: env[`${prefix}_CLIENT_SECRET`],
      redirectUri: env[`${prefix}_REDIRECT_URI`],
      scopes: env[`${prefix}_SCOPES`]?.split(/\s+/).filter(Boolean),
    });
    if (
      parsed.success &&
      (protocol !== 'trello' || parsed.data.scopes.includes('read:member:trello')) &&
      (protocol !== 'atlassian-rest' || parsed.data.scopes.includes('read:me'))
    )
      configurations[protocol] = parsed.data;
  }
  return configurations;
}
export const hashAccountValue = (value: string) => createHash('sha256').update(value).digest('hex');
export const configurationHash = (protocol: AccountProtocol, config: OAuthConfiguration) =>
  hashAccountValue(JSON.stringify([protocol, config.clientId, config.clientSecret, config.redirectUri, config.scopes]));

function decodedMetadata(value: string) {
  for (let pass = 0; pass < 8; pass++) {
    const next = value
      .replace(/\\u([a-f0-9]{4})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\x([a-f0-9]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\([\\/"'])/g, '$1')
      .replace(/&#(x[a-f0-9]+|[0-9]+);?/gi, (_, code: string) => {
        const point = code[0]?.toLowerCase() === 'x' ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10);
        return point <= 0x10ffff ? String.fromCodePoint(point) : '';
      })
      .replace(
        /&(amp|quot|apos|lt|gt);/g,
        (_, name: string) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[name] ?? '',
      );
    const decoded = next.replace(/(?:%[a-f0-9]{2})+/gi, encoded => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        throw new AccountError('account-unavailable');
      }
    });
    if (decoded === value) return decoded;
    value = decoded;
  }
  throw new AccountError('account-unavailable');
}

export function rejectReflectedCredentials(value: unknown, credentials: string[]) {
  const secrets = credentials
    .filter(Boolean)
    .flatMap(secret => [
      decodedMetadata(secret),
      Buffer.from(secret).toString('base64'),
      Buffer.from(secret).toString('base64url'),
    ]);
  const inspect = (item: unknown): void => {
    if (typeof item === 'string') {
      const decoded = decodedMetadata(item);
      if (secrets.some(secret => decoded.includes(secret))) throw new AccountError('account-unavailable');
    } else if (Array.isArray(item)) item.forEach(inspect);
    else if (item && typeof item === 'object')
      for (const [key, child] of Object.entries(item)) {
        inspect(key);
        inspect(child);
      }
  };
  inspect(value);
}

export function accountAuthorizationUrl(
  protocol: AccountProtocol,
  config: OAuthConfiguration,
  state: string,
  verifier: string,
) {
  const url = new URL(protocols[protocol].authorize);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: config.scopes.join(' '),
    state,
  }).toString();
  if (protocols[protocol].pkce) {
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
  }
  if (protocol !== 'atlassian-mcp') url.searchParams.set('prompt', 'consent');
  if (protocol === 'atlassian-rest') url.searchParams.set('audience', 'api.atlassian.com');
  return url.href;
}

async function requestJson(url: string, init: RequestInit, fetcher: typeof fetch): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await observeFetch(
      'atlassian',
      'oauth',
      fetcher,
    )(url, { ...init, redirect: 'error', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 131072) throw new Error();
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AccountError('account-unavailable');
  } finally {
    clearTimeout(timer);
  }
}

export async function exchangeAccountToken(
  protocol: AccountProtocol,
  config: OAuthConfiguration,
  grant: { kind: 'code'; code: string; verifier: string } | { kind: 'refresh'; token: string },
  fetcher: typeof fetch = fetch,
) {
  const body: Record<string, string> = { client_id: config.clientId, client_secret: config.clientSecret };
  if (grant.kind === 'code') {
    Object.assign(body, { grant_type: 'authorization_code', code: grant.code, redirect_uri: config.redirectUri });
    if (protocols[protocol].pkce) body.code_verifier = grant.verifier;
  } else Object.assign(body, { grant_type: 'refresh_token', refresh_token: grant.token });
  try {
    const mcp = protocol === 'atlassian-mcp';
    return tokenResponseSchema.parse(
      await requestJson(
        protocols[protocol].token,
        {
          method: 'POST',
          headers: {
            'Content-Type': mcp ? 'application/x-www-form-urlencoded' : 'application/json',
            Accept: 'application/json',
          },
          body: mcp ? new URLSearchParams(body).toString() : JSON.stringify(body),
        },
        fetcher,
      ),
    );
  } catch {
    throw new AccountError('account-unavailable');
  }
}

export async function accountIdentity(
  protocol: AccountProtocol,
  token: string,
  grantId: string,
  fetcher: typeof fetch = fetch,
) {
  if (protocol === 'atlassian-mcp')
    return {
      identity: {
        id: grantId,
        label: 'Atlassian MCP grant',
        qualification: 'grant-bound-needs-qualification' as const,
      },
      resources: [],
    };
  const init = { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } };
  try {
    if (protocol === 'trello') {
      const member = z
        .object({ id: z.string().regex(/^[a-f0-9]{24}$/i), username: z.string().min(1).max(256) })
        .parse(await requestJson('https://api.trello.com/1/members/me?fields=id,username', init, fetcher));
      rejectReflectedCredentials(member, [token]);
      return { identity: { id: member.id, label: member.username, qualification: 'verified' as const }, resources: [] };
    }
    const me = z
      .object({ account_id: z.string().min(1).max(256), name: z.string().min(1).max(256) })
      .parse(await requestJson('https://api.atlassian.com/me', init, fetcher));
    const resources = z
      .array(tableSchema)
      .max(256)
      .parse(await requestJson('https://api.atlassian.com/oauth/token/accessible-resources', init, fetcher));
    rejectReflectedCredentials({ me, resources }, [token]);
    return { identity: { id: me.account_id, label: me.name, qualification: 'verified' as const }, resources };
  } catch {
    throw new AccountError('account-unavailable');
  }
}
