import { PassThrough } from 'node:stream';
import { normalizeIP } from '@fastify/rate-limit';
import { APIError } from 'better-auth/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';
import { isFeatureEnabled } from '@tulipfarm/observability';
import { canonicalEmail } from '@tulipfarm/workspaces/canonical-email';
import { onboardingDetailsSchema, onboardingTokenSchema } from '@tulipfarm/workspaces/onboarding-contracts';
import { saveOnboarding, OnboardingConflict, OnboardingUnavailable } from '@tulipfarm/workspaces/onboarding';
import { authConfig, type registerAuth } from './auth.ts';
import { guideAccess, guideTokens, GuideUnavailable } from './public-guide-access.ts';
import { guideLimits, guideMessageSchema, publicGuideOrigins } from './public-guide-config.ts';
import { publicGuideModel } from './public-guide-model.ts';
import { createTurnstileVerifier, turnstileConfig } from './turnstile.ts';
import { requestBoundaryError } from './security.ts';

const sessionSchema = z.strictObject({ challengeToken: z.string().min(1).max(2048) });
const signupFields = {
  token: onboardingTokenSchema,
  details: onboardingDetailsSchema,
  challengeToken: z.string().min(1).max(2048),
};
const signupSchema = z.discriminatedUnion('method', [
  z.strictObject({
    ...signupFields,
    method: z.literal('email'),
    name: z.string().trim().min(1).max(80),
    email: z.email().max(254),
  }),
  z.strictObject({ ...signupFields, method: z.literal('google') }),
]);
type Signup = z.infer<typeof signupSchema>;
type SignupResult = { status: 'email-sent' } | { status: 'redirect'; url: string };
const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'openapi-3.0' });
const validator = (schema: z.ZodType) => () => (input: unknown) => {
  const parsed = schema.safeParse(input);
  return parsed.success ? { value: parsed.data } : { error: parsed.error };
};
const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

export type PublicGuideDependencies = {
  origins: string[];
  tokens: ReturnType<typeof guideTokens>;
  access: ReturnType<typeof guideAccess>;
  model: ReturnType<typeof publicGuideModel>;
  enabled(): Promise<boolean>;
  siteKey: string | null;
  appOrigin: string;
  googleAvailable: boolean;
  verify(origin: string, token: string, action: 'public_guide' | 'sign_in'): Promise<void>;
  signup(input: Signup, origin: string): Promise<SignupResult>;
  google(token: string): Promise<Response>;
};

