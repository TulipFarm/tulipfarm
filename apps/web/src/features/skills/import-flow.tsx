import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { SkillImportView } from '@tulipfarm/agents/skill-import-contracts';
import { skillImportRoute, workspaceRoute } from '@/router';
import { Button } from '@tulipfarm/sprout/button';
import { ActionButton } from '@/components/action-button';
import { Input } from '@tulipfarm/sprout/input';
import { Field, ChoiceGroup, CheckboxField } from '@tulipfarm/sprout/field';
import { Form, FormFooter } from '@tulipfarm/sprout/form';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { ReadError, ReadFeedback } from '@/components/read-feedback';
import { Disclosure } from '@/components/disclosure';
import { useFeatureRead } from '@/lib/query';
import { useTableWrite } from '@/features/tables/use-table-write';
import { WriteFeedback } from '@/features/tables/feedback';
import { useSkillChanges } from './queries';
import { skillImportApi, importErrors } from './import-api';
import { PackageFiles } from './package-files';

type ImportNavigation = {
  onOpen?: ((id: string) => void) | undefined;
  onInstalled?: ((receipts: SkillImportView['receipts']) => void) | undefined;
  onRestart?: (() => void) | undefined;
};

export function ImportSkillForm({
  initialUrl = '',
  onOpen,
}: { initialUrl?: string } & Pick<ImportNavigation, 'onOpen'>) {
  const { workspace } = workspaceRoute.useRouteContext();
  const navigate = useNavigate();
  const api = useMemo(() => skillImportApi(workspace.id), [workspace.id]);
  const [url, setUrl] = useState(initialUrl),
    [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const open = (id: string) =>
    onOpen
      ? onOpen(id)
      : void navigate({
          to: '/$workspaceSlug/skills/import/$importId',
          params: { workspaceSlug: workspace.slug, importId: id },
        });
  const write = useTableWrite(
    (request: { id: string; url: string }) => api.prepare(request.id, { kind: 'url', url: request.url }),
    view => open(view.id),
  );
  const busy = write.state.kind === 'sending' || write.state.kind === 'uncertain';
  return (
    <section aria-label="Import skill" className="min-w-0 space-y-4 border-b pb-6">
      <h2 className="text-base font-medium">Import skill</h2>
      <Form
        disabled={busy}
        onSubmit={() => {
          if (busy) return;
          if (!url.trim() || url.length > 4096) {
            setError('Enter a public skill link.');
            return 'invalid';
          }
          setError('');
          void write.submit({ id: crypto.randomUUID(), url: url.trim() });
        }}
      >
        <div className="space-y-4">
          <Field
            id="skill-source"
            label="Source URL"
            required
            error={error || undefined}
            helper="A public skills.sh, GitHub, or website link to a skill package."
          >
            <Input
              ref={input}
              value={url}
              maxLength={4096}
              placeholder="https://skills.sh/owner/repository/skill"
              onChange={event => {
                setUrl(event.target.value);
                setError('');
              }}
            />
          </Field>
          <FormFooter
            dirty={false}
            submit={{
              label: 'Find skills',
              pendingLabel: 'Finding skills…',
              state: busy ? { kind: 'busy' } : { kind: 'ready' },
            }}
            error={error ? 'Fix the source URL to continue.' : undefined}
            note="You choose what to install. Safety review uses workspace Credits."
          >
            <WriteFeedback
              state={write.state}
              retry={request => void write.submit(request)}
              checkStatus={() => {
                if ('input' in write.state) open(write.state.input.id);
              }}
            />
          </FormFooter>
        </div>
      </Form>
    </section>
  );
}

export function ImportSkillPage() {
  const { workspace } = workspaceRoute.useRouteContext();
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PageContent>
        <PageHeader
          title="Import skill"
          back={{
            label: 'Back to skills',
            link: <Link to="/$workspaceSlug/skills" params={{ workspaceSlug: workspace.slug }} />,
          }}
        />
        <ImportSkillForm />
      </PageContent>
    </div>
  );
}

export function SkillImportPage() {
  const { workspace } = workspaceRoute.useRouteContext();
  const { importId } = skillImportRoute.useParams();
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PageContent>
        <PageHeader
          title="Review skill import"
          back={{
            label: 'Back to skills',
            link: <Link to="/$workspaceSlug/skills" params={{ workspaceSlug: workspace.slug }} />,
          }}
        />
        <SkillImportPanel importId={importId} />
      </PageContent>
    </div>
  );
}

