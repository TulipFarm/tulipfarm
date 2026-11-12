import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  executionAllocationSchema,
  executionCommandSchema,
  executionFileSchema,
  executionJobSchema,
  executionJobStateSchema,
  executionOutputSchema,
  executionOutputBytes,
  executionPathSchema,
  executionPolicySchema,
  type ExecutionAllocation,
  type ExecutionBackend,
  type ExecutionJob,
  type ExecutionJobState,
  type ExecutionPolicy,
} from '@tulipfarm/execution-contract';
import { ExecutionConflict } from './state.ts';

const packetBytes = 1024 * 1024;
const blockBytes = 64 * 1024;
const optionsSchema = z.strictObject({
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  gatewayImage: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  runnerId: z.uuid(),
  dns: z
    .array(z.string().refine(value => isIP(value) === 4))
    .min(1)
    .max(3),
  deniedNetworks: z.array(z.string().regex(/^[0-9a-fA-F.:]+\/\d{1,3}$/)).max(256),
  pidsLimit: z.number().int().min(8).max(1024),
  helperCpuMillis: z.number().int().positive(),
  helperMemoryMiB: z.number().int().min(32),
});
export type DockerExecutionOptions = z.infer<typeof optionsSchema>;
const inspectionSchema = z.object({
  Config: z.object({ Image: z.string(), Labels: z.record(z.string(), z.string()).nullable() }),
  State: z.object({ Running: z.boolean(), ExitCode: z.number().int(), OOMKilled: z.boolean() }),
});
type Inspection = z.infer<typeof inspectionSchema>;
function allocationReference({ areaId, allocationId, generation }: ExecutionAllocation): ExecutionAllocation {
  return executionAllocationSchema.parse({ areaId, allocationId, generation });
}

function jobReference(input: ExecutionJob): ExecutionJob {
  return executionJobSchema.parse({ ...allocationReference(input), jobId: input.jobId });
}

function jobState(value: unknown, expectedJobId: string): ExecutionJobState {
  const { jobId, ...state } = z.object({ jobId: z.uuid() }).catchall(z.unknown()).parse(value);
  if (jobId !== expectedJobId) throw new ExecutionConflict('stale');
  return executionJobStateSchema.parse(state);
}

const safeDns = (address: string) => {
  const [a, b, c] = address.split('.').map(Number);
  return (
    a !== undefined &&
    b !== undefined &&
    c !== undefined &&
    a !== 0 &&
    a !== 10 &&
    a !== 127 &&
    a < 224 &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
    !(a === 203 && b === 0 && c === 113)
  );
};

async function docker(args: string[], signal: AbortSignal, input?: unknown, missing = false): Promise<string> {
  signal.throwIfAborted();
  const body = input === undefined ? undefined : JSON.stringify(input);
  if (body && Buffer.byteLength(body) > packetBytes) throw new ExecutionConflict('quota');
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let failed = false;
    const fail = () => {
      failed = true;
      child.kill('SIGKILL');
    };
    signal.addEventListener('abort', fail, { once: true });
    for (const [stream, chunks] of [
      [child.stdout, output],
      [child.stderr, errors],
    ] as const) {
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > packetBytes) fail();
        else chunks.push(chunk);
      });
    }
    child.on('error', () => {
      signal.removeEventListener('abort', fail);
      reject(new Error('execution-backend-unavailable'));
    });
    child.stdin.on('error', fail);
    child.on('close', code => {
      signal.removeEventListener('abort', fail);
      if (signal.aborted) return reject(signal.reason);
      if (failed) return reject(new Error('execution-transport-unavailable'));
      if (code !== 0) {
        const absent = missing && /no such (object|container)/i.test(Buffer.concat(errors).toString('utf8'));
        if (absent) return resolve('');
        return reject(new Error('execution-backend-unavailable'));
      }
      resolve(Buffer.concat(output).toString('utf8').trim());
    });
    if (signal.aborted) fail();
    child.stdin.end(body);
  });
}

