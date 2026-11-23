import { creditGate } from '@tulipfarm/extensions';
import { createEmailSender, emailSenderConfigFromEnv, emailSenderConfigured, renderEmail } from '@tulipfarm/email';
import {
  advanceCreditAlert,
  creditAlertCompatibility,
  creditAlertLevel,
  workspaceAdmins,
} from '@tulipfarm/workspace-storage/credit-alerts';
import type { SqlClient } from '@tulipfarm/workspace-storage/runtime';

type Transaction = { client: SqlClient; schema: string };
type WorkspaceRuntime = {
  transaction<T>(
    workspaceId: string,
    compatibility: { readonly minimum: number; readonly maximum: number },
    action: (tx: Transaction) => Promise<T>,
  ): Promise<T>;
};

const credit = 1_000_000_000_000;
const credits = (units: bigint) => Number(units) / credit;

/**
 * Emails a workspace's admins when its credits run low (10% of granted credits left), when grace credits start, and
 * when work stops. Each level is sent once per crossing and re-arms after a top-up lifts the balance back above it.
 * Present only when the credit gate reports a balance, email is configured and `WEB_ORIGIN` is set.
 */
export function createCreditAlerts(options: {
  readonly runtime: WorkspaceRuntime;
  readonly discover: (after: string | null) => Promise<string[]>;
  readonly profiles: { read(workspaceId: string, userIds: string[]): Promise<{ id: string; email: string }[]> };
  readonly workspace: (workspaceId: string) => Promise<{ slug: string; name: string } | undefined>;
  readonly env?: NodeJS.ProcessEnv;
  readonly send?: (to: string, message: Awaited<ReturnType<typeof renderEmail>>) => Promise<unknown>;
}) {
  const gate = creditGate();
  const env = options.env ?? process.env;
  if (!gate.balance || !URL.canParse(env.WEB_ORIGIN ?? '')) return undefined;
  if (!options.send && !emailSenderConfigured(env)) return undefined;
  const balance = gate.balance.bind(gate);
  const origin = env.WEB_ORIGIN!;
  let sender = options.send;
  const send = (to: string, message: Awaited<ReturnType<typeof renderEmail>>) =>
    (sender ??= createEmailSender(emailSenderConfigFromEnv(env)))(to, message);

  async function check(workspaceId: string) {
    await options.runtime.transaction(workspaceId, creditAlertCompatibility, async tx => {
      const account = await balance(tx);
      if (!account) return;
      const level = await advanceCreditAlert(tx, creditAlertLevel(account));
      if (!level) return;
      const admins = (await workspaceAdmins(tx)).filter(id => /^[0-9a-f-]{36}$/i.test(id));
      const workspace = await options.workspace(workspaceId);
      if (!admins.length || !workspace) return;
      const recipients = await options.profiles.read(workspaceId, admins);
      const message = await renderEmail({
        template: 'credit-alert',
        props: {
          level,
          workspaceName: workspace.name,
          available: credits(account.available),
          granted: account.granted === null ? null : credits(account.granted),
          grace: account.grace == null ? null : credits(account.grace),
          url: new URL(`/${encodeURIComponent(workspace.slug)}/settings/usage`, origin).href,
        },
      });
      // A failed send rolls the recorded level back, so the next check sends it again.
      for (const { email } of recipients) await send(email, message);
    });
  }

  return {
    async run(signal: AbortSignal) {
      const failures: unknown[] = [];
      let after: string | null = null;
      for (;;) {
        const page = await options.discover(after);
        if (!page.length) break;
        for (const workspaceId of page) {
          signal.throwIfAborted();
          try {
            await check(workspaceId);
          } catch (error) {
            failures.push(error);
          }
        }
        after = page.at(-1)!;
      }
      if (failures.length) throw new AggregateError(failures, 'Credit alerts failed');
    },
  };
}
