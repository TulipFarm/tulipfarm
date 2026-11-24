import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  ExecutionBackend,
  ExecutionCommand,
  ExecutionConfiguration,
  ExecutionFile,
  ExecutionJob,
  ExecutionJobState,
  ExecutionProfile,
  ExecutionSecret,
} from '@tulipfarm/execution-contract';

export type ChatExecutionLanguage = 'python' | 'javascript' | 'typescript' | 'bash';
export type ChatExecutionResult = {
  state: Exclude<ExecutionJobState['state'], 'running'>;
  exitCode?: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
};
/** A file a run asked to return, or why it could not be. */
export type ChatExecutionOutput =
  | { path: string; bytes: Uint8Array }
  | { path: string; error: 'missing' | 'not-a-file' | 'unchanged' | 'too-large' | 'unreadable' | 'not-run' };
/**
 * Runs one snippet of model-written code in the chat's own isolated machine. The machine and its `/workspace` stay
 * for the chat's later runs until it sits idle, so tools installed and files written by one run are there for the next.
 *
 * `stage` copies the run's input files in one at a time and returns false to stop before anything runs. `save` takes
 * each returned file in turn, so at most one file is held in memory. A file is returned only when the run exits 0 and
 * wrote the file itself. `fresh` replaces the chat's machine with a new one first.
 */
export type ChatExecution = (
  input: {
    workspaceId: string;
    conversationId: string;
    language: ChatExecutionLanguage;
    code: string;
    outputs?: readonly string[];
    fresh?: boolean;
    stage?: (write: (path: string, bytes: Uint8Array) => Promise<void>) => Promise<boolean>;
    save?: (output: ChatExecutionOutput) => Promise<void>;
  },
  signal?: AbortSignal,
) => Promise<ChatExecutionResult | undefined>;

const commands: Record<ChatExecutionLanguage, (code: string) => ExecutionCommand> = {
  python: code => ({ program: 'python3', args: ['-c', code] }),
  javascript: code => ({ program: 'node', args: ['-e', code] }),
  typescript: code => ({ program: 'node', args: ['--input-type=module-typescript', '-e', code] }),
  bash: code => ({ program: 'bash', args: ['-c', code] }),
};
const chatOutputLimit = 65536;
const poll = 200;
// Waits between checks double up to this, so many long runs do not flood the backend.
const longestPoll = 2000;
const slack = 120000;
/** The profile chat runs use when the policy has it: a machine big enough for office suites and media tools. */
export const chatProfileId = 'computer';
/** One chat run may take this long, within the reply's own time limit. */
export const chatJobMs = 5 * 60 * 1000;
/** A chat's machine runs for at most this long in all, then the next run starts a new one. */
export const chatMachineMs = 4 * 60 * 60 * 1000;
/** A chat's machine is destroyed after this long without a run. */
export const chatIdleSeconds = 30 * 60;
/** The largest file a run may return. Files keep the same limit. */
export const chatFileBytes = 100 * 1024 * 1024;
/** All the files one run returns together. */
const chatOutputBytes = 2 * chatFileBytes;
/** How long a run that was cancelled may take to stop before its machine is destroyed instead. */
const stopMs = 15000;

type RunnableConfiguration = Exclude<ExecutionConfiguration, { mode: 'off' }>;
type Allocation = { areaId: string; allocationId: string; generation: number };

function profileOf(configuration: RunnableConfiguration, id?: string) {
  const { policy } = configuration;
  const profile =
    (id && policy.profiles.find(item => item.id === id)) ||
    policy.profiles.find(item => item.id === policy.defaultProfile);
  if (!profile) throw new Error('execution-profile-missing');
  return profile;
}

async function prepareAllocation(
  backend: ExecutionBackend,
  configuration: RunnableConfiguration,
  allocation: Allocation,
  input: {
    workspaceId: string;
    profile: ExecutionProfile;
    deadline: string;
    secrets?: readonly ExecutionSecret[] | undefined;
    idleSeconds?: number;
  },
  signal: AbortSignal,
) {
  let prepared = await backend.prepare(
    {
      ...allocation,
      profile: input.profile,
      baseRevision: configuration.policy.baseRevision,
      policyRevision: configuration.policyRevision,
      deadline: input.deadline,
      workspaceId: input.workspaceId,
      ...(input.secrets?.length ? { secrets: input.secrets } : {}),
      ...(input.idleSeconds ? { idleSeconds: input.idleSeconds } : {}),
    },
    { signal },
  );
  let wait = poll;
  while (prepared.state === 'preparing') {
    await delay(wait, undefined, { signal });
    wait = Math.min(wait * 2, longestPoll);
    prepared = await backend.inspect(allocation, { signal });
  }
  return prepared.state;
}

async function runJob(
  backend: ExecutionBackend,
  job: ExecutionJob,
  command: ExecutionCommand,
  timeout: number,
  outputLimit: number,
  signal: AbortSignal,
): Promise<ChatExecutionResult> {
  let state = await backend.startJob(
    { ...job, command, deadline: new Date(Date.now() + timeout).toISOString() },
    { signal },
  );
  let wait = poll;
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
}

