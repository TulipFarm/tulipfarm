import { useEffect, useId, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { useSecrets, useSecretsApi } from '@/features/secrets/queries';
import type { SecretSummary } from '@/features/secrets/contracts';
import { useFeatureScope } from '@/lib/query';
import { UnsavedChanges } from '@/features/tables/feedback';
import type { McpApi } from './api';
import { authSchema, type Capabilities, type Integration, type McpPackage, type SetupInput } from './contracts';
import { McpCommandFeedback, useMcpCommand } from './state';
import { useMcpSetupRecovery } from './queries';

export type HostedSetting = {
  name: string;
  description?: string | undefined;
  secret: boolean;
  required?: boolean | undefined;
};
type Row = {
  name: string;
  description?: string | undefined;
  secret: boolean;
  required?: boolean | undefined;
  value: string;
  secretId: string;
  reveal: boolean;
};

const envName = /^[A-Z_][A-Z0-9_]{0,127}$/;
const hostName = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/;
const normalizeName = (registry: McpPackage['registry'], name: string) =>
  registry === 'pypi' ? name.toLowerCase().replace(/[-_.]+/g, '-') : name;

/** The identity a hosted package's secret reveals are granted to: the digest of its registry and normalized name. */
export async function hostedServerIdentity(value: Pick<McpPackage, 'registry' | 'name'>) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${value.registry}:${normalizeName(value.registry, value.name)}`),
  );
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** A protected secret stays on the server, which adds it to the package's requests to the secret's own hosts. */
export const protectable = (secret: SecretSummary) =>
  (secret.placement.kind === 'bearer' || secret.placement.kind === 'basic' || secret.placement.kind === 'header') &&
  secret.destinations.some(destination => destination.kind === 'host');

/** Sets up an npm or PyPI MCP server package that TulipFarm runs in an isolated sandbox for this workspace. */
export function HostedSetup({
  api,
  capabilities,
  name: initialName,
  pkg,
  settings,
  egress: initialEgress,
  catalogEntryId,
  integration,
  personalOnly,
  close,
  saved,
}: {
  api: McpApi;
  capabilities: Capabilities;
  name: string;
  pkg: McpPackage | undefined;
  settings: readonly HostedSetting[];
  egress: readonly string[];
  catalogEntryId?: string | undefined;
  integration?: Integration | undefined;
  personalOnly: boolean;
  close: () => void;
  saved: (id: string) => void;
}) {
  const prefix = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const scope = useFeatureScope();
  const you = scope.kind === 'workspace' ? scope.membershipId : '';
  const secretsApi = useSecretsApi(api.workspaceId);
  const [name, setName] = useState(initialName);
  const [registry, setRegistry] = useState<McpPackage['registry']>(pkg?.registry ?? 'npm');
  const [packageName, setPackageName] = useState(pkg?.name ?? '');
  const [version, setVersion] = useState(pkg?.version ?? '');
  const [ownership, setOwnership] = useState<'personal' | 'shared'>(integration?.ownership ?? 'personal');
  const [egress, setEgress] = useState(initialEgress.join('\n'));
  const [rows, setRows] = useState<Row[]>(
    settings.map(setting => ({ ...setting, value: '', secretId: '', reveal: false })),
  );
  const savedSecrets = useSecrets(
    api.workspaceId,
    rows.some(row => row.secret),
  );
  const secrets =
    savedSecrets.state.kind === 'ready'
      ? savedSecrets.state.data.filter(
          secret => secret.status === 'active' && (protectable(secret) || secret.ownerMembershipId === you),
        )
      : [];
  const [done, setDone] = useState<string | null>(null);
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
  const update = (index: number, change: Partial<Row>) =>
    setRows(previous => previous.map((row, at) => (at === index ? { ...row, ...change } : row)));

  const submit = () => {
    if (command.blocked) return;
    const fields: Record<string, string> = {};
    if (!name.trim()) fields.name = 'Enter an integration name.';
    if (!packageName.trim()) fields.package = 'Enter the package name.';
    if (!version.trim()) fields.version = 'Enter an exact package version.';
    const hosts = egress
      .split(/[\s,]+/)
      .map(host => host.trim().toLowerCase())
      .filter(Boolean);
    if (hosts.length > 20 || hosts.some(host => !hostName.test(host)))
      fields.egress = 'Enter up to 20 host names, such as api.example.com, one per line.';
    const env: ({ name: string; value: string } | { name: string; secretId: string; reveal?: boolean })[] = [];
    rows.forEach((row, index) => {
      const key = row.name.trim();
      if (!key && !row.value && !row.secretId) return;
      if (!envName.test(key)) fields[`env-${index}`] = 'Use capital letters, digits and underscores.';
      else if (row.secret) {
        const secret = secrets.find(candidate => candidate.id === row.secretId);
        if (!secret) fields[`env-${index}`] = 'Choose a saved secret.';
        else if (!row.reveal && !protectable(secret))
          fields[`env-${index}`] =
            'This secret can only be shared with the package. Send it as a bearer, basic or header secret for a website to protect it.';
        else env.push({ name: key, secretId: row.secretId, ...(row.reveal ? { reveal: true } : {}) });
      } else if (row.required && !row.value) fields[`env-${index}`] = 'Enter a value.';
      else env.push({ name: key, value: row.value });
    });
    const auth = authSchema.safeParse({ kind: 'hosted', env });
    if (!auth.success) fields.auth = 'Check the settings.';
    setValidation(fields);
    if (Object.keys(fields).length || !auth.success) return;
    const current = integration;
    const input = {
      name: name.trim(),
      package: {
        registry,
        name: packageName.trim(),
        version: version.trim(),
        ...(pkg?.arguments ? { arguments: pkg.arguments } : {}),
      },
      egress: hosts,
      ownership,
      auth: auth.data,
      ...(catalogEntryId ? { catalogEntryId } : {}),
      ...(current ? { expectedVersion: current.version } : {}),
    };
    const body = JSON.stringify(input);
    if (request.current?.body !== body) request.current = { body, id: crypto.randomUUID() };
    const payload: SetupInput = { ...input, requestId: request.current.id };
    void command.run(
      async () => {
        const reveals = env.filter(item => 'secretId' in item && item.reveal);
        if (reveals.length) {
          const serverIdentity = await hostedServerIdentity(input.package);
          for (const item of reveals)
            if ('secretId' in item) await secretsApi.setReveal(item.secretId, { serverIdentity, revealed: true });
        }
        const next = await api.setup(payload, integration?.id);
        setDone(next.integration.id);
        setRows(previous => previous.map(row => ({ ...row, value: '' })));
        request.current = null;
      },
      () => {},
    );
  };
  const check = async () => {
    if (done) saved(done);
    else {
      await recover();
      command.reset();
    }
  };
  return (
    <section aria-label="Hosted MCP setup" className="space-y-4 border-t pt-6">
      <UnsavedChanges dirty={!done && rows.some(row => !!row.value)} />
      <h3 tabIndex={-1} ref={heading} className="text-lg font-medium">
        {integration ? 'Update hosted MCP package' : 'Run an MCP package'}
      </h3>
      <p className="text-sm text-muted-foreground">
        TulipFarm installs this exact package version in an isolated sandbox for this workspace. It can reach only the
        hosts listed here and the hosts of the secrets it uses.
      </p>
      {integration && (
        <Alert>
          <AlertDescription>
            Saved values are never shown. Enter every setting again. Changing the package, version, settings or hosts
            requires tool review and explicit reselection.
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
        <fieldset disabled={command.blocked || !!done} className="min-w-0 space-y-4">
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
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor={`${prefix}-registry`}>Registry</Label>
              <Select
                value={registry}
                items={{ npm: 'npm', pypi: 'PyPI' }}
                onValueChange={value => {
                  if (value === 'npm' || value === 'pypi') setRegistry(value);
                }}
              >
                <SelectTrigger id={`${prefix}-registry`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="npm">npm</SelectItem>
                  <SelectItem value="pypi">PyPI</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${prefix}-package`}>Package</Label>
              <Input
                id={`${prefix}-package`}
                value={packageName}
                onChange={event => setPackageName(event.target.value)}
                aria-invalid={!!errors.package}
                aria-describedby={errors.package ? `${prefix}-package-error` : undefined}
                placeholder={registry === 'npm' ? '@scope/server' : 'mcp-server'}
              />
              {error('package')}
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${prefix}-version`}>Version</Label>
              <Input
                id={`${prefix}-version`}
                value={version}
                onChange={event => setVersion(event.target.value)}
                aria-invalid={!!errors.version}
                aria-describedby={errors.version ? `${prefix}-version-error` : undefined}
                placeholder="1.2.3"
              />
              {error('version')}
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-ownership`}>Integration ownership</Label>
            <Select
              value={ownership}
              items={ownershipLabels}
              disabled={!!integration || personalOnly}
              onValueChange={value => {
                if (value === 'personal' || value === 'shared') setOwnership(value);
              }}
            >
              <SelectTrigger id={`${prefix}-ownership`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="personal">{ownershipLabels.personal}</SelectItem>
                {capabilities.canManageShared && <SelectItem value="shared">{ownershipLabels.shared}</SelectItem>}
              </SelectContent>
            </Select>
          </div>
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Settings</legend>
            <p className="text-sm text-muted-foreground">
              Protected secrets stay on TulipFarm's servers and are added to the package's requests to the secret's
              websites. Share a value with the package only when it must read the value itself.
            </p>
            {rows.map((row, index) => (
              <div key={index} className="space-y-2 rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="max-w-64">
                    <Input
                      aria-label="Setting name"
                      value={row.name}
                      onChange={event => update(index, { name: event.target.value.toUpperCase() })}
                      placeholder="API_KEY"
                    />
                  </div>
                  <Select
                    value={row.secret ? 'secret' : 'value'}
                    items={{ value: 'Plain value', secret: 'Saved secret' }}
                    onValueChange={value => update(index, { secret: value === 'secret', value: '', secretId: '' })}
                  >
                    <SelectTrigger aria-label={`How ${row.name || 'this setting'} is set`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="value">Plain value</SelectItem>
                      <SelectItem value="secret">Saved secret</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setRows(previous => previous.filter((_, at) => at !== index))}
                  >
                    Remove
                  </Button>
                </div>
                {row.description && <p className="text-sm text-muted-foreground">{row.description}</p>}
                {row.secret ? (
                  <>
                    <Select
                      value={row.secretId}
                      items={Object.fromEntries(secrets.map(secret => [secret.id, secret.name]))}
                      onValueChange={value => {
                        const secret = secrets.find(candidate => candidate.id === value);
                        update(index, {
                          secretId: value ?? '',
                          reveal: !!secret && !protectable(secret),
                          ...(row.name ? {} : { name: secret?.variableName ?? '' }),
                        });
                      }}
                    >
                      <SelectTrigger aria-label={`Saved secret for ${row.name || 'this setting'}`}>
                        <SelectValue
                          placeholder={savedSecrets.state.kind === 'ready' ? 'Choose a saved secret' : 'Loading…'}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {secrets.map(secret => (
                          <SelectItem key={secret.id} value={secret.id}>
                            {secret.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {(() => {
                      const secret = secrets.find(candidate => candidate.id === row.secretId);
                      if (!secret) return null;
                      const owner = secret.ownerMembershipId === you;
                      return (
                        <div className="flex items-start gap-2">
                          <Checkbox
                            id={`${prefix}-reveal-${index}`}
                            checked={row.reveal}
                            disabled={!owner || !protectable(secret)}
                            onCheckedChange={checked => update(index, { reveal: checked === true })}
                          />
                          <Label htmlFor={`${prefix}-reveal-${index}`}>
                            Let the package read the value
                            {!owner && ' (only the secret’s owner can allow this)'}
                          </Label>
                        </div>
                      );
                    })()}
                  </>
                ) : (
                  <Input
                    aria-label={`Value for ${row.name || 'this setting'}`}
                    value={row.value}
                    onChange={event => update(index, { value: event.target.value })}
                  />
                )}
                {error(`env-${index}`)}
              </div>
            ))}
            {rows.length < 20 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setRows(previous => [
                    ...previous,
                    { name: '', secret: false, value: '', secretId: '', reveal: false },
                  ])
                }
              >
                Add setting
              </Button>
            )}
            {error('auth')}
          </fieldset>
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-egress`}>Other hosts it may reach</Label>
            <Textarea
              id={`${prefix}-egress`}
              value={egress}
              onChange={event => setEgress(event.target.value)}
              aria-invalid={!!errors.egress}
              aria-describedby={errors.egress ? `${prefix}-egress-error` : undefined}
              placeholder="api.example.com"
            />
            {error('egress')}
          </div>
          <Button type="submit" aria-busy={command.busy} disabled={!capabilities.integrationsEnabled}>
            {command.busy ? 'Starting the package…' : 'Install and discover tools'}
          </Button>
        </fieldset>
      </form>
      {done && (
        <section className="space-y-3">
          <p role="status">
            Setup saved. TulipFarm is installing the package and discovering its tools, which can take a few minutes.
          </p>
          <Button onClick={() => saved(done)}>Review integration</Button>
        </section>
      )}
      <McpCommandFeedback command={command} check={check} />
      <Button variant="ghost" onClick={close}>
        Close setup
      </Button>
    </section>
  );
}

const ownershipLabels = { personal: 'Personal, private to you', shared: 'Shared workspace integration' };
