import { z } from 'zod';
import { GitHubBatchError, type GitHubWrite } from './batch-contracts.ts';
import type { GitHubCredential } from './accounts.ts';
import { repositoryPath } from './repository-writes.ts';

export type ActionsWrite = Extract<GitHubWrite, { kind: `actions.${string}` }>;
export function isActionsWrite(operation: GitHubWrite): operation is ActionsWrite {
  return operation.kind.startsWith('actions.');
}
export const actionsApiVersion = '2026-03-10';
export function actionsPath(operation: ActionsWrite) {
  const base = `${repositoryPath(operation)}/actions`;
  if (operation.kind === 'actions.dispatch') return `${base}/workflows/${operation.workflowId}`;
  if (operation.kind === 'actions.artifact-delete') return `${base}/artifacts/${operation.artifactId}`;
  return `${base}/runs/${operation.runId}`;
}
export function actionsRequest(operation: ActionsWrite) {
  const path = actionsPath(operation);
  switch (operation.kind) {
    case 'actions.dispatch':
      return { path: `${path}/dispatches`, method: 'POST', body: { ref: operation.ref, inputs: operation.inputs } };
    case 'actions.rerun':
      return { path: `${path}/${operation.mode === 'failed' ? 'rerun-failed-jobs' : 'rerun'}`, method: 'POST' };
    case 'actions.cancel':
      return { path: `${path}/cancel`, method: 'POST' };
    case 'actions.artifact-delete':
      return { path, method: 'DELETE' };
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}
export async function checkActionsTarget(
  operation: ActionsWrite,
  credential: GitHubCredential,
  read: (path: string) => Promise<unknown>,
  dispatch: boolean,
) {
  const repository = z
    .object({
      id: z.literal(operation.repositoryId),
      full_name: z.string(),
      archived: z.boolean(),
      permissions: z.object({ push: z.boolean() }),
    })
    .parse(await read(repositoryPath(operation)));
  if (
    repository.full_name.toLowerCase() !== `${operation.owner}/${operation.repo}`.toLowerCase() ||
    !credential.scopes.includes('repo') ||
    (dispatch && (repository.archived || !repository.permissions.push))
  )
    throw new GitHubBatchError('batch-conflict');
  if (!dispatch) return;
  if (operation.kind === 'actions.dispatch') {
    z.object({ id: z.literal(operation.workflowId), state: z.literal('active') }).parse(
      await read(actionsPath(operation)),
    );
    z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }).parse(
      await read(`${repositoryPath(operation)}/commits/${encodeURIComponent(operation.ref)}`),
    );
    return;
  }
  if (operation.kind === 'actions.artifact-delete') {
    z.object({ id: z.literal(operation.artifactId) }).parse(await read(actionsPath(operation)));
    return;
  }
  z.object({
    id: z.literal(operation.runId),
    workflow_id: z.literal(operation.workflowId),
    run_attempt: z.literal(operation.runAttempt),
    head_sha: z.literal(operation.headSha),
    status: z.literal(operation.expectedStatus),
    repository: z.object({ id: z.literal(operation.repositoryId) }),
  }).parse(await read(actionsPath(operation)));
}
export function actionsResult(operation: ActionsWrite, value: unknown) {
  const base = { repositoryId: operation.repositoryId };
  switch (operation.kind) {
    case 'actions.dispatch': {
      const result = z
        .object({
          workflow_run_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          run_url: z.string(),
          html_url: z.string(),
        })
        .parse(value);
      if (
        result.run_url.toLowerCase() !==
          `https://api.github.com/repos/${operation.owner}/${operation.repo}/actions/runs/${result.workflow_run_id}`.toLowerCase() ||
        result.html_url.toLowerCase() !==
          `https://github.com/${operation.owner}/${operation.repo}/actions/runs/${result.workflow_run_id}`.toLowerCase()
      )
        throw new GitHubBatchError('batch-unavailable');
      return {
        ...base,
        workflowId: operation.workflowId,
        runId: result.workflow_run_id,
        ref: operation.ref,
        providerAcknowledged: true,
      };
    }
    case 'actions.artifact-delete':
      z.null().parse(value);
      return { ...base, artifactId: operation.artifactId, deleted: true };
    case 'actions.rerun':
    case 'actions.cancel':
      z.union([z.null(), z.strictObject({})]).parse(value);
      return {
        ...base,
        workflowId: operation.workflowId,
        runId: operation.runId,
        approvedAttempt: operation.runAttempt,
        headSha: operation.headSha,
        providerAcknowledged: true,
        request: operation.kind === 'actions.rerun' ? 'rerun-requested' : 'cancellation-requested',
      };
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}
export function actionsMcpArguments(operation: Extract<ActionsWrite, { kind: 'actions.rerun' | 'actions.cancel' }>) {
  return {
    owner: operation.owner,
    repo: operation.repo,
    run_id: operation.runId,
    method:
      operation.kind === 'actions.cancel'
        ? 'cancel_workflow_run'
        : operation.mode === 'failed'
          ? 'rerun_failed_jobs'
          : 'rerun_workflow_run',
  };
}
export function actionsMcpResult(
  operation: Extract<ActionsWrite, { kind: 'actions.rerun' | 'actions.cancel' }>,
  value: unknown,
) {
  const cancel = operation.kind === 'actions.cancel';
  z.strictObject({
    run_id: z.literal(operation.runId),
    status_code: z.literal(cancel ? 202 : 201),
    status: z.literal(cancel ? '202 Accepted' : '201 Created'),
    message: z.literal(
      cancel
        ? 'Workflow run has been cancelled'
        : operation.mode === 'failed'
          ? 'Failed jobs have been queued for re-run'
          : 'Workflow run has been queued for re-run',
    ),
  }).parse(value);
  return actionsResult(operation, null);
}
