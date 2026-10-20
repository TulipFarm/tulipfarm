import { Pool } from 'pg';
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { createEmailSender, emailSenderConfigFromEnv, renderEmail } from '@tulipfarm/email';
import { createEmailDeliveryStore, emailDeliveryKeys } from '@tulipfarm/workspaces/email-delivery';
import { createBackgroundJob, log } from '@tulipfarm/observability';
import { z } from 'zod';

export async function createEmailDeliveryComposition(
  send?: (to: string, message: Awaited<ReturnType<typeof renderEmail>>) => Promise<unknown>,
) {
  const keys = emailDeliveryKeys();
  const pool = new Pool({
    connectionString: z.string().min(1).parse(process.env.EMAIL_DELIVERY_DATABASE_URL),
    max: 2,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  pool.on('error', () => log('error', 'dependency', 'database_connection_failed'));
  try {
    const privileges = await pool.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relname IN ('users', 'sessions', 'accounts', 'verifications')
      AND has_any_column_privilege(current_user, c.oid, 'SELECT') LIMIT 1`);
    if (privileges.rowCount) throw new Error('Email worker requires a restricted delivery database login');
  } catch {
    await pool.end();
    throw new Error('Email worker requires a restricted delivery database login');
  }
  const store = createEmailDeliveryStore(pool, keys);
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });
  let sender: ReturnType<typeof createEmailSender> | undefined;
  let running: Promise<void> | undefined;
  const dispatchJob = createBackgroundJob('email-dispatch', 5);
  async function dispatch() {
    for (const id of await store.pending()) {
      try {
        await connection.withDeadline(Date.now() + 5000, () =>
          client.workflow.start('deliverEmailWorkflow', {
            workflowId: `email-delivery-${id}`,
            taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
            workflowIdReusePolicy: 'ALLOW_DUPLICATE',
            args: [id],
          }),
        );
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw new Error('Email dispatch unavailable');
      }
    }
  }
  function tick() {
    if (running) return;
    running = dispatchJob
      .run(dispatch)
      .catch(() => {
        log('error', 'dependency', 'dispatch_failed');
      })
      .finally(() => {
        running = undefined;
      });
  }
  const timer = setInterval(tick, 5000);
  tick();
  return {
    activities: {
      deliverEmail: (id: string) =>
        store.deliver(id, async payload => {
          if (!send) sender ??= createEmailSender(emailSenderConfigFromEnv());
          const message =
            payload.kind === 'invitation'
              ? await renderEmail({
                  template: 'invitation',
                  props: {
                    url: payload.url,
                    email: payload.email,
                    workspaceName: payload.workspaceName,
                    expiresAt: payload.expiresAt,
                  },
                })
              : payload.kind === 'password-reset'
                ? await renderEmail({
                    template: 'password-reset',
                    props: { email: payload.email, url: payload.url, expiresInMinutes: 60 },
                  })
                : await renderEmail({
                    template: 'magic-link',
                    props: { email: payload.email, url: payload.url, expiresInMinutes: 15 },
                  });
          if (send) await send(payload.email, message);
          else if (sender) await sender(payload.email, message);
        }),
    },
    async close() {
      clearInterval(timer);
      await running;
      dispatchJob.close();
      await connection.close();
      await pool.end();
    },
  };
}
