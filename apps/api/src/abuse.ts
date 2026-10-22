import { createHmac } from 'node:crypto';
import { createBackgroundJob } from '@tulipfarm/observability';
import { normalizeIP } from '@fastify/rate-limit';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';
import { canonicalEmail } from '@tulipfarm/workspaces/canonical-email';
import { idSchema } from '@tulipfarm/workflows/contracts';
import { authConfig, type registerAuth } from './auth.ts';

const counterSchema = z.object({ current: z.number().int().positive(), ttl: z.number().int().positive() });
type Policy = { name: string; max: number; windowMs: number };
const authPolicy: Policy = { name: 'auth', max: 120, windowMs: 60_000 };
const authWritePolicy: Policy = { name: 'auth-write', max: 30, windowMs: 60_000 };
const emailIpPolicy: Policy = { name: 'email-ip', max: 5, windowMs: 60_000 };
const emailPolicy: Policy = { name: 'email-recipient', max: 3, windowMs: 900_000 };
// Password sign-in and sign-up send no email; these bound password guessing per address and per client.
const passwordIpPolicy: Policy = { name: 'password-ip', max: 10, windowMs: 60_000 };
const passwordPolicy: Policy = { name: 'password-account', max: 10, windowMs: 900_000 };
const passwordPaths = new Set(['/v1/auth/sign-in/email', '/v1/auth/sign-up/email']);
const onboardingPolicy: Policy = { name: 'onboarding-draft', max: 20, windowMs: 3_600_000 };
const webhookWorkspacePolicy: Policy = { name: 'workflow-webhook-workspace', max: 600, windowMs: 60_000 };
const webhookPolicy: Policy = { name: 'workflow-webhook', max: 120, windowMs: 60_000 };
const webhookSourcePolicy: Policy = { name: 'workflow-webhook-source', max: 60, windowMs: 60_000 };
const webhookTarget = z.object({ workspaceId: idSchema, workflowId: idSchema });
const mutations = new Map<string, Policy>([
  ['slackinstallV1', { name: 'slack-install', max: 5, windowMs: 60_000 }],
  ['slackdisconnectV1', { name: 'slack-install', max: 5, windowMs: 60_000 }],
  ['saveWorkflowV1', { name: 'workflow-save', max: 30, windowMs: 60_000 }],
  ['startWorkflowV1', { name: 'workflow-run', max: 30, windowMs: 60_000 }],
  ['emitWorkflowEventV1', { name: 'workflow-run', max: 30, windowMs: 60_000 }],
  ['sendWorkflowWebhookTestV1', { name: 'workflow-run', max: 30, windowMs: 60_000 }],
  ['respondWorkflowV1', { name: 'workflow-input', max: 30, windowMs: 60_000 }],
  ['createWorkspaceV1', { name: 'workspace-create', max: 3, windowMs: 3_600_000 }],
  ['completeOnboardingV1', { name: 'workspace-create', max: 3, windowMs: 3_600_000 }],
  ['createGovernanceInvitationV1', { name: 'invitation-create', max: 20, windowMs: 3_600_000 }],
  ['resendGovernanceInvitationV1', { name: 'invitation-create', max: 20, windowMs: 3_600_000 }],
  ['submitAgentChatV1', { name: 'agent-chat', max: 20, windowMs: 60_000 }],
  ['createConversationV1', { name: 'conversation-create', max: 20, windowMs: 60_000 }],
  ['sendConversationMessageV1', { name: 'conversation-send', max: 60, windowMs: 60_000 }],
  ['retryConversationTurnV1', { name: 'conversation-control', max: 30, windowMs: 60_000 }],
  ['cancelConversationTurnV1', { name: 'conversation-control', max: 30, windowMs: 60_000 }],
  ['deleteConversationV1', { name: 'conversation-control', max: 30, windowMs: 60_000 }],
  ['reserveConversationUploadV1', { name: 'conversation-upload', max: 30, windowMs: 60_000 }],
  ['uploadConversationBytesV1', { name: 'conversation-upload', max: 30, windowMs: 60_000 }],
  ['retryAgentChatV1', { name: 'agent-chat', max: 20, windowMs: 60_000 }],
  ['createProjectV1', { name: 'project-create', max: 20, windowMs: 60_000 }],
  ['saveProjectKnowledgeV1', { name: 'project-knowledge', max: 30, windowMs: 60_000 }],
  ['uploadProjectKnowledgeV1', { name: 'project-knowledge', max: 30, windowMs: 60_000 }],
  ['promoteProjectAttachmentV1', { name: 'project-knowledge', max: 30, windowMs: 60_000 }],
]);

