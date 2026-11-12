import type { FastifyError, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied, uuidSchema } from '@tulipfarm/access';
import { loadModelCatalog, planProviders } from '@tulipfarm/config';
import { isFeatureEnabled } from '@tulipfarm/observability';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import {
  copilotGitHubClient,
  createTokenPlan,
  TokenPlanError,
  type TokenPlan,
  type TokenPlanProvider,
  type TokenPlanRuntime,
  type TokenPlanVerifier,
} from '@tulipfarm/integrations/token-plans';
import { checkClaudePlan, copilotPlanModels, PlanSessionError } from '@tulipfarm/agents/plan-sessions';
import { authenticateRoutes } from './authenticated-routes.ts';
import { authConfig, type registerAuth } from './auth.ts';
import { routeValidation } from './route-validation.ts';

const labels: Record<TokenPlanProvider, string> = { claude: 'Claude', copilot: 'GitHub Copilot' };

/** A vendor check failure as the sign-in error a member sees. A plan at its usage limit is still a working plan. */
function vendorFailure(provider: TokenPlanProvider, error: unknown): 'limited' {
  if (error instanceof PlanSessionError) {
    if (error.code === 'plan_usage_limit') return 'limited';
    if (error.code === 'plan_reconnect') throw new TokenPlanError(provider, 'token-rejected');
    if (error.code === 'plan_not_eligible') throw new TokenPlanError(provider, 'not-eligible');
  }
  throw new TokenPlanError(provider, 'unavailable');
}

/** The catalog's model slugs for `provider`, named as the catalog names them. */
function catalogModels(provider: TokenPlanProvider) {
  const families = loadModelCatalog().catalog.models;
  return families.flatMap(family =>
    family.routes
      .filter(route => route.provider === provider)
      .map(route => ({ slug: route.model, label: family.name })),
  );
}

export function claudeVerifier(check: (token: string) => Promise<void> = checkClaudePlan): TokenPlanVerifier {
  return async token => {
    await check(token).catch(error => vendorFailure('claude', error));
    // Every Claude plan runs the same models, so the catalog lists them.
    return { models: catalogModels('claude') };
  };
}

export function copilotVerifier(
  list: (token: string) => Promise<string[]> = copilotPlanModels,
  fetcher: typeof fetch = fetch,
): TokenPlanVerifier {
  return async token => {
    const slugs = await list(token).catch(error => vendorFailure('copilot', error));
    const named = new Map(catalogModels('copilot').map(model => [model.slug, model.label]));
    const models = (slugs === 'limited' ? [...named.keys()] : slugs).map(slug => ({
      slug,
      label: named.get(slug) ?? slug,
    }));
    const account = await fetcher('https://api.github.com/user', {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000),
    })
      .then(async response => (response.ok ? z.object({ login: z.string() }).parse(await response.json()).login : null))
      .catch(() => null);
    return { models, account };
  };
}

/** The member-facing connection for `provider`, or null without a workspace runtime. */
export function tokenPlan(
  provider: TokenPlanProvider,
  runtime: TokenPlanRuntime | undefined,
  env: NodeJS.ProcessEnv = process.env,
  verify: TokenPlanVerifier = provider === 'claude' ? claudeVerifier() : copilotVerifier(),
  githubAccountToken?: (workspaceId: string, membershipId: string, accountId: string) => Promise<string>,
): TokenPlan | null {
  if (!runtime) return null;
  return createTokenPlan({
    provider,
    runtime,
    keyring: integrationCredentialKeyring(env),
    verify,
    ...(provider === 'copilot'
      ? { ...copilotGitHubClient(env), ...(githubAccountToken ? { githubAccountToken } : {}) }
      : {}),
  });
}

const errorSchema = z.object({ error: z.string() });
const workspaceParams = z.strictObject({ workspaceId: uuidSchema });
const attemptParams = workspaceParams.extend({ attemptId: uuidSchema });
const connectionSchema = z.object({
  state: z.enum(['not-connected', 'connected', 'reconnect-required', 'signed-out']),
  account: z.string().nullable(),
  /** For Copilot, the personal GitHub account the connection uses instead of a token of its own. */
  githubAccountId: z.uuid().nullable().optional(),
  planUsage: z.boolean(),
  /** Whether members can sign in through GitHub instead of pasting a token. Always false for Claude. */
  deviceSignIn: z.boolean(),
  models: z.array(z.object({ slug: z.string(), label: z.string() })),
});
const tokenBody = z.strictObject({ token: z.string().min(1).max(1000) });
const githubAccountBody = z.strictObject({ accountId: uuidSchema });
const deviceSchema = z.object({
  attemptId: z.uuid(),
  userCode: z.string(),
  verificationUri: z.string(),
  intervalSeconds: z.number(),
  expiresInSeconds: z.number(),
});
const attemptSchema = z.object({
  status: z.enum(['pending', 'completed', 'failed']),
  errorCode: z.string().nullable(),
});
const disconnectSchema = z.object({ revoked: z.boolean() });
const statuses: Record<string, number> = {
  'attempt-not-found': 404,
  'attempt-expired': 410,
  'token-invalid': 400,
  'not-connected': 409,
  'reconnect-required': 409,
  'token-rejected': 409,
  'not-eligible': 409,
  'device-sign-in-unavailable': 409,
  'authorization-declined': 409,
  'authorization-failed': 409,
  'rate-limited': 429,
  unavailable: 503,
};