/**
 * Runs one command in a fresh allocation and destroys the allocation afterwards.
 * `timeoutMs` shortens the policy's job timeout for callers with a tighter budget. `limitMs` replaces that job timeout
 * for work with a limit of its own, such as a coding run; ordinary jobs keep the policy's. `template` starts the default
 * profile from another backend image, `secrets` are held by the backend for the allocation's life, and `outputBytes`
 * raises the 64 KiB output cap.
 */
export async function runIsolated(
  backend: ExecutionBackend,
  configuration: RunnableConfiguration,
  input: {
    workspaceId: string;
    areaId: string;
    command: ExecutionCommand;
    timeoutMs?: number;
    limitMs?: number;
    template?: string;
    secrets?: readonly ExecutionSecret[];
    outputBytes?: number;
  },
  outer?: AbortSignal,
): Promise<ChatExecutionResult> {
  const { policy } = configuration;
  const defaultProfile = profileOf(configuration);
  const profile = input.template ? { ...defaultProfile, template: input.template } : defaultProfile;
  const timeout = Math.min(input.limitMs ?? policy.limits.jobTimeoutSeconds * 1000, input.timeoutMs ?? Infinity);
  const margin = input.timeoutMs === undefined && input.limitMs === undefined ? slack : Math.min(slack, 5000);
  const signal = AbortSignal.any([AbortSignal.timeout(timeout + margin), ...(outer ? [outer] : [])]);
  const allocation = { areaId: input.areaId, allocationId: randomUUID(), generation: 1 };
  try {
    const state = await prepareAllocation(
      backend,
      configuration,
      allocation,
      {
        workspaceId: input.workspaceId,
        profile,
        deadline: new Date(Date.now() + timeout + margin).toISOString(),
        secrets: input.secrets,
      },
      signal,
    );
    if (state !== 'ready') throw new Error(`execution-allocation-${state}`);
    return await runJob(
      backend,
      { ...allocation, jobId: randomUUID() },
      input.command,
      timeout,
      input.outputBytes ?? chatOutputLimit,
      signal,
    );
  } finally {
    await backend.destroy(allocation, { signal: AbortSignal.timeout(60000) }).catch(() => undefined);
  }
}

