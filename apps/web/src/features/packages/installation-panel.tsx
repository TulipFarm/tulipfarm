import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import {
  type SystemPackage,
  type PackageBindings,
  type SystemPackageInstallation,
} from '@tulipfarm/agents/system-package-contracts';
import { Alert, AlertDescription, AlertTitle } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Field } from '@tulipfarm/sprout/field';
import { Input } from '@tulipfarm/sprout/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { Disclosure } from '@/components/disclosure';
import { ReadFeedback, ReadError } from '@/components/read-feedback';
import { useFeatureChanges, useFeatureRead } from '@/lib/query';
import { useTableWrite } from '@/features/tables/use-table-write';
import { UnsavedChanges, WriteFeedback } from '@/features/tables/feedback';
import {
  systemPackageApi,
  type PackageImport,
  type PackageReview,
  type PackageValidation,
  type SystemPackageApi,
} from '@/features/packages/api';
import { systemPackageRoute, workspaceRoute } from '@/router';
import { InstallationOutline } from './progress';

const statusLabels: Record<SystemPackageInstallation['status'], string> = {
  pending: 'Ready to start',
  'waiting-review': 'Needs your review',
  running: 'Installing',
  blocked: 'Blocked',
  failed: 'Needs attention',
  completed: 'Verified',
};

function PackageInput({
  input,
  binding,
  api,
  onChange,
}: {
  input: SystemPackage['inputs'][number];
  binding: PackageBindings[string] | undefined;
  api: SystemPackageApi;
  onChange: (binding: PackageBindings[string]) => void;
}) {
  const kind = input.kind;
  const [after, setAfter] = useState<string>();
  const [search, setSearch] = useState('');
  const manual = kind === 'timezone' || kind === 'slack-channel' || kind === 'asset';
  const read = useFeatureRead({
    key: ['system-package-choices', kind, after, search],
    load: signal => api.choices(kind, signal, after, search),
    enabled: !manual,
  });
  if (manual)
    return (
      <Field
        id={`package-input-${input.key}`}
        label={input.title}
        required
        helper={
          kind === 'timezone'
            ? 'Use an IANA time zone, such as Asia/Kolkata.'
            : kind === 'slack-channel'
              ? 'Use a Slack channel ID. Current access and channel assignment are checked before review.'
              : 'Use an existing table, integration, or Slack destination ID. Current access is checked before import.'
        }
      >
        <Input
          value={binding ? ('value' in binding ? binding.value : binding.id) : ''}
          onChange={event =>
            onChange(kind === 'asset' ? { kind, id: event.target.value } : { kind, value: event.target.value })
          }
          placeholder={
            kind === 'timezone'
              ? Intl.DateTimeFormat().resolvedOptions().timeZone
              : kind === 'slack-channel'
                ? 'C0123456789'
                : 'Resource UUID'
          }
        />
      </Field>
    );
  const choices = read.state.kind === 'ready' ? read.state.data.items : [];
  const value = binding && 'id' in binding ? binding.id : '';
  return (
    <div className="space-y-2">
      {['file', 'agent', 'skill'].includes(kind) && (
        <Field id={`package-search-${input.key}`} label={`Search ${input.title}`} optional>
          <Input
            value={search}
            onChange={event => {
              setSearch(event.target.value);
              setAfter(undefined);
            }}
          />
        </Field>
      )}
      <Field
        id={`package-input-${input.key}`}
        label={input.title}
        required
        helper={
          kind === 'integration'
            ? 'Choose an existing authorized connection. Packages never contain credentials.'
            : 'Current access is checked again before installation.'
        }
      >
        <Select
          value={value}
          onValueChange={id => {
            if (id) onChange({ kind, id });
          }}
          disabled={read.state.kind !== 'ready'}
        >
          <SelectTrigger id={`package-input-${input.key}`} width="full">
            <SelectValue>
              {choices.find(choice => choice.id === value)?.label ?? (value || 'Choose a workspace resource')}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {choices.map(choice => (
              <SelectItem key={choice.id} value={choice.id}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {(after || (read.state.kind === 'ready' && read.state.data.nextCursor)) && (
        <div className="flex gap-2">
          {after && (
            <Button variant="outline" size="sm" onClick={() => setAfter(undefined)}>
              First choices
            </Button>
          )}
          {read.state.kind === 'ready' && read.state.data.nextCursor && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (read.state.kind === 'ready') setAfter(read.state.data.nextCursor ?? undefined);
              }}
            >
              More choices
            </Button>
          )}
        </div>
      )}
      {read.state.kind === 'loading' && <p role="status">Loading choices…</p>}
      {read.state.kind === 'ready' && choices.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No available {kind === 'integration' ? 'connections' : 'choices'}. Complete the workspace setup first.
        </p>
      )}
      {(read.state.kind === 'error' || read.state.kind === 'unavailable') && (
        <Button variant="outline" size="sm" onClick={() => void read.refresh()}>
          Retry loading choices
        </Button>
      )}
    </div>
  );
}