type LimitMode = 'spend' | 'check' | 'refund';
const staleSignatureAnswer = z.object({ error: z.enum(['webhook-signature-expired', 'webhook-signature-replayed']) });

function staleSignature(status: number, payload: unknown) {
  if (status !== 409 || typeof payload !== 'string') return false;
  try {
    return staleSignatureAnswer.safeParse(JSON.parse(payload)).success;
  } catch {
    return false;
  }
}
const refused = new WeakMap<FastifyRequest, string>();
/** The webhook budget that refused a delivery before its handler ran, if any. Only the per-workflow budget is spent by verified deliveries alone. */
export const webhookRefusal = (request: FastifyRequest) => refused.get(request);

export function createAbuseLimiter(pool: Pool, secret: string) {
  return async (policy: Policy, identity: string, mode: LimitMode = 'spend') => {
    const key = createHmac('sha256', secret).update(`${policy.name}:${identity}`).digest('hex');
    if (mode === 'refund') {
      await pool.query(
        `UPDATE app.api_rate_limits SET hits = hits - 1 WHERE key = $1 AND hits > 1 AND expires_at > statement_timestamp()`,
        [key],
      );
      return null;
    }
    if (mode === 'check') {
      const row = (
        await pool.query(
          `SELECT hits AS current, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - statement_timestamp())) * 1000))::integer AS ttl
        FROM app.api_rate_limits WHERE key = $1 AND expires_at > statement_timestamp()`,
          [key],
        )
      ).rows[0];
      if (!row) return null;
      const { current, ttl } = counterSchema.parse(row);
      return current >= policy.max ? Math.ceil(ttl / 1000) : null;
    }
    const result = await pool.query(
      `INSERT INTO app.api_rate_limits AS limits (key, hits, expires_at)
      VALUES ($1, 1, statement_timestamp() + $2 * interval '1 millisecond')
      ON CONFLICT (key) DO UPDATE SET
        hits = CASE WHEN limits.expires_at <= statement_timestamp() THEN 1 ELSE LEAST(limits.hits + 1, $3 + 1) END,
        expires_at = CASE WHEN limits.expires_at <= statement_timestamp() THEN EXCLUDED.expires_at ELSE limits.expires_at END
      RETURNING hits AS current, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - statement_timestamp())) * 1000))::integer AS ttl`,
      [key, policy.windowMs, policy.max],
    );
    const { current, ttl } = counterSchema.parse(result.rows[0]);
    return current > policy.max ? Math.ceil(ttl / 1000) : null;
  };
}

export function registerAbuseProtection(app: FastifyInstance, auth: ReturnType<typeof registerAuth>['auth']) {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgresql://tulipfarm:local-tulipfarm@127.0.0.1:5432/tulipfarm',
    max: 2,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 2_000,
    query_timeout: 3_000,
  });
  pool.on('error', () => app.log.error('Abuse protection database unavailable'));
  const consume = createAbuseLimiter(pool, authConfig().secret);
  const cleanupJob = createBackgroundJob('abuse-expiry', 60);
  let cleanup: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    cleanup ??= cleanupJob
      .run(() =>
        pool.query(`DELETE FROM app.api_rate_limits WHERE expires_at < now() AND key IN
      (SELECT key FROM app.api_rate_limits WHERE expires_at < now() ORDER BY expires_at LIMIT 1000)`),
      )
      .catch(() => app.log.error('Abuse protection cleanup failed'))
      .finally(() => {
        cleanup = undefined;
      });
  }, 60_000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await cleanup;
    cleanupJob.close();
    await pool.end();
  });
  registerAbuseHooks(app, consume, auth);
}

