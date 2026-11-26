import { PassThrough } from 'node:stream';
import { normalizeIP } from '@fastify/rate-limit';
import { APIError } from 'better-auth/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { databasePools } from '@tulipfarm/config/database-connections';
import { z } from 'zod';
import { canonicalEmail } from '@tulipfarm/workspaces/canonical-email';
import {
  interviewRequestSchema,
  interviewTurnSchema,
  onboardingDetailsSchema,
  onboardingTokenSchema,
} from '@tulipfarm/workspaces/onboarding-contracts';
import { ruleTurn } from '@tulipfarm/workspaces/onboarding-interview';
import { onboardingInterviewer } from './onboarding-interviewer.ts';
import { findWebsite } from './onboarding-website.ts';
import { readOnboardingSite, siteLine } from './onboarding-site.ts';
import { saveOnboarding, OnboardingConflict, OnboardingUnavailable } from '@tulipfarm/workspaces/onboarding';
import { authConfig, type registerAuth } from './auth.ts';
import { guideAccess, guideTokens, GuideUnavailable } from './public-guide-access.ts';
import { guideLimits, guideMessageSchema, publicGuideOrigins, type GuideMessage } from './public-guide-config.ts';
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

/** The latest turns that fit the signed history limit; the onboarding profile carries older answers. */
function recentHistory(messages: GuideMessage[]) {
  const kept = [...messages];
  while (kept.length > 2 && Buffer.byteLength(JSON.stringify(kept)) > guideLimits.historyBytes) kept.splice(0, 2);
  return kept;
}

const websiteLookupSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    language: z
      .string()
      .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
      .max(35)
      .optional(),
    timeZone: z
      .string()
      .regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/)
      .max(64)
      .optional(),
  })
  .strict();

export type PublicGuideDependencies = {
  origins: string[];
  tokens: ReturnType<typeof guideTokens>;
  access: ReturnType<typeof guideAccess>;
  model: ReturnType<typeof publicGuideModel>;
  interviewer: ReturnType<typeof onboardingInterviewer>;
  readSite: typeof readOnboardingSite;
  findWebsite: typeof findWebsite;
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
    const visitor = async (request: FastifyRequest) => {
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
          response: {
            200: json(
              z.object({
                enabled: z.boolean(),
                modelAvailable: z.boolean(),
                turnstileSiteKey: z.string().nullable(),
                appOrigin: z.string(),
                googleAvailable: z.boolean(),
                messageCharacters: z.number(),
              }),
            ),
          },
        },
      },
      () => ({
        enabled: true,
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
          response: { 200: json(z.object({ token: z.string(), expiresIn: z.number() })) },
        },
      },
      async request => {
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
          response: {
            200: {
              description: 'Public guide answer events',
              content: { 'text/event-stream': { schema: { type: 'string' } } },
            },
          },
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
    // Signup step 1 fills in the website from the workspace name. The browser's locale and time zone are only a hint
    // for the search, never stored.
    routes.post(
      '/public/guide/website',
      {
        bodyLimit: 2048,
        validatorCompiler: validator(websiteLookupSchema),
        schema: {
          operationId: 'publicGuideWebsiteV1',
          tags: ['Public guide'],
          summary: 'Find the website of a business from its name, for signup step 1',
          body: json(websiteLookupSchema),
          response: { 200: json(z.object({ website: z.string().nullable() })) },
        },
      },
      async request => {
        const id = await visitor(request);
        const body = websiteLookupSchema.parse(request.body);
        await deps.access.lookup(normalizeIP(request.ip), id);
        const website = await deps.findWebsite(
          body.name,
          { language: body.language, timeZone: body.timeZone },
          AbortSignal.timeout(10_000),
        );
        return { website };
      },
    );
    routes.post(
      '/public/guide/onboarding',
      {
        bodyLimit: 24_000,
        validatorCompiler: validator(interviewRequestSchema),
        schema: {
          operationId: 'publicGuideOnboardingV1',
          tags: ['Public guide'],
          summary: 'Take one onboarding chat turn: TulipFarm replies, updates the answers and picks the next stage',
          body: json(interviewRequestSchema),
          response: { 200: json(interviewTurnSchema) },
        },
      },
      async request => {
        const id = await visitor(request);
        const body = interviewRequestSchema.parse(request.body);
        const history = deps.tokens.readConversation(id, body.conversation);
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(new Error('guide-timeout')), guideLimits.timeoutMs);
        controllers.add(controller);
        try {
          // Without a model the rules answer for free, so only model turns spend the guide's budget.
          const release = deps.model ? await deps.access.turn(normalizeIP(request.ip), id, controller) : async () => {};
          let turn;
          // The first message reads the website from step 1, so TulipFarm starts from the visitor's business. The
          // read never rejects: an unreadable site is null.
          const site =
            body.kind === 'open' && body.profile.website
              ? await deps.readSite(body.profile.website, controller.signal)
              : null;
          const input = body.kind === 'open' ? { ...body, profile: { ...body.profile, site: siteLine(site) } } : body;
          try {
            turn = await deps.interviewer(history, input, controller.signal, site);
          } catch (error) {
            // Onboarding never waits on the model: the rules take the turn instead.
            request.log.warn({ err: error }, 'Onboarding interviewer fell back to rules');
            turn = ruleTurn(input);
          } finally {
            await release();
          }
          return {
            ...turn,
            conversation: deps.tokens.conversation(
              id,
              recentHistory([
                ...history,
                ...(input.message ? [{ role: 'user' as const, content: input.message }] : []),
                { role: 'assistant', content: turn.reply },
              ]),
            ),
          };
        } finally {
          clearTimeout(deadline);
          controllers.delete(controller);
        }
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
          response: {
            200: json(
              z.discriminatedUnion('status', [
                z.object({ status: z.literal('email-sent') }),
                z.object({ status: z.literal('redirect'), url: z.string() }),
              ]),
            ),
          },
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
          response: { 302: { type: 'null', description: 'Continue to Google sign-in' } },
        },
      },
      async (request, reply) => {
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
    max: databasePools.publicGuide,
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
    // The app's own origin runs the onboarding chat after signup step 1.
    origins: [...new Set([...publicGuideOrigins(), new URL(config.webOrigin).origin])],
    tokens,
    access: guideAccess(pool, config.secret),
    model: publicGuideModel(),
    interviewer: onboardingInterviewer(),
    readSite: readOnboardingSite,
    findWebsite,
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
