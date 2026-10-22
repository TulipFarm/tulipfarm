import { canonicalEmail } from '@tulipfarm/workspaces/canonical-email';
import { invitationInputSchema } from '@tulipfarm/workspaces/governance-contracts';

export type InvitationReceipt =
  | { outcome: 'already-member' }
  | { outcome: 'created' | 'pending'; invitationId: string };
/**
 * `memberRequestId` and `memberRecordId` make the workspace member row that is
 * created for a new email idempotent, so a retry never adds a second row.
 */
export type RecipientCommand = {
  email: string;
  requestId: string;
  memberRequestId: string;
  memberRecordId: string;
  workspaceMemberId?: string;
};
export type RecipientState =
  | { kind: 'queued' | 'sending' }
  | { kind: 'success'; result: InvitationReceipt }
  | {
      kind: 'failed';
      code: 'access-lost' | 'rate-limited' | 'invalid' | 'uncertain' | 'member-conflict' | 'member-unavailable';
    };
export type RecipientRow = RecipientCommand & { state: RecipientState };

export function parseRecipients(input: string) {
  const seen = new Set<string>();
  const recipients: string[] = [];
  const invalid: string[] = [];
  const duplicates: string[] = [];
  for (const entry of input
    .split(/[,\n]/)
    .map(value => value.trim())
    .filter(Boolean)) {
    const parsed = invitationInputSchema.shape.email.safeParse(entry);
    if (!parsed.success) {
      invalid.push(entry);
      continue;
    }
    const key = canonicalEmail(parsed.data);
    if (seen.has(key)) {
      duplicates.push(parsed.data);
      continue;
    }
    seen.add(key);
    recipients.push(parsed.data);
  }
  return { recipients, invalid, duplicates };
}

export async function sendInvitationBatch<Command extends Pick<RecipientCommand, 'email' | 'requestId'>>(
  commands: Command[],
  send: (command: Command) => Promise<RecipientState>,
  update: (command: Command, state: RecipientState) => void,
) {
  let next = 0;
  let stopped: 'access-lost' | 'rate-limited' | undefined;
  async function worker() {
    while (next < commands.length) {
      const command = commands[next++];
      if (!command) return;
      if (stopped) {
        update(command, { kind: 'failed', code: stopped });
        continue;
      }
      update(command, { kind: 'sending' });
      const state = await send(command);
      if (state.kind === 'failed' && (state.code === 'access-lost' || state.code === 'rate-limited'))
        stopped = state.code;
      update(command, state);
    }
  }
  await Promise.all([worker(), worker()]);
}
