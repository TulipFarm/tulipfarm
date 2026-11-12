import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import {
  packageBindingsSchema,
  type SystemPackage,
  type PackageBindings,
  type SystemPackageInstallation,
} from '@tulipfarm/agents/system-package-contracts';
import type { A2uiComponent } from '@tulipfarm/sprout/a2ui';
import { Button } from '@tulipfarm/sprout/button';
import { CodeBlock } from '@tulipfarm/sprout/code-block';
import { Field } from '@tulipfarm/sprout/field';
import { Input } from '@tulipfarm/sprout/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { ReadFeedback, ReadError } from '@/components/read-feedback';
import { useFeatureChanges, useFeatureRead } from '@/lib/query';
import { useTableWrite } from '@/features/tables/use-table-write';
import { UnsavedChanges, WriteFeedback } from '@/features/tables/feedback';
import {
  systemPackageApi,
  type PackageImport,
  type PackageValidation,
  type SystemPackageApi,
} from '@/features/packages/api';
import { systemPackageRoute, workspaceRoute } from '@/router';
import { InstallationOutline, installationVerified, resourceTitle } from './progress';
import { PackageSuccess, PackageSurface } from './package-surface';

const statusLabels: Record<SystemPackageInstallation['status'], string> = {
  pending: 'Ready to start',
  'waiting-review': 'Needs your review',
  running: 'Installing',
  blocked: 'Blocked',
  failed: 'Needs attention',
  completed: 'Verified',
};

const choicePlaceholders = {
  team: 'Choose a team',
  member: 'Choose a workspace member',
  integration: 'Choose an authorized connection',
  file: 'Choose a file',
  skill: 'Choose a skill',
  agent: 'Choose an agent',
  connection: 'Choose a connection',
  'slack-destination': 'Choose a Slack destination',
};

