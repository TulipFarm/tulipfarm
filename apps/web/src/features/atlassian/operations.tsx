import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { isWrite, type ProviderOperation } from '@tulipfarm/atlassian/operation-contracts';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@tulipfarm/sprout/accordion';
import { Button } from '@tulipfarm/sprout/button';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { ResultCard } from '@tulipfarm/sprout/result-card';
import { Disclosure } from '@/components/disclosure';
import { Textarea } from '@tulipfarm/sprout/textarea';
import {
  atlassianApi,
  atlassianError,
  rejected,
  type Source,
  type Proposal,
  type ProposalRequest,
  type ProviderData,
} from '@/lib/atlassian';
import { initialFields, operationDefinitions, operationKinds, parseOperation } from './operation-fields';
import { ProviderResult } from './result';
import {
  useAtlassianRecovery,
  useAtlassianProposal,
  useAtlassianOperation,
  useIntegrationChanges,
} from '@/features/integrations/queries';

type WriteState =
  | { kind: 'draft' }
  | { kind: 'proposal-pending' | 'proposal-uncertain' | 'proposal-rejected'; request: ProposalRequest }
  | {
      kind: 'review';
      request: ProposalRequest | null;
      proposal: Proposal;
      executionAttempted: boolean;
      decisionUncertain: boolean;
    };
type ReadState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error' } | { kind: 'result'; data: ProviderData };

