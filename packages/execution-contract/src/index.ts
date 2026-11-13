import { z } from 'zod';

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const name = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const cost = z.string().regex(/^(0|[1-9]\d{0,29})$/);

export const executionModeSchema = z.enum(['off', 'local', 'docker', 'extension']);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

export const executionResourcesSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('shared') }),
  z.strictObject({
    kind: z.literal('limited'),
    cpuMillis: positive,
    memoryMiB: positive,
    diskBytes: positive,
  }),
]);
export const executionProfileSchema = z.strictObject({
  id: name,
  resources: executionResourcesSchema,
  /** A backend machine image to start from instead of the profile's own; only a backend that lists it runs it. */
  template: name.optional(),
});
export type ExecutionProfile = z.infer<typeof executionProfileSchema>;

const profiles = z
  .array(executionProfileSchema)
  .min(1)
  .max(64)
  .refine(items => new Set(items.map(item => item.id)).size === items.length, 'Duplicate execution profile');

export const executionCapabilitiesSchema = z.strictObject({
  isolation: z.enum(['direct', 'container', 'microvm']),
  network: z.enum(['inherited', 'public-only']),
  hardDeadlines: z.boolean(),
  reconnect: z.boolean(),
  previews: z.boolean(),
  /** Whether `prepare` accepts held secrets. Backends without it reject an allocation that names any. */
  secrets: z.boolean().optional(),
});
export type ExecutionCapabilities = z.infer<typeof executionCapabilitiesSchema>;

export const executionDescriptorSchema = z.strictObject({
  capabilities: executionCapabilitiesSchema,
  profiles,
  /** The machine images a profile's `template` may name. */
  templates: z
    .array(name)
    .max(64)
    .refine(items => new Set(items).size === items.length, 'Duplicate execution template')
    .optional(),
});
export type ExecutionDescriptor = z.infer<typeof executionDescriptorSchema>;

export const executionPolicySchema = z
  .strictObject({
    version: z.literal(1),
    baseRevision: digest,
    defaultProfile: name,
    profiles,
    network: z.enum(['inherited', 'public-only']),
    idleTimeoutSeconds: z.literal(300),
    limits: z.strictObject({
      jobTimeoutSeconds: positive,
      queueTimeoutSeconds: positive,
      stopGraceSeconds: positive,
      checkpointIntervalSeconds: positive,
      workspaceConcurrency: positive,
      deploymentConcurrency: positive,
      workspaceStorageBytes: positive,
      fileBytes: positive,
      fileCount: positive,
      outputBytes: positive,
      jobBudgetPicoUsd: cost,
    }),
  })
  .superRefine((policy, context) => {
    const issue = (path: string[], message: string) => context.addIssue({ code: 'custom', path, message });
    if (!policy.profiles.some(profile => profile.id === policy.defaultProfile))
      issue(['defaultProfile'], 'Default execution profile is not configured');
    if (policy.limits.workspaceConcurrency > policy.limits.deploymentConcurrency)
      issue(['limits', 'workspaceConcurrency'], 'Workspace concurrency exceeds deployment concurrency');
    if (policy.limits.fileBytes > policy.limits.workspaceStorageBytes)
      issue(['limits', 'fileBytes'], 'File limit exceeds workspace storage quota');
    if (policy.limits.checkpointIntervalSeconds > policy.limits.jobTimeoutSeconds)
      issue(['limits', 'checkpointIntervalSeconds'], 'Checkpoint interval exceeds job timeout');
  });
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;

export type ExecutionConfiguration =
  | { readonly mode: 'off' }
  | {
      readonly mode: Exclude<ExecutionMode, 'off'>;
      readonly policy: ExecutionPolicy;
      readonly policyRevision: string;
    };

export const executionAllocationSchema = z.strictObject({
  areaId: z.uuid(),
  allocationId: z.uuid(),
  generation: positive,
});
export type ExecutionAllocation = z.infer<typeof executionAllocationSchema>;
export const executionJobSchema = executionAllocationSchema.extend({ jobId: z.uuid() });
export type ExecutionJob = z.infer<typeof executionJobSchema>;

const secretHost = z
  .string()
  .max(253)
  .regex(/^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/);
/**
 * A credential the backend holds outside the machine. The machine sees only a placeholder, in `env` when set; the
 * backend's egress puts the value into the `header` of HTTPS requests to `hosts`, replacing the placeholder or, when
 * the request lacks the header, writing `format` with `{value}` replaced.
 */
export const executionSecretSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,15}$/),
  value: z
    .string()
    .min(1)
    .max(16384)
    .regex(/^[\x20-\x7e]+$/),
  env: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]{0,127}$/)
    .optional(),
  hosts: z.array(secretHost).min(1).max(16),
  header: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,128}$/)
    .optional(),
  format: z
    .string()
    .max(1024)
    .refine(value => value.includes('{value}'), 'Format must contain {value}')
    .optional(),
});
export type ExecutionSecret = z.infer<typeof executionSecretSchema>;
export const executionSecretsSchema = z
  .array(executionSecretSchema)
  .max(8)
  .refine(items => new Set(items.map(item => item.name)).size === items.length, 'Duplicate execution secret')
  .refine(
    items => new Set(items.flatMap(item => (item.env ? [item.env] : []))).size === items.filter(i => i.env).length,
    'Duplicate execution secret variable',
  );

export const executionPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    path =>
      [...path].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
      !/[\\:]/u.test(path) &&
      path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..'),
    'Expected a relative working-file path',
  );
