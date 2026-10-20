import type { Pool } from 'pg';
import { authConfig, createAuth } from './better-auth.ts';

export type DevSession = { user: { id: string; email: string; name: string }; cookies: string[]; cookieHeader: string };

const loopbackHosts = ['127.0.0.1', 'localhost', '::1'];

// Matches the development sign-in link gate: never in production, with real email, or off loopback.
export function devSessionsAllowed(env: NodeJS.ProcessEnv = process.env) {
  return (
    env.NODE_ENV !== 'production' &&
    !env.EMAIL_PROVIDER &&
    !env.ACS_CONNECTION_STRING &&
    !env.SMTP_HOST &&
    loopbackHosts.includes(env.HOST ?? '127.0.0.1')
  );
}

export function safeRedirectPath(value: unknown) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  const url = new URL(value, 'http://local.invalid');
  return url.origin === 'http://local.invalid' ? `${url.pathname}${url.search}${url.hash}` : '/';
}

// Signs in through Better Auth's own magic-link verification, without email or a Turnstile challenge.
export function createDevSessions(pool: Pool) {
  let pending: string | undefined;
  const auth = createAuth(
    pool,
    async ({ url }) => {
      pending = url;
    },
    async () => {},
  );
  const origin = authConfig().webOrigin;
  return {
    async signIn(emailInput: string, name?: string): Promise<DevSession> {
      const email = emailInput.trim().toLowerCase();
      pending = undefined;
      await auth.api.signInMagicLink({ headers: new Headers({ origin }), body: { email, ...(name ? { name } : {}) } });
      const link = pending as string | undefined;
      if (!link) throw new Error('Better Auth did not issue a sign-in link');
      const response = await auth.handler(new Request(link, { headers: { origin } }));
      const cookies = response.headers.getSetCookie();
      const cookieHeader = cookies.map(value => value.split(';')[0]).join('; ');
      const session = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader }) });
      if (!session) throw new Error('Development session was not created');
      if (name && !session.user.name)
        await pool.query('UPDATE app.users SET name = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [
          session.user.id,
          name.trim(),
        ]);
      return {
        user: { id: session.user.id, email: session.user.email, name: name ?? session.user.name },
        cookies,
        cookieHeader,
      };
    },
  };
}