export function registerAbuseHooks(
  app: FastifyInstance,
  consume: ReturnType<typeof createAbuseLimiter>,
  auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>,
) {
  const deliveries = new WeakMap<
    FastifyRequest,
    { workflow: string; workspace: string; source: string; reachedHandler: boolean }
  >();
  async function enforce(reply: FastifyReply, policy: Policy, identity: string, mode?: LimitMode, failOpen = false) {
    refused.set(reply.request, policy.name);
    try {
      const retry = await consume(policy, identity, mode);
      if (retry !== null) {
        reply.code(429).header('Retry-After', retry).send({ error: 'rate-limit-exceeded' });
        return false;
      }
      refused.delete(reply.request);
      return true;
    } catch {
      app.log.error({ policy: policy.name, failOpen }, 'Abuse protection unavailable');
      // Session reads must not block public entry when the limiter store is unavailable; writes stay fail-closed.
      if (failOpen) {
        refused.delete(reply.request);
        return true;
      }
      reply.code(503).header('Retry-After', 5).send({ error: 'abuse-protection-unavailable' });
      return false;
    }
  }
  app.addHook('onRequest', async (request, reply) => {
    if (['saveOnboardingV1', 'resumeOnboardingV1'].includes(request.routeOptions.schema?.operationId ?? '')) {
      if (!(await enforce(reply, onboardingPolicy, normalizeIP(request.ip)))) return reply;
    }
    if (request.routeOptions.schema?.operationId === 'receiveWorkflowWebhookV1') {
      const target = webhookTarget.safeParse(request.params);
      if (!target.success) return;
      // Only a delivery whose key passed spends the workflow and workspace budgets, so a sender without the key cannot exhaust them.
      // Every attempt spends its source budget before the authorization lock and gets it back once the key is accepted.
      const delivery = {
        workflow: `${target.data.workspaceId}:${target.data.workflowId}`,
        workspace: target.data.workspaceId,
        source: normalizeIP(request.ip),
        reachedHandler: false,
      };
      if (!(await enforce(reply, webhookPolicy, delivery.workflow, 'check'))) return reply;
      if (!(await enforce(reply, webhookWorkspacePolicy, delivery.workspace, 'check'))) return reply;
      if (!(await enforce(reply, webhookSourcePolicy, delivery.source))) return reply;
      deliveries.set(request, delivery);
      return;
    }
    if (request.routeOptions.url !== '/v1/auth/*') return;
    if (request.method === 'POST') {
      if (request.headers.origin !== authConfig().webOrigin) return reply.code(403).send({ error: 'untrusted-origin' });
      if (!(await enforce(reply, authWritePolicy, normalizeIP(request.ip)))) return reply;
    }
    if (!(await enforce(reply, authPolicy, normalizeIP(request.ip), 'spend', request.method === 'GET'))) return reply;
  });
  app.addHook('preHandler', async (request, reply) => {
    const delivery = deliveries.get(request);
    if (delivery) delivery.reachedHandler = true;
    if (request.routeOptions.url === '/v1/auth/*' && request.method === 'POST') {
      const body = z.object({ email: z.string() }).safeParse(request.body);
      const password = authConfig().emailPassword && passwordPaths.has(request.url.split('?')[0] ?? '');
      if (body.success) {
        if (!(await enforce(reply, password ? passwordIpPolicy : emailIpPolicy, normalizeIP(request.ip)))) return reply;
        if (!(await enforce(reply, password ? passwordPolicy : emailPolicy, canonicalEmail(body.data.email))))
          return reply;
      }
    }
    const policy = mutations.get(request.routeOptions.schema?.operationId ?? '');
    if (!policy) return;
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (session && !(await enforce(reply, policy, session.user.id))) return reply;
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const delivery = deliveries.get(request);
    deliveries.delete(request);
    // The handler answers 404 for a wrong key or an unknown workflow; a body rejected before the handler never reached the key check.
    // A captured signed request keeps a valid signature, so an expired or replayed one is no more trusted than a wrong key.
    if (
      !delivery?.reachedHandler ||
      reply.statusCode === 404 ||
      reply.statusCode >= 500 ||
      staleSignature(reply.statusCode, payload)
    )
      return payload;
    try {
      await consume(webhookSourcePolicy, delivery.source, 'refund');
      await consume(webhookPolicy, delivery.workflow);
      await consume(webhookWorkspacePolicy, delivery.workspace);
    } catch {
      app.log.error('Webhook rate limit accounting failed');
    }
    return payload;
  });
}
