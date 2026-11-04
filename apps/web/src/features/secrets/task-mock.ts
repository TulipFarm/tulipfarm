import type { SecretRequestView, TaskSecretRequest } from './contracts';

const waitingId = '56565656-5656-4565-8565-565656565656';
const providedId = '57575757-5757-4575-8575-575757575757';
const expiredId = '58585858-5858-4585-8585-585858585858';
const hour = 3_600_000;

/** Secret forms a task sent its owner, for the task page mock. `settled` runs once the owner answers. */
export function taskSecretMock(settled: () => void) {
  const at = (offset: number) => new Date(Date.now() + offset).toISOString();
  const view: SecretRequestView = {
    id: waitingId,
    status: 'waiting',
    revision: 1,
    expiresAt: at(23 * hour),
    purpose: 'I need read access to the billing service to compare last week’s failed invoices with checkout errors.',
    destinations: [
      { kind: 'endpoint', value: 'http://billing.internal:8080/api/invoices' },
      { kind: 'host', value: 'api.stripe.com' },
    ],
    fields: [
      { id: 'billing', label: 'Billing service token', kind: 'token', placement: { kind: 'bearer' }, options: [] },
      {
        id: 'stripe',
        label: 'Stripe restricted key',
        kind: 'api-key',
        placement: { kind: 'bearer' },
        options: [
          {
            secretId: '59595959-5959-4595-8595-595959595959',
            name: 'Stripe read-only key',
            lifetime: 'saved',
            placement: { kind: 'bearer' },
            expiresAt: null,
          },
        ],
      },
    ],
    declineReason: null,
  };
  const requests: TaskSecretRequest[] = [
    {
      id: waitingId,
      status: 'waiting',
      revision: 1,
      expiresAt: view.expiresAt,
      purpose: view.purpose,
      declineReason: null,
      references: [],
    },
    {
      id: providedId,
      status: 'provided',
      revision: 2,
      expiresAt: at(-hour),
      purpose: 'Read the checkout error dashboard.',
      declineReason: null,
      references: [
        {
          referenceId: '5a5a5a5a-5a5a-45a5-85a5-5a5a5a5a5a5a',
          fieldId: 'grafana',
          name: 'Grafana API token',
          kind: 'token',
        },
      ],
    },
    {
      id: expiredId,
      status: 'expired',
      revision: 2,
      expiresAt: at(-26 * hour),
      purpose: 'Read the payments database replica.',
      declineReason: null,
      references: [],
    },
  ];
  const finish = (status: 'provided' | 'declined', references: TaskSecretRequest['references']) => {
    view.status = status;
    requests[0] = { ...requests[0]!, status, revision: 2, references };
    settled();
    return Response.json({ status });
  };
  /** Answers the task's secret routes, or returns null for any other path. */
  function respond(path: string, method: string) {
    if (path.endsWith('/secrets/capabilities')) return Response.json({ enabled: true });
    if (path.endsWith('/secret-requests') && method === 'GET') return Response.json({ requests });
    if (!path.includes(`/secret-requests/${waitingId}`)) return null;
    if (method === 'GET') return Response.json(view);
    if (view.status !== 'waiting') return Response.json({ error: 'secret-conflict' }, { status: 409 });
    if (path.endsWith('/decline')) return finish('declined', []);
    return finish(
      'provided',
      view.fields.map(field => ({
        referenceId: crypto.randomUUID(),
        fieldId: field.id,
        name: field.label,
        kind: field.kind,
      })),
    );
  }
  return { respond };
}
