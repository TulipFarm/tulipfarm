import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { z } from 'zod';
import {
  providerIntegrationSchema,
  providerIntegrationInputSchema,
  providerSourceSchema,
  providerTestInputSchema,
  providerTestResultSchema,
  providerResourceInputSchema,
  type Definition,
} from '@tulipfarm/workflows/contracts';
import { workflowRequest as request, WorkflowRequestError as ProviderRequestError } from '@/features/workflows/api';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { CheckboxField, Field } from '@tulipfarm/sprout/field';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { Disclosure } from '@/components/disclosure';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { workflowSources as examples } from '@/features/workflows/provider-sources';
import { providerFieldHelp, providerIssues, type ProviderField } from '@/features/workflows/provider-fields';
import { useWorkflowProviders, useWorkflowProviderStatus, useWorkflowChanges } from '@/features/workflows/queries';
import { WorkflowSharing } from '@/features/workflows/sharing';
import { ProviderResourcePicker, providerFailureMessage } from '@/features/workflows/provider-discovery';

type Source = z.infer<typeof providerSourceSchema>;
type Integration = z.infer<typeof providerIntegrationSchema>;
type ReadState =
  | { kind: 'loading' }
  | { kind: 'error'; denied: boolean }
  | { kind: 'ready'; integrations: Integration[] };
type Command = { path: string; method: string; body: unknown };