export function SkillImportPanel({
  importId,
  onOpen,
  onInstalled,
  onRestart,
}: { importId: string } & ImportNavigation) {
  const { workspace } = workspaceRoute.useRouteContext();
  const api = useMemo(() => skillImportApi(workspace.id), [workspace.id]);
  const read = useFeatureRead({
    key: ['skill-imports', importId],
    load: signal => api.read(importId, signal),
    pollWhile: view => ['pending', 'preparing', 'pending-review', 'reviewing'].includes(view.status),
    interval: 2000,
    maxChecks: 30,
  });
  const retry = (
    <Button variant="outline" onClick={() => void read.refresh()}>
      Check status again
    </Button>
  );
  return (
    <ReadFeedback
      state={read.state}
      errorTitle="Could not load the review"
      retry={retry}
      refreshError={message => <ReadError message={message}>{retry}</ReadError>}
      loading={<p role="status">Loading skill review…</p>}
      unavailable={() => (
        <StatePanel
          kind="unavailable"
          title="Review unavailable"
          description="This import is private to the person who started it, or your access changed."
        >
          {retry}
        </StatePanel>
      )}
    >
      {view => (
        <ImportReview
          key={`${view.id}/${view.status}`}
          view={view}
          api={api}
          refresh={read.refresh}
          delayed={read.delayed}
          onOpen={onOpen}
          onInstalled={onInstalled}
          onRestart={onRestart}
        />
      )}
    </ReadFeedback>
  );
}

