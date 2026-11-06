import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { executionModeSchema, executionPolicySchema, type ExecutionConfiguration } from '@tulipfarm/execution-contract';

export class ExecutionConfigurationError extends Error {
  override name = 'ExecutionConfigurationError';
}

export function executionConfiguration(env: NodeJS.ProcessEnv = process.env): ExecutionConfiguration {
  const mode = executionModeSchema.safeParse(env.TULIPFARM_EXECUTION_BACKEND ?? 'off');
  if (!mode.success) throw new ExecutionConfigurationError('Invalid TULIPFARM_EXECUTION_BACKEND');
  if (mode.data === 'off') return { mode: 'off' };
  const file = env.TULIPFARM_EXECUTION_POLICY_FILE;
  if (!file?.trim()) throw new ExecutionConfigurationError('TULIPFARM_EXECUTION_POLICY_FILE is required');
  let input: unknown;
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const maximumBytes = 256 * 1024;
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > maximumBytes) throw new Error('execution-policy-size');
      const bytes = Buffer.alloc(maximumBytes + 1);
      let length = 0;
      for (;;) {
        const read = readSync(fd, bytes, length, bytes.length - length, null);
        if (!read) break;
        length += read;
        if (length > maximumBytes) throw new Error('execution-policy-size');
      }
      input = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new ExecutionConfigurationError('Could not read TULIPFARM_EXECUTION_POLICY_FILE');
  }
  const parsed = executionPolicySchema.safeParse(input);
  if (!parsed.success) throw new ExecutionConfigurationError('Invalid execution policy');
  const policy = parsed.data;
  const local = mode.data === 'local';
  if (
    policy.network !== (local ? 'inherited' : 'public-only') ||
    policy.profiles.some(profile => profile.resources.kind !== (local ? 'shared' : 'limited'))
  )
    throw new ExecutionConfigurationError('Execution policy does not match the selected backend mode');
  const policyRevision = createHash('sha256')
    .update(JSON.stringify({ mode: mode.data, policy }))
    .digest('hex');
  return { mode: mode.data, policy, policyRevision };
}
