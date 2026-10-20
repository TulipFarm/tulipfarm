import { createEmailDeliveryStore, emailDeliveryKeys } from '@tulipfarm/workspaces/email-delivery';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { log } from '@tulipfarm/observability';
import { turnstileConfig } from './turnstile.ts';
import { createDevSessions, devSessionsAllowed, safeRedirectPath } from './dev-session.ts';
import { authConfig, createAuth, emailTransportConfigured } from './better-auth.ts';
import { registerAccountDetails } from './account-details.ts';

export { authConfig, createAuth } from './better-auth.ts';

export function registerAuth(app: FastifyInstance) {
  const config = authConfig();
  const turnstile = turnstileConfig();
  if (process.env.NODE_ENV === 'production' && emailTransportConfigured()) emailDeliveryKeys();
  // Local development has no mail transport; keep the latest link per email so the login page can offer it.
  const devLinks = devSessionsAllowed() ? new Map<string, string>() : undefined;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgresql://tulipfarm:local-tulipfarm@127.0.0.1:5432/tulipfarm',
    options: '-c search_path=app',
    connectionTimeoutMillis: 5000,
    max: 10,
  });
  pool.on('error', () => log('error', 'dependency', 'database_connection_failed'));
  app.addHook('onClose', async () => {
    await pool.end();
  });
  const passwordResetEmail = config.emailPassword && emailTransportConfigured();
  const auth = createAuth(
    pool,
    async ({ email, url }) => {
      const link = new URL('/verify-email', config.webOrigin);
      link.search = new URL(url).search;
      if (devLinks) {
        devLinks.set(email.toLowerCase(), link.toString());
        app.log.info({ email, link: link.toString() }, 'Development sign-in link');
        return;
      }
      await createEmailDeliveryStore(pool, emailDeliveryKeys()).enqueueMagicLink(email, link.toString());
    },
    undefined,
    passwordResetEmail
      ? async ({ email, url }) => {
          await createEmailDeliveryStore(pool, emailDeliveryKeys()).enqueuePasswordReset(email, url);
        }
      : undefined,
  );
  registerAccountDetails(app, { auth, identity: pool, googleEnabled: Boolean(config.google) });

  app.get('/auth/options', { schema: { hide: true } }, async (_request, reply) => {
    return reply.header('Cache-Control', 'no-store').send({
      turnstileSiteKey: turnstile?.siteKey ?? null,
      ...(config.emailPassword && { emailPassword: true, passwordResetEmail }),
    });
  });

  if (devLinks)
    app.get('/dev/sign-in-link', { schema: { hide: true } }, async (request, reply) => {
      const email = String((request.query as { email?: unknown }).email ?? '').toLowerCase();
      const link = devLinks.get(email);
      if (!link) return reply.code(404).send({ error: 'No sign-in link' });
      devLinks.delete(email);
      return reply.header('Cache-Control', 'no-store').send({ link });
    });

  // One-click local sign-in for agents and UI verification; see docs/mock-data.md.
  if (devLinks) {
    const devSessions = createDevSessions(pool);
    app.get('/dev/session', { schema: { hide: true } }, async (request, reply) => {
      const query = request.query as { email?: unknown; name?: unknown; redirect?: unknown };
      const email = typeof query.email === 'string' && query.email.includes('@') ? query.email : 'dev@tulipfarm.test';
      const name = typeof query.name === 'string' && query.name.trim() ? query.name.trim().slice(0, 80) : 'Dev User';
      const session = await devSessions.signIn(email, name);
      return reply
        .code(302)
        .header('Cache-Control', 'no-store')
        .header('set-cookie', session.cookies)
        .header('location', new URL(safeRedirectPath(query.redirect), config.webOrigin).toString())
        .send();
    });
  }

  app.route({
    method: ['GET', 'POST'],
    url: '/auth/*',
    bodyLimit: 16_384,
    schema: { hide: true },
    logLevel: 'silent',
    async handler(request, reply) {
      const headers = fromNodeHeaders(request.headers);
      headers.set('x-tulipfarm-client-ip', request.ip);
      const response = await auth.handler(
        new Request(new URL(request.url, config.baseURL), {
          method: request.method,
          headers,
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        }),
      );
      reply.code(response.status).header('Cache-Control', 'no-store');
      response.headers.forEach((value, key) => {
        if (key !== 'set-cookie') reply.header(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header('set-cookie', cookies);
      return reply.send(response.body ? await response.text() : null);
    },
  });
  return { auth, pool };
}