function ImportReview({
  view,
  api,
  refresh,
  delayed,
  onOpen,
  onInstalled,
  onRestart,
}: {
  view: SkillImportView;
  api: ReturnType<typeof skillImportApi>;
  refresh: () => Promise<void>;
  delayed: boolean;
} & ImportNavigation) {
  const { workspace } = workspaceRoute.useRouteContext();
  const changed = useSkillChanges();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const [selected, setSelected] = useState(
    view.selected.length ? view.selected : view.candidates.length === 1 ? [view.candidates[0]!.id] : [],
  );
  const [acknowledgeWarnings, setAcknowledgeWarnings] = useState(false);
  const [replaceLocalChanges, setReplaceLocalChanges] = useState(false);
  const [chosenLink, setChosenLink] = useState(view.links[0] ?? '');
  const navigate = useNavigate();
  const open = (id: string) =>
    onOpen
      ? onOpen(id)
      : void navigate({
          to: '/$workspaceSlug/skills/import/$importId',
          params: { workspaceSlug: workspace.slug, importId: id },
        });
  type Command =
    | { kind: 'select'; selected: string[] }
    | { kind: 'cancel' }
    | { kind: 'follow'; id: string; url: string }
    | {
        kind: 'approve';
        commandId: string;
        digest: string;
        selected: string[];
        acknowledgeWarnings: boolean;
        replaceLocalChanges: boolean;
      };
  const write = useTableWrite(
    async (command: Command) => {
      if (command.kind === 'select') await api.select(view.id, command.selected);
      else if (command.kind === 'cancel') await api.cancel(view.id);
      else if (command.kind === 'follow') open((await api.prepare(command.id, { kind: 'url', url: command.url })).id);
      else {
        const { kind: _kind, ...decision } = command;
        const receipts = await api.approve(view.id, decision);
        await Promise.all(receipts.map(receipt => changed(receipt.id)));
      }
    },
    () => {
      void refresh();
    },
  );
  const busy = write.state.kind === 'sending' || write.state.kind === 'uncertain';
  const pending = ['pending', 'preparing', 'pending-review', 'reviewing'].includes(view.status);
  const candidates =
    view.status === 'ready'
      ? view.candidates.filter(candidate => view.selected.includes(candidate.id))
      : view.candidates;
  const findings = candidates.flatMap(candidate =>
    candidate.report ? [...candidate.report.deterministic, ...candidate.report.ai.findings] : [],
  );
  const blocked = findings.some(finding => finding.severity === 'blocked');
  const high = findings.some(finding => finding.severity === 'high');
  const restart = onRestart ? (
    <Button variant="outline" onClick={onRestart}>
      Start a new import
    </Button>
  ) : (
    <Button
      variant="outline"
      nativeButton={false}
      render={<Link to="/$workspaceSlug/skills/import" params={{ workspaceSlug: workspace.slug }} />}
    >
      Start a new import
    </Button>
  );
  return (
    <section className="min-w-0 space-y-6">
      <h2 ref={heading} tabIndex={-1} className="text-base font-medium">
        {view.input.kind === 'draft' ? 'Created in chat' : 'From a public source'}
      </h2>
      {view.input.url && <p className="break-all text-sm text-muted-foreground">{view.input.url}</p>}
      {pending && (
        <StatePanel
          kind="loading"
          title={
            delayed
              ? 'This is taking longer'
              : view.status === 'pending' || view.status === 'preparing'
                ? 'Reading the source'
                : 'Reviewing selected skills'
          }
          description={
            delayed
              ? 'The job may still be running. You can leave and return to this review.'
              : 'The job continues if you leave this page.'
          }
        >
          <Button variant="outline" onClick={() => void refresh()}>
            Check status again
          </Button>
        </StatePanel>
      )}
      {view.status === 'discovered' && (
        <Form
          disabled={busy}
          onSubmit={() => {
            if (!busy && selected.length > 0 && selected.length <= 16) void write.submit({ kind: 'select', selected });
          }}
        >
          <div className="space-y-4">
            <ChoiceGroup
              type="checkbox"
              legend="Choose skills to review"
              required
              value={selected}
              onValueChange={setSelected}
              helper="Choose up to 16 packages. Only these packages receive the metered AI review."
              options={view.candidates.map(candidate => ({
                value: candidate.id,
                label: candidate.definition.name,
                description: `${candidate.path || 'Root package'} — ${candidate.definition.package?.manifest.metadata.description ?? ''}`,
              }))}
            />
            <FormFooter
              dirty={false}
              submit={{
                label: 'Review selected skills',
                pendingLabel: 'Starting review…',
                state: busy
                  ? { kind: 'busy' }
                  : !selected.length || selected.length > 16
                    ? { kind: 'blocked', reason: 'Choose between 1 and 16 skills.' }
                    : { kind: 'ready' },
              }}
              note="Review uses normal workspace Credits."
            />
          </div>
        </Form>
      )}
      {view.status === 'ready' && (
        <>
          {candidates.map(candidate => (
            <section key={candidate.id} className="min-w-0 space-y-3 border-b pb-5">
              <h3 className="break-words text-lg font-medium">{candidate.definition.name}</h3>
              <p>{candidate.definition.package?.manifest.metadata.description}</p>
              <p className="break-all text-sm text-muted-foreground">
                {candidate.source.canonicalUrl === 'chat' ? 'Created in chat' : candidate.source.canonicalUrl}
              </p>
              {candidate.report && (
                <>
                  <p>{candidate.report.ai.summary}</p>
                  <p className="text-sm text-muted-foreground">
                    Safety review is advice, not proof that this skill is safe.
                  </p>
                  {[...candidate.report.deterministic, ...candidate.report.ai.findings].map((finding, index) => (
                    <p key={index} className="break-words text-sm">
                      <strong>
                        {finding.severity === 'blocked'
                          ? 'Blocked'
                          : finding.severity === 'high'
                            ? 'High warning'
                            : 'Note'}
                        :{' '}
                      </strong>
                      {finding.message}{' '}
                      <span className="text-muted-foreground">
                        {finding.path}
                        {finding.line ? `:${finding.line}` : ''}
                      </span>
                    </p>
                  ))}
                  {!!candidate.report.unreviewedFiles.length && (
                    <p className="break-words text-sm">
                      Not reviewed as text: {candidate.report.unreviewedFiles.join(', ')}.
                    </p>
                  )}
                </>
              )}
              <Disclosure title="Read the procedure">
                <p className="whitespace-pre-wrap break-words">{candidate.definition.instructions}</p>
              </Disclosure>
              {candidate.changes && (
                <Disclosure title="File changes">
                  <ul className="space-y-1">
                    {candidate.changes.map(change => (
                      <li key={change.path} className="break-all text-sm">
                        {change.kind}: {change.path}
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              )}
              {candidate.definition.package && (
                <Disclosure title="Read package files">
                  <PackageFiles
                    identity={`${view.id}/${candidate.id}`}
                    files={candidate.definition.package.manifest.files}
                    load={(path, offset, signal) => api.preview(view.id, candidate.id, path, offset, signal)}
                  />
                </Disclosure>
              )}
              <Disclosure title="Files and details">
                <ul className="space-y-1">
                  {candidate.definition.package?.manifest.files.map(file => (
                    <li key={file.path} className="break-all text-sm">
                      {file.path} <span className="text-muted-foreground">({file.size.toLocaleString()} bytes)</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-sm">
                  License: {candidate.definition.package?.manifest.metadata.license ?? 'Not supplied'}
                </p>
                <p className="break-all text-xs">Package: {candidate.definition.package?.digest}</p>
                <p className="text-sm">Scripts: fixed Bash, Python, or Node; no network or dependency installation.</p>
              </Disclosure>
            </section>
          ))}
          {high && (
            <CheckboxField
              label="I have read the high-risk warnings"
              checked={acknowledgeWarnings}
              onCheckedChange={setAcknowledgeWarnings}
              disabled={busy}
            />
          )}
          {view.input.target && view.input.kind === 'url' && (
            <CheckboxField
              label="Replace the current package with these files"
              helper="This replaces local edits and removes files missing from the new package. To keep selected local changes, ask chat to merge the packages instead."
              checked={replaceLocalChanges}
              onCheckedChange={setReplaceLocalChanges}
              disabled={busy}
            />
          )}
          <ActionButton
            pendingLabel="Installing skills…"
            state={
              busy
                ? { kind: 'busy' }
                : blocked
                  ? { kind: 'blocked', reason: 'Resolve the blocked findings in a new package before installing.' }
                  : high && !acknowledgeWarnings
                    ? { kind: 'blocked', reason: 'Read and acknowledge the high-risk warnings first.' }
                    : view.input.target && view.input.kind === 'url' && !replaceLocalChanges
                      ? { kind: 'blocked', reason: 'Confirm that this update may replace the current files.' }
                      : { kind: 'ready' }
            }
            onClick={() => {
              if (view.digest)
                void write.submit({
                  kind: 'approve',
                  commandId: crypto.randomUUID(),
                  digest: view.digest,
                  selected: view.selected,
                  acknowledgeWarnings,
                  replaceLocalChanges,
                });
            }}
          >
            Install and enable
          </ActionButton>
          <p className="text-sm text-muted-foreground">
            Saves and enables these exact versions privately. Sharing, tools, and data access stay unchanged.
          </p>
        </>
      )}
      {view.status === 'installed' && (
        <StatePanel
          kind="success"
          title="Skills installed and enabled"
          description="These exact versions are ready to use."
        >
          {onInstalled ? (
            <Button onClick={() => onInstalled(view.receipts)}>Add installed skills to agent</Button>
          ) : (
            view.receipts.map((receipt, index) => (
              <Button
                key={receipt.id}
                nativeButton={false}
                render={
                  <Link
                    to="/$workspaceSlug/skills/$skillId"
                    params={{ workspaceSlug: workspace.slug, skillId: receipt.id }}
                  />
                }
              >
                Open{' '}
                {view.candidates.find(candidate => candidate.id === view.selected[index])?.definition.name ??
                  'installed skill'}
              </Button>
            ))
          )}
        </StatePanel>
      )}
      {view.status === 'page' && (
        <StatePanel
          kind="empty"
          title="This page has no skill package"
          description="Ask chat to help turn the page into a skill for your review."
        >
          <Button
            nativeButton={false}
            render={
              <Link
                to="/$workspaceSlug"
                params={{ workspaceSlug: workspace.slug }}
                search={{ intent: 'create-skill' }}
              />
            }
          >
            Ask chat to make a skill
          </Button>
          {restart}
        </StatePanel>
      )}
      {view.status === 'links' && (
        <Form
          disabled={busy}
          onSubmit={() => {
            if (chosenLink && !busy) void write.submit({ kind: 'follow', id: crypto.randomUUID(), url: chosenLink });
          }}
        >
          <div className="space-y-4">
            <ChoiceGroup
              type="radio"
              legend="Choose a published package link"
              required
              value={chosenLink}
              onValueChange={setChosenLink}
              options={view.links.map(link => ({ value: link, label: link }))}
            />
            <FormFooter
              dirty={false}
              submit={{
                label: 'Find skills',
                pendingLabel: 'Finding skills…',
                state: busy ? { kind: 'busy' } : { kind: 'ready' },
              }}
            />
          </div>
        </Form>
      )}
      {view.status === 'unchanged' && (
        <StatePanel
          kind="success"
          title="Already up to date"
          description="The source package has the same files. No review Credits were used and no saved revision changed."
        >
          {view.input.target && (
            <Button
              variant="outline"
              nativeButton={false}
              render={
                <Link
                  to="/$workspaceSlug/skills/$skillId"
                  params={{ workspaceSlug: workspace.slug, skillId: view.input.target.id }}
                />
              }
            >
              Back to skill
            </Button>
          )}
        </StatePanel>
      )}
      {['failed', 'cancelled', 'expired'].includes(view.status) && (
        <StatePanel
          kind={view.status === 'failed' ? 'error' : 'unavailable'}
          title={
            view.status === 'expired'
              ? 'Review expired'
              : view.status === 'cancelled'
                ? 'Import cancelled'
                : 'Could not prepare this skill'
          }
          description={
            view.error
              ? (importErrors[view.error] ?? 'Preparation stopped. Check the source and try a new import.')
              : 'No skill was installed from this review.'
          }
        >
          {restart}
        </StatePanel>
      )}
      <WriteFeedback
        state={write.state}
        checkStatus={() => void refresh()}
        retry={command => void write.submit(command)}
      />
      {!['installed', 'cancelled', 'expired', 'unchanged'].includes(view.status) && (
        <ActionButton
          variant="ghost"
          pendingLabel="Cancelling import…"
          state={busy ? { kind: 'busy' } : { kind: 'ready' }}
          onClick={() => void write.submit({ kind: 'cancel' })}
        >
          Cancel import
        </ActionButton>
      )}
    </section>
  );
}