export function Operations({
  workspaceId,
  sources,
  mcpEnabled,
  available,
}: {
  workspaceId: string;
  sources: Source[];
  mcpEnabled: boolean;
  available: boolean;
}) {
  const [sourceId, setSourceId] = useState('');
  const [kind, setKind] = useState<ProviderOperation['kind']>('jira.search');
  const [values, setValues] = useState<Record<string, string>>(() => initialFields('jira.search'));
  const [included, setIncluded] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [write, setWrite] = useState<WriteState>({ kind: 'draft' });
  const recover = useAtlassianRecovery(workspaceId);
  const changes = useIntegrationChanges();
  const review = useAtlassianProposal(
    workspaceId,
    write.kind === 'review' ? write.proposal.id : '',
    write.kind === 'review',
  );
  const [readInput, setReadInput] = useState<Parameters<typeof atlassianApi.read>[1] | null>(null);
  const operationRead = useAtlassianOperation(workspaceId, readInput);
  const read: ReadState =
    readInput === null
      ? { kind: 'idle' }
      : operationRead.state.kind === 'ready'
        ? { kind: 'result', data: operationRead.state.data.data }
        : operationRead.state.kind === 'loading'
          ? { kind: 'loading' }
          : { kind: 'error' };
  const currentProposal = review.data;
  const reviewBlocked = review.busy || !!review.error;
  useEffect(() => {
    if (currentProposal)
      setWrite(previous =>
        previous.kind === 'review' && previous.proposal.id === currentProposal.id
          ? { ...previous, proposal: currentProposal }
          : previous,
      );
  }, [currentProposal]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [recoverId, setRecoverId] = useState('');
  const [reconciled, setReconciled] = useState(false);
  const lock = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const admittedSourceId =
    write.kind === 'review' ? write.proposal.source.id : write.kind !== 'draft' ? write.request.sourceId : sourceId;
  const source = sources.find(item => item.id === admittedSourceId && item.enabled);
  const allowed =
    available &&
    source !== undefined &&
    (source.binding.kind === 'trello' || source.binding.kind === 'confluence-trash' || mcpEnabled);
  const renderedReviewId =
    allowed && write.kind === 'review' && review.state.kind === 'ready' ? write.proposal.id : null;
  useEffect(() => {
    if (renderedReviewId !== null) heading.current?.focus();
  }, [renderedReviewId]);
  const definition = operationDefinitions[kind];
  const writeKind = !kind.endsWith('.read') && !kind.endsWith('.search');
  function selectKind(next: ProviderOperation['kind']) {
    setKind(next);
    setValues(initialFields(next));
    setIncluded([]);
    setErrors({});
    setReadInput(null);
    setMessage(null);
  }
  async function run(label: string, action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(label);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage(atlassianError(error));
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }
  async function propose(request: ProposalRequest) {
    const recovering = write.kind === 'proposal-uncertain';
    setWrite({ kind: 'proposal-pending', request });
    try {
      const proposal = await atlassianApi.propose(workspaceId, request);
      await changes.content('atlassian');
      setWrite({ kind: 'review', request, proposal, executionAttempted: false, decisionUncertain: false });
    } catch (error) {
      setWrite({ kind: rejected(error) && !recovering ? 'proposal-rejected' : 'proposal-uncertain', request });
      throw error;
    }
  }
  function submit() {
    if (!allowed || lock.current || write.kind !== 'draft') return;
    const parsed = parseOperation(kind, values, included);
    if (!parsed.success) {
      const fields = Object.fromEntries(
        parsed.error.issues.map(issue => [String(issue.path.at(-1) ?? 'form'), issue.message]),
      );
      setErrors(fields);
      setMessage('Check the highlighted fields. Updates need at least one selected change.');
      return;
    }
    setErrors({});
    if (isWrite(parsed.data)) {
      const request = { commandId: crypto.randomUUID(), sourceId, operation: parsed.data };
      void run('Preparing review', () => propose(request));
    } else {
      const input = { sourceId, operation: parsed.data };
      if (JSON.stringify(input) === JSON.stringify(readInput)) void operationRead.refresh();
      else setReadInput(input);
    }
  }
  function checkProposal() {
    if (!allowed || write.kind !== 'review') return;
    const current = write;
    void run('Checking saved receipt', async () => {
      const proposal = await recover(current.proposal.id);
      if (proposal.receipt) await changes.content('atlassian');
      setWrite({ ...current, proposal, decisionUncertain: false });
    });
  }
  function decide(decision: 'approve' | 'reject') {
    if (!allowed || reviewBlocked || write.kind !== 'review' || write.proposal.decision || write.decisionUncertain)
      return;
    const current = write;
    void run(decision === 'approve' ? 'Approving action' : 'Rejecting action', async () => {
      setWrite({ ...current, decisionUncertain: true });
      const proposal = await atlassianApi.decide(workspaceId, current.proposal, decision);
      await changes.content('atlassian');
      setWrite({ ...current, proposal, decisionUncertain: false });
    });
  }
  function execute() {
    if (
      !allowed ||
      reviewBlocked ||
      write.kind !== 'review' ||
      write.executionAttempted ||
      write.proposal.receipt ||
      write.proposal.decision !== 'approve'
    )
      return;
    const current = write;
    void run('Executing approved action', async () => {
      setWrite({ ...current, executionAttempted: true });
      const receipt = await atlassianApi.execute(workspaceId, current.proposal.id);
      await changes.content('atlassian');
      setWrite({ ...current, executionAttempted: true, proposal: { ...current.proposal, receipt } });
    });
  }
  const proposal = write.kind === 'review' ? write.proposal : null;
  const receipt = proposal?.receipt;
  const uncertain =
    write.kind === 'review' &&
    (receipt?.status === 'outcome-unknown' ||
      receipt?.status === 'executing' ||
      (write.executionAttempted && !receipt));
  const expired = proposal !== null && Date.parse(proposal.expiresAt) <= Date.now();
  if (!available || (admittedSourceId !== '' && !source))
    return (
      <StatePanel
        kind="unavailable"
        title="Operation access unavailable"
        description="Refresh Atlassian integrations to check account and source access. Your draft and command reference are retained privately. Restoring access does not send a write."
      />
    );
  if (write.kind === 'review' && review.state.kind !== 'ready')
    return (
      <StatePanel
        kind={
          review.state.kind === 'loading' ? 'loading' : review.state.kind === 'unavailable' ? 'unavailable' : 'error'
        }
        title="Checking saved action"
        description="The private review is hidden until its current access and saved status are confirmed."
      >
        <Button variant="outline" disabled={review.busy} onClick={() => void review.refresh()}>
          Check saved receipt
        </Button>
      </StatePanel>
    );
  return (
    <section className="min-w-0 space-y-4 border-t border-border pt-6" aria-labelledby="atlassian-operations-heading">
      <h3 id="atlassian-operations-heading" className="text-base font-medium">
        Run an operation
      </h3>
      <p className="text-muted-foreground">
        Search and read run immediately. Writes require a saved review, your decision, and a separate execution action.
      </p>
      <form
        className="space-y-4"
        onSubmit={event => {
          event.preventDefault();
          submit();
        }}
      >
        <fieldset disabled={busy !== null || write.kind !== 'draft'} className="grid min-w-0 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="operation-source">Operation source</Label>
            <Select
              value={sourceId}
              onValueChange={value => {
                const selected = sources.find(item => item.id === value);
                setSourceId(value ?? '');
                const first = operationKinds.find(item => operationDefinitions[item].source === selected?.binding.kind);
                if (first) selectKind(first);
              }}
            >
              <SelectTrigger id="operation-source" width="full">
                <SelectValue placeholder="Select a source">{source?.name.slice(0, 40)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Select a source</SelectItem>
                {sources
                  .filter(item => item.enabled)
                  .map(item => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name.slice(0, 40)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="operation-kind">Operation</Label>
            <Select
              value={kind}
              disabled={!source}
              onValueChange={value => {
                const next = operationKinds.find(item => item === value);
                if (next) selectKind(next);
              }}
            >
              <SelectTrigger id="operation-kind" width="full">
                <SelectValue>{definition.label}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {operationKinds
                  .filter(item => operationDefinitions[item].source === (source?.binding.kind ?? 'jira'))
                  .map(item => (
                    <SelectItem key={item} value={item}>
                      {operationDefinitions[item].label}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          {source &&
            definition.fields.map(field => (
              <div key={field.key} className="min-w-0 space-y-2">
                <Label htmlFor={`operation-${field.key}`}>{field.label}</Label>
                {field.optional && (
                  <Label>
                    <Checkbox
                      checked={included.includes(field.key)}
                      onCheckedChange={checked =>
                        setIncluded(current =>
                          checked === true ? [...current, field.key] : current.filter(key => key !== field.key),
                        )
                      }
                    />
                    Include {field.label.toLowerCase()}
                  </Label>
                )}
                {field.kind === 'multiline' ? (
                  <Textarea
                    id={`operation-${field.key}`}
                    value={values[field.key] ?? ''}
                    disabled={field.optional && !included.includes(field.key)}
                    onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))}
                    aria-invalid={Boolean(errors[field.key])}
                    aria-describedby={`operation-${field.key}-help operation-${field.key}-error`}
                  />
                ) : field.kind === 'boolean' ? (
                  <Select
                    value={values[field.key] ?? 'false'}
                    disabled={field.optional && !included.includes(field.key)}
                    onValueChange={value => setValues(current => ({ ...current, [field.key]: value ?? 'false' }))}
                  >
                    <SelectTrigger id={`operation-${field.key}`} width="full">
                      <SelectValue>{values[field.key] === 'true' ? 'Yes' : 'No'}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="false">No</SelectItem>
                      <SelectItem value="true">Yes</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id={`operation-${field.key}`}
                    type={field.kind === 'number' ? 'number' : 'text'}
                    value={values[field.key] ?? ''}
                    disabled={field.optional && !included.includes(field.key)}
                    onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))}
                    aria-invalid={Boolean(errors[field.key])}
                    aria-describedby={`operation-${field.key}-help operation-${field.key}-error`}
                  />
                )}
                <p id={`operation-${field.key}-help`} className="text-sm text-muted-foreground">
                  {field.help}
                </p>
                <p id={`operation-${field.key}-error`} className="text-sm text-destructive">
                  {errors[field.key]}
                </p>
              </div>
            ))}
        </fieldset>
        {source && !allowed && (
          <p>
            Operations are unavailable for this source. Refresh sources and check account access or the MCP
            configuration above.
          </p>
        )}
        {kind.endsWith('.delete') && <p>Deletion is permanent. Review the exact object ID before approving.</p>}
        {kind === 'confluence.trash' && (
          <p>This moves a current page to trash. It does not purge pages or discard drafts.</p>
        )}
        <Button type="submit" disabled={!allowed || busy !== null || write.kind !== 'draft'} aria-busy={busy !== null}>
          {writeKind ? 'Prepare write review' : read.kind === 'error' ? 'Retry read' : definition.label}
        </Button>
      </form>
      {busy && <p role="status">{busy}…</p>}
      {read.kind === 'loading' && <p role="status">Reading provider…</p>}
      {readInput &&
        (operationRead.state.kind === 'error' ||
          (operationRead.state.kind === 'ready' && operationRead.state.error)) && (
          <p role="alert">Provider read could not refresh. Retry the read to check its status.</p>
        )}
      {message && (
        <Alert variant="destructive">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      {allowed && (
        <>
          {available && read.kind === 'result' && (
            <section className="space-y-3" aria-label="Operation results">
              <h4 className="font-medium">Read results</h4>
              {(Array.isArray(read.data) && read.data.length === 0) ||
              (read.data !== null &&
                typeof read.data === 'object' &&
                !Array.isArray(read.data) &&
                Object.entries(read.data).some(
                  ([key, value]) =>
                    ['issues', 'results', 'cards'].includes(key) && Array.isArray(value) && value.length === 0,
                )) ? (
                <StatePanel
                  kind="empty"
                  title="No matching results"
                  description="Change the search query above and search again."
                />
              ) : null}
              <ProviderResult value={read.data} />
            </section>
          )}
          {write.kind !== 'draft' && (
            <p className="break-all text-sm text-muted-foreground">
              Command reference {write.request?.commandId ?? 'Recovered from saved proposal'}. Keep this reference.
              Leaving this page discards the local form; save the proposal reference below to check its receipt later.
            </p>
          )}
          {write.kind === 'proposal-uncertain' && (
            <div className="space-y-3">
              <p>
                The proposal response is unconfirmed. Recovering repeats only the original proposal request with the
                same command ID and fields. It never executes the action.
              </p>
              <Button
                variant="outline"
                disabled={busy !== null || !available}
                onClick={() => {
                  const request = write.request;
                  void run('Recovering original review', () => propose(request));
                }}
              >
                Recover original review
              </Button>
            </div>
          )}
          {write.kind === 'proposal-rejected' && (
            <div className="space-y-3">
              <p>
                The proposal request was rejected. No execution was requested. Check account and source access, then
                correct the form.
              </p>
              <Button variant="outline" disabled={busy !== null} onClick={() => setWrite({ kind: 'draft' })}>
                Edit rejected request
              </Button>
            </div>
          )}
          {write.kind === 'review' && (
            <section
              className="min-w-0 space-y-4 rounded-lg border border-border p-4"
              aria-label="Immutable write review"
            >
              {review.error && (
                <p role="alert">The saved action could not refresh. Check its receipt before approving or executing.</p>
              )}
              <h4 ref={heading} tabIndex={-1} className="sr-only">
                Review saved action
              </h4>
              <ResultCard
                title={`${operationDefinitions[write.proposal.operation.kind].label} on ${write.proposal.source.name}`}
                kind="Action"
                status={
                  receipt?.status === 'succeeded'
                    ? 'Confirmed by provider'
                    : uncertain
                      ? 'Outcome not confirmed'
                      : receipt?.status === 'failed'
                        ? 'Action failed'
                        : write.decisionUncertain
                          ? 'Decision not confirmed'
                          : write.proposal.decision === 'reject'
                            ? 'Action rejected'
                            : expired
                              ? 'Review expired'
                              : write.proposal.decision === 'approve'
                                ? 'Approved · Not executed yet'
                                : 'Waiting for review'
                }
                state={
                  receipt?.status === 'succeeded'
                    ? 'success'
                    : uncertain || write.decisionUncertain || receipt?.status === 'failed'
                      ? 'error'
                      : 'default'
                }
                apps={[
                  {
                    brand: write.proposal.operation.kind.startsWith('jira.')
                      ? 'jira'
                      : write.proposal.operation.kind.startsWith('confluence.')
                        ? 'confluence'
                        : 'trello',
                    name: write.proposal.operation.kind.startsWith('jira.')
                      ? 'Jira'
                      : write.proposal.operation.kind.startsWith('confluence.')
                        ? 'Confluence'
                        : 'Trello',
                    actions: [
                      {
                        label: operationDefinitions[write.proposal.operation.kind].label,
                        state:
                          receipt?.status === 'succeeded'
                            ? 'completed'
                            : uncertain
                              ? 'unknown'
                              : receipt?.status === 'failed'
                                ? 'failed'
                                : expired || write.proposal.decision === 'reject'
                                  ? 'cancelled'
                                  : 'pending',
                      },
                    ],
                  },
                ]}
              />
              <Disclosure title="Action details">
                <dl className="space-y-2 text-sm">
                  <div>
                    <dt className="font-medium">Proposal reference</dt>
                    <dd className="break-all">{write.proposal.id}</dd>
                  </div>
                  <div>
                    <dt className="font-medium">Account reference</dt>
                    <dd className="break-all">{write.proposal.source.accountId}</dd>
                  </div>
                  <div>
                    <dt className="font-medium">Source binding</dt>
                    <dd className="break-all">{JSON.stringify(write.proposal.source.binding)}</dd>
                  </div>
                  <div>
                    <dt className="font-medium">Exact-action digest</dt>
                    <dd className="break-all">{write.proposal.digest}</dd>
                  </div>
                  <div>
                    <dt className="font-medium">Expires</dt>
                    <dd>{new Date(write.proposal.expiresAt).toLocaleString()}</dd>
                  </div>
                </dl>
                <pre className="overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-sm">
                  {JSON.stringify(write.proposal.operation, null, 2)}
                </pre>
              </Disclosure>
              <p>These saved fields cannot be edited. Approval authorizes only this exact action.</p>
              {expired && (
                <p role="status">This review has expired. Check the saved receipt before preparing another action.</p>
              )}
              {!write.proposal.decision && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={busy !== null || !available || reviewBlocked || expired || write.decisionUncertain}
                    onClick={() => decide('approve')}
                  >
                    Approve exact action
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy !== null || !available || reviewBlocked || write.decisionUncertain}
                    onClick={() => decide('reject')}
                  >
                    Reject action
                  </Button>
                </div>
              )}
              {write.decisionUncertain && (
                <p>The decision is unconfirmed. Check the saved receipt before making another decision.</p>
              )}
              {write.proposal.decision === 'reject' && <p role="status">Action rejected. It will not be executed.</p>}
              {write.proposal.decision === 'approve' && (
                <p role="status">Action approved. Execution is a separate action.</p>
              )}
              {write.proposal.decision === 'approve' && (
                <Button
                  disabled={
                    busy !== null ||
                    !available ||
                    reviewBlocked ||
                    expired ||
                    write.executionAttempted ||
                    write.proposal.receipt !== null
                  }
                  aria-busy={busy === 'Executing approved action'}
                  onClick={execute}
                >
                  Execute approved action
                </Button>
              )}
              {receipt && (
                <div className="space-y-3">
                  <h5 className="font-medium">Receipt · {receipt.status}</h5>
                  {receipt.status === 'succeeded' && <p role="status">The provider confirmed this action.</p>}
                  {receipt.status === 'failed' && (
                    <p>The provider request failed before dispatch. Correct the cause before preparing a new action.</p>
                  )}
                  {receipt.result !== null && <ProviderResult value={receipt.result} />}
                </div>
              )}
              {uncertain && (
                <Alert>
                  <AlertDescription>
                    This action may have succeeded. Do not replay it. Check the saved receipt and inspect the provider
                    before preparing a replacement. An executing receipt may remain uncertain after a server restart.
                  </AlertDescription>
                </Alert>
              )}
              <Button variant="outline" disabled={busy !== null} onClick={checkProposal}>
                Check saved receipt
              </Button>
              {(uncertain || (write.executionAttempted && !receipt)) && (
                <Label>
                  <Checkbox checked={reconciled} onCheckedChange={checked => setReconciled(checked === true)} />I
                  checked the provider and know whether a replacement is needed.
                </Label>
              )}
              {(write.proposal.decision === 'reject' || receipt || expired || reconciled) && (
                <Button
                  variant="outline"
                  disabled={busy !== null || (uncertain && !reconciled)}
                  onClick={() => {
                    setWrite({ kind: 'draft' });
                    setMessage(null);
                    setReconciled(false);
                  }}
                >
                  Prepare a new action
                </Button>
              )}
            </section>
          )}
        </>
      )}
      {write.kind === 'draft' && (
        <Accordion>
          <AccordionItem>
            <AccordionTrigger>Recover a saved proposal</AccordionTrigger>
            <AccordionContent>
              <div className="space-y-3">
                <p>
                  Enter a proposal reference to read its saved decision and receipt. Recovery never resends an
                  execution.
                </p>
                <Label htmlFor="recover-proposal">Proposal reference</Label>
                <Input id="recover-proposal" value={recoverId} onChange={event => setRecoverId(event.target.value)} />
                <Button
                  variant="outline"
                  disabled={busy !== null || !z.uuid().safeParse(recoverId).success}
                  onClick={() =>
                    void run('Loading saved proposal', async () => {
                      const recovered = await recover(recoverId);
                      setWrite({
                        kind: 'review',
                        request: null,
                        proposal: recovered,
                        executionAttempted: true,
                        decisionUncertain: false,
                      });
                    })
                  }
                >
                  Load saved proposal
                </Button>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}
    </section>
  );
}
