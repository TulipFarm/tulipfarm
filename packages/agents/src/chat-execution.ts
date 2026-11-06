import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  ExecutionBackend,
  ExecutionConfiguration,
  ExecutionJob,
  ExecutionJobState,
} from '@tulipfarm/execution-contract';

export type ChatExecutionLanguage = 'python' | 'javascript' | 'bash';
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

const commands: Record<ChatExecutionLanguage, (code: string) => { program: string; args: string[] }> = {
  python: code => ({ program: 'python3', args: ['-c', code] }),
  javascript: code => ({ program: 'node', args: ['-e', code] }),
  bash: code => ({ program: 'bash', args: ['-c', code] }),
};
const outputLimit = 65536;
const poll = 200;

export function createChatExecution(
  backend: ExecutionBackend,
  configuration: Exclude<ExecutionConfiguration, { mode: 'off' }>,
): ChatExecution {
  const { policy, policyRevision } = configuration;
  const profile = policy.profiles.find(item => item.id === policy.defaultProfile);
  if (!profile) throw new Error('execution-profile-missing');
  return async ({ conversationId, language, code }, outer) => {
    const timeout = policy.limits.jobTimeoutSeconds * 1000;
    const signal = AbortSignal.any([AbortSignal.timeout(timeout + 120000), ...(outer ? [outer] : [])]);
    const allocation = { areaId: conversationId, allocationId: randomUUID(), generation: 1 };
    const job: ExecutionJob = { ...allocation, jobId: randomUUID() };
    try {
      const allocationDeadline = new Date(Date.now() + timeout + 120000).toISOString();
      let prepared = await backend.prepare(
        { ...allocation, profile, baseRevision: policy.baseRevision, policyRevision, deadline: allocationDeadline },
        { signal },
      );
      while (prepared.state === 'preparing') {
        await delay(poll, undefined, { signal });
        prepared = await backend.inspect(allocation, { signal });
      }
      if (prepared.state !== 'ready') throw new Error(`execution-allocation-${prepared.state}`);
      let state = await backend.startJob(
        { ...job, command: commands[language](code), deadline: new Date(Date.now() + timeout).toISOString() },
        { signal },
      );
      while (state.state === 'running') {
        await delay(poll, undefined, { signal });
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
  };
}
