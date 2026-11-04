import { toolPresentation } from '@tulipfarm/conversations/tool-activity';
import type { ApiCallView } from './api';

const callId = (index: number) => `88888888-8888-4888-8888-${String(index).padStart(12, '0')}`;
const expiresAt = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString();
const bearer = { name: 'LINEAR_API_KEY', placement: { kind: 'bearer' } };

/** Change reviews in every state, for the chat and task page mocks. */
export function apiReviewMock(origin: ApiCallView['origin']) {
  const base = (index: number, method: ApiCallView['method'], url: string): ApiCallView => ({
    id: callId(index),
    status: 'awaiting-approval',
    method,
    url,
    host: new URL(url).host,
    headers: {},
    body: null,
    secrets: [],
    purpose: null,
    digest: 'a'.repeat(64),
    expiresAt,
    responseStatus: null,
    errorCode: null,
    origin,
  });
  const body = JSON.stringify(
    {
      title: 'Checkout fails for EUR orders',
      teamId: 'ENG',
      priority: 2,
      description: 'Orders paid in euros fail at the final step with an empty currency. Seen 14 times since Monday.',
    },
    null,
    2,
  );
  const calls: ApiCallView[] = [
    {
      ...base(1, 'POST', 'https://api.linear.app/v1/issues'),
      headers: { 'Content-Type': 'application/json', 'Linear-Client': 'tulipfarm' },
      body: { contentType: 'application/json', preview: body, bytes: body.length, truncated: false },
      secrets: [bearer],
      purpose: 'Create the bug report you asked for in the Engineering team.',
    },
    {
      ...base(2, 'PATCH', 'https://api.linear.app/v1/issues/ENG-482'),
      status: 'sent',
      responseStatus: 200,
      secrets: [bearer],
    },
    { ...base(3, 'DELETE', 'https://api.linear.app/v1/issues/ENG-301'), status: 'rejected', secrets: [bearer] },
    { ...base(4, 'PUT', 'https://hooks.example.com/deploy/staging'), status: 'expired' },
    { ...base(5, 'POST', 'https://api.stripe.com/v1/refunds'), status: 'conflict' },
    {
      ...base(6, 'POST', 'https://api.example.com/v1/orders/1042/cancel'),
      status: 'outcome-unknown',
      errorCode: 'outcome-unknown',
    },
  ];
  const tools = calls.map(call => ({
    id: call.id,
    tool: 'api.request',
    status: call.status === 'awaiting-approval' ? 'running' : call.status === 'sent' ? 'completed' : 'failed',
    ...(call.status === 'awaiting-approval' ? { activityStatus: 'waiting' } : {}),
    presentation: toolPresentation('api.request', { tool: 'api.request', method: call.method, url: call.url }),
    api:
      call.status === 'awaiting-approval'
        ? { review: true }
        : call.status === 'sent'
          ? { httpStatus: call.responseStatus, review: true }
          : { error: call.status === 'failed' ? (call.errorCode ?? 'failed') : call.status, review: true },
  }));
  let checks = 0;
  /** Answers the API call routes, or returns null for any other path. */
  function respond(path: string, method: string, init?: RequestInit) {
    if (path.endsWith('/api-calls') && method === 'GET') return Response.json({ calls });
    const match = /\/api-calls\/([^/]+)(\/decision)?$/.exec(path);
    const call = calls.find(item => item.id === match?.[1]);
    if (!match || !call) return null;
    if (match[2] && method === 'POST') {
      const { decision } = JSON.parse(String(init?.body)) as { decision: 'approve' | 'reject' };
      if (call.status !== 'awaiting-approval') return Response.json({ error: 'api-call-conflict' }, { status: 409 });
      call.status = decision === 'approve' ? 'sending' : 'rejected';
      checks = 0;
      return Response.json(call);
    }
    if (call.status === 'sending' && ++checks > 1) {
      call.status = 'sent';
      call.responseStatus = 201;
    }
    return Response.json(call);
  }
  return { calls, tools, respond };
}