export function registerPublicGuideRoutes(app: FastifyInstance, deps: PublicGuideDependencies) {
  const pending = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  app.addHook('onClose', async () => {
    for (const controller of controllers) controller.abort();
    await Promise.all(pending);
  });
  app.register(async routes => {
    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
      if (
        request.routeOptions.schema?.operationId !== 'publicGuideGoogleV1' &&
        !deps.origins.includes(request.headers.origin ?? '')
      ) {
        return reply.code(403).send({ error: 'untrusted-origin' });
      }
    });
    routes.setErrorHandler((error, request, reply) => {
      if (error instanceof GuideUnavailable) {
        if (error.retryAfter) reply.header('Retry-After', error.retryAfter);
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof APIError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof OnboardingConflict)
        return reply.code(409).send({ error: 'These saved details have changed. Start sign-up again.' });
      if (error instanceof OnboardingUnavailable)
        return reply.code(404).send({ error: 'These saved details expired. Start sign-up again.' });
      if (
        error instanceof z.ZodError ||
        (typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 400)
      ) {
        return reply.code(400).send({ error: 'invalid-guide-request' });
      }
      if (requestBoundaryError(error, reply)) return;
      request.log.error({ err: error }, 'Public guide unavailable');
      return reply.code(503).header('Retry-After', 5).send({ error: 'guide-unavailable' });
    });
    const enabled = async () => {
      if (!(await deps.enabled())) throw new GuideUnavailable(404, 'guide-disabled');
    };
    const visitor = async (request: FastifyRequest) => {
      await enabled();
      const authorization = request.headers.authorization;
      return deps.tokens.readVisitor(
        authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined,
        request.headers.origin ?? '',
      );
    };
    routes.get(
      '/public/guide/options',
      {
        schema: {
          operationId: 'publicGuideOptionsV1',
          tags: ['Public guide'],
          summary: 'Public guide availability and browser configuration',
        },
      },
      async () => ({
        enabled: await deps.enabled(),
        modelAvailable: deps.model !== null,
        turnstileSiteKey: deps.siteKey,
        appOrigin: deps.appOrigin,
        googleAvailable: deps.googleAvailable,
        messageCharacters: guideLimits.messageCharacters,
      }),
    );
    routes.post(
      '/public/guide/session',
      {
        bodyLimit: 4096,
        validatorCompiler: validator(sessionSchema),
        schema: {
          operationId: 'publicGuideSessionV1',
          tags: ['Public guide'],
          summary: 'Verify a visitor and issue a short-lived anonymous browser token',
          body: json(sessionSchema),
        },
      },
      async request => {
        await enabled();
        await deps.access.session(normalizeIP(request.ip));
        const { challengeToken } = sessionSchema.parse(request.body);
        const origin = request.headers.origin ?? '';
        await deps.verify(origin, challengeToken, 'public_guide');
        return { token: deps.tokens.visitor(origin), expiresIn: 86_400 };
      },
    );
    routes.post(
      '/public/guide/messages',
      {
        bodyLimit: 24_000,
        validatorCompiler: validator(guideMessageSchema),
        schema: {
          operationId: 'publicGuideMessageV1',
          tags: ['Public guide'],
          summary: 'Stream a bounded TulipFarm-only answer as status, delta, action, done or error SSE events',
          body: json(guideMessageSchema),
        },
      },
      async (request, reply) => {
        const id = await visitor(request);
        if (!deps.model) throw new GuideUnavailable(503, 'guide-model-unavailable', 30);
        const input = guideMessageSchema.parse(request.body);
        const history = deps.tokens.readConversation(id, input.conversation);
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(new Error('guide-timeout')), guideLimits.timeoutMs);
        controllers.add(controller);
        const disconnected = () => {
          if (!reply.raw.writableFinished) controller.abort();
        };
        reply.raw.once('close', disconnected);
        let release: () => Promise<void>;
        try {
          release = await deps.access.turn(normalizeIP(request.ip), id, controller);
        } catch (error) {
          clearTimeout(deadline);
          controllers.delete(controller);
          reply.raw.removeListener('close', disconnected);
          throw error;
        }
        const stream = new PassThrough();
        stream.once('close', () => controller.abort());
        const model = deps.model;
        const work = (async () => {
          let answer = '';
          try {
            controller.signal.throwIfAborted();
            stream.write(event('status', { status: 'answering' }));
            const result = await model(
              history,
              input.message,
              text => {
                controller.signal.throwIfAborted();
                answer += text;
                stream.write(event('delta', { text }));
              },
              controller.signal,
            );
            controller.signal.throwIfAborted();
            if (result.signup) stream.write(event('action', { type: 'signup' }));
            stream.write(
              event('done', {
                conversation: deps.tokens.conversation(id, [
                  ...history,
                  { role: 'user', content: input.message },
                  { role: 'assistant', content: answer },
                ]),
              }),
            );
          } catch (error) {
            request.log.warn({ err: error }, 'Public guide answer interrupted');
            if (!stream.destroyed)
              stream.write(event('error', { error: 'The guide could not finish. Please try again.' }));
          } finally {
            try {
              await release();
            } catch (error) {
              request.log.error({ err: error }, 'Public guide admission cleanup failed');
            }
            clearTimeout(deadline);
            controllers.delete(controller);
            reply.raw.removeListener('close', disconnected);
            stream.end();
          }
        })();
        pending.add(work);
        void work.finally(() => pending.delete(work));
        return reply.type('text/event-stream; charset=utf-8').header('X-Accel-Buffering', 'no').send(stream);
      },
    );
    routes.post(
      '/public/guide/signup',
      {
        bodyLimit: 16_384,
        validatorCompiler: validator(signupSchema),
        schema: {
          operationId: 'publicGuideSignupV1',
          tags: ['Public guide'],
          summary: 'Save reviewed workspace details and begin verified email or Google signup',
          body: json(signupSchema),
        },
      },
      async request => {
        const id = await visitor(request);
        const input = signupSchema.parse(request.body);
        await deps.access.signup(
          normalizeIP(request.ip),
          id,
          input.method === 'email' ? canonicalEmail(input.email) : undefined,
        );
        if (input.method === 'google' && !deps.googleAvailable)
          throw new GuideUnavailable(503, 'Google sign-in is unavailable. Use an email link.');
        return deps.signup(input, request.headers.origin ?? '');
      },
    );
    routes.get(
      '/public/guide/google',
      {
        schema: {
          operationId: 'publicGuideGoogleV1',
          tags: ['Public guide'],
          summary: 'Continue a verified signup in a first-party Google OAuth navigation',
          querystring: json(z.strictObject({ token: z.string().max(1024) })),
        },
      },
      async (request, reply) => {
        await enabled();
        await deps.access.google(normalizeIP(request.ip));
        const { token } = z.object({ token: z.string() }).parse(request.query);
        const response = await deps.google(deps.tokens.readGoogle(token));
        if (!response.ok)
          throw new GuideUnavailable(503, 'Google sign-in could not start. Return to the guide and try again.');
        const data = z.object({ url: z.url() }).parse(await response.json());
        const url = new URL(data.url);
        if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com' || url.username || url.password)
          throw new Error('Invalid Google sign-in destination');
        const cookies = response.headers.getSetCookie();
        if (cookies.length) reply.header('set-cookie', cookies);
        return reply.redirect(url.href);
      },
    );
  });
}