/** Immutable images and operating limits come from the operator, never a chat or a model. */
export function createDockerExecutionBackend(
  policyInput: ExecutionPolicy,
  optionsInput: DockerExecutionOptions,
): ExecutionBackend {
  const policy = executionPolicySchema.parse(policyInput);
  const options = optionsSchema.parse(optionsInput);
  if (
    policy.network !== 'public-only' ||
    policy.profiles.some(profile => profile.resources.kind !== 'limited') ||
    policy.baseRevision !== options.image.slice(7) ||
    policy.limits.outputBytes > packetBytes / 8 ||
    policy.limits.jobTimeoutSeconds > 86400 ||
    options.dns.some(address => !safeDns(address))
  )
    throw new ExecutionConflict('request-conflict');
  const name = (input: ExecutionAllocation) => `tf-execution-${input.allocationId}`;
  const gateway = (input: ExecutionAllocation) => `tf-execution-net-${input.allocationId}`;
  const labels = (input: ExecutionAllocation) => ({
    'org.tulipfarm.execution.area': input.areaId,
    'org.tulipfarm.execution.allocation': input.allocationId,
    'org.tulipfarm.execution.generation': String(input.generation),
    'org.tulipfarm.execution.runner': options.runnerId,
  });
  async function inspectContainer(
    input: ExecutionAllocation,
    target: string,
    signal: AbortSignal,
  ): Promise<Inspection | undefined> {
    allocationReference(input);
    const value = await docker(['container', 'inspect', target], signal, undefined, true);
    if (!value) return undefined;
    const inspection = inspectionSchema.parse(z.array(z.unknown()).length(1).parse(JSON.parse(value))[0]);
    if (Object.entries(labels(input)).some(([key, value]) => inspection.Config.Labels?.[key] !== value))
      throw new ExecutionConflict('stale');
    return inspection;
  }
  async function rpc(input: ExecutionAllocation, request: unknown, signal: AbortSignal) {
    const inspection = await inspectContainer(input, name(input), signal);
    if (!inspection?.State.Running || inspection.Config.Image !== options.image) throw new ExecutionConflict('stale');
    const result: unknown = JSON.parse(
      await docker(
        ['exec', '--interactive', name(input), 'python3', '-I', '/opt/execution/supervisor.py', 'request'],
        signal,
        request,
      ),
    );
    if (z.object({ error: z.string() }).safeParse(result).success) throw new Error('execution-request-failed');
    return result;
  }
  async function ready(input: ExecutionAllocation, signal: AbortSignal) {
    for (;;) {
      signal.throwIfAborted();
      try {
        await rpc(input, { operation: 'status' }, signal);
        return;
      } catch {
        if (!(await inspectContainer(input, name(input), signal))?.State.Running)
          throw new Error('execution-backend-unavailable');
        await delay(50, undefined, { signal });
      }
    }
  }
  async function inspectJob(input: ExecutionJob, operation: { signal: AbortSignal }): Promise<ExecutionJobState> {
    jobReference(input);
    const container = await inspectContainer(input, name(input), operation.signal);
    if (!container) return { state: 'outcome-unknown' };
    if (container.State.Running) {
      const value = await rpc(input, { operation: 'status' }, operation.signal);
      const current = z.object({ jobId: z.uuid().optional(), state: z.string() }).parse(value);
      if (current.jobId === input.jobId) return jobState(value, input.jobId);
    }
    const lines = (await docker(['logs', '--tail', '128', name(input)], operation.signal)).split('\n');
    for (const line of lines.reverse()) {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!z.object({ jobId: z.literal(input.jobId) }).safeParse(record).success) continue;
      let state: ExecutionJobState;
      try {
        state = jobState(record, input.jobId);
      } catch {
        break;
      }
      if (state.state !== 'running') return state;
      if (!container.State.Running && container.State.ExitCode === 124) return { state: 'timed-out' };
      break;
    }
    return { state: 'outcome-unknown' };
  }
  return {
    descriptor: {
      profiles: policy.profiles,
      capabilities: {
        isolation: 'container',
        network: 'public-only',
        hardDeadlines: true,
        reconnect: true,
        previews: false,
      },
    },
    async prepare(input, { signal }) {
      allocationReference(input);
      const until = Date.parse(z.iso.datetime().parse(input.deadline));
      const profile = policy.profiles.find(profile => profile.id === input.profile.id);
      if (
        !profile ||
        input.secrets?.length ||
        JSON.stringify(profile) !== JSON.stringify(input.profile) ||
        profile.resources.kind !== 'limited' ||
        input.baseRevision !== policy.baseRevision ||
        until <= Date.now() ||
        until - Date.now() > 86400000
      )
        throw new ExecutionConflict('request-conflict');
      const prior = await inspectContainer(input, name(input), signal);
      if (prior) {
        if (prior.Config.Image !== options.image) throw new ExecutionConflict('stale');
        if (prior.State.Running) await ready(input, signal);
        return { state: prior.State.Running ? 'ready' : 'stopped' };
      }
      const shared = [
        '--detach',
        '--pull',
        'never',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        ...Object.entries(labels(input)).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
        '--log-driver',
        'local',
        '--log-opt',
        'max-size=1m',
        '--log-opt',
        'max-file=1',
        '--log-opt',
        'compress=false',
      ];
      const helper = await inspectContainer(input, gateway(input), signal);
      if (!helper) {
        await docker(
          [
            'run',
            '--name',
            gateway(input),
            ...shared,
            '--cap-add',
            'NET_ADMIN',
            '--cpus',
            String(options.helperCpuMillis / 1000),
            '--memory',
            `${options.helperMemoryMiB}m`,
            '--memory-swap',
            `${options.helperMemoryMiB}m`,
            '--pids-limit',
            String(options.pidsLimit),
            ...options.dns.flatMap(address => ['--dns', address]),
            options.gatewayImage,
            '--lifetime-seconds',
            String(Math.ceil((until - Date.now()) / 1000)),
            ...options.deniedNetworks.flatMap(network => ['--deny-network', network]),
          ],
          signal,
        );
      } else if (!helper.State.Running || helper.Config.Image !== options.gatewayImage)
        throw new ExecutionConflict('stale');
      while (!(await docker(['logs', '--tail', '1', gateway(input)], signal)).includes('ready')) {
        if (!(await inspectContainer(input, gateway(input), signal))?.State.Running)
          throw new Error('execution-backend-unavailable');
        await delay(50, undefined, { signal });
      }
      await docker(
        [
          'run',
          '--name',
          name(input),
          ...shared,
          ...['SETUID', 'SETGID', 'KILL', 'CHOWN', 'DAC_OVERRIDE'].flatMap(capability => ['--cap-add', capability]),
          '--cpus',
          String(profile.resources.cpuMillis / 1000),
          '--memory',
          `${profile.resources.memoryMiB}m`,
          '--memory-swap',
          `${profile.resources.memoryMiB}m`,
          '--pids-limit',
          String(options.pidsLimit),
          '--network',
          `container:${gateway(input)}`,
          '--tmpfs',
          `/work:rw,exec,nosuid,nodev,size=${profile.resources.diskBytes},mode=0755`,
          '--tmpfs',
          '/run/execution:rw,nosuid,nodev,size=16777216,mode=0700',
          options.image,
          'serve',
          '--deadline',
          String(until / 1000),
          '--output-limit',
          String(policy.limits.outputBytes),
        ],
        signal,
      );
      await ready(input, signal);
      return { state: 'ready' };
    },
    async inspect(input, { signal }) {
      const container = await inspectContainer(input, name(input), signal);
      return { state: !container ? 'absent' : container.State.Running ? 'ready' : 'stopped' };
    },
    async destroy(input, { signal }) {
      for (const target of [name(input), gateway(input)]) {
        if (await inspectContainer(input, target, signal)) await docker(['rm', '--force', target], signal);
      }
      return { state: 'stopped' };
    },
    async startJob(input, { signal }) {
      jobReference(input);
      const command = executionCommandSchema.parse(input.command);
      const deadline = Date.parse(z.iso.datetime().parse(input.deadline)) / 1000;
      return jobState(
        await rpc(input, { operation: 'start', jobId: input.jobId, deadline, command }, signal),
        input.jobId,
      );
    },
    inspectJob,
    async stopJob(input, operation) {
      const current = await inspectJob(input, operation);
      if (current.state !== 'running') return current;
      await docker(['stop', '--timeout', String(policy.limits.stopGraceSeconds), name(input)], operation.signal);
      return inspectJob(input, operation);
    },
    async *readOutput(input, { signal }) {
      jobReference(input);
      z.number().int().nonnegative().parse(input.after);
      z.number().int().positive().parse(input.maximumBytes);
      const current = z.object({ jobId: z.uuid().optional() }).parse(await rpc(input, { operation: 'status' }, signal));
      if (current.jobId !== input.jobId) throw new ExecutionConflict('stale');
      const { events } = z
        .object({ events: z.array(executionOutputSchema).max(64) })
        .parse(await rpc(input, { operation: 'output', after: input.after, maximumBytes: input.maximumBytes }, signal));
      let bytes = 0;
      for (const event of events) {
        bytes += executionOutputBytes(event);
        if (bytes > input.maximumBytes) throw new ExecutionConflict('quota');
        yield event;
      }
    },
    async *listFiles(input, { signal }) {
      let after = '';
      for (;;) {
        const { files } = z
          .object({ files: z.array(executionFileSchema).max(100) })
          .parse(await rpc(input, { operation: 'list', after }, signal));
        for (const file of files) {
          if (file.path <= after) throw new ExecutionConflict('request-conflict');
          after = file.path;
          yield file;
        }
        if (files.length < 100) break;
      }
    },
    async *readFile(input, { signal }) {
      const file = executionFileSchema.parse(input.file);
      if (file.size > policy.limits.fileBytes) throw new ExecutionConflict('quota');
      const digest = createHash('sha256');
      if (file.size === 0) {
        const current = executionFileSchema.parse(await rpc(input, { operation: 'file', path: file.path }, signal));
        if (current.size !== file.size || current.sha256 !== file.sha256)
          throw new ExecutionConflict('request-conflict');
      }
      for (let offset = 0; offset < file.size;) {
        const response = z
          .object({ bytes: z.string().max(blockBytes * 2) })
          .parse(await rpc(input, { operation: 'read', path: file.path, size: file.size, offset }, signal));
        const bytes = Buffer.from(response.bytes, 'base64');
        if (!bytes.length || bytes.length > Math.min(blockBytes, file.size - offset))
          throw new ExecutionConflict('request-conflict');
        digest.update(bytes);
        offset += bytes.length;
        yield bytes;
      }
      if (digest.digest('hex') !== file.sha256) throw new ExecutionConflict('request-conflict');
    },
    async writeFile(input, { signal }) {
      const file = executionFileSchema.parse(input.file);
      if (file.size > policy.limits.fileBytes) throw new ExecutionConflict('quota');
      const upload = z
        .object({ id: z.string().regex(/^[a-f0-9]{32}$/) })
        .parse(await rpc(input, { operation: 'write-begin', ...file }, signal));
      let length = 0;
      let committed = false;
      try {
        for await (const chunk of input.bytes) {
          if (chunk.length > file.size - length) throw new ExecutionConflict('quota');
          for (let offset = 0; offset < chunk.length; offset += blockBytes) {
            await rpc(
              input,
              {
                operation: 'write',
                id: upload.id,
                bytes: Buffer.from(chunk.subarray(offset, offset + blockBytes)).toString('base64'),
              },
              signal,
            );
          }
          length += chunk.length;
        }
        if (length !== file.size) throw new ExecutionConflict('request-conflict');
        await rpc(input, { operation: 'write-commit', id: upload.id }, signal);
        committed = true;
      } finally {
        if (!committed && !signal.aborted)
          await rpc(input, { operation: 'write-abort', id: upload.id }, signal).catch(() => undefined);
      }
    },
    async removeFile(input, { signal }) {
      await rpc(input, { operation: 'remove', path: executionPathSchema.parse(input.path) }, signal);
    },
  };
}
