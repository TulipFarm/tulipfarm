import { useEffect, useRef, useState } from 'react';
import { actionEvidenceState, type BatchView } from '@tulipfarm/github/batch-contracts';
import { useGitHubBatches, useIntegrationChanges } from '@/features/integrations/queries';
import { decodeFileContent } from '@tulipfarm/github/file-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { apiOrigin } from '@/lib/auth';
import { githubOperationLabel } from '@tulipfarm/conversations/tool-activity';
import { ResultCard, type ResultAppAction } from '@tulipfarm/sprout/result-card';
import { useOptionalCanvas } from './canvas-state';
import { Disclosure } from '@/components/disclosure';

const evidenceMessages = {
  preparatory: 'Preparatory Git objects were saved. They do not confirm the branch update.',
  'confirmed-original-success': 'Provider evidence checked. The original success was confirmed.',
  unresolved: 'Provider evidence checked. The original outcome remains unresolved. No mutation was retried.',
  rejected: 'The action was rejected. Saved preparatory evidence does not confirm success.',
} satisfies Record<NonNullable<ReturnType<typeof actionEvidenceState>>, string>;

export function GitHubBatches({
  workspaceId,
  chatId,
  revision,
  task = false,
  variant = 'cards',
  batchId,
}: {
  workspaceId: string;
  chatId: string;
  revision: string;
  task?: boolean;
  variant?: 'cards' | 'review';
  batchId?: string;
}) {
  const canvas = useOptionalCanvas();
  const [selected, setSelected] = useState<string | null>(null);
  const read = useGitHubBatches(workspaceId, chatId, task);
  const state = read.state;
  const load = read.refresh;
  const changes = useIntegrationChanges();
  const [localBusy, setBusy] = useState<string | null>(null);
  const [localError, setError] = useState(false);
  const lock = useRef(false);
  const previousRevision = useRef(revision);
  const base = `${apiOrigin}/v1/workspaces/${workspaceId}/github/${task ? 'tasks' : 'chats'}/${chatId}/batches`;
  const mutation = batchId ? canvas?.actionMutations[`${base}/${batchId}`] : undefined;
  const busy = localBusy ?? (mutation === 'pending' ? batchId : null);
  const error = localError || mutation === 'uncertain';
  useEffect(() => {
    if (previousRevision.current === revision) return;
    previousRevision.current = revision;
    void changes.batches(chatId, task);
  }, [changes, chatId, revision, task]);
  async function act(batch: BatchView, action: 'approve' | 'reject' | 'execute' | 'reconcile') {
    if (busy || error || lock.current) return;
    lock.current = true;
    setBusy(batch.snapshot.id);
    setError(false);
    canvas?.setActionMutation(`${base}/${batch.snapshot.id}`, 'pending');
    try {
      const decision = action === 'approve' || action === 'reject';
      const response = await fetch(`${base}/${batch.snapshot.id}/${decision ? 'decision' : action}`, {
        method: 'POST',
        credentials: 'include',
        headers: decision ? { 'Content-Type': 'application/json' } : {},
        body: decision ? JSON.stringify({ digest: batch.digest, decision: action }) : null,
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) throw new Error('unconfirmed');
      await changes.content('github-personal');
      canvas?.setActionMutation(`${base}/${batch.snapshot.id}`, undefined);
    } catch {
      setError(true);
      canvas?.setActionMutation(`${base}/${batch.snapshot.id}`, 'uncertain');
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }
  async function reconcileStatus(id: string) {
    if (busy || lock.current) return;
    lock.current = true;
    setBusy(id);
    setError(false);
    canvas?.setActionMutation(`${base}/${id}`, 'pending');
    try {
      const response = await fetch(`${base}/${id}/reconcile-status`, {
        method: 'POST',
        credentials: 'include',
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error('unavailable');
      await changes.content('github-personal');
      canvas?.setActionMutation(`${base}/${id}`, undefined);
    } catch {
      setError(true);
      canvas?.setActionMutation(`${base}/${id}`, 'uncertain');
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }
  async function checkStatus() {
    const result = await load();
    if (!result) return;
    if (!mutation) setError(false);
    for (const batch of result.batches) {
      const settled =
        batch.decision === 'reject' ||
        batch.actions.some(action => action.status === 'unknown' || action.status === 'rejected') ||
        (batch.actions.length > 0 && batch.actions.every(action => action.status === 'succeeded'));
      const id = 'snapshot' in batch ? batch.snapshot.id : batch.id;
      if (settled && canvas?.actionMutations[`${base}/${id}`] === 'uncertain') {
        canvas.setActionMutation(`${base}/${id}`, undefined);
        setError(false);
      }
    }
  }
  if (state.kind === 'loading')
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Checking GitHub approvals…
      </p>
    );
  if (state.kind !== 'ready')
    return (
      <StatePanel
        kind={state.kind === 'unavailable' ? 'unavailable' : 'error'}
        title="GitHub approvals unavailable"
        description="Private batch details are hidden until current access can be checked."
      >
        <Button variant="outline" onClick={() => void load()}>
          Check approvals
        </Button>
      </StatePanel>
    );
  if (!state.data.batches.length) return null;
  const batches = state.data.batches.filter(
    batch => !batchId || ('snapshot' in batch ? batch.snapshot.id : batch.id) === batchId,
  );
  if (!batches.length)
    return (
      <StatePanel
        kind="unavailable"
        title="GitHub batch unavailable"
        description="This batch is no longer available with your current access."
      />
    );
  if (variant === 'cards')
    return (
      <section aria-label="GitHub approvals" className="space-y-3">
        {batches.map(batch => {
          const id = 'snapshot' in batch ? batch.snapshot.id : batch.id;
          const known = 'snapshot' in batch;
          const completed = batch.actions.filter(action => action.status === 'succeeded').length;
          const unknown = batch.actions.some(action => action.status === 'unknown');
          const rejected = batch.decision === 'reject' || batch.actions.some(action => action.status === 'rejected');
          const allDone = batch.actions.length > 0 && completed === batch.actions.length;
          const mutation = canvas?.actionMutations[`${base}/${id}`];
          const actionState = (status: string | undefined): ResultAppAction['state'] =>
            status === 'succeeded'
              ? 'completed'
              : status === 'unknown'
                ? 'unknown'
                : status === 'rejected'
                  ? 'failed'
                  : 'pending';
          return (
            <ResultCard
              key={id}
              id={`github-batch:${id}`}
              title="GitHub changes"
              kind="Action"
              status={
                mutation === 'pending'
                  ? 'Request in progress'
                  : mutation === 'uncertain'
                    ? 'Request not confirmed'
                    : !known
                      ? 'Private details unavailable'
                      : unknown
                        ? 'Some outcomes are unconfirmed'
                        : rejected
                          ? 'Action rejected'
                          : allDone
                            ? `${completed} ${completed === 1 ? 'action' : 'actions'} confirmed in GitHub`
                            : batch.expired
                              ? 'Approval expired'
                              : batch.decision === 'approve'
                                ? `${completed} of ${batch.actions.length} actions confirmed`
                                : 'Waiting for review'
              }
              state={
                mutation === 'pending'
                  ? 'running'
                  : mutation === 'uncertain' || unknown || rejected
                    ? 'error'
                    : known && allDone
                      ? 'success'
                      : 'default'
              }
              apps={[
                {
                  brand: 'github',
                  name: 'GitHub',
                  actions: known
                    ? batch.snapshot.actions.map((operation, index) => ({
                        label: githubOperationLabel(operation.kind) ?? 'GitHub action',
                        state: actionState(batch.actions[index]?.status),
                      }))
                    : [],
                },
              ]}
              action={{
                label: 'View GitHub changes',
                onClick: () =>
                  canvas
                    ? canvas.show({
                        id: `github-batch:${id}`,
                        title: 'GitHub changes',
                        content: { kind: 'github-batch', workspaceId, chatId, batchId: id, task },
                      })
                    : setSelected(id),
              }}
            />
          );
        })}
        {state.error && <p role="alert">Could not refresh GitHub changes. Open the batch to check its status.</p>}
        {!canvas && selected && (
          <GitHubBatches
            workspaceId={workspaceId}
            chatId={chatId}
            task={task}
            revision={revision}
            variant="review"
            batchId={selected}
          />
        )}
      </section>
    );
  return (
    <section aria-label="GitHub approvals" className="space-y-4">
      {busy && <p role="status">The request is still in progress. Do not submit it again.</p>}
      {(error || state.error) && (
        <div className="space-y-2">
          <p role="alert">The last request is unconfirmed. Check status before taking another action.</p>
          <Button variant="outline" disabled={!!busy || read.busy} onClick={() => void checkStatus()}>
            Check batch status
          </Button>
        </div>
      )}
      <fieldset disabled={!!state.error} className="min-w-0 space-y-4">
        {batches.map(batch =>
          !('snapshot' in batch) ? (
            <article key={batch.id} className="space-y-3 rounded-lg border p-4" aria-busy={busy === batch.id}>
              <h2 className="text-lg font-medium">GitHub batch status</h2>
              <p className="text-sm">
                Private details are hidden because current source or target access could not be verified. Status does
                not prove a missing target was deleted.
              </p>
              <ol>
                {batch.actions.map(action => (
                  <li key={action.ordinal}>
                    Action {action.ordinal + 1}: {action.status}
                  </li>
                ))}
              </ol>
              <Button variant="outline" disabled={!!busy} onClick={() => void load()}>
                Check private details
              </Button>
              {batch.actions.some(action => action.status === 'unknown') && (
                <Button variant="outline" disabled={!!busy} onClick={() => void reconcileStatus(batch.id)}>
                  Check provider outcome
                </Button>
              )}
            </article>
          ) : (
            <article
              key={batch.snapshot.id}
              className="space-y-3 rounded-lg border p-4"
              aria-busy={busy === batch.snapshot.id}
            >
              <h2 className="text-lg font-medium">Review GitHub changes</h2>
              <Disclosure title="Account details">
                <p className="text-sm break-all">
                  Account {batch.snapshot.accountId} · Generation {batch.snapshot.generation} · Selection{' '}
                  {batch.snapshot.selectionVersion}
                </p>
              </Disclosure>
              <p className="text-sm">
                {batch.expired ? 'Approval expired' : `Expires ${new Date(batch.snapshot.expiresAt).toLocaleString()}`}{' '}
                ·{' '}
                {batch.decision === 'approve'
                  ? 'Approved'
                  : batch.decision === 'reject'
                    ? 'Rejected'
                    : 'Awaiting your approval'}
              </p>
              <ol className="space-y-3">
                {batch.snapshot.actions.map((operation, index) => {
                  const evidence = actionEvidenceState(batch.actions[index]);
                  return (
                    <li key={index} className="space-y-1">
                      <h3 className="font-medium">
                        {index + 1}. {operation.kind} · {batch.actions[index]?.status}
                      </h3>
                      {'ownerType' in operation && 'ownerNodeId' in operation && (
                        <p className="text-sm break-words">
                          Project owner {operation.owner}, {operation.ownerType}, node {operation.ownerNodeId}. The
                          connected account must have current project rights. GitHub does not atomically compare
                          previous content or freeze permissions.
                        </p>
                      )}
                      {operation.kind === 'project.create' && (
                        <p className="text-sm">
                          Create project “{operation.title}”. Further changes require a new proposal with its returned
                          project identity. A lost acknowledgement cannot safely be retried.
                        </p>
                      )}
                      {(operation.kind === 'project.close' || operation.kind === 'project.reopen') && (
                        <p className="text-sm">
                          {operation.kind === 'project.close' ? 'Close' : 'Reopen'} project {operation.projectNumber} in{' '}
                          {operation.owner}. This does not archive or delete its items.
                        </p>
                      )}
                      {(operation.kind === 'project.delete' ||
                        operation.kind === 'project.field-delete' ||
                        operation.kind === 'project.item-delete') && (
                        <p className="text-sm text-destructive">
                          Permanently delete{' '}
                          {'itemId' in operation
                            ? `item ${operation.itemId} from the project`
                            : 'fieldId' in operation
                              ? `field ${operation.fieldId} and its values`
                              : `project ${operation.projectNumber} and its project data`}
                          . Linked repository issues and pull requests are not deleted. A missing object alone does not
                          prove success.
                        </p>
                      )}
                      {(operation.kind === 'project.field-create' || operation.kind === 'project.field-update') && (
                        <p className="text-sm">
                          Apply the exact {operation.field.dataType} field definition “{operation.field.name}”. The
                          supplied options or iterations replace their configuration. Omitted options may lose existing
                          values.
                        </p>
                      )}
                      {(operation.kind === 'project.item-archive' || operation.kind === 'project.item-unarchive') && (
                        <p className="text-sm">
                          {operation.kind === 'project.item-archive' ? 'Archive' : 'Unarchive'} item {operation.itemId}{' '}
                          in project {operation.projectNumber}. This does not close the linked issue or pull request.
                        </p>
                      )}
                      {operation.kind.startsWith('discussion.') && (
                        <p className="text-sm">
                          Apply only the reviewed Discussion change. Owner, repository, and existing object identities
                          are checked before dispatch. GitHub does not atomically compare the previous content. An
                          unconfirmed mutation is never retried automatically.
                        </p>
                      )}
                      {(operation.kind === 'discussion.delete' || operation.kind === 'discussion.comment-delete') && (
                        <p className="text-sm text-destructive">
                          Permanently delete{' '}
                          {operation.kind === 'discussion.delete'
                            ? `discussion ${operation.discussionId} and its comments`
                            : `comment ${operation.commentId}`}{' '}
                          in {operation.owner}/{operation.repo}. TulipFarm cannot undo this action. A missing object
                          alone does not confirm deletion.
                        </p>
                      )}
                      {operation.kind === 'discussion.create' && (
                        <p className="text-sm">
                          Creating a discussion can notify repository subscribers. Further changes require a new
                          proposal with its returned identity.
                        </p>
                      )}
                      {operation.kind === 'actions.dispatch' && (
                        <p className="text-sm">
                          Dispatch workflow {operation.workflowId} in {operation.owner}/{operation.repo} at ref{' '}
                          {operation.ref} with exactly the supplied inputs. GitHub resolves the branch or tag when it
                          starts the run and applies defaults for omitted inputs. This may consume runner minutes or
                          trigger deployment steps. A receipt confirms dispatch, not workflow success.
                        </p>
                      )}
                      {operation.kind === 'actions.rerun' && (
                        <p className="text-sm">
                          Request a rerun of{' '}
                          {operation.mode === 'failed' ? 'failed jobs and their dependents' : 'all jobs'} for run{' '}
                          {operation.runId}, reviewed attempt {operation.runAttempt}. The head and completed state are
                          checked before dispatch. GitHub cannot atomically pin the attempt. A receipt confirms the
                          request, not a new attempt number or workflow success.
                        </p>
                      )}
                      {operation.kind === 'actions.cancel' && (
                        <p className="text-sm text-destructive">
                          Request normal cancellation of run {operation.runId}, reviewed attempt {operation.runAttempt},
                          in {operation.owner}/{operation.repo}. This does not force-cancel jobs or undo completed
                          effects. GitHub cannot atomically pin the attempt. Acceptance does not mean cancellation has
                          finished.
                        </p>
                      )}
                      {operation.kind === 'actions.artifact-delete' && (
                        <p className="text-sm text-destructive">
                          Permanently delete Actions artifact {operation.artifactId} in {operation.owner}/
                          {operation.repo}, repository ID {operation.repositoryId}. TulipFarm cannot undo this action. A
                          missing artifact alone does not confirm deletion.
                        </p>
                      )}
                      {operation.kind === 'release.create' && (
                        <p className="text-sm">
                          Create a draft release. Publishing it requires a separate exact approval using its returned
                          release ID.
                        </p>
                      )}
                      {operation.kind === 'release.publish' && (
                        <p className="text-sm text-destructive">
                          Publish release {operation.releaseId} in {operation.owner}/{operation.repo} with the reviewed
                          notes and asset IDs. This makes the draft available to repository readers. GitHub does not
                          atomically check the reviewed timestamp or asset list.
                        </p>
                      )}
                      {(operation.kind === 'release.delete' || operation.kind === 'release.asset-delete') && (
                        <p className="text-sm text-destructive">
                          Permanently delete{' '}
                          {operation.kind === 'release.delete'
                            ? `release ${operation.releaseId} and its listed assets`
                            : `asset ${operation.assetId}`}{' '}
                          in {operation.owner}/{operation.repo}. TulipFarm cannot undo this action.
                        </p>
                      )}
                      {operation.kind === 'release.asset-upload' && (
                        <p className="text-sm break-all">
                          Upload {operation.name}, {operation.size} bytes, {operation.contentType}. SHA-256{' '}
                          {operation.sha256}. The approved base64 below is the complete immutable binary content.
                        </p>
                      )}
                      {batch.actions[index]?.status === 'unknown' && (
                        <p role="status" className="text-sm">
                          The original outcome is unknown. Do not repeat this action or propose a replacement. New
                          writes are blocked until provider evidence confirms the original outcome.
                        </p>
                      )}
                      {operation.kind === 'pull.merge' && (
                        <p className="text-sm text-destructive">
                          Merge {operation.owner}/{operation.repo} #{operation.pullNumber} into {operation.base} using{' '}
                          {operation.mergeMethod}. This changes the base branch. Only head {operation.headSha} is
                          approved.
                        </p>
                      )}
                      {operation.kind === 'pull.close' && (
                        <p className="text-sm">
                          Close {operation.owner}/{operation.repo} #{operation.pullNumber} without merging its changes.
                        </p>
                      )}
                      {operation.kind === 'repository.delete' && (
                        <p className="text-sm text-destructive">
                          Delete {operation.owner}/{operation.repo}, repository ID {operation.repositoryId}. This
                          permanently removes the repository and its contents. TulipFarm cannot undo this action.
                        </p>
                      )}
                      {operation.kind === 'branch.delete' && (
                        <p className="text-sm text-destructive">
                          Delete branch {operation.branch} in {operation.owner}/{operation.repo}. The reviewed head is{' '}
                          {operation.headSha}. GitHub does not provide an atomic head check for branch deletion.
                        </p>
                      )}
                      {operation.kind === 'repository.create' && (
                        <p className="text-sm">
                          Create a {operation.private ? 'private' : 'public'} repository in {operation.owner}. Further
                          writes require a new proposal using the returned repository ID.
                        </p>
                      )}
                      {(operation.kind === 'file.create' ||
                        operation.kind === 'file.update' ||
                        operation.kind === 'file.delete') && (
                        <p className="text-sm">
                          Commit this exact file change to {operation.owner}/{operation.repo} on {operation.branch}.
                          GitHub checks the old file identity for updates and deletions, but cannot atomically compare
                          the branch head through the Contents API. A concurrent branch change can leave the outcome
                          unresolved.
                        </p>
                      )}
                      {operation.kind === 'files.commit' && (
                        <p className="text-sm">
                          Commit all listed changes together on {operation.branch}. The final branch update is
                          non-force. Preparatory Git objects alone do not mean the branch changed.
                        </p>
                      )}
                      {operation.kind === 'pull.create-fork' && (
                        <p className="text-sm">
                          Open a pull request from {operation.headOwner}/{operation.headRepo}, branch {operation.head},
                          into {operation.owner}/{operation.repo}, branch {operation.base}. GitHub resolves the head
                          branch at creation time. The reviewed head is checked before dispatch, not atomically by
                          GitHub.
                        </p>
                      )}
                      <Disclosure title="Exact change">
                        <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-sm">
                          {JSON.stringify(operation, null, 2)}
                        </pre>
                        {(operation.kind === 'files.commit'
                          ? operation.files
                          : operation.kind === 'file.create' || operation.kind === 'file.update'
                            ? [operation]
                            : []
                        ).map(
                          file =>
                            'content' in file && (
                              <div key={file.path}>
                                <h4 className="text-sm font-medium">Exact text · {file.path}</h4>
                                <pre
                                  aria-label={`Exact text for ${file.path}`}
                                  className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-sm"
                                >
                                  {decodeFileContent(file)}
                                </pre>
                              </div>
                            ),
                        )}
                        {batch.actions[index]?.result && (
                          <pre className="whitespace-pre-wrap break-all text-sm">
                            {JSON.stringify(batch.actions[index]?.result, null, 2)}
                          </pre>
                        )}
                      </Disclosure>
                      {evidence && <p className="text-sm">{evidenceMessages[evidence]}</p>}
                    </li>
                  );
                })}
              </ol>
              <p className="text-sm text-muted-foreground">
                Actions run in this order and stop on failure or uncertainty. Recovery markers are part of the exact
                approved body or commit message. An approval cannot be edited.
              </p>
              <div className="flex flex-wrap gap-2">
                {!batch.decision && !batch.expired && (
                  <>
                    <Button disabled={!!busy || error} onClick={() => void act(batch, 'approve')}>
                      {busy === batch.snapshot.id ? 'Applying approved batch…' : 'Approve exact batch'}
                    </Button>
                    <Button variant="outline" disabled={!!busy || error} onClick={() => void act(batch, 'reject')}>
                      Reject batch
                    </Button>
                  </>
                )}
                {batch.actions.some(action => action.status === 'unknown') && (
                  <Button variant="outline" disabled={!!busy || error} onClick={() => void act(batch, 'reconcile')}>
                    Reconcile with GitHub
                  </Button>
                )}
                {!task &&
                  batch.decision === 'approve' &&
                  !batch.expired &&
                  batch.actions.some(action => action.status === 'unattempted') &&
                  batch.actions.every(action => ['succeeded', 'unattempted'].includes(action.status)) && (
                    <Button variant="outline" disabled={!!busy || error} onClick={() => void act(batch, 'execute')}>
                      Continue unattempted actions
                    </Button>
                  )}
                {task && batch.decision === 'approve' && (
                  <p role="status">
                    Approval saved. The task worker resumes eligible actions and records their outcomes.
                  </p>
                )}
              </div>
            </article>
          ),
        )}
      </fieldset>
    </section>
  );
}