export function registerPublicGuide(app: FastifyInstance, { auth, pool: authPool }: ReturnType<typeof registerAuth>) {
  const config = authConfig();
  const turnstile = turnstileConfig();
  const tokens = guideTokens(config.secret);
  const pool = new Pool({
    connectionString: authPool.options.connectionString,
    max: guideLimits.concurrent + 2,
    connectionTimeoutMillis: 2000,
    statement_timeout: 2000,
    query_timeout: 3000,
  });
  pool.on('error', () => app.log.error('Public guide admission database unavailable'));
  app.addHook('onClose', () => pool.end());
  const callbacks = (token: string) => {
    const callbackURL = new URL(`/onboarding/chat#token=${token}`, config.webOrigin).href;
    const error = new URL('/login', config.webOrigin);
    error.searchParams.set('error', 'sign_in_failed');
    error.searchParams.set('redirect', `/onboarding/chat#token=${token}`);
    return { callbackURL, newUserCallbackURL: callbackURL, errorCallbackURL: error.href };
  };
  registerPublicGuideRoutes(app, {
    origins: publicGuideOrigins(),
    tokens,
    access: guideAccess(pool, config.secret),
    model: publicGuideModel(),
    enabled: () => isFeatureEnabled('public-tulipfarm-guide', { id: 'public-tulipfarm-guide' }),
    siteKey: turnstile?.siteKey ?? null,
    appOrigin: config.webOrigin,
    googleAvailable: Boolean(config.google),
    verify: (origin, token, action) => createTurnstileVerifier(turnstile, origin, action)(token),
    async signup(input, origin) {
      if (input.method === 'google') await createTurnstileVerifier(turnstile, origin)(input.challengeToken);
      await saveOnboarding(authPool, input.token, input.details);
      if (input.method === 'google') {
        const url = new URL('/v1/public/guide/google', config.baseURL);
        url.searchParams.set('token', tokens.google(input.token));
        return { status: 'redirect', url: url.href };
      }
      await auth.api.signInMagicLink({
        body: { email: input.email, name: input.name, ...callbacks(input.token) },
        headers: new Headers({ origin, 'x-captcha-response': input.challengeToken }),
      });
      return { status: 'email-sent' };
    },
    google: token =>
      auth.api.signInSocial({
        body: { provider: 'google', ...callbacks(token), disableRedirect: true },
        headers: new Headers({ origin: config.webOrigin }),
        asResponse: true,
      }),
  });
}