export const executionCommandSchema = z.strictObject({
  program: z
    .string()
    .min(1)
    .max(4096)
    .refine(value => !value.includes('\0')),
  args: z
    .array(
      z
        .string()
        .max(65536)
        .refine(value => !value.includes('\0')),
    )
    .max(256),
  cwd: executionPathSchema.optional(),
});
export type ExecutionCommand = z.infer<typeof executionCommandSchema>;

export const executionFileSchema = z.strictObject({
  path: executionPathSchema,
  size: count,
  sha256: digest,
  executable: z.boolean(),
});
export type ExecutionFile = z.infer<typeof executionFileSchema>;

export const executionAllocationStateSchema = z.strictObject({
  state: z.enum(['absent', 'preparing', 'ready', 'stopping', 'stopped', 'recovery-required']),
});
export type ExecutionAllocationState = z.infer<typeof executionAllocationStateSchema>;
export const executionJobStateSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('running') }),
  z.strictObject({ state: z.literal('completed'), exitCode: z.number().int() }),
  z.strictObject({ state: z.literal('cancelled') }),
  z.strictObject({ state: z.literal('timed-out') }),
  z.strictObject({ state: z.literal('outcome-unknown') }),
]);
export type ExecutionJobState = z.infer<typeof executionJobStateSchema>;

export const executionOutputChunkBytes = 8192;
const base64Bytes = (data: string) => (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
const outputSequence = positive.max(2147483647);
export const executionOutputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('chunk'),
    sequence: outputSequence,
    stream: z.enum(['stdout', 'stderr']),
    data: z
      .string()
      .min(4)
      .max(4 * Math.ceil(executionOutputChunkBytes / 3))
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
      .refine(data => base64Bytes(data) <= executionOutputChunkBytes),
  }),
  z.strictObject({ kind: z.literal('truncated'), sequence: outputSequence }),
  z.strictObject({ kind: z.literal('end'), sequence: outputSequence }),
]);
export type ExecutionOutput = z.infer<typeof executionOutputSchema>;
export const executionOutputBytes = (output: ExecutionOutput) =>
  output.kind === 'chunk' ? base64Bytes(output.data) : 0;

type Operation = { readonly signal: AbortSignal };

/** Only logical IDs cross this boundary. Adapters retain their own provider and host identifiers. */
export interface ExecutionBackend {
  readonly descriptor: ExecutionDescriptor;
  prepare(
    input: ExecutionAllocation & {
      readonly profile: ExecutionProfile;
      readonly baseRevision: string;
      readonly policyRevision: string;
      readonly deadline: string;
      /** Only for a backend with `capabilities.secrets`; it deletes them when the allocation is destroyed. */
      readonly secrets?: readonly ExecutionSecret[];
    },
    operation: Operation,
  ): Promise<ExecutionAllocationState>;
  inspect(input: ExecutionAllocation, operation: Operation): Promise<ExecutionAllocationState>;
  destroy(input: ExecutionAllocation, operation: Operation): Promise<ExecutionAllocationState>;
  startJob(
    input: ExecutionJob & { readonly command: ExecutionCommand; readonly deadline: string },
    operation: Operation,
  ): Promise<ExecutionJobState>;
  inspectJob(input: ExecutionJob, operation: Operation): Promise<ExecutionJobState>;
  stopJob(input: ExecutionJob, operation: Operation): Promise<ExecutionJobState>;
  readOutput(
    input: ExecutionJob & { readonly after: number; readonly maximumBytes: number },
    operation: Operation,
  ): AsyncIterable<ExecutionOutput>;
  listFiles(input: ExecutionAllocation, operation: Operation): AsyncIterable<ExecutionFile>;
  readFile(
    input: ExecutionAllocation & { readonly file: ExecutionFile },
    operation: Operation,
  ): AsyncIterable<Uint8Array>;
  writeFile(
    input: ExecutionAllocation & { readonly file: ExecutionFile; readonly bytes: AsyncIterable<Uint8Array> },
    operation: Operation,
  ): Promise<void>;
  removeFile(input: ExecutionAllocation & { readonly path: string }, operation: Operation): Promise<void>;
  shutdown?(): Promise<void>;
}

const methods = [
  'prepare',
  'inspect',
  'destroy',
  'startJob',
  'inspectJob',
  'stopJob',
  'readOutput',
  'listFiles',
  'readFile',
  'writeFile',
  'removeFile',
] as const satisfies readonly (keyof ExecutionBackend)[];

export function executionBackendValid(value: unknown): value is ExecutionBackend {
  return (
    value !== null &&
    typeof value === 'object' &&
    'descriptor' in value &&
    executionDescriptorSchema.safeParse(value.descriptor).success &&
    methods.every(method => method in value && typeof Reflect.get(value, method) === 'function') &&
    (!('shutdown' in value) || typeof value.shutdown === 'function')
  );
}

export function executionProfileSupported(profile: ExecutionProfile, descriptor: ExecutionDescriptor): boolean {
  if (profile.template !== undefined && !descriptor.templates?.includes(profile.template)) return false;
  return descriptor.profiles.some(candidate => {
    if (candidate.id !== profile.id || candidate.resources.kind !== profile.resources.kind) return false;
    const requested = profile.resources;
    const available = candidate.resources;
    return (
      (requested.kind === 'shared' && available.kind === 'shared') ||
      (requested.kind === 'limited' &&
        available.kind === 'limited' &&
        requested.cpuMillis === available.cpuMillis &&
        requested.memoryMiB === available.memoryMiB &&
        requested.diskBytes === available.diskBytes)
    );
  });
}
