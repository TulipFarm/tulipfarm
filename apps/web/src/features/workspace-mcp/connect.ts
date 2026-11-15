import { useRef, useState } from 'react';
import type { McpApi } from './api';
import type { Integration, SetupResult } from './contracts';
import { sameEndpoint } from './setup';
import { markMcpConnected, startMcpSignIn } from './sign-in';
import { useMcpCommand } from './state';

export const mcpStatusLabel: Record<Integration['status'], string> = {
  setup: 'One more step',
  'oauth-pending': 'Finish sign-in',
  'registration-required': 'One more step',
  discovering: 'Connecting',
  'review-required': 'Tools changed',
  ready: 'Connected',
  disabled: 'Turned off',
  disconnected: 'Disconnected',
  error: 'Needs attention',
};

export type Ownership = 'personal' | 'shared';
type Registration = Extract<SetupResult, { kind: 'registration-required' }>;

/** The connection a person can already use or manage for this server, if any. */
export const connectionFor = (integrations: readonly Integration[], endpoint: string) =>
  integrations.find(
    integration => (integration.canManage || integration.canUse) && sameEndpoint(integration.endpoint, endpoint),
  );

/** A lone `Authorization: Bearer` header is saved as a bearer token; anything else as headers. */
const credentialOf = (headers: { name: string; value: string }[]) => {
  const bearer =
    headers.length === 1 && /^authorization$/i.test(headers[0]!.name) && /^Bearer (.+)$/.exec(headers[0]!.value);
  return bearer ? ({ kind: 'bearer', token: bearer[1]! } as const) : ({ kind: 'headers', headers } as const);
};

/**
 * One click to connect a remote server: it saves the connection and goes straight to the provider's sign-in.
 * Servers that don't register apps automatically come back asking for a client ID, kept in `registration`.
 */
export function useMcpConnect({
  api,
  name,
  endpoint,
  authentication,
  existing,
  refresh,
  opened,
}: {
  api: McpApi;
  name: string;
  endpoint: string;
  /** `headers` sends a person's API key with every request instead of signing in. */
  authentication: 'oauth' | 'none' | { headers: { name: string; value: string }[] };
  existing: Integration | undefined;
  refresh: () => Promise<void>;
  /** Called with the saved connection, before any sign-in redirect. */
  opened?: ((result: SetupResult) => void) | undefined;
}) {
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const command = useMcpCommand();
  const current = registration?.integration ?? existing;
  const request = useRef<{ key: string; id: string } | null>(null);
  const connect = (ownership: Ownership) => {
    // A retry after a lost response reuses its request id, so it can't create a second connection.
    const key = JSON.stringify([
      current?.id,
      current?.version,
      ownership,
      endpoint,
      authentication,
      clientId.trim(),
      !!clientSecret,
    ]);
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    const requestId = request.current.id;
    void command.run(
      async () => {
        const result = await api.setup(
          {
            requestId,
            name: current?.name ?? name,
            endpoint,
            ownership: current?.ownership ?? ownership,
            ...(!current && ownership === 'shared' ? { shareWithWorkspace: true } : {}),
            auth:
              authentication === 'none'
                ? { kind: 'none' }
                : typeof authentication === 'object'
                  ? credentialOf(authentication.headers)
                  : {
                      kind: 'oauth',
                      ...(clientId.trim()
                        ? {
                            client: {
                              clientId: clientId.trim(),
                              authMethod: clientSecret ? 'client_secret_basic' : 'none',
                              ...(clientSecret ? { clientSecret } : {}),
                            },
                          }
                        : {}),
                    },
            ...(current ? { expectedVersion: current.version } : {}),
          },
          current?.id,
        );
        setClientSecret('');
        request.current = null;
        opened?.(result);
        if (result.kind === 'oauth') return startMcpSignIn(result.authorizationUrl);
        setRegistration(result.kind === 'registration-required' ? result : null);
        if (result.kind === 'saved') markMcpConnected(result.integration.id);
        await refresh();
      },
      () => {},
    );
  };
  return { connect, command, current, registration, clientId, setClientId, clientSecret, setClientSecret };
}
