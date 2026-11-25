import { Context } from '@temporalio/activity';
import { Client, Connection } from '@temporalio/client';
import { z } from 'zod';
import { temporalConnectionOptions } from '@tulipfarm/config/temporal';
import type { ConversationRuntime } from '@tulipfarm/conversations/runtime';
import type { ExecutionBackend, ExecutionConfiguration } from '@tulipfarm/execution-contract';
import { codingAgentProviders, codingAgents, runCodingJob, type CodingJobOutcome } from '@tulipfarm/agents/coding-runs';
import { createGitHubAccounts, githubConfiguration } from '@tulipfarm/github';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { log } from '@tulipfarm/observability';
import { createWorkflows, type CodingStepRunner } from '@tulipfarm/workflows';
import type { CodingStepJob, CodingStepResult } from '@tulipfarm/workflows/contracts';
import { codingRunServices } from './coding-runs.ts';

const github = 'https://api.github.com';
const headers = (token: string) => ({
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${token}`,
  'x-github-api-version': '2022-11-28',
  'user-agent': 'TulipFarm',
});
const repositorySchema = z.object({ permissions: z.object({ push: z.boolean() }).partial().optional() });
const pullSchema = z.object({ number: z.number().int().positive(), html_url: z.string() });

type Account = { token: string; login: string; id: string };

/**
 * The member's GitHub account for the step, among their accounts on for coding: the login it names when that one is on
 * for coding, else the first that can push to the repository, or, without a pull request, read it. A named account on
 * for coding that cannot do so gives null instead of another account.
 */
export async function repositoryAccount(
  accounts: ReturnType<typeof createGitHubAccounts>,
  workspaceId: string,
  member: { membershipId: string; userId: string },
  job: CodingStepJob,
): Promise<Account | null> {
  const listed = await accounts.list(workspaceId, member.userId);
  const usable = listed.accounts.filter(account => account.state !== 'disconnected' && account.useForCoding);
  const named = job.githubAccount?.toLowerCase();
  const chosen = named ? usable.filter(account => account.identity?.login.toLowerCase() === named) : [];
  const candidates = chosen.length ? chosen : usable;
  let reader: Account | null = null;
  for (const account of candidates) {
    if (account.state !== 'active' || !account.identity) continue;
    const token = await accounts.memberAccessToken(workspaceId, member.membershipId, account.id).catch(() => null);
    if (!token) continue;
    const response = await fetch(`${github}/repos/${job.repository}`, { headers: headers(token) });
    if (!response.ok) continue;
    const found = { token, login: account.identity.login, id: account.identity.id };
    if (repositorySchema.parse(await response.json()).permissions?.push) return found;
    reader ??= found;
  }
  return job.pullRequest ? null : reader;
}

const firstLine = (text: string) =>
  Array.from(text.split('\n').find(line => line.trim()) ?? 'Changes from a coding agent')
    .slice(0, 72)
    .join('')
    .trim();

export async function openPullRequest(
  token: string,
  job: CodingStepJob,
  branch: string,
  base: string,
  body: string,
): Promise<{ number: number; url: string } | null> {
  const response = await fetch(`${github}/repos/${job.repository}/pulls`, {
    method: 'POST',
    headers: { ...headers(token), 'content-type': 'application/json' },
    body: JSON.stringify({ title: job.title ?? firstLine(job.prompt), head: branch, base, body }),
  });
  if (response.ok) {
    const pull = pullSchema.parse(await response.json());
    return { number: pull.number, url: pull.html_url };
  }
  // A retried job finds the pull request it opened before.
  const owner = job.repository.split('/')[0]!;
  const existing = await fetch(
    `${github}/repos/${job.repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    { headers: headers(token) },
  );
  if (!existing.ok) return null;
  const [pull] = z.array(pullSchema).parse(await existing.json());
  return pull ? { number: pull.number, url: pull.html_url } : null;
}

function failure(outcome: CodingJobOutcome): CodingStepResult | null {
  const error =
    outcome.status === 'clone-failed'
      ? 'clone-failed'
      : outcome.status === 'timed-out'
        ? 'timed-out'
        : outcome.status === 'push-failed'
          ? 'push-failed'
          : outcome.status === 'completed'
            ? null
            : 'agent-failed';
  if (!error) return null;
  return {
    kind: 'failed',
    error,
    message: Array.from(outcome.message).slice(0, 4000).join(''),
    ...(outcome.log ? { log: Array.from(outcome.log).slice(-4096).join('') } : {}),
  };
}

/** The activities that run workflow coding steps, outside the workflow's short advance activity. */
export function createWorkflowCodingActivities(
  runtime: ConversationRuntime,
  backend: ExecutionBackend,
  configuration: Exclude<ExecutionConfiguration, { mode: 'off' }>,
  env: NodeJS.ProcessEnv = process.env,
) {
  const workflows = createWorkflows(runtime);
  const services = codingRunServices(runtime);
  const settings = githubConfiguration(env);
  const accounts = createGitHubAccounts({
    runtime,
    configuration: settings,
    keyring: settings ? integrationCredentialKeyring(env) : null,
  });
  const { capabilities, templates = [] } = backend.descriptor;
  const agents = capabilities.secrets ? codingAgents.filter(agent => templates.includes(agent)) : [];

  async function run(workspaceId: string, runId: string, stepId: string, jobId: string, signal: AbortSignal) {
    const found = await workflows.codingJob(workspaceId, runId, stepId, jobId);
    if (!found) return null;
    const { job } = found;
    if (!agents.includes(job.agent))
      return { kind: 'failed', error: 'unavailable', message: '' } satisfies CodingStepResult;
    const plan = await services.plan(
      workspaceId,
      found.membershipId,
      codingAgentProviders[job.agent],
      job.planConnectionId,
    );
    if (!plan) return { kind: 'failed', error: 'plan-required', message: '' } satisfies CodingStepResult;
    const account = await repositoryAccount(accounts, workspaceId, found, job);
    if (!account) return { kind: 'failed', error: 'github-account-required', message: '' } satisfies CodingStepResult;
    const branch = job.pullRequest ? `tulipfarm/${job.agent}-${jobId.slice(0, 8)}` : null;
    const outcome = await runCodingJob(
      backend,
      configuration,
      {
        workspaceId,
        areaId: runId,
        repository: job.repository,
        task: job.prompt,
        branch: job.branch,
        agent: job.agent,
        planToken: plan.token,
        githubToken: account.token,
        ...(branch
          ? {
              push: {
                branch,
                name: account.login,
                email: `${account.id}+${account.login}@users.noreply.github.com`,
                message: job.title ?? firstLine(job.prompt),
              },
            }
          : {}),
      },
      signal,
    );
    const failed = failure(outcome);
    if (failed) return failed;
    let pullRequest: { number: number; url: string } | null = null;
    if (branch && outcome.pushed && outcome.base) {
      // A run cancelled while the agent worked keeps its pushed branch but gets no pull request.
      if (!(await workflows.codingJob(workspaceId, runId, stepId, jobId))) return null;
      const body = [
        Array.from(outcome.message).slice(0, 60000).join('') || 'A coding agent made these changes.',
        '',
        `---`,
        `Opened by the TulipFarm workflow “${found.workflowName}”.`,
      ].join('\n');
      pullRequest = await openPullRequest(account.token, job, branch, outcome.base, body).catch(() => null);
      if (!pullRequest) return { kind: 'failed', error: 'pull-request-failed', message: '' } satisfies CodingStepResult;
    }
    return {
      kind: 'completed',
      output: {
        status: outcome.files.length ? 'changed' : 'unchanged',
        agent: job.agent,
        repository: job.repository,
        base: outcome.base,
        message: Array.from(outcome.message).slice(0, 4000).join(''),
        files: outcome.files.slice(0, 100),
        diffTruncated: outcome.diffTruncated,
        branch: outcome.pushed ? branch : null,
        pullRequest,
      },
    } satisfies CodingStepResult;
  }

  return {
    async runWorkflowCodingStep(workspaceId: string, runId: string, stepId: string, jobId: string) {
      const context = Context.current();
      const heartbeat = setInterval(() => context.heartbeat(), 20_000);
      try {
        const result = await run(workspaceId, runId, stepId, jobId, context.cancellationSignal);
        if (result) await workflows.recordCodingResult(workspaceId, runId, stepId, jobId, result);
      } finally {
        clearInterval(heartbeat);
      }
    },
    async interruptWorkflowCodingStep(workspaceId: string, runId: string, stepId: string, jobId: string) {
      await workflows.recordCodingResult(workspaceId, runId, stepId, jobId, {
        kind: 'failed',
        error: 'interrupted',
        message: '',
      });
    },
  };
}

/** Starts one `workflowCodingStepV1` workflow per job; starting it again while it runs or after it ran changes nothing. */
export function createWorkflowCodingDispatcher() {
  const connection = Connection.lazy(temporalConnectionOptions());
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm';
  const runner: CodingStepRunner = {
    async start(workspaceId, runId, stepId, jobId) {
      try {
        await connection.withDeadline(Date.now() + 5000, () =>
          client.workflow.start('workflowCodingStepV1', {
            workflowId: `workflow-coding-v1-${workspaceId}-${jobId}`,
            taskQueue,
            args: [workspaceId, runId, stepId, jobId],
            workflowIdConflictPolicy: 'USE_EXISTING',
            workflowIdReusePolicy: 'REJECT_DUPLICATE',
          }),
        );
      } catch (error) {
        // The job already ran; its result is on the step.
        if (error instanceof Error && error.name === 'WorkflowExecutionAlreadyStartedError') return;
        log('warn', 'activity', 'call_failed', { operation: 'workflow.coding.dispatch', outcome: 'error' });
        throw error;
      }
    },
  };
  return { runner, close: () => connection.close() };
}