/** The same allocation ID for every run of one chat, so any worker finds the chat's machine. */
export function chatAllocationId(workspaceId: string, conversationId: string) {
  const hash = createHash('sha256').update(`chat-machine-v2:${workspaceId}:${conversationId}`).digest();
  hash.writeUInt8((hash.readUInt8(6) & 0x0f) | 0x40, 6);
  hash.writeUInt8((hash.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function* once(bytes: Uint8Array) {
  yield bytes;
}

/**
 * Reports each output as `ok <size> <sha256>` or the reason it can't be returned. A file whose status time is not
 * after the run's marker was not written by the run, so an earlier run's file is never returned as this run's.
 */
const checkOutputs = `m=\${TMPDIR:-/tmp}/.tulipfarm-run-$1; max=$2; shift 2
for p in "$@"; do
  p=./$p
  if [ -L "$p" ]; then echo not-a-file
  elif [ ! -e "$p" ]; then echo missing
  elif [ ! -f "$p" ]; then echo not-a-file
  elif [ -z "$(find "$p" -maxdepth 0 -cnewer "$m" 2>/dev/null)" ]; then echo unchanged
  else
    s=$(stat -c %s -- "$p")
    if [ "$s" -gt "$max" ]; then echo too-large; else echo "ok $s $(sha256sum -- "$p" | cut -c1-64)"; fi
  fi
done
rm -f -- "$m"`;
const checkedSchema = /^(?:ok (\d+) ([a-f0-9]{64})|(missing|not-a-file|unchanged|too-large))$/;

export function createChatExecution(backend: ExecutionBackend, configuration: RunnableConfiguration): ChatExecution {
  const profile = profileOf(configuration, chatProfileId);
  // Two runs of one chat at once must not both start a machine for it.
  const preparing = new Map<string, Promise<void>>();
  async function ready(allocation: Allocation, workspaceId: string, fresh: boolean, signal: AbortSignal) {
    if (fresh) await backend.destroy(allocation, { signal });
    const prepare = () =>
      prepareAllocation(
        backend,
        configuration,
        allocation,
        {
          workspaceId,
          profile,
          deadline: new Date(Date.now() + chatMachineMs).toISOString(),
          idleSeconds: chatIdleSeconds,
        },
        signal,
      );
    let state = await prepare();
    if (state !== 'ready') {
      // A machine that was lost or stopped is replaced; its files are gone.
      await backend.destroy(allocation, { signal });
      state = await prepare();
    }
    if (state !== 'ready') throw new Error(`execution-allocation-${state}`);
  }
  /** Runs a job; when the reply is cancelled, stops it, or destroys the machine when it won't stop. */
  async function job(
    allocation: Allocation,
    command: ExecutionCommand,
    timeout: number,
    signal: AbortSignal,
    jobId: string = randomUUID(),
  ) {
    const running = { ...allocation, jobId };
    try {
      return await runJob(backend, running, command, timeout, chatOutputLimit, signal);
    } catch (error) {
      if (signal.aborted) {
        const stopped = await backend
          .stopJob(running, { signal: AbortSignal.timeout(stopMs) })
          .then(state => ['completed', 'cancelled', 'timed-out'].includes(state.state))
          .catch(() => false);
        if (!stopped) await backend.destroy(allocation, { signal: AbortSignal.timeout(60000) }).catch(() => undefined);
      }
      throw error;
    }
  }
  async function read(allocation: Allocation, file: ExecutionFile, signal: AbortSignal): Promise<ChatExecutionOutput> {
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const part of backend.readFile({ ...allocation, file }, { signal })) {
        // A file that grew after it was checked is not held in memory beyond its checked size.
        size += part.byteLength;
        if (size > file.size) return { path: file.path, error: 'unreadable' };
        parts.push(part);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      return { path: file.path, error: 'unreadable' };
    }
    const bytes = Buffer.concat(parts);
    if (bytes.byteLength !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256)
      return { path: file.path, error: 'unreadable' };
    return { path: file.path, bytes };
  }
  return async ({ workspaceId, conversationId, language, code, outputs = [], fresh = false, stage, save }, outer) => {
    const signal = AbortSignal.any([AbortSignal.timeout(chatJobMs + slack), ...(outer ? [outer] : [])]);
    const machine = `${workspaceId}:${conversationId}`;
    const allocation = {
      areaId: conversationId,
      allocationId: chatAllocationId(workspaceId, conversationId),
      generation: 1,
    };
    const prepared = (preparing.get(machine) ?? Promise.resolve()).then(() =>
      ready(allocation, workspaceId, fresh, signal),
    );
    const settled = prepared.then(
      () => undefined,
      () => undefined,
    );
    preparing.set(machine, settled);
    try {
      await prepared;
    } finally {
      if (preparing.get(machine) === settled) preparing.delete(machine);
    }
    const staged: string[] = [];
    const write = (path: string, bytes: Uint8Array) => {
      staged.push(path);
      return backend.writeFile(
        {
          ...allocation,
          file: {
            path,
            size: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            executable: false,
          },
          bytes: once(bytes),
        },
        { signal },
      );
    };
    // Earlier runs' files are checked against the chat's recorded runs, so a run that copied files in but recorded
    // nothing leaves no files behind. Inputs of a run that never started are removed; after a program ran, it may
    // have copied them anywhere, so the machine goes.
    const destroy = () =>
      backend.destroy(allocation, { signal: AbortSignal.timeout(60000) }).then(
        () => undefined,
        () => undefined,
      );
    const unstage = async () => {
      if (!staged.length) return;
      const removed = await runJob(
        backend,
        { ...allocation, jobId: randomUUID() },
        { program: 'rm', args: ['-f', '--', ...staged] },
        60000,
        chatOutputLimit,
        AbortSignal.timeout(60000 + slack),
      ).catch(() => undefined);
      if (removed?.state !== 'completed' || removed.exitCode !== 0) await destroy();
    };
    try {
      if (stage && !(await stage(write))) {
        await unstage();
        return undefined;
      }
    } catch (error) {
      await unstage();
      throw error;
    }
    try {
      return await execute();
    } catch (error) {
      if (staged.length) await destroy();
      throw error;
    }
    async function execute() {
      const jobId = randomUUID();
      const command = commands[language](code);
      // The marker's time separates files this run wrote from earlier runs' files. It goes in the machine's temp
      // directory, which is writable on every backend.
      const marked = outputs.length && save;
      const result = await job(
        allocation,
        marked
          ? {
              ...command,
              program: 'bash',
              args: [
                '-c',
                'touch -- "${TMPDIR:-/tmp}/.tulipfarm-run-$0" && exec "$@"',
                jobId,
                command.program,
                ...command.args,
              ],
            }
          : command,
        chatJobMs,
        signal,
        jobId,
      );
      if (!outputs.length || !save) return result;
      if (result.state !== 'completed' || result.exitCode !== 0) {
        for (const path of outputs) await save({ path, error: 'not-run' });
        return result;
      }
      const checked = await job(
        allocation,
        { program: 'bash', args: ['-c', checkOutputs, 'check', jobId, String(chatFileBytes), ...outputs] },
        60000,
        signal,
      );
      const lines = checked.stdout.split('\n');
      let total = 0;
      for (const [index, path] of outputs.entries()) {
        const line = checkedSchema.exec(checked.state === 'completed' ? (lines[index] ?? '') : '');
        if (!line) {
          await save({ path, error: 'unreadable' });
          continue;
        }
        if (line[3]) {
          await save({ path, error: line[3] as 'missing' | 'not-a-file' | 'unchanged' | 'too-large' });
          continue;
        }
        const size = Number(line[1]);
        total += size;
        if (total > chatOutputBytes) {
          await save({ path, error: 'too-large' });
          continue;
        }
        await save(await read(allocation, { path, size, sha256: line[2]!, executable: false }, signal));
      }
      return result;
    }
  };
}
