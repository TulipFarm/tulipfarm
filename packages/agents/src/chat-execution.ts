import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  ExecutionBackend,
  ExecutionCommand,
  ExecutionConfiguration,
  ExecutionJob,
  ExecutionJobState,
} from '@tulipfarm/execution-contract';

export type ChatExecutionLanguage = 'python' | 'javascript' | 'typescript' | 'bash';
export type ChatExecutionResult = {
  state: Exclude<ExecutionJobState['state'], 'running'>;
  exitCode?: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
};
/** Runs one snippet of model-written code in a fresh, isolated machine for a chat turn. */
export type ChatExecution = (
  input: { conversationId: string; language: ChatExecutionLanguage; code: string },
  signal?: AbortSignal,
) => Promise<ChatExecutionResult>;

const commands: Record<ChatExecutionLanguage, (code: string) => ExecutionCommand> = {
  python: code => ({ program: 'python3', args: ['-c', code] }),
  javascript: code => ({ program: 'node', args: ['-e', code] }),
  typescript: code => ({ program: 'node', args: ['--input-type=module-typescript', '-e', code] }),
  bash: code => ({ program: 'bash', args: ['-c', code] }),
};
const outputLimit = 65536;
const poll = 200;
// Waits between checks double up to this, so many long runs do not flood the backend.
const longestPoll = 2000;
const slack = 120000;

type RunnableConfiguration = Exclude<ExecutionConfiguration, { mode: 'off' }>;

/**
 * Runs one command in a fresh allocation and destroys the allocation afterwards.
 * `timeoutMs` shortens the policy's job timeout for callers with a tighter budget.
 */
export async function runIsolated(
  backend: ExecutionBackend,
  configuration: RunnableConfiguration,
  input: { areaId: string; command: ExecutionCommand; timeoutMs?: number },
  outer?: AbortSignal,
): Promise<ChatExecutionResult> {
  const { policy, policyRevision } = configuration;
  const profile = policy.profiles.find(item => item.id === policy.defaultProfile);
  if (!profile) throw new Error('execution-profile-missing');
  const timeout = Math.min(policy.limits.jobTimeoutSeconds * 1000, input.timeoutMs ?? Infinity);
  const margin = input.timeoutMs === undefined ? slack : Math.min(slack, 5000);
  const signal = AbortSignal.any([AbortSignal.timeout(timeout + margin), ...(outer ? [outer] : [])]);
  const allocation = { areaId: input.areaId, allocationId: randomUUID(), generation: 1 };
  const job: ExecutionJob = { ...allocation, jobId: randomUUID() };
  try {
    const allocationDeadline = new Date(Date.now() + timeout + margin).toISOString();
    let prepared = await backend.prepare(
      { ...allocation, profile, baseRevision: policy.baseRevision, policyRevision, deadline: allocationDeadline },
      { signal },
    );
    let wait = poll;
    while (prepared.state === 'preparing') {
      await delay(wait, undefined, { signal });
      wait = Math.min(wait * 2, longestPoll);
      prepared = await backend.inspect(allocation, { signal });
    }
    if (prepared.state !== 'ready') throw new Error(`execution-allocation-${prepared.state}`);
    let state = await backend.startJob(
      { ...job, command: input.command, deadline: new Date(Date.now() + timeout).toISOString() },
      { signal },
    );
    wait = poll;
    while (state.state === 'running') {
      await delay(wait, undefined, { signal });
      wait = Math.min(wait * 2, longestPoll);
      state = await backend.inspectJob(job, { signal });
    }
    const streams = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    let after = 0;
    let bytes = 0;
    let truncated = false;
    let ended = false;
    while (!ended) {
      let seen = false;
      for await (const event of backend.readOutput({ ...job, after, maximumBytes: outputLimit }, { signal })) {
        seen = true;
        after = event.sequence;
        if (event.kind === 'end') ended = true;
        else if (event.kind === 'truncated') truncated = true;
        else if (bytes < outputLimit) {
          const data = Buffer.from(event.data, 'base64');
          const kept = data.subarray(0, outputLimit - bytes);
          bytes += kept.length;
          truncated ||= kept.length < data.length;
          streams[event.stream].push(kept);
        } else truncated = true;
      }
      if (!seen && !ended) await delay(poll, undefined, { signal });
    }
    return {
      state: state.state,
      ...(state.state === 'completed' ? { exitCode: state.exitCode } : {}),
      stdout: Buffer.concat(streams.stdout).toString('utf8'),
      stderr: Buffer.concat(streams.stderr).toString('utf8'),
      truncated,
    };
  } finally {
    await backend.destroy(allocation, { signal: AbortSignal.timeout(60000) }).catch(() => undefined);
  }
}

export function createChatExecution(backend: ExecutionBackend, configuration: RunnableConfiguration): ChatExecution {
  if (!configuration.policy.profiles.some(item => item.id === configuration.policy.defaultProfile))
    throw new Error('execution-profile-missing');
  return ({ conversationId, language, code }, signal) =>
    runIsolated(backend, configuration, { areaId: conversationId, command: commands[language](code) }, signal);
}