export function PackageOffer({
  api,
  refresh,
  document,
  chatId,
  installed,
  progress,
  disabled = false,
}: {
  api: SystemPackageApi;
  refresh: () => Promise<void>;
  document: SystemPackage;
  chatId: string;
  installed: (installation: SystemPackageInstallation) => void;
  progress: (order: string[] | undefined) => ReactNode;
  disabled?: boolean;
}) {
  const [bindings, setBindings] = useState<PackageBindings>({});
  const [validation, setValidation] = useState<PackageValidation | null>(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const sourceVersion = useRef(0);
  const allowNavigation = useRef(false);
  const write = useTableWrite(
    (input: PackageImport) => api.import(input),
    installation => {
      allowNavigation.current = true;
      installed(installation);
      void refresh();
    },
  );
  const busy = disabled || checking || write.state.kind === 'sending' || write.state.kind === 'uncertain';
  async function check() {
    if (busy) return;
    const version = sourceVersion.current;
    setChecking(true);
    setError('');
    try {
      const result = await api.validate({ package: document, bindings });
      if (version === sourceVersion.current) setValidation(result);
    } catch (failure) {
      if (version === sourceVersion.current)
        setError(failure instanceof Error ? failure.message : 'The package could not be checked.');
    } finally {
      setChecking(false);
    }
  }
  return (
    <section aria-label="Package offer" className="space-y-5 border-b pb-6">
      <UnsavedChanges dirty={Object.keys(bindings).length > 0} allowNavigation={allowNavigation} />
      <Badge variant="outline">Bundled local example</Badge>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="space-y-5">
        <div>
          <h2 className="text-base font-medium">{document.package.title}</h2>
          <p className="text-sm text-muted-foreground">{document.package.description}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {document.package.name} · {document.package.version} · {document.package.license}
          </p>
        </div>
        {progress(validation?.valid ? validation.order : undefined)}
        <fieldset disabled={busy} className="space-y-4">
          {document.inputs.length > 0 && <legend className="mb-4 text-sm font-medium">Workspace inputs</legend>}
          {document.inputs.map(input => (
            <PackageInput
              key={input.key}
              input={input}
              binding={bindings[input.key]}
              api={api}
              onChange={binding => {
                sourceVersion.current++;
                setBindings(current => ({ ...current, [input.key]: binding }));
                setValidation(null);
              }}
            />
          ))}
        </fieldset>
        <Button variant="outline" disabled={busy} onClick={() => void check()}>
          {checking ? 'Checking package…' : 'Check package and access'}
        </Button>
        {validation && (
          <Alert variant={validation.valid ? 'default' : 'destructive'}>
            <AlertTitle>{validation.valid ? 'Ready to install' : 'Resolve these blockers'}</AlertTitle>
            <AlertDescription>
              {validation.valid ? (
                'The package is valid. Each resource still needs its required review before it is applied.'
              ) : (
                <ul className="list-disc space-y-1 pl-4">
                  {validation.issues.map((issue, index) => (
                    <li key={`${issue.path}-${index}`}>
                      {issue.path}: {issue.message}
                    </li>
                  ))}
                </ul>
              )}
            </AlertDescription>
          </Alert>
        )}
        <Button
          disabled={busy || !validation?.valid}
          onClick={() => {
            if (validation?.valid) void write.submit({ requestId: chatId, chatId, package: document, bindings });
          }}
        >
          Install
        </Button>
        <p className="text-sm text-muted-foreground">
          One tracked installation. No silent overwrites, connection consent, or publishing. Verification runs last.
        </p>
      </div>
      <WriteFeedback state={write.state} retry={input => void write.submit(input)} checkStatus={() => void refresh()} />
    </section>
  );
}

export function Installation({
  view,
  api,
  refresh,
  stale,
  progress,
}: {
  view: SystemPackageInstallation;
  api: SystemPackageApi;
  refresh: () => Promise<void>;
  stale: boolean;
  progress?: ReactNode;
}) {
  const changes = useFeatureChanges();
  const write = useTableWrite(
    (input: { kind: 'resume'; version: number } | { kind: 'review'; review: PackageReview }) =>
      input.kind === 'resume' ? api.resume(view.id, input.version) : api.review(view.id, input.review),
    () => {
      void refresh();
      void changes.change({ keys: [['system-package-installations']] });
    },
  );
  const busy = stale || write.state.kind === 'sending' || write.state.kind === 'uncertain';
  const ordered = [
    ...view.nodes.filter(node => node.kind !== 'verify'),
    ...view.nodes.filter(node => node.kind === 'verify'),
  ];
  const verification = view.nodes.find(node => node.key === '$verify' && node.kind === 'verify');
  const completed = view.status === 'completed' && verification?.state === 'completed';
  return (
    <div className="space-y-5">
      <Badge variant={completed ? 'success' : view.status === 'failed' ? 'destructive' : 'outline'}>
        {view.status === 'completed' && !completed ? 'Verification missing' : statusLabels[view.status]}
      </Badge>
      {progress ?? <InstallationOutline view={view} />}
      {!verification && (
        <Alert variant="destructive">
          <AlertTitle>Verification step missing</AlertTitle>
          <AlertDescription>This installation cannot be shown as complete. Refresh its server state.</AlertDescription>
        </Alert>
      )}
      {completed && (
        <p role="status" className="text-sm">
          All requested resources were read back and verified.
        </p>
      )}
      {ordered
        .filter(node => (node.state === 'waiting-review' && node.review) || node.error)
        .map(node => (
          <section key={node.key} aria-label={`Review ${node.title}`} className="space-y-3 border-t pt-4">
            <h2 className="text-base font-medium">{node.title}</h2>
            {node.error && (
              <Alert variant="destructive">
                <AlertDescription>{node.error}</AlertDescription>
              </Alert>
            )}
            {node.state === 'waiting-review' && node.review && (
              <>
                <p className="text-sm">{node.review.description}</p>
                {node.definition && (
                  <Disclosure title="Exact resource definition">
                    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">
                      {JSON.stringify(node.definition, null, 2)}
                    </pre>
                  </Disclosure>
                )}
                {node.definition?.kind === 'skill' &&
                  node.definition.files.map(file => {
                    const asset = view.assets.find(candidate => candidate.key === file.asset);
                    return (
                      <Disclosure key={file.path} title={`Skill file: ${file.path}`}>
                        {asset?.encoding === 'base64' ? (
                          <p className="break-all text-xs">
                            Binary file: {asset.size.toLocaleString()} bytes. SHA-256: {asset.sha256}. Binary content is
                            not rendered. Review the original file before approving this skill.
                          </p>
                        ) : (
                          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">
                            {asset?.content ?? 'File content is unavailable. Refresh before approving.'}
                          </pre>
                        )}
                      </Disclosure>
                    );
                  })}
                <p className="text-xs text-muted-foreground">
                  This decision applies only to this resource and its current reviewed definition.
                </p>
                <div className="flex gap-2">
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void write.submit({
                        kind: 'review',
                        review: {
                          requestId: crypto.randomUUID(),
                          expectedVersion: view.version,
                          key: node.key,
                          digest: node.review!.digest,
                          decision: 'approve',
                        },
                      })
                    }
                  >
                    Approve {node.title}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void write.submit({
                        kind: 'review',
                        review: {
                          requestId: crypto.randomUUID(),
                          expectedVersion: view.version,
                          key: node.key,
                          digest: node.review!.digest,
                          decision: 'reject',
                        },
                      })
                    }
                  >
                    Reject
                  </Button>
                </div>
              </>
            )}
          </section>
        ))}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => void refresh()}>
          Refresh status
        </Button>
        {view.status !== 'completed' && (
          <Button disabled={busy} onClick={() => void write.submit({ kind: 'resume', version: view.version })}>
            {view.status === 'pending' ? 'Start installation' : 'Check and continue'}
          </Button>
        )}
      </div>
      <WriteFeedback state={write.state} retry={input => void write.submit(input)} checkStatus={() => void refresh()} />
      <Disclosure title="Installation identity and workspace inputs">
        <p className="text-xs text-muted-foreground">
          Package digest: <code className="break-all">{view.packageDigest}</code>
        </p>
        <pre className="overflow-auto whitespace-pre-wrap break-all text-xs">
          {JSON.stringify(view.bindings, null, 2)}
        </pre>
      </Disclosure>
    </div>
  );
}

