import { canonicalEmail } from '@tulipfarm/workspaces/canonical-email';
import { avatarImageSchema } from '@tulipfarm/workspaces/contracts';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { magicLink } from 'better-auth/plugins';
import type { Pool } from 'pg';
import { modelFamilyIdSchema, selectableModelFamilies } from '@tulipfarm/config';
import { emitHook } from '@tulipfarm/extensions';
import { createTurnstileVerifier, turnstileConfig } from './turnstile.ts';
import { publicGuideOrigins } from './public-guide-config.ts';
import { isQaEmail } from '@tulipfarm/workspaces/qa-accounts';

export function authConfig() {
  const production = process.env.NODE_ENV === 'production';
  const secret = process.env.BETTER_AUTH_SECRET;
  if (production && (!secret || secret.length < 32))
    throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters');
  const googleId = process.env.GOOGLE_CLIENT_ID;
  const googleSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (Boolean(googleId) !== Boolean(googleSecret))
    throw new Error('Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
  if (production && (!process.env.BETTER_AUTH_URL || !process.env.WEB_ORIGIN))
    throw new Error('Set BETTER_AUTH_URL and WEB_ORIGIN in production');
  const webOrigin = new URL(process.env.WEB_ORIGIN ?? 'http://localhost:5173').origin;
  const emailPassword = process.env.AUTH_EMAIL_PASSWORD?.trim().toLowerCase();
  if (emailPassword && emailPassword !== 'true' && emailPassword !== 'false')
    throw new Error('AUTH_EMAIL_PASSWORD must be true or false');
  return {
    emailPassword: emailPassword === 'true',
    baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3001',
    webOrigin,
    websiteOrigin: new URL(process.env.WEBSITE_ORIGIN ?? (production ? webOrigin : 'http://localhost:5100')).origin,
    secret: secret ?? 'local-development-only-tulipfarm-auth-secret',
    google:
      googleId && googleSecret
        ? {
            clientId: googleId,
            clientSecret: googleSecret,
            prompt: 'select_account' as const,
            overrideUserInfoOnSignIn: false,
          }
        : undefined,
  };
}

const accountExists = () =>
  new APIError('CONFLICT', { code: 'ACCOUNT_EXISTS', message: 'An account already exists for this address.' });
const automationOnly = () =>
  new APIError('FORBIDDEN', { code: 'AUTOMATION_ONLY', message: 'This account requires a QA credential.' });

/** Whether this process can hand mail to the worker's transport; the same settings the worker reads. */
export function emailTransportConfigured(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(env.EMAIL_PROVIDER || env.ACS_CONNECTION_STRING || env.SMTP_HOST);
}

/** The web page that sets a new password with a reset token. */
export function passwordResetURL(token: string) {
  const url = new URL('/login/reset-password', authConfig().webOrigin);
  url.searchParams.set('token', token);
  return url.toString();
}

const passwordPaths = new Set(['/sign-in/email', '/sign-up/email', '/request-password-reset']);

export function createAuth(
  pool: Pool,
  sendMagicLink: (data: { email: string; url: string }) => Promise<void>,
  verifyChallenge = (token: string | null, origin?: string) => {
    const trusted = [authConfig().webOrigin, ...publicGuideOrigins()];
    if (origin && !trusted.includes(origin)) throw new APIError('FORBIDDEN', { message: 'Untrusted sign-in origin.' });
    return createTurnstileVerifier(turnstileConfig(), origin ?? authConfig().webOrigin)(token);
  },
  // Without a sender, /request-password-reset is disabled; the admin CLI issues reset links instead.
  sendResetPassword?: (data: { email: string; url: string }) => Promise<void>,
) {
  const config = authConfig();
  async function qaUser(userId: string) {
    const user = (await pool.query<{ email: string }>('SELECT email FROM app.users WHERE id=$1', [userId])).rows[0];
    return user !== undefined && isQaEmail(user.email);
  }
  // True when another user owns this address's canonical form, such as a@gmail.com for a+1@gmail.com.
  async function aliasOfAnotherUser(email: string) {
    const address = email.trim().toLowerCase();
    const result = await pool.query<{ exact: boolean }>(
      'SELECT lower(email) = $1 AS exact FROM users WHERE lower(email) = $1 OR canonical_email = $2',
      [address, canonicalEmail(address)],
    );
    return result.rows.length > 0 && !result.rows.some(row => row.exact);
  }
  return betterAuth({
    appName: 'TulipFarm',
    baseURL: config.baseURL,
    basePath: '/v1/auth',
    secret: config.secret,
    database: pool,
    logger: { disabled: true },
    trustedOrigins: [config.webOrigin, ...publicGuideOrigins()],
    advanced: { database: { generateId: 'uuid' }, ipAddress: { ipAddressHeaders: ['x-tulipfarm-client-ip'] } },
    emailAndPassword: config.emailPassword
      ? {
          enabled: true,
          revokeSessionsOnPasswordReset: true,
          resetPasswordTokenExpiresIn: 60 * 60,
          ...(sendResetPassword && {
            sendResetPassword: ({ user, token }) =>
              sendResetPassword({ email: user.email, url: passwordResetURL(token) }),
          }),
        }
      : { enabled: false },
    socialProviders: config.google ? { google: config.google } : {},
    hooks: {
      before: createAuthMiddleware(async ctx => {
        if (ctx.path !== '/sign-in/magic-link' && !(config.emailPassword && passwordPaths.has(ctx.path))) return;
        // The admin CLI asks for reset links in-process, with no browser request to challenge.
        if (ctx.path === '/request-password-reset' && !ctx.request) return;
        await verifyChallenge(ctx.headers?.get('x-captcha-response') ?? null, ctx.headers?.get('origin') ?? undefined);
        const email: unknown = ctx.body?.email;
        if (typeof email === 'string' && isQaEmail(email)) throw automationOnly();
        if (ctx.path === '/sign-in/email' || ctx.path === '/request-password-reset') return;
        if (typeof email === 'string' && (await aliasOfAnotherUser(email))) throw accountExists();
      }),
    },
    databaseHooks: {
      session: {
        create: {
          before: async session => {
            if (await qaUser(session.userId)) throw automationOnly();
          },
        },
      },
      account: {
        create: {
          before: async account => {
            if (await qaUser(account.userId)) throw automationOnly();
          },
        },
      },
      user: {
        create: {
          before: async user => {
            if (isQaEmail(user.email)) throw automationOnly();
            if (await aliasOfAnotherUser(user.email)) throw accountExists();
            return { data: { ...user, name: user.name.trim(), canonicalEmail: canonicalEmail(user.email) } };
          },
          // Subscribers run in the background; their failures go to the error reporters.
          after: async user => {
            void emitHook('user.signed-up', { userId: user.id, email: user.email, name: user.name });
          },
        },
        update: {
          before: async user => {
            // Google supplies an https photo URL; uploads are small data URLs.
            if (
              user.image != null &&
              !/^https:\/\/\S{1,2000}$/.test(user.image) &&
              !avatarImageSchema.safeParse(user.image).success
            )
              throw new APIError('BAD_REQUEST', { message: 'Use a PNG, JPEG, or WebP image under 32 KB.' });
            if (user.name === undefined) return;
            const name = user.name.trim();
            if (!name || name.length > 80)
              throw new APIError('BAD_REQUEST', { message: 'Enter a name between 1 and 80 characters.' });
            return { data: { ...user, name } };
          },
        },
      },
    },
    user: {
      modelName: 'users',
      fields: { emailVerified: 'email_verified', createdAt: 'created_at', updatedAt: 'updated_at' },
      additionalFields: {
        canonicalEmail: {
          type: 'string',
          required: false,
          input: false,
          returned: false,
          fieldName: 'canonical_email',
        },
        lastModelFamilyId: {
          type: 'string',
          required: false,
          fieldName: 'last_model_family_id',
          validator: {
            input: modelFamilyIdSchema.refine(id => selectableModelFamilies.some(family => family.id === id)),
          },
        },
      },
    },
    session: {
      modelName: 'sessions',
      fields: {
        userId: 'user_id',
        expiresAt: 'expires_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    account: {
      modelName: 'accounts',
      accountLinking: { enabled: true, trustedProviders: ['google'], updateUserInfoOnLink: false },
      fields: {
        userId: 'user_id',
        accountId: 'account_id',
        providerId: 'provider_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    verification: {
      modelName: 'verifications',
      fields: { expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at' },
      ...(config.emailPassword && {
        storeIdentifier: { default: 'plain', overrides: { 'reset-password:': 'hashed' } },
      }),
    },
    plugins: [magicLink({ expiresIn: 15 * 60, storeToken: 'hashed', sendMagicLink })],
  });
}