/**
 * Routes for a member's own Claude or GitHub Copilot connection, under `/workspaces/:workspaceId/<provider>/connection`.
 * Without a service, or while the workspace's feature flag for the plan is off, they answer 404 `<provider>-plan-disabled`.
 */
export function registerTokenPlan(
  app: FastifyInstance,
  auth: { api: Pick<ReturnType<typeof registerAuth>['auth']['api'], 'getSession'> },
  provider: TokenPlanProvider,
  plan: TokenPlan | null,
) {
  const label = labels[provider];
  const tag = provider === 'claude' ? 'Claude' : 'Copilot';
  const validation = routeValidation({
    target: 'openapi-3.0',
    missing: `Missing ${label} plan validator`,
    invalid: () => new Error('invalid-request'),
  });
  const { json } = validation;
  const schema = (operation: string, response: z.ZodType) => {
    const error = json(errorSchema);
    return {
      operationId: `${operation.replace('$', tag)}V1`,
      tags: [`${label} plan`],
      response: {
        200: json(response),
        400: error,
        401: error,
        403: error,
        404: error,
        409: error,
        410: error,
        429: error,
        503: error,
      },
    };
  };
  app.register(async routes => {
    validation.install(routes, true);
    const user = authenticateRoutes(routes, auth, { origin: () => authConfig().webOrigin });
    routes.addHook('onRequest', async (_request, reply) => {
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header('Cache-Control', 'no-store');
    });
    routes.setErrorHandler<FastifyError>((error, _request, reply) => {
      if (error instanceof AccessDenied) return reply.code(404).send({ error: `${provider}-connection-not-found` });
      if (error instanceof TokenPlanError) return reply.code(statuses[error.code] ?? 409).send({ error: error.code });
      if (error.statusCode === 400 || error.validation || error instanceof z.ZodError)
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(503).send({ error: 'unavailable' });
    });
    const base = `/workspaces/:workspaceId/${provider}/connection`;
    const statusRoute = { schema: { ...schema('get$Connection', connectionSchema), params: json(workspaceParams) } };
    if (!plan) {
      routes.get(base, statusRoute, async (_request, reply) =>
        reply.code(404).send({ error: `${provider}-plan-disabled` }),
      );
      return;
    }
    // Members can still disconnect, so turning the plan off never strands a stored token.
    routes.addHook('preHandler', async (request, reply) => {
      if (request.routeOptions.url?.endsWith('/disconnect')) return;
      const { workspaceId } = request.params as { workspaceId: string };
      if (!(await isFeatureEnabled(planProviders[provider].flag, null, { id: workspaceId })))
        return reply.code(404).send({ error: `${provider}-plan-disabled` });
    });
    const withDevice = <T extends object>(status: T) => ({ ...status, deviceSignIn: plan.deviceSignIn });
    routes.get(base, statusRoute, async request =>
      withDevice(await plan.status(workspaceParams.parse(request.params).workspaceId, user(request))),
    );
    routes.post(
      `${base}/token`,
      {
        schema: {
          ...schema('connect$Token', connectionSchema),
          params: json(workspaceParams),
          body: json(tokenBody),
        },
      },
      async request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        return withDevice(await plan.connectToken(workspaceId, user(request), tokenBody.parse(request.body).token));
      },
    );
    if (provider === 'copilot') {
      routes.post(
        `${base}/github-account`,
        {
          schema: {
            ...schema('use$GitHubAccount', connectionSchema),
            params: json(workspaceParams),
            body: json(githubAccountBody),
          },
        },
        async request => {
          const { workspaceId } = workspaceParams.parse(request.params);
          const { accountId } = githubAccountBody.parse(request.body);
          await plan.useGitHubAccount(workspaceId, user(request), accountId);
          return withDevice(await plan.status(workspaceId, user(request)));
        },
      );
      routes.post(
        `${base}/device`,
        { schema: { ...schema('begin$DeviceSignIn', deviceSchema), params: json(workspaceParams) } },
        async request => plan.beginDevice(workspaceParams.parse(request.params).workspaceId, user(request)),
      );
      routes.get(
        `${base}/attempts/:attemptId`,
        { schema: { ...schema('get$ConnectionAttempt', attemptSchema), params: json(attemptParams) } },
        async request => {
          const { workspaceId, attemptId } = attemptParams.parse(request.params);
          return plan.attempt(workspaceId, user(request), attemptId);
        },
      );
    }
    routes.post(
      `${base}/disconnect`,
      { schema: { ...schema('disconnect$', disconnectSchema), params: json(workspaceParams) } },
      async request => plan.disconnect(workspaceParams.parse(request.params).workspaceId, user(request)),
    );
  });
}