export function WorkflowProviders({
  workspaceId,
  workflowId,
  initialProvider,
  trigger,
  disabled,
  onTrigger,
  onDenied,
}: {
  workspaceId: string;
  workflowId: string | null;
  initialProvider?: Source['provider'] | undefined;
  trigger: Definition['trigger'];
  disabled: boolean;
  onTrigger?: (trigger: Definition['trigger']) => void;
  onDenied: () => void;
}) {
  const base = `/workspaces/${workspaceId}/workflows`;
  const read = useWorkflowProviders(workspaceId);
  const statusRead = useWorkflowProviderStatus(workspaceId, trigger.kind === 'provider' ? workflowId : null);
  const changes = useWorkflowChanges();
  const [denied, setDenied] = useState(false);
  const state: ReadState =
    denied || read.state.kind === 'unavailable'
      ? { kind: 'error', denied: true }
      : read.state.kind === 'ready'
        ? { kind: 'ready', integrations: read.state.data }
        : read.state.kind === 'error'
          ? { kind: 'error', denied: false }
          : { kind: 'loading' };
  const [source, changeSource] = useState<Source>(
    () =>
      examples.find(item => item.source.provider === initialProvider)?.source ?? {
        provider: 'sheets',
        spreadsheetId: '',
        range: 'Sheet1!A2:Z1000',
        keyColumn: 0,
      },
  );
  const setupHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (initialProvider) {
      setupHeading.current?.focus();
      setupHeading.current?.scrollIntoView({ block: 'start' });
    }
  }, [initialProvider]);
  const [name, setName] = useState('');
  const [token, changeToken] = useState('');
  const [verified, setVerified] = useState<{ source: Source; token: string; target: string | null } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState('');
  const testSequence = useRef(0);
  const setSource = (next: Source) => {
    testSequence.current++;
    changeSource(next);
    setVerified(null);
    setTesting(false);
    setTestError('');
  };
  const setToken = (next: string) => {
    testSequence.current++;
    changeToken(next);
    setVerified(null);
    setTesting(false);
    setTestError('');
  };
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Command | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const status = statusRead.state.kind === 'ready' ? statusRead.state.data : null;
  const statusError =
    statusRead.state.kind === 'error' || (statusRead.state.kind === 'ready' && !!statusRead.state.error);
  const blocked = disabled || busy || pending !== null;
  const accessVersion = useRef(0);
  const deny = useCallback(() => {
    accessVersion.current++;
    setDenied(true);
    setToken('');
    setPending(null);
    onDenied();
  }, [onDenied]);
  const refresh = async () => {
    await read.refresh();
    setDenied(false);
  };
  useEffect(() => {
    if (read.state.kind === 'unavailable' || statusRead.state.kind === 'unavailable') deny();
  }, [read.state.kind, statusRead.state.kind, deny]);
  useEffect(
    () => () => {
      accessVersion.current++;
      testSequence.current++;
    },
    [],
  );
  async function execute(command: Command) {
    if (busy) return;
    const access = accessVersion.current;
    setBusy(true);
    setPending(command);
    setError('');
    setMessage('');
    try {
      await request(command.path, command.method, command.body);
      await changes.providers();
      if (access !== accessVersion.current) return;
      setPending(null);
      setToken('');
      setAttempted(false);
      setTouched(new Set());
      setMessage(
        onTrigger
          ? 'Provider source saved. Select it below, then save and activate the workflow.'
          : 'Connected source saved. Create or edit a workflow in chat to use it.',
      );
    } catch (failure) {
      if (access !== accessVersion.current) return;
      if (failure instanceof ProviderRequestError && [401, 403, 404].includes(failure.status)) deny();
      else if (failure instanceof ProviderRequestError && failure.status < 500) {
        setPending(null);
        setVerified(null);
        setError(providerFailureMessage(failure));
      } else setError('Provider setup is unconfirmed. Retry the exact setup request before changing it.');
    } finally {
      setBusy(false);
    }
  }
  const readStatus = statusRead.refresh;
  const [touched, setTouched] = useState<ReadonlySet<ProviderField>>(new Set());
  const [attempted, setAttempted] = useState(false);
  const issues = providerIssues({ name, source, token, consent });
  const visible = Object.fromEntries(
    Object.entries(issues).filter(([key]) => attempted || touched.has(key as ProviderField)),
  ) as Partial<Record<ProviderField, string>>;
  const issueCount = Object.keys(issues).length;
  const markTouched = (field: ProviderField) =>
    setTouched(current => (current.has(field) ? current : new Set(current).add(field)));
  function sourceField(field: ProviderField, label: string, id: string, control: ReactElement) {
    const resource = providerResourceInputSchema.shape.resource.safeParse(field);
    if (resource.success) {
      const value = field in source ? String(source[field as keyof Source]) : '';
      const parentId =
        source.provider === 'slack' && field === 'channelId'
          ? source.teamId
          : source.provider === 'jira' && field === 'projectKey'
            ? source.cloudId
            : source.provider === 'gmail' && field === 'labelId'
              ? source.emailAddress
              : undefined;
      control = (
        <ProviderResourcePicker
          base={base}
          provider={source.provider}
          resource={resource.data}
          token={token}
          parentId={parentId}
          conversation={source.provider === 'slack' ? source.conversation : undefined}
          value={value}
          label={label}
          manualInput={control}
          onDenied={deny}
          onSelect={selected => {
            let next = { ...source, [field]: selected };
            if (next.provider === 'slack' && field === 'teamId') next = { ...next, channelId: '' };
            if (next.provider === 'jira' && field === 'cloudId') next = { ...next, projectKey: '' };
            if (next.provider === 'gmail' && field === 'emailAddress') next = { ...next, labelId: '' };
            setSource(next);
          }}
        />
      );
    }
    return (
      <div onBlur={() => markTouched(field)}>
        <Field id={id} label={label} required helper={providerFieldHelp[field]} error={visible[field]}>
          {control}
        </Field>
      </div>
    );
  }
  async function testIntegration(integration?: Integration) {
    const candidate = integration?.source ?? source;
    if (!providerTestInputSchema.safeParse({ source: candidate, token }).success) {
      setAttempted(true);
      setTestError('Check the source fields and token before testing.');
      return;
    }
    const current = ++testSequence.current,
      access = accessVersion.current;
    setTesting(true);
    setVerified(null);
    setTestError('');
    try {
      providerTestResultSchema.parse(
        await request(`${base}/provider-integrations/test`, 'POST', { source: candidate, token }),
      );
      if (current === testSequence.current && access === accessVersion.current)
        setVerified({ source: candidate, token, target: integration?.id ?? null });
    } catch (failure) {
      if (current !== testSequence.current || access !== accessVersion.current) return;
      if (failure instanceof ProviderRequestError && [401, 403, 404].includes(failure.status)) deny();
      else setTestError(providerFailureMessage(failure));
    } finally {
      if (current === testSequence.current) setTesting(false);
    }
  }
  const tested = verified?.source === source && verified.token === token && verified.target === null;
  function create() {
    setAttempted(true);
    if (issueCount > 0 || !tested) return;
    const body = providerIntegrationInputSchema.parse({ id: crypto.randomUUID(), name, source, token, consent });
    void execute({ path: `${base}/provider-integrations`, method: 'POST', body });
  }
  return (
    <section id="provider-setup" aria-label="Provider triggers" className="max-w-3xl space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h2 ref={setupHeading} tabIndex={-1} className="scroll-mt-6 text-lg font-medium">
          Advanced workflow inputs
        </h2>
        <Button variant="outline" disabled={busy} onClick={() => void refresh()}>
          Retry loading sources
        </Button>
      </header>
      <p>
        Connect a source you are authorized to use. New integrations are private. You can explicitly share use or
        management with people and teams. Provider histories require both history access and current integration use.
      </p>
      {state.kind === 'loading' && (
        <StatePanel
          kind="loading"
          title="Loading provider sources"
          description="Checking the workspace's consented integrations."
        />
      )}
      {state.kind === 'error' && (
        <StatePanel
          kind={state.denied ? 'unavailable' : 'error'}
          title={state.denied ? 'Provider access unavailable' : 'Provider sources could not load'}
          description="Retry loading sources after access or connectivity is restored."
        >
          <Button variant="outline" onClick={() => void refresh()}>
            Retry provider read
          </Button>
        </StatePanel>
      )}
      {state.kind === 'ready' && (
        <>
          {read.state.kind === 'ready' && read.state.error && (
            <p role="alert">
              Provider integrations could not refresh. Your source draft is retained. Retry loading sources.
            </p>
          )}
          {!state.integrations.length && (
            <StatePanel
              kind="empty"
              title="Connect a provider source"
              description="Connect one source below to start workflows from new provider data."
            />
          )}
          <div className="flex flex-wrap gap-2">
            {examples.map(example => (
              <Button
                key={example.source.provider}
                variant={source.provider === example.source.provider ? 'secondary' : 'outline'}
                disabled={blocked}
                onClick={() => {
                  setSource(example.source);
                  setToken('');
                  setConsent(false);
                  setTouched(new Set());
                  setAttempted(false);
                }}
              >
                {example.title}
              </Button>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            {examples.find(example => example.source.provider === source.provider)?.help}
          </p>
          <p className="text-sm text-muted-foreground">
            Polling continues after you leave. Supply an existing authorized bearer token. Hosted OAuth sign-in and
            automatic token refresh are not available. Rotate expiring tokens here.
          </p>
          <ProviderInstructions source={source} />
          <p className="text-sm text-muted-foreground">
            Changing providers clears the source fields, token and consent. Your source name is kept.
          </p>
          <fieldset disabled={blocked} className="space-y-3">
            <legend className="text-sm font-medium">Connect a source</legend>
            {sourceField(
              'name',
              'Source name',
              'provider-name',
              <Input value={name} onChange={event => setName(event.target.value)} />,
            )}
            {sourceField(
              'token',
              'Bearer token for new source or rotation',
              'provider-token',
              <Input
                type="password"
                autoComplete="off"
                value={token}
                onChange={event => setToken(event.target.value)}
              />,
            )}
            {source.provider === 'sheets' && (
              <>
                {sourceField(
                  'spreadsheetId',
                  'Spreadsheet ID',
                  'sheet-id',
                  <Input
                    value={source.spreadsheetId}
                    onChange={event => setSource({ ...source, spreadsheetId: event.target.value })}
                  />,
                )}
                {sourceField(
                  'range',
                  'Data range without header',
                  'sheet-range',
                  <Input
                    value={source.range}
                    onChange={event => setSource({ ...source, range: event.target.value })}
                  />,
                )}
                {sourceField(
                  'keyColumn',
                  'Unique key column, starting at zero',
                  'key-column',
                  <Input
                    type="number"
                    min={0}
                    max={99}
                    value={source.keyColumn}
                    onChange={event => setSource({ ...source, keyColumn: Number(event.target.value) })}
                  />,
                )}
              </>
            )}
            {source.provider === 'slack' && (
              <>
                {sourceField(
                  'teamId',
                  'Slack workspace ID',
                  'slack-team',
                  <Input
                    value={source.teamId}
                    onChange={event => setSource({ ...source, teamId: event.target.value })}
                  />,
                )}
                {sourceField(
                  'channelId',
                  'Conversation ID',
                  'channel-id',
                  <Input
                    value={source.channelId}
                    onChange={event => setSource({ ...source, channelId: event.target.value })}
                  />,
                )}
                <div className="flex gap-2">
                  <Button
                    variant={source.conversation === 'public' ? 'secondary' : 'outline'}
                    onClick={() => setSource({ ...source, conversation: 'public' })}
                  >
                    Public channel
                  </Button>
                  <Button
                    variant={source.conversation === 'direct' ? 'secondary' : 'outline'}
                    onClick={() => setSource({ ...source, conversation: 'direct' })}
                  >
                    Direct conversation
                  </Button>
                </div>
              </>
            )}
            {source.provider === 'notion' &&
              sourceField(
                'dataSourceId',
                'Data source ID',
                'notion-id',
                <Input
                  value={source.dataSourceId}
                  onChange={event => setSource({ ...source, dataSourceId: event.target.value })}
                />,
              )}
            {source.provider === 'gmail' && (
              <>
                {sourceField(
                  'emailAddress',
                  'Gmail account email',
                  'gmail-account',
                  <Input
                    type="email"
                    value={source.emailAddress}
                    onChange={event => setSource({ ...source, emailAddress: event.target.value })}
                  />,
                )}
                {sourceField(
                  'labelId',
                  'Gmail label ID',
                  'gmail-label',
                  <Input
                    value={source.labelId}
                    onChange={event => setSource({ ...source, labelId: event.target.value })}
                  />,
                )}
              </>
            )}
            {source.provider === 'forms' &&
              sourceField(
                'formId',
                'Google Form ID',
                'form-id',
                <Input
                  value={source.formId}
                  onChange={event => setSource({ ...source, formId: event.target.value })}
                />,
              )}
            {source.provider === 'jira' && (
              <>
                {sourceField(
                  'cloudId',
                  'Jira cloud ID',
                  'jira-cloud',
                  <Input
                    value={source.cloudId}
                    onChange={event => setSource({ ...source, cloudId: event.target.value })}
                  />,
                )}
                {sourceField(
                  'projectKey',
                  'Jira project key',
                  'jira-project',
                  <Input
                    value={source.projectKey}
                    onChange={event => setSource({ ...source, projectKey: event.target.value })}
                  />,
                )}
              </>
            )}
            {source.provider === 'hubspot' && (
              <>
                {sourceField(
                  'portalId',
                  'HubSpot portal ID',
                  'hubspot-account',
                  <Input
                    value={source.portalId}
                    onChange={event => setSource({ ...source, portalId: event.target.value })}
                  />,
                )}
                <div className="flex flex-wrap gap-2">
                  {(['contacts', 'companies', 'deals', 'tickets'] as const).map(objectType => (
                    <Button
                      key={objectType}
                      variant={source.objectType === objectType ? 'secondary' : 'outline'}
                      onClick={() => setSource({ ...source, objectType })}
                    >
                      {objectType}
                    </Button>
                  ))}
                </div>
              </>
            )}
            <CheckboxField
              id="provider-consent"
              label="I authorize access to this source for my workflows. I control who may use this integration."
              error={visible.consent}
              checked={consent}
              onCheckedChange={value => {
                setConsent(value);
                markTouched('consent');
              }}
            />
            <p className="text-sm text-muted-foreground">
              Test integration checks this token and source without saving them or starting a workflow. Saving checks
              again. Changing a source or token requires a new test.
            </p>
            <Button variant="outline" disabled={testing} aria-busy={testing} onClick={() => void testIntegration()}>
              {testing ? 'Testing integration…' : 'Test integration'}
            </Button>
            {verified && (
              <p role="status">
                Integration test succeeded{verified.target ? ' for the selected saved source' : ''}. You can now{' '}
                {verified.target ? 'rotate its token' : 'connect this source'}.
              </p>
            )}
            {testError && <p role="alert">{testError}</p>}
            {attempted && issueCount > 0 && (
              <p role="alert" className="text-sm text-destructive">
                Fix {issueCount === 1 ? 'the highlighted field' : `${issueCount} highlighted fields`} before connecting.
              </p>
            )}
            <Button disabled={!tested || !consent} aria-busy={busy} onClick={create}>
              Connect provider source
            </Button>
          </fieldset>
          <ul className="space-y-3">
            {state.integrations.map(integration => (
              <li key={integration.id} className="space-y-2 border-t pt-3">
                <p className="font-medium">
                  {integration.name} · {integration.source.provider} ·{' '}
                  {!integration.authorized ? 'Consent revoked' : integration.enabled ? 'Enabled' : 'Disabled'}
                </p>
                <div className="flex flex-wrap gap-2">
                  {onTrigger && (
                    <Button
                      variant="outline"
                      disabled={
                        blocked || !integration.capabilities.use || !integration.enabled || !integration.authorized
                      }
                      onClick={() =>
                        onTrigger({ kind: 'provider', integrationId: integration.id, event: 'created', minutes: 5 })
                      }
                    >
                      Use {integration.name}
                    </Button>
                  )}
                  {integration.capabilities.manage && (
                    <Button
                      variant="outline"
                      disabled={blocked}
                      onClick={() =>
                        void execute({
                          path: `${base}/provider-integrations/${integration.id}`,
                          method: 'PATCH',
                          body: {
                            commandId: crypto.randomUUID(),
                            expectedGeneration: integration.generation,
                            enabled: !integration.enabled,
                          },
                        })
                      }
                    >
                      {integration.enabled ? 'Disable' : 'Enable'} {integration.name}
                    </Button>
                  )}
                  {integration.capabilities.manage && integration.capabilities.rotate && (
                    <>
                      <Button
                        variant="outline"
                        disabled={blocked || !token || testing}
                        onClick={() => void testIntegration(integration)}
                      >
                        Test replacement token for {integration.name}
                      </Button>
                      <Button
                        variant="outline"
                        disabled={blocked || verified?.target !== integration.id || verified?.token !== token}
                        onClick={() =>
                          void execute({
                            path: `${base}/provider-integrations/${integration.id}`,
                            method: 'PATCH',
                            body: {
                              commandId: crypto.randomUUID(),
                              expectedGeneration: integration.generation,
                              enabled: integration.enabled,
                              token,
                            },
                          })
                        }
                      >
                        Rotate token for {integration.name}
                      </Button>
                    </>
                  )}
                </div>
                {integration.capabilities.manage && (
                  <WorkflowSharing workspaceId={workspaceId} id={integration.id} provider changed={refresh} />
                )}
              </li>
            ))}
          </ul>
          {onTrigger && trigger.kind === 'provider' && (
            <fieldset disabled={blocked} className="space-y-3">
              <legend className="text-sm font-medium">Selected provider trigger</legend>
              <p>
                {state.integrations.find(integration => integration.id === trigger.integrationId)?.name ??
                  'Source unavailable'}{' '}
                · {trigger.event === 'updated' ? 'Updated rows' : 'New items'}
              </p>
              <div className="flex gap-2">
                <Button
                  variant={trigger.event === 'created' ? 'secondary' : 'outline'}
                  onClick={() => onTrigger({ ...trigger, event: 'created' })}
                >
                  New items
                </Button>
                {state.integrations.find(integration => integration.id === trigger.integrationId)?.source.provider ===
                  'sheets' && (
                  <Button
                    variant={trigger.event === 'updated' ? 'secondary' : 'outline'}
                    onClick={() => onTrigger({ ...trigger, event: 'updated' })}
                  >
                    Updated rows
                  </Button>
                )}
              </div>
              <Label htmlFor="provider-minutes">Poll interval in minutes</Label>
              <Input
                id="provider-minutes"
                type="number"
                min={1}
                max={1440}
                value={trigger.minutes}
                onChange={event => onTrigger({ ...trigger, minutes: Number(event.target.value) })}
              />
              <p className="text-sm text-muted-foreground">
                Save and activate the workflow to apply this trigger. Activation begins with current data, without a
                historical backfill.
              </p>
            </fieldset>
          )}
          {workflowId && trigger.kind === 'provider' && (
            <div className="space-y-2">
              <Button variant="outline" onClick={() => void readStatus()}>
                Check provider status
              </Button>
              {statusError && <p role="alert">Provider status could not load. Check provider status again.</p>}
              {status && (
                <p role="status">
                  {status.lastSuccess ? `Last successful poll ${status.lastSuccess}.` : 'No successful poll yet.'}{' '}
                  {status.pending} events waiting for admission.{' '}
                  {status.error
                    ? `Polling stopped or delayed (${status.error}). Check source access or rotate the token.`
                    : ''}
                </p>
              )}
            </div>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {pending && !busy && (
        <Button variant="outline" onClick={() => void execute(pending)}>
          Retry exact provider setup
        </Button>
      )}
    </section>
  );
}

const sourceInstructions: Record<Source['provider'], string> = {
  sheets:
    'Use a Google OAuth token with spreadsheets.readonly and source access. Loading spreadsheet choices also needs drive.metadata.readonly; otherwise enter the ID between /d/ and /edit manually. Use a bounded A1 or named range of at most 1000 rows and 100 columns, such as Sheet1!A2:Z1000. The key column starts at zero within this range. Testing checks range access and column position; polling checks that keys are present and unique.',
  slack:
    'Ask your Slack app administrator for the workspace ID (for example T0123456789), conversation ID (for example C0123456789), and a bearer token for that conversation. Public channels need channels:read and channels:history; direct conversations need im:read and im:history.',
  notion:
    'Ask your Notion integration administrator for the data source ID and integration token. Share the parent database with that integration first. The database ID in a page URL is not the data source ID.',
  gmail:
    'Use a Google OAuth bearer token with gmail.readonly for the exact Gmail account. Enter its email address and label ID, for example INBOX. Personal Google sign-in in Integrations does not supply this workflow token. Share integration use and history access only with authorized recipients.',
  forms:
    'Use a Google OAuth token with forms.responses.readonly, forms.body.readonly and access to this form. Loading choices also needs drive.metadata.readonly; otherwise enter the ID from the editor URL between /d/ and /edit manually. Testing checks form identity and response-read access without returning answers.',
  jira: 'Ask your Jira administrator for the site cloud ID, a project key such as OPS, and an OAuth bearer token with read:jira-work and Browse projects permission. The cloud ID is not the site name or project key.',
  hubspot:
    'Ask your HubSpot administrator for the portal ID and a private app or OAuth bearer token with account-info and read access to the selected object. Choose contacts, companies, deals or tickets. New objects start workflows; existing objects are not imported.',
};

function ProviderInstructions({ source }: { source: Source }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const instructions = sourceInstructions[source.provider];
  useEffect(() => {
    setCopied(false);
    setFailed(false);
  }, [source.provider]);
  return (
    <section className="space-y-2">
      <h3 className="font-medium">Before you connect</h3>
      <p className="text-base">{instructions}</p>
      <Button
        variant="outline"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(instructions);
            setCopied(true);
            setFailed(false);
          } catch {
            setFailed(true);
          }
        }}
      >
        Copy setup instructions
      </Button>
      {copied && <p role="status">Setup instructions copied.</p>}
      {failed && <p role="alert">Clipboard unavailable. Select the instructions below to copy them manually.</p>}
      <Disclosure title="Selectable setup instructions" defaultOpen={failed}>
        <Label htmlFor="provider-instructions">Instructions to send your administrator</Label>
        <Textarea id="provider-instructions" value={instructions} readOnly rows={5} />
      </Disclosure>
    </section>
  );
}