function PackageInput({
  input,
  binding,
  api,
  onChange,
  selectedLabel,
}: {
  input: SystemPackage['inputs'][number];
  binding: PackageBindings[string] | undefined;
  api: SystemPackageApi;
  onChange: (binding: PackageBindings[string], label: string) => void;
  selectedLabel: string | undefined;
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
            onChange(
              kind === 'asset' ? { kind, id: event.target.value } : { kind, value: event.target.value },
              event.target.value,
            )
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
            if (id) onChange({ kind, id }, choices.find(choice => choice.id === id)?.label ?? id);
          }}
          disabled={read.state.kind !== 'ready'}
        >
          <SelectTrigger id={`package-input-${input.key}`} width="full">
            <SelectValue>
              {choices.find(choice => choice.id === value)?.label ?? selectedLabel ?? choicePlaceholders[kind]}
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
          {kind === 'team'
            ? 'You’re not in a team that can own these resources. Ask a workspace admin to add you to one.'
            : `No available ${kind === 'integration' ? 'connections' : 'choices'}. Complete the workspace setup first.`}
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
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [answered, setAnswered] = useState<string[]>([]);
  const [stage, setStage] = useState<'overview' | 'questions' | 'review'>('overview');
  const [editing, setEditing] = useState<string | null>(null);
  const [validation, setValidation] = useState<PackageValidation | null>(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const sourceVersion = useRef(0);
  const allowNavigation = useRef(false);
  const needsTeam = document.inputs.some(input => input.kind === 'team');
  const teamDefault = useFeatureRead({
    key: ['system-package-default-team'],
    load: signal => api.defaultTeam(signal),
    enabled: needsTeam,
  });
  const resolvingTeam = needsTeam && teamDefault.state.kind === 'loading';
  const defaultTeam = needsTeam && teamDefault.state.kind === 'ready' ? teamDefault.state.data : null;
  const implied = (input: SystemPackage['inputs'][number]) => !!defaultTeam && input.kind === 'team';
  const questions = document.inputs.filter(input => !implied(input));
  const allBindings: PackageBindings = { ...bindings };
  const allLabels: Record<string, string> = { ...labels };
  if (defaultTeam)
    for (const input of document.inputs.filter(implied)) {
      allBindings[input.key] = { kind: 'team', id: defaultTeam.id };
      allLabels[input.key] = defaultTeam.label;
    }
  const write = useTableWrite(
    async (input: PackageImport) => {
      const bytes = new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(
            `system-package-install:${chatId}:${document.package.name}:${document.package.version}`,
          ),
        ),
      );
      bytes[6] = (bytes[6]! & 0x0f) | 0x80;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      const hex = Array.from(bytes.subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
      const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      return api.import({ ...input, requestId });
    },
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
      const result = await api.validate({ package: document, bindings: allBindings });
      if (version === sourceVersion.current) setValidation(result);
    } catch (failure) {
      if (version === sourceVersion.current)
        setError(failure instanceof Error ? failure.message : 'The package could not be checked.');
    } finally {
      setChecking(false);
    }
  }
  const missing = questions.find(input => !answered.includes(input.key));
  const currentInput = questions.find(input => input.key === editing) ?? missing;
  const currentBinding = currentInput && bindings[currentInput.key];
  const answerValid =
    !!currentInput &&
    !!currentBinding &&
    currentBinding.kind === currentInput.kind &&
    packageBindingsSchema.safeParse({ [currentInput.key]: currentBinding }).success;
  function continueInput() {
    if (busy || !currentInput || !answerValid) return;
    const next = answered.includes(currentInput.key) ? answered : [...answered, currentInput.key];
    setAnswered(next);
    setEditing(null);
    if (questions.every(input => next.includes(input.key))) {
      setStage('review');
      void check();
    }
  }
  const resourceDetails: A2uiComponent[] = document.resources.map((resource, index) => ({
    id: `resource_${index}`,
    component: 'PackageResource',
    kind: resource.kind,
    text: `${resourceTitle(resource, document.resources, document.assets)}${'requestedState' in resource ? ` — requested ${resource.requestedState}` : ''}`,
  }));
  const counts = (
    [
      ['table', 'table', 'tables'],
      ['seed-row', 'starter record', 'starter records'],
      ['skill', 'skill', 'skills'],
      ['agent', 'agent', 'agents'],
      ['workflow', 'workflow', 'workflows'],
      ['integration', 'integration binding', 'integration bindings'],
      ['file', 'file', 'files'],
    ] as const
  ).flatMap(([kind, singular, plural]) => {
    const count = document.resources.filter(resource => resource.kind === kind).length;
    return count
      ? [
          {
            id: `count_${kind.replaceAll('-', '_')}`,
            component: 'PackageResource',
            kind,
            badge: true,
            text: `${count} ${count === 1 ? singular : plural}`,
          },
        ]
      : [];
  });
  const children = ['counts', 'contents'];
  const components: A2uiComponent[] = [
    {
      id: 'contents',
      component: 'Details',
      items: [{ title: `${document.resources.length} resources to install`, child: 'resources' }],
    },
    { id: 'resources', component: 'Column', children: [...resourceDetails.map(item => item.id), 'plan'] },
    { id: 'counts', component: 'Row', children: counts.map(item => item.id) },
    ...counts,
    ...resourceDetails,
    { id: 'plan', component: 'PackagePlan' },
  ];
  const actions: Parameters<typeof PackageSurface>[0]['actions'] = {};
  if (stage === 'overview') {
    children.push('description', 'start');
    components.push(
      { id: 'description', component: 'Text', text: document.package.description },
      { id: 'start', component: 'PackageAction', action: 'start' },
    );
    actions.start = {
      label: questions.length ? 'Continue' : 'Review installation',
      disabled: busy || resolvingTeam,
      run: () => {
        if (busy || resolvingTeam) return;
        setStage(questions.length ? 'questions' : 'review');
        if (!questions.length) void check();
      },
    };
  }
  if (stage === 'questions' && currentInput) {
    children.push('question_count', 'question', 'next');
    components.push(
      {
        id: 'question_count',
        component: 'Text',
        variant: 'caption',
        text: editing ? 'Update your answer' : `Question ${answered.length + 1} of ${questions.length}`,
      },
      { id: 'question', component: 'PackageQuestion' },
      { id: 'next', component: 'PackageAction', action: 'next' },
    );
    actions.next = { label: 'Continue', run: continueInput, disabled: busy || !answerValid };
  }
  if (stage === 'review') {
    children.push('answers', 'validation', 'install');
    components.push(
      { id: 'answers', component: 'Column', children: document.inputs.map((_, index) => `answer_${index}`) },
      {
        id: 'validation',
        component: 'Callout',
        tone: validation?.valid ? 'success' : validation ? 'error' : 'info',
        title: checking
          ? 'Checking package and access'
          : validation?.valid
            ? 'Ready for your approval'
            : 'Not ready to install',
        text: validation?.valid
          ? 'Approve this package and its selected inputs once. All listed resources and requested activation states will be installed without further approval prompts.'
          : validation
            ? validation.issues.map(issue => `${issue.path}: ${issue.message}`).join('\n')
            : 'Checking compatibility and current workspace permissions before installation.',
      },
      { id: 'install', component: 'PackageAction', action: 'install' },
    );
    document.inputs.forEach((input, index) => {
      const fixed = implied(input);
      components.push(
        {
          id: `answer_${index}`,
          component: 'Row',
          children: fixed ? [`answer_text_${index}`] : [`answer_text_${index}`, `edit_${index}`],
        },
        { id: `answer_text_${index}`, component: 'Text', text: `${input.title}: ${allLabels[input.key] ?? ''}` },
      );
      if (fixed) return;
      components.push({ id: `edit_${index}`, component: 'PackageAction', action: `edit-${input.key}` });
      actions[`edit-${input.key}`] = {
        label: `Change ${input.title}`,
        secondary: true,
        disabled: busy,
        run: () => {
          if (busy) return;
          setEditing(input.key);
          setValidation(null);
          setStage('questions');
        },
      };
    });
    actions.install = {
      label: 'Install package',
      disabled: busy || !validation?.valid,
      run: () => {
        if (!busy && validation?.valid)
          void write.submit({
            requestId: chatId,
            chatId,
            package: document,
            bindings: allBindings,
            approval: { packageDigest: validation.packageDigest, inputDigest: validation.inputDigest },
          });
      },
    };
    if (!checking && !validation?.valid) {
      children.push('retry');
      components.push({ id: 'retry', component: 'PackageAction', action: 'retry' });
      actions.retry = { label: 'Check again', secondary: true, disabled: busy, run: () => void check() };
    }
  }
  if (error) {
    children.push('error');
    components.push({ id: 'error', component: 'Callout', tone: 'error', text: error });
  }
  children.push('write_status');
  components.push(
    { id: 'write_status', component: 'PackageWriteStatus' },
    { id: 'root', component: 'Card', title: document.package.title, children },
  );
  return (
    <section aria-label="Package offer">
      <UnsavedChanges dirty={Object.keys(bindings).length > 0} allowNavigation={allowNavigation} />
      <PackageSurface
        id={`package-offer-${chatId}-${document.package.name}-${document.package.version}`}
        components={components}
        actions={actions}
        plan={progress(validation?.valid ? validation.order : undefined)}
        question={
          currentInput && (
            <fieldset disabled={busy}>
              <PackageInput
                key={currentInput.key}
                input={currentInput}
                binding={bindings[currentInput.key]}
                selectedLabel={labels[currentInput.key]}
                api={api}
                onChange={(binding, label) => {
                  if (busy) return;
                  sourceVersion.current++;
                  setBindings(current => ({ ...current, [currentInput.key]: binding }));
                  setLabels(current => ({ ...current, [currentInput.key]: label }));
                  setValidation(null);
                  setError('');
                }}
              />
            </fieldset>
          )
        }
        feedback={
          <WriteFeedback
            state={write.state}
            retry={input => void write.submit(input)}
            checkStatus={() => void refresh()}
          />
        }
      />
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
    (input: { kind: 'resume'; version: number } | { kind: 'approve'; packageDigest: string; inputDigest: string }) =>
      input.kind === 'resume'
        ? api.resume(view.id, input.version)
        : api.approve(view.id, { packageDigest: input.packageDigest, inputDigest: input.inputDigest }),
    () => {
      void refresh();
      void changes.change({ keys: [['system-package-installations']] });
    },
  );
  const busy = stale || write.state.kind === 'sending' || write.state.kind === 'uncertain';
  const verification = view.nodes.find(node => node.key === '$verify' && node.kind === 'verify');
  const completed = installationVerified(view);
  const children = completed ? ['plan'] : ['status', 'plan'];
  const components: A2uiComponent[] = [
    {
      id: 'status',
      component: 'Badge',
      tone: completed ? 'success' : view.status === 'failed' ? 'error' : 'neutral',
      text:
        view.status === 'completed'
          ? completed
            ? 'Verified'
            : 'Verification missing'
          : !view.packageApproved
            ? 'Ready for your approval'
            : statusLabels[view.status],
    },
    { id: 'plan', component: 'PackagePlan' },
  ];
  const actions: Parameters<typeof PackageSurface>[0]['actions'] = {
    refresh: { label: 'Refresh status', secondary: true, run: () => void refresh() },
    resume: {
      label: 'Retry installation',
      disabled: busy,
      run: () => {
        if (!busy) void write.submit({ kind: 'resume', version: view.version });
      },
    },
  };
  if (!verification) {
    children.push('verification');
    components.push({
      id: 'verification',
      component: 'Callout',
      tone: 'error',
      text: 'The verification step is missing. This installation cannot be shown as complete. Refresh its server state.',
    });
  }
  for (const [index, node] of view.nodes.entries()) {
    if (!node.error) continue;
    const id = `error_${index}`;
    children.push(id);
    components.push({ id, component: 'Callout', tone: 'error', title: node.title, text: node.error });
  }
  if (!view.packageApproved && !completed) {
    children.push('approval_scope', 'definitions', 'approve');
    components.push(
      {
        id: 'approval_scope',
        component: 'Text',
        text: 'This installation was started without a whole-package approval. Approve the exact package and selected inputs once to install the remaining resources without individual prompts.',
      },
      {
        id: 'definitions',
        component: 'Details',
        items: [{ title: 'Exact package definitions and files', child: 'definitions_content' }],
      },
      {
        id: 'definitions_content',
        component: 'PackageDefinitions',
      },
      { id: 'approve', component: 'PackageAction', action: 'approve' },
    );
    actions.approve = {
      label: 'Approve package and install',
      disabled: busy,
      run: () => {
        if (!busy)
          void write.submit({ kind: 'approve', packageDigest: view.packageDigest, inputDigest: view.inputDigest });
      },
    };
  } else if (
    view.packageApproved &&
    (view.status === 'blocked' || view.status === 'failed' || view.status === 'waiting-review')
  ) {
    children.push('resume');
  }
  children.push('write_status', ...(completed ? ['identity_content', 'refresh'] : ['identity']));
  components.push(
    { id: 'refresh', component: 'PackageAction', action: 'refresh' },
    { id: 'resume', component: 'PackageAction', action: 'resume' },
    { id: 'write_status', component: 'PackageWriteStatus' },
    {
      id: 'identity',
      component: 'Details',
      items: [{ title: 'Installation details', child: 'details' }],
    },
    { id: 'details', component: 'Column', children: ['identity_content', 'refresh'] },
    {
      id: 'identity_content',
      component: 'Code',
      language: 'json',
      code: JSON.stringify({ packageDigest: view.packageDigest, bindings: view.bindings }, null, 2),
    },
    completed
      ? { id: 'root', component: 'Column', children }
      : { id: 'root', component: 'Card', title: view.package.title, children },
  );
  const surface = (
    <PackageSurface
      id={`package-installation-${view.id}`}
      components={components}
      actions={actions}
      plan={progress ?? <InstallationOutline view={view} />}
      definitions={
        <CodeBlock
          language="json"
          code={JSON.stringify(
            {
              resources: view.nodes.flatMap(node => (node.definition ? [node.definition] : [])),
              assets: view.assets,
              bindings: view.bindings,
            },
            null,
            2,
          )}
        />
      }
      feedback={
        <WriteFeedback
          state={write.state}
          retry={input => void write.submit(input)}
          checkStatus={() => void refresh()}
        />
      }
    />
  );
  return completed ? (
    <PackageSuccess id={`package-success-${view.id}`} title={view.package.title} details={surface} />
  ) : (
    surface
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
