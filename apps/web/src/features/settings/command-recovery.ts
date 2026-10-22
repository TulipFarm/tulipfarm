import { z } from 'zod';
import { modelAvailabilityCommandSchema, modelPolicyCommandSchema } from '@tulipfarm/agents/model-policy-contracts';
import { settingsCommandSchema } from './api';

const prefix = 'tulipfarm.pending-command.';
export const recoveryChanged = 'tulipfarm:command-recovery-changed';
const owner = { userId: z.string().min(1), workspaceId: z.uuid() };
const pendingSchema = z.discriminatedUnion('channel', [
  z.object({ ...owner, channel: z.literal('settings'), command: settingsCommandSchema }),
  z.object({ ...owner, channel: z.literal('availability'), command: modelAvailabilityCommandSchema }),
  z
    .object({ ...owner, channel: z.literal('fallback'), scope: z.string().min(1), command: modelPolicyCommandSchema })
    .refine(value => value.scope === value.command.sourceFamilyId),
]);
export type PendingCommand = z.infer<typeof pendingSchema>;

export interface CommandRecovery<C> {
  load: () => C | null;
  save: (command: C) => void;
  clear: () => void;
}

function keyFor(userId: string, workspaceId: string, channel: PendingCommand['channel'], scope?: string) {
  return `${prefix}${JSON.stringify(scope ? [userId, workspaceId, channel, scope] : [userId, workspaceId, channel])}`;
}

export function pendingCommands(userId: string): PendingCommand[] {
  const result: PendingCommand[] = [];
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (!key.startsWith(prefix)) continue;
      try {
        const parsed = pendingSchema.safeParse(JSON.parse(sessionStorage.getItem(key) ?? 'null'));
        if (
          parsed.success &&
          parsed.data.userId === userId &&
          key ===
            keyFor(
              userId,
              parsed.data.workspaceId,
              parsed.data.channel,
              parsed.data.channel === 'fallback' ? parsed.data.scope : undefined,
            )
        )
          result.push(parsed.data);
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }
  return result;
}

export function commandRecovery<C>({
  userId,
  workspaceId,
  channel,
  schema,
  scope,
}: {
  userId: string;
  workspaceId: string;
  channel: PendingCommand['channel'];
  schema: z.ZodType<C>;
  scope?: string;
}): CommandRecovery<C> {
  const key = keyFor(userId, workspaceId, channel, scope);
  return {
    load: () => {
      const pending = pendingCommands(userId).find(
        item =>
          item.workspaceId === workspaceId &&
          item.channel === channel &&
          (item.channel !== 'fallback' || item.scope === scope),
      );
      const parsed = schema.safeParse(pending?.command);
      return parsed.success ? parsed.data : null;
    },
    save: command => {
      if (!sessionStorage.getItem(key) && pendingCommands(userId).length >= 20)
        throw new Error('Recovery storage full');
      sessionStorage.setItem(
        key,
        JSON.stringify(pendingSchema.parse({ userId, workspaceId, channel, scope, command: schema.parse(command) })),
      );
      window.dispatchEvent(new Event(recoveryChanged));
    },
    clear: () => {
      sessionStorage.removeItem(key);
      window.dispatchEvent(new Event(recoveryChanged));
    },
  };
}