export function SystemPackagePage() {
  const { workspace } = workspaceRoute.useRouteContext();
  const { installationId } = systemPackageRoute.useParams();
  const api = useMemo(() => systemPackageApi(workspace.id), [workspace.id]);
  const read = useFeatureRead({
    key: ['system-package-installations', installationId],
    load: signal => api.read(installationId, signal),
    pollWhile: view => view.status === 'running' || view.status === 'pending',
    interval: 2000,
    maxChecks: Infinity,
  });
  const retry = (
    <Button variant="outline" onClick={() => void read.refresh()}>
      Refresh installation
    </Button>
  );
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PageContent>
        <PageHeader
          title={read.state.kind === 'ready' ? read.state.data.package.title : 'Package installation'}
          description="Exact definitions, reviewed changes, and a final check of every resource."
          back={{
            label: 'Back to packages',
            link: <Link to="/$workspaceSlug/packages" params={{ workspaceSlug: workspace.slug }} />,
          }}
        />
        <ReadFeedback
          state={read.state}
          errorTitle="Could not load this installation"
          retry={retry}
          loading={
            <div role="status" aria-label="Loading installation">
              <Skeleton />
              <Skeleton />
              <Skeleton />
            </div>
          }
          unavailable={() => (
            <StatePanel
              kind="unavailable"
              title="Installation unavailable"
              description="This installation belongs to another member or your workspace access changed."
            >
              {retry}
            </StatePanel>
          )}
          refreshError={message => <ReadError message={`Showing the last loaded state. ${message}`}>{retry}</ReadError>}
        >
          {view => (
            <Installation
              view={view}
              api={api}
              refresh={read.refresh}
              stale={read.state.kind === 'ready' && read.state.error !== null}
            />
          )}
        </ReadFeedback>
      </PageContent>
    </div>
  );
}
