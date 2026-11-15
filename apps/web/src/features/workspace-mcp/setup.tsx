import { useId, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { ChoiceGroup } from '@tulipfarm/sprout/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { useSecrets } from '@/features/secrets/queries';
import { placementPhrase } from '@/features/secrets/contracts';
import { UnsavedChanges } from '@/features/tables/feedback';
import type { McpApi } from './api';
import {
  authSchema,
  type Capabilities,
  type CatalogEntry,
  type Integration,
  type McpPackage,
  type SetupInput,
  type SetupResult,
} from './contracts';
import { McpCommandFeedback, useMcpCommand } from './state';
import { useMcpSetupRecovery } from './queries';
import { HostedSetup, type HostedSetting } from './hosted-setup';
import { startMcpSignIn } from './sign-in';
import { Disclosure } from '@/components/disclosure';
import { SetupDialog } from './setup-dialog';

type SetupProps = {
  api: McpApi;
  capabilities: Capabilities;
  entry?: CatalogEntry | undefined;
  /** A chat's suggestion. It sets up a personal integration only. */
  proposal?: { name: string; endpoint: string; authentication: 'oauth' | 'secrets' | 'none' } | undefined;
  /** A chat's suggestion to run a package. It sets up a personal integration only. */
  packageProposal?: { name: string; package: McpPackage; settings: HostedSetting[]; egress: string[] } | undefined;
  integration?: Integration | undefined;
  /** Who the new connection is for; sharing with everyone includes people who join later. */
  ownership?: 'personal' | 'shared' | undefined;
  /** Opens the package form without a suggestion or catalog listing. */
  hosted?: boolean | undefined;
  /** Switches a server added by hand to the package form. */
  runPackage?: (() => void) | undefined;
  close: () => void;
  saved: (id: string) => void;
  /** Receives the provider sign-in link when OAuth setup starts. */
  authorizing?: ((id: string, authorizationUrl: string) => void) | undefined;
};

export function McpSetup(props: SetupProps) {
  const { entry, packageProposal, integration } = props;
  if (props.hosted || integration?.kind === 'hosted' || entry?.package || packageProposal)
    return (
      <HostedSetup
        api={props.api}
        capabilities={props.capabilities}
        name={integration?.name ?? entry?.name ?? packageProposal?.name ?? ''}
        pkg={integration?.package ?? entry?.package ?? packageProposal?.package}
        settings={entry?.package?.environment ?? packageProposal?.settings ?? []}
        egress={integration?.egress ?? packageProposal?.egress ?? []}
        catalogEntryId={entry?.id}
        integration={integration}
        personalOnly={!!packageProposal}
        close={props.close}
        saved={props.saved}
      />
    );
  return (
    <RemoteSetup
      api={props.api}
      capabilities={props.capabilities}
      entry={entry}
      proposal={props.proposal}
      ownership={props.ownership}
      integration={integration}
      close={props.close}
      saved={props.saved}
      authorizing={props.authorizing}
      runPackage={props.runPackage}
    />
  );
}

function RemoteSetup({
  api,
  capabilities,
  entry,
  proposal,
  integration,
  close,
  saved,
  authorizing,
  runPackage,
  ...props
}: SetupProps) {
  const prefix = useId();
  const [name, setName] = useState(integration?.name ?? entry?.name ?? proposal?.name ?? '');
  const [named, setNamed] = useState(!!name);
  const [endpoint, setEndpoint] = useState(integration?.endpoint ?? entry?.endpoint ?? proposal?.endpoint ?? '');
  const [ownership, setOwnership] = useState<'personal' | 'shared'>(
    integration?.ownership ?? props.ownership ?? 'personal',
  );
  const [auth, setAuth] = useState<string>(
    integration?.authMethod === 'secret-bearer' || integration?.authMethod === 'secret-headers'
      ? 'secrets'
      : (integration?.authMethod ??
          proposal?.authentication ??
          (entry && entry.authentication !== 'unknown' ? entry.authentication : 'oauth')),
  );
  const method = auth === 'oauth' || auth === 'none' ? auth : 'key';
  const [secretIds, setSecretIds] = useState<string[]>([]);
  const savedSecrets = useSecrets(api.workspaceId, auth === 'secrets');
  const usableSecrets =
    savedSecrets.state.kind === 'ready'
      ? savedSecrets.state.data.filter(
          secret =>
            secret.status === 'active' &&
            secret.placement.kind !== 'query' &&
            secret.placement.kind !== 'body' &&
            secret.destinations.some(
              destination => destination.kind === 'endpoint' && sameEndpoint(destination.value, endpoint),
            ),
        )
      : [];
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
  const formId = `${prefix}-form`;
  const locked = command.blocked || result?.kind === 'saved' || result?.kind === 'oauth';
  const clearSecrets = () => {
    setToken('');
    setClientSecret('');
    setHeaders([{ name: '', value: '' }]);
  };
  const submit = () => {
    if (command.blocked) return;
    const fields: Record<string, string> = {};
    if (!name.trim()) fields.name = 'Enter a name.';
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
        fields.endpoint = endpoint.includes('{')
          ? 'Replace the parts in {curly braces} with your own details.'
          : 'Use a link that starts with https:// and has no password or port number.';
    } catch {
      fields.endpoint = 'That doesn’t look like a link. It should start with https://.';
    }
    const parsed = authSchema.safeParse(
      auth === 'none'
        ? { kind: auth }
        : auth === 'bearer'
          ? { kind: auth, token: token.trim().replace(/^Bearer\s+/i, '') }
          : auth === 'headers'
            ? { kind: auth, headers }
            : auth === 'secrets'
              ? { kind: auth, secretIds: secretIds.filter(id => usableSecrets.some(secret => secret.id === id)) }
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
      fields.auth = 'Enter the client secret, or choose No secret.';
    if (!parsed.success)
      fields.auth =
        auth === 'bearer'
          ? 'Paste the API key.'
          : auth === 'headers'
            ? 'Fill in each header name and value.'
            : auth === 'secrets'
              ? 'Choose a saved secret.'
              : 'Choose how it signs in.';
    setValidation(fields);
    if (Object.keys(fields).length || !parsed.success) return;
    const current = result?.integration ?? integration;
    const input = {
      name: name.trim(),
      endpoint,
      ownership,
      ...(!current && ownership === 'shared' ? { shareWithWorkspace: true } : {}),
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
        if (next.kind === 'oauth') {
          authorizing?.(next.integration.id, next.authorizationUrl);
          startMcpSignIn(next.authorizationUrl);
        }
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
  const fieldError = (field: string) =>
    errors[field] ? (
      <p id={`${prefix}-${field}-error`} role="alert" className="text-sm text-destructive">
        {errors[field]}
      </p>
    ) : null;
  const title = integration
    ? `Reconnect ${integration.name}`
    : entry || proposal
      ? `Connect ${name}`
      : 'Add a custom app';
  const done = result?.kind === 'saved' || result?.kind === 'oauth';
  return (
    <SetupDialog
      title={title}
      description={integration ? 'Update its link or sign-in.' : 'Connect any app that has an MCP server link.'}
      close={close}
      footer={
        <>
          {method === 'key' && !done && <p>Keys are encrypted and never shown to other members.</p>}
          <Button variant="outline" onClick={close}>
            {done ? 'Close' : 'Cancel'}
          </Button>
          {result?.kind === 'saved' ? (
            <Button onClick={() => saved(result.integration.id)}>Open {result.integration.name}</Button>
          ) : result?.kind === 'oauth' ? (
            <Button onClick={() => saved(result.integration.id)}>I’ve signed in</Button>
          ) : (
            <Button
              type="submit"
              form={formId}
              aria-busy={command.busy}
              disabled={!capabilities.integrationsEnabled || command.blocked}
            >
              {command.busy ? 'Connecting…' : method === 'oauth' ? 'Connect and sign in' : 'Connect'}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-6">
        <UnsavedChanges
          dirty={!result && (!!endpoint || !!token || !!clientSecret || headers.some(header => !!header.value))}
        />
        {integration && (
          <Alert>
            <AlertDescription>
              If you change the link or account, you’ll need to review and turn on its tools again. Past approvals will
              stop working, and history from the old account may not be available.
            </AlertDescription>
          </Alert>
        )}
        <form
          id={formId}
          onSubmit={event => {
            event.preventDefault();
            submit();
          }}
        >
          <fieldset disabled={locked} className="min-w-0 space-y-6">
            <div className="space-y-2">
              <Label htmlFor={`${prefix}-endpoint`}>Server link</Label>
              <Input
                id={`${prefix}-endpoint`}
                type="url"
                inputMode="url"
                autoComplete="off"
                autoFocus={!endpoint}
                value={endpoint}
                onChange={event => {
                  setEndpoint(event.target.value);
                  if (!named) setName(nameFromEndpoint(event.target.value));
                }}
                aria-invalid={!!errors.endpoint}
                aria-describedby={errors.endpoint ? `${prefix}-endpoint-error` : `${prefix}-endpoint-help`}
                placeholder="https://mcp.example.com/mcp"
              />
              {fieldError('endpoint') ?? (
                <p id={`${prefix}-endpoint-help`} className="text-sm text-muted-foreground">
                  Find it in the app’s docs, usually under “MCP” or “AI assistants”.
                </p>
              )}
            </div>
            {
              <div className="space-y-2">
                <Label htmlFor={`${prefix}-name`}>Name</Label>
                <Input
                  id={`${prefix}-name`}
                  value={name}
                  maxLength={120}
                  onChange={event => {
                    setNamed(true);
                    setName(event.target.value);
                  }}
                  aria-invalid={!!errors.name}
                  aria-describedby={errors.name ? `${prefix}-name-error` : undefined}
                />
                {fieldError('name')}
              </div>
            }
            {capabilities.canManageShared && (
              <ChoiceGroup
                type="radio"
                required
                legend="Who can use it"
                value={ownership}
                disabled={!!integration || !!proposal}
                onValueChange={setOwnership}
                options={[
                  { value: 'personal', label: 'Just me', description: 'Uses your own account.' },
                  {
                    value: 'shared',
                    label: 'Everyone in the workspace',
                    description: 'Members, including people who join later, use one shared account and its access.',
                  },
                ]}
              />
            )}
            <ChoiceGroup
              type="radio"
              required
              legend="How it signs in"
              value={method}
              error={method !== 'key' ? errors.auth : undefined}
              helper={
                entry?.authentication === 'unknown'
                  ? 'This listing doesn’t say which one. Most apps use Sign in with the app.'
                  : undefined
              }
              onValueChange={value => {
                setAuth(value === 'key' ? 'bearer' : value);
                clearSecrets();
              }}
              options={[
                {
                  value: 'oauth',
                  label: 'Sign in with the app',
                  description: 'Most apps use this. You’ll approve access on the app’s site, then come back here.',
                },
                { value: 'key', label: 'API key', description: 'Paste a key or token from the app’s settings.' },
                { value: 'none', label: 'No sign-in', description: 'For public servers that don’t need an account.' },
              ]}
            />
            {auth === 'bearer' && (
              <div className="space-y-2">
                <Label htmlFor={`${prefix}-token`}>API key</Label>
                <Input
                  id={`${prefix}-token`}
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={event => setToken(event.target.value)}
                  aria-invalid={!!errors.auth}
                  aria-describedby={errors.auth ? `${prefix}-auth-error` : undefined}
                />
                {fieldError('auth')}
              </div>
            )}
            {auth === 'headers' && (
              <div className="space-y-3">
                {headers.map((header, index) => (
                  <div key={index} className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor={`${prefix}-header-${index}`}>Header name</Label>
                      <Input
                        id={`${prefix}-header-${index}`}
                        value={header.name}
                        placeholder="X-API-Key"
                        onChange={event =>
                          setHeaders(previous =>
                            previous.map((item, i) => (i === index ? { ...item, name: event.target.value } : item)),
                          )
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`${prefix}-secret-${index}`}>Value</Label>
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
                    size="sm"
                    disabled={headers.length >= 10}
                    onClick={() => setHeaders(previous => [...previous, { name: '', value: '' }])}
                  >
                    Add header
                  </Button>
                  {headers.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setHeaders(previous => previous.slice(0, -1))}
                    >
                      Remove last header
                    </Button>
                  )}
                </div>
                {fieldError('auth')}
              </div>
            )}
            {auth === 'secrets' && (
              <fieldset className="space-y-2" aria-describedby={`${prefix}-secrets-help`}>
                <legend className="text-sm font-medium">Saved secrets to send</legend>
                {savedSecrets.state.kind === 'ready' ? (
                  usableSecrets.length ? (
                    usableSecrets.map(secret => (
                      <div key={secret.id} className="flex items-center gap-2">
                        <Checkbox
                          id={`${prefix}-saved-${secret.id}`}
                          checked={secretIds.includes(secret.id)}
                          onCheckedChange={checked =>
                            setSecretIds(ids => (checked ? [...ids, secret.id] : ids.filter(id => id !== secret.id)))
                          }
                        />
                        <Label htmlFor={`${prefix}-saved-${secret.id}`}>
                          {secret.name}{' '}
                          <span className="text-muted-foreground">sent {placementPhrase(secret.placement)}</span>
                        </Label>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm">No saved secrets are set up for this link yet.</p>
                  )
                ) : (
                  <p className="text-sm text-muted-foreground">Loading saved secrets…</p>
                )}
                <p id={`${prefix}-secrets-help`} className="text-sm text-muted-foreground">
                  Only secrets set up for this exact link appear here. Add one in Settings › Secrets.
                  {ownership === 'shared' && ' Everyone who uses this app must also be able to use each secret.'}
                </p>
                {fieldError('auth')}
              </fieldset>
            )}
            <Disclosure
              key={result?.kind === 'registration-required' ? 'needed' : 'optional'}
              title="Advanced"
              defaultOpen={
                result?.kind === 'registration-required' || !!clientId || auth === 'headers' || auth === 'secrets'
              }
            >
              {method === 'key' && (
                <div className="space-y-2">
                  <Label htmlFor={`${prefix}-send`}>Send the key as</Label>
                  <Select
                    value={auth}
                    items={keyLabels}
                    onValueChange={value => {
                      if (value) setAuth(value);
                      clearSecrets();
                    }}
                  >
                    <SelectTrigger id={`${prefix}-send`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(keyLabels).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {method === 'oauth' && (
                <>
                  <p className="text-sm text-muted-foreground">
                    Leave these blank unless the app asks you to register your own OAuth app.
                  </p>
                  <div className="space-y-2">
                    <Label htmlFor={`${prefix}-client`}>Client ID</Label>
                    <Input
                      id={`${prefix}-client`}
                      value={clientId}
                      onChange={event => setClientId(event.target.value)}
                      autoComplete="off"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`${prefix}-client-auth`}>Client authentication</Label>
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
                        <SelectItem value="none">No secret (public client)</SelectItem>
                        <SelectItem value="client_secret_basic">Client secret, HTTP Basic</SelectItem>
                        <SelectItem value="client_secret_post">Client secret, request body</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-sm text-muted-foreground">
                      Use the same method you chose when you registered the app.
                    </p>
                  </div>
                  {clientAuthMethod !== 'none' && (
                    <div className="space-y-2">
                      <Label htmlFor={`${prefix}-client-secret`}>Client secret</Label>
                      <Input
                        id={`${prefix}-client-secret`}
                        type="password"
                        autoComplete="off"
                        value={clientSecret}
                        onChange={event => setClientSecret(event.target.value)}
                      />
                    </div>
                  )}
                  {fieldError('auth')}
                </>
              )}
              <p className="text-sm text-muted-foreground">
                Works with public HTTPS servers that use Streamable HTTP or HTTP+SSE. The app may charge the connected
                account under its own terms.
              </p>
            </Disclosure>
            {runPackage && !integration && !entry && !proposal && (
              <Button type="button" variant="link" size="sm" onClick={runPackage}>
                Have an npm or PyPI package instead? Run it here
              </Button>
            )}
          </fieldset>
        </form>
        {result?.kind === 'registration-required' && (
          <Alert>
            <AlertDescription>
              <div className="space-y-2">
                <p className="font-medium">Register an OAuth app with {name || 'this app'} first</p>
                <p className="whitespace-pre-wrap break-words">{result.registration.instructions}</p>
                <dl className="space-y-1 break-all">
                  <div>
                    <dt className="font-medium">Callback URL</dt>
                    <dd>{result.registration.redirectUri}</dd>
                  </div>
                  <div>
                    <dt className="font-medium">Client metadata URL</dt>
                    <dd>{result.registration.clientMetadataUrl}</dd>
                  </div>
                </dl>
                <p>Then enter the client ID under Advanced and select Connect and sign in again.</p>
              </div>
            </AlertDescription>
          </Alert>
        )}
        {result?.kind === 'oauth' && (
          <div role="status" className="space-y-2 rounded-lg border p-4">
            <p className="font-medium">Taking you to sign in…</p>
            <p className="text-sm text-muted-foreground">
              Approve access on the app’s site. You’ll come back here when you’re done.
            </p>
            {new URL(result.authorizationUrl).protocol === 'https:' && (
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<a href={result.authorizationUrl} target="_blank" rel="noopener noreferrer" />}
              >
                Open sign-in again
              </Button>
            )}
          </div>
        )}
        {result?.kind === 'saved' && (
          <p role="status" className="rounded-lg border p-4 text-sm">
            {result.integration.name} is connected. Review its tools before your agents use them.
          </p>
        )}
        <McpCommandFeedback command={command} check={check} />
      </div>
    </SetupDialog>
  );
}

const keyLabels = {
  bearer: 'Standard (Authorization: Bearer)',
  headers: 'Custom headers',
  secrets: 'Saved secret',
};

/** "https://mcp.acme-tools.com/mcp" → "Acme-tools". */
export function nameFromEndpoint(endpoint: string) {
  try {
    const parts = new URL(endpoint.trim()).hostname
      .split('.')
      .filter(part => !['mcp', 'api', 'www', 'server'].includes(part));
    const core = parts.length > 1 ? parts[parts.length - 2]! : (parts[0] ?? '');
    return core ? core[0]!.toUpperCase() + core.slice(1) : '';
  } catch {
    return '';
  }
}

export function sameEndpoint(a: string, b: string) {
  try {
    const left = new URL(a);
    const right = new URL(b.trim());
    return left.origin === right.origin && left.pathname.replace(/\/$/, '') === right.pathname.replace(/\/$/, '');
  } catch {
    return false;
  }
}
