import { useEffect, useId, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { UnsavedChanges } from '@/features/tables/feedback';
import type { McpApi } from './api';
import {
  authSchema,
  type Capabilities,
  type CatalogEntry,
  type Integration,
  type SetupInput,
  type SetupResult,
} from './contracts';
import { McpCommandFeedback, useMcpCommand } from './state';
import { useMcpSetupRecovery } from './queries';

export function McpSetup({
  api,
  capabilities,
  entry,
  integration,
  close,
  saved,
}: {
  api: McpApi;
  capabilities: Capabilities;
  entry?: CatalogEntry | undefined;
  integration?: Integration;
  close: () => void;
  saved: (id: string) => void;
}) {
  const prefix = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const [name, setName] = useState(integration?.name ?? entry?.name ?? '');
  const [endpoint, setEndpoint] = useState(integration?.endpoint ?? entry?.endpoint ?? '');
  const [ownership, setOwnership] = useState<'personal' | 'shared'>(integration?.ownership ?? 'personal');
  const [auth, setAuth] = useState(
    integration?.authMethod ?? (entry?.authentication === 'unknown' ? '' : (entry?.authentication ?? '')),
  );
  const [token, setToken] = useState('');
  const [headers, setHeaders] = useState([{ name: '', value: '' }]);
  const [clientId, setClientId] = useState('');
  const [clientAuthMethod, setClientAuthMethod] = useState<'none' | 'client_secret_basic' | 'client_secret_post'>(
    'none',
  );
  const [clientSecret, setClientSecret] = useState('');
  const [result, setResult] = useState<SetupResult | null>(null);
  const [validation, setValidation] = useState<Record<string, string>>({});
  const command = useMcpCommand();
  const recover = useMcpSetupRecovery(api);
  const request = useRef<{ body: string; id: string } | null>(null);
  const errors = { ...validation, ...(command.state.kind === 'error' ? command.state.fields : {}) };
  const error = (field: string) =>
    errors[field] ? (
      <p id={`${prefix}-${field}-error`} role="alert" className="text-sm text-destructive">
        {errors[field]}
      </p>
    ) : null;
  const submit = () => {
    if (command.blocked) return;
    const fields: Record<string, string> = {};
    if (!name.trim()) fields.name = 'Enter an integration name.';
    try {
      const url = new URL(endpoint);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.hash ||
        (url.port && url.port !== '443') ||
        endpoint.includes('{')
      )
        fields.endpoint = 'Enter a resolved public HTTPS endpoint on port 443, without credentials or a fragment.';
    } catch {
      fields.endpoint = 'Enter a valid public HTTPS endpoint.';
    }
    const parsed = authSchema.safeParse(
      auth === 'none'
        ? { kind: auth }
        : auth === 'bearer'
          ? { kind: auth, token }
          : auth === 'headers'
            ? { kind: auth, headers }
            : {
                kind: auth,
                ...(clientId
                  ? {
                      client: {
                        clientId,
                        authMethod: clientAuthMethod,
                        ...(clientAuthMethod !== 'none' && clientSecret ? { clientSecret } : {}),
                      },
                    }
                  : {}),
              },
    );
    if (auth === 'oauth' && clientId && clientAuthMethod !== 'none' && !clientSecret)
      fields.auth = 'Enter the client secret for the selected registered authentication method.';
    if (!parsed.success) fields.auth = 'Choose an authentication method and fill in its required values.';
    setValidation(fields);
    if (Object.keys(fields).length || !parsed.success) return;
    const current = result?.integration ?? integration;
    const input = {
      name: name.trim(),
      endpoint,
      ownership,
      auth: parsed.data,
      ...(entry ? { catalogEntryId: entry.id } : {}),
      ...(current ? { expectedVersion: current.version } : {}),
    };
    const body = JSON.stringify(input);
    if (request.current?.body !== body) request.current = { body, id: crypto.randomUUID() };
    const payload: SetupInput = { ...input, requestId: request.current.id };
    void command.run(
      async () => {
        const next = await api.setup(payload, integration?.id ?? result?.integration.id);
        setResult(next);
        setToken('');
        setClientSecret('');
        setHeaders(previous => previous.map(header => ({ name: header.name, value: '' })));
        request.current = null;
      },
      () => {},
    );
  };
  const check = async () => {
    if (result) saved(result.integration.id);
    else {
      await recover();
      command.reset();
    }
  };
  return (
    <section aria-label="MCP integration setup" className="space-y-4 border-t pt-6">
      <UnsavedChanges
        dirty={!result && (!!name || !!endpoint || !!token || !!clientSecret || headers.some(header => !!header.value))}
      />
      <h3 tabIndex={-1} ref={heading} className="text-lg font-medium">
        {integration ? 'Reconnect MCP server' : 'Set up MCP server'}
      </h3>
      <p className="text-sm text-muted-foreground">
        Public HTTPS Streamable HTTP tools only. Resolve any endpoint template values first. Local packages and
        private-network servers are not supported.
      </p>
      {entry?.authentication === 'unknown' && (
        <Alert>
          <AlertDescription>
            This listing does not specify authentication. Check the provider's requirements; missing metadata does not
            mean no authentication.
          </AlertDescription>
        </Alert>
      )}
      {integration && (
        <Alert>
          <AlertDescription>
            Changing endpoint, account, or credential scope requires tool review and explicit reselection. Old approvals
            and standing exceptions are invalidated. Old-account history may become unavailable. Reconnecting never
            clears an unknown-outcome barrier.
          </AlertDescription>
        </Alert>
      )}
      <form
        className="space-y-4"
        onSubmit={event => {
          event.preventDefault();
          submit();
        }}
      >
        <fieldset
          disabled={command.blocked || result?.kind === 'saved' || result?.kind === 'oauth'}
          className="min-w-0 space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-name`}>Integration name</Label>
            <Input
              id={`${prefix}-name`}
              value={name}
              maxLength={120}
              onChange={event => setName(event.target.value)}
              aria-invalid={!!errors.name}
              aria-describedby={errors.name ? `${prefix}-name-error` : undefined}
            />
            {error('name')}
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-endpoint`}>MCP endpoint</Label>
            <Input
              id={`${prefix}-endpoint`}
              type="url"
              value={endpoint}
              onChange={event => setEndpoint(event.target.value)}
              aria-invalid={!!errors.endpoint}
              aria-describedby={errors.endpoint ? `${prefix}-endpoint-error` : undefined}
              placeholder="https://mcp.example.com/mcp"
            />
            {error('endpoint')}
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-ownership`}>Integration ownership</Label>
            <Select
              value={ownership}
              disabled={!!integration}
              onValueChange={value => {
                if (value === 'personal' || value === 'shared') setOwnership(value);
              }}
            >
              <SelectTrigger id={`${prefix}-ownership`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="personal">Personal, private to you</SelectItem>
                {capabilities.canManageShared && <SelectItem value="shared">Shared workspace integration</SelectItem>}
              </SelectContent>
            </Select>
          </div>
          {ownership === 'shared' && (
            <Alert>
              <AlertDescription>
                Shared users act with this external credential's data scope. TulipFarm cannot enforce provider-specific
                folder or record permissions. Use narrowly scoped credentials. Admin management does not grant use;
                grant people or teams explicitly after setup.
              </AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-auth`}>Authentication</Label>
            <Select
              value={auth}
              onValueChange={value => {
                setAuth(value ?? '');
                setToken('');
                setClientSecret('');
                setHeaders([{ name: '', value: '' }]);
              }}
            >
              <SelectTrigger
                id={`${prefix}-auth`}
                aria-invalid={!!errors.auth}
                aria-describedby={`${prefix}-auth-help`}
              >
                <SelectValue placeholder="Choose the provider's method" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No authentication</SelectItem>
                <SelectItem value="bearer">Bearer token</SelectItem>
                <SelectItem value="headers">Secret headers / API key</SelectItem>
                <SelectItem value="oauth">OAuth</SelectItem>
              </SelectContent>
            </Select>
            <p id={`${prefix}-auth-help`} className="text-sm text-muted-foreground">
              Secrets are encrypted on the server. They are never shown to shared users or saved in this browser.
            </p>
            {error('auth')}
          </div>
          {auth === 'bearer' && (
            <div className="space-y-2">
              <Label htmlFor={`${prefix}-token`}>Bearer token</Label>
              <Input
                id={`${prefix}-token`}
                type="password"
                autoComplete="off"
                value={token}
                onChange={event => setToken(event.target.value)}
              />
            </div>
          )}
          {auth === 'headers' && (
            <div className="space-y-3">
              {headers.map((header, index) => (
                <div key={index} className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor={`${prefix}-header-${index}`}>Header name {index + 1}</Label>
                    <Input
                      id={`${prefix}-header-${index}`}
                      value={header.name}
                      onChange={event =>
                        setHeaders(previous =>
                          previous.map((item, i) => (i === index ? { ...item, name: event.target.value } : item)),
                        )
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`${prefix}-secret-${index}`}>Header secret {index + 1}</Label>
                    <Input
                      id={`${prefix}-secret-${index}`}
                      type="password"
                      autoComplete="off"
                      value={header.value}
                      onChange={event =>
                        setHeaders(previous =>
                          previous.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)),
                        )
                      }
                    />
                  </div>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={headers.length >= 10}
                  onClick={() => setHeaders(previous => [...previous, { name: '', value: '' }])}
                >
                  Add secret header
                </Button>
                {headers.length > 1 && (
                  <Button type="button" variant="ghost" onClick={() => setHeaders(previous => previous.slice(0, -1))}>
                    Remove last header
                  </Button>
                )}
              </div>
            </div>
          )}
          {auth === 'oauth' && (
            <div className="space-y-3">
              <p>
                The server checks supported OAuth registration methods. If automatic registration is unavailable,
                register a client with the provider and enter its details here.
              </p>
              <div className="space-y-2">
                <Label htmlFor={`${prefix}-client`}>Registered client ID, if required</Label>
                <Input
                  id={`${prefix}-client`}
                  value={clientId}
                  onChange={event => setClientId(event.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${prefix}-client-secret`}>Client secret, if required</Label>
                <Input
                  id={`${prefix}-client-secret`}
                  type="password"
                  autoComplete="off"
                  value={clientSecret}
                  onChange={event => setClientSecret(event.target.value)}
                />
              </div>
            </div>
          )}
          {auth === 'oauth' && (
            <div className="space-y-2">
              <Label htmlFor={`${prefix}-client-auth`}>Registered client authentication method</Label>
              <Select
                value={clientAuthMethod}
                onValueChange={value => {
                  if (value === 'none' || value === 'client_secret_basic' || value === 'client_secret_post') {
                    setClientAuthMethod(value);
                    if (value === 'none') setClientSecret('');
                  }
                }}
              >
                <SelectTrigger id={`${prefix}-client-auth`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">none, public client</SelectItem>
                  <SelectItem value="client_secret_basic">client_secret_basic, HTTP Basic</SelectItem>
                  <SelectItem value="client_secret_post">client_secret_post, request body</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-sm text-muted-foreground">
                Choose the method registered for this client, even if the issuer supports both secret methods. TulipFarm
                does not guess from advertised methods.
              </p>
            </div>
          )}
          <Button type="submit" aria-busy={command.busy} disabled={!capabilities.integrationsEnabled}>
            {command.busy
              ? 'Verifying MCP setup…'
              : auth === 'oauth'
                ? 'Start OAuth setup'
                : 'Verify and discover tools'}
          </Button>
        </fieldset>
      </form>
      {result?.kind === 'registration-required' && (
        <section aria-label="OAuth registration required" className="space-y-3">
          <h4 className="font-medium">Register an OAuth client</h4>
          <p className="whitespace-pre-wrap break-words">{result.registration.instructions}</p>
          <dl className="space-y-2 break-all">
            <div>
              <dt>Exact callback URI</dt>
              <dd>{result.registration.redirectUri}</dd>
            </div>
            <div>
              <dt>Public client metadata URL</dt>
              <dd>{result.registration.clientMetadataUrl}</dd>
            </div>
          </dl>
          <p>Enter the registered client details above, then start OAuth setup again. This integration is not ready.</p>
        </section>
      )}
      {result?.kind === 'oauth' && (
        <section className="space-y-3">
          <h4 className="font-medium">Authorization pending</h4>
          <p>Complete authorization with the provider, then check this integration. No tools are enabled yet.</p>
          {new URL(result.authorizationUrl).protocol === 'https:' && (
            <Button
              nativeButton={false}
              render={<a href={result.authorizationUrl} target="_blank" rel="noopener noreferrer" />}
            >
              Continue to OAuth provider
            </Button>
          )}
          <Button variant="outline" onClick={() => saved(result.integration.id)}>
            Check authorization status
          </Button>
        </section>
      )}
      {result?.kind === 'saved' && (
        <section className="space-y-3">
          <p role="status">
            Setup saved. The server reports {result.integration.status}. Review discovered tools before selecting this
            integration for work.
          </p>
          <Button onClick={() => saved(result.integration.id)}>Review integration</Button>
        </section>
      )}
      <McpCommandFeedback command={command} check={check} />
      <p className="text-sm text-muted-foreground">
        Leaving clears unsaved secrets. Third-party service charges follow the connected account's terms.
      </p>
      <Button variant="ghost" onClick={close}>
        Close setup
      </Button>
    </section>
  );
}
