import type { AuthEndpoints } from "@tulipfarm/integrations";
import type { SecretsService } from "@tulipfarm/secrets";
import type {
  BundledIntegration,
  IntegrationManifest,
  SoulLoader,
  SoulWriter,
} from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { AuthorizationCheck } from "../authz/route-gate";
import { commitActorFromRequest } from "../soul/commit-actor";
import {
  AuthBrokerError,
  completeAuthStep,
  type IntegrationAuthRequestRepo,
  startAuthStep,
} from "./auth-broker";
import { mergeConnectionEnv, readConnectionEnv } from "./connection-writer";
import { sealPrincipalCredential } from "./principal-connect";
import type { PrincipalProviderTokenRepo } from "./principal-tokens";
import { mergeIntegrations } from "./routes";

/* Generic auth routes: per-Integration start, one shared provider callback; no bespoke routes. */

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface AuthRoutesDeps {
  soulLoader: SoulLoader;
  soulWriter: SoulWriter;
  secrets: SecretsService;
  repo: IntegrationAuthRequestRepo;
  bundled: ReadonlyMap<string, BundledIntegration>;
  endpoints: AuthEndpoints | (() => Promise<AuthEndpoints>);
  fetchImpl?: typeof globalThis.fetch;
  /** Provider redirects must trigger the same post-connect setup as pasted credentials. */
  onConnected?: (slug: string) => Promise<void>;
  /** Personal credentials require a store; absence is a compile-time error, not shared fallback. */
  tokens: PrincipalProviderTokenRepo | undefined;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const StartActionSchema = {
  type: "object",
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["collect_fields", "redirect", "form_post", "completed"] },
    url: { type: "string" },
    field: { type: "string" },
    value: { type: "string" },
    fields: { type: "array", items: { type: "object", additionalProperties: true } },
  },
};

function denialStatus(reason: AuthBrokerError["reason"]): 400 | 404 | 409 | 502 {
  switch (reason) {
    case "unknown_step":
      return 404;
    case "invalid_state":
      return 400;
    case "missing_credentials":
      return 409;
    case "exchange_failed":
      return 502;
  }
}

export function registerIntegrationAuthRoutes(
  app: FastifyInstance,
  deps: AuthRoutesDeps,
  requireAuth: PreHandler,
  authorizationCheck: AuthorizationCheck
): void {
  const resolveEndpoints = () =>
    typeof deps.endpoints === "function" ? deps.endpoints() : Promise.resolve(deps.endpoints);
  const resolveManifest = (slug: string): IntegrationManifest | undefined =>
    mergeIntegrations(deps.soulLoader, deps.bundled).get(slug)?.manifest;

  app.post(
    "/api/v1/integrations/:name/auth/start/:step",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Prepare one step of an integration's declared auth flow, returning what the browser must do next.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["name", "step"],
          properties: { name: { type: "string" }, step: { type: "integer", minimum: 0 } },
        },
        // Nullable preserves the pre-body business-scoped default path.
        body: {
          type: ["object", "null"],
          properties: {
            scope: {
              type: "string",
              enum: ["business", "user"],
              description:
                "`business` (default) connects the deployment's shared credential and requires an administrator. `user` connects the caller's own credential and requires only authentication; only an oauth2 authorization_code step declaring `personal: true` can issue one.",
            },
            org: {
              type: "string",
              minLength: 1,
              maxLength: 39,
              pattern: "^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$",
              description:
                "Optional target org login for an app_manifest step, so the provider app is created under that org instead of the caller's personal account. Ignored by steps that do not support org targeting.",
            },
          },
          additionalProperties: false,
        },
        response: {
          200: StartActionSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          502: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name, step } = req.params as { name: string; step: number };
      if (!NAME_RE.test(name)) {
        return reply.code(404).send({ error: `integration not found: ${name}` });
      }
      const manifest = resolveManifest(name);
      if (!manifest) return reply.code(404).send({ error: `integration not found: ${name}` });

      const body = req.body as { scope?: string; org?: string } | undefined;
      const scope = body?.scope ?? "business";
      const org = body?.org?.trim();
      // Credential owner comes from authenticated request, never the body.
      const caller = req.principal;
      if (caller === undefined) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      // User connect is self-service; business connect re-points deployment credentials.
      if (
        scope === "business" &&
        !(await authorizationCheck(caller, {
          action: "integration_connection.authorize",
          resourceType: "integration_connection",
          conditions: { scope: "business" },
          fallback: "admin",
        }))
      ) {
        return reply.code(403).send({ error: "forbidden" });
      }
      if (scope === "user" && deps.tokens === undefined) {
        return reply.code(409).send({ error: "this deployment cannot store personal credentials" });
      }

      try {
        const endpoints = await resolveEndpoints();
        const action = await startAuthStep({
          slug: name,
          manifest,
          stepIndex: Number(step),
          env: await readConnectionEnv(deps, name),
          endpoints,
          repo: deps.repo,
          fetchImpl: deps.fetchImpl,
          ...(org ? { org } : {}),
          ...(scope === "user" && caller !== undefined
            ? { principal: { kind: caller.kind, id: caller.id } }
            : {}),
        });

        // Server-side env is sealed and never returned in the response body.
        if (action.action === "completed") {
          if (Object.keys(action.env).length > 0) {
            const { connectedNow } = await mergeConnectionEnv(deps, {
              slug: name,
              manifest,
              patch: action.env,
              commitMessage: `soul: integration ${name} auth step ${step}`,
              actor: commitActorFromRequest(req),
            });
            if (connectedNow) await deps.onConnected?.(name);
          }
          return { action: "completed" };
        }
        return action;
      } catch (err) {
        if (err instanceof AuthBrokerError) {
          return reply.code(denialStatus(err.reason)).send({ error: err.message });
        }
        throw err;
      }
    }
  );

  app.get(
    "/api/v1/integrations/auth/callback",
    {
      // Provider callbacks are unauthenticated; one-use state proves authenticity and replay.
      schema: {
        description:
          "Single provider callback for every integration auth flow: consumes the one-use state and stores what the step produced.",
        tags: ["integrations"],
        querystring: { type: "object", properties: { state: { type: "string" } } },
        response: { 302: { type: "null" }, 400: ErrorSchema, 404: ErrorSchema, 502: ErrorSchema },
      },
    },
    async (req, reply) => {
      const query = req.query as Record<string, string>;
      try {
        const endpoints = await resolveEndpoints();
        const outcome = await completeAuthStep({
          query,
          loadManifest: resolveManifest,
          loadEnv: (slug) => readConnectionEnv(deps, slug),
          endpoints,
          repo: deps.repo,
          fetchImpl: deps.fetchImpl,
        });

        const manifest = resolveManifest(outcome.slug);
        // Personal credentials must never be merged into shared `connection.yaml`.
        if (outcome.principal !== undefined) {
          if (deps.tokens === undefined) {
            throw new AuthBrokerError(
              "missing_credentials",
              "this deployment cannot store personal credentials",
              outcome.slug
            );
          }
          await sealPrincipalCredential({
            outcome,
            secrets: deps.secrets,
            tokens: deps.tokens,
          });
        } else if (manifest && Object.keys(outcome.env).length > 0) {
          const { connectedNow } = await mergeConnectionEnv(deps, {
            slug: outcome.slug,
            manifest,
            patch: outcome.env,
            commitMessage: `soul: integration ${outcome.slug} auth step ${outcome.stepIndex}`,
          });
          if (connectedNow) await deps.onConnected?.(outcome.slug);
        }
        return reply.redirect(
          `${outcome.webUrl}/integrations/${outcome.slug}?step=${outcome.stepIndex}&status=ok`,
          302
        );
      } catch (err) {
        if (err instanceof AuthBrokerError) {
          // Browser failures redirect to an Integration page; unknown slugs land on the list.
          const slug = err.slug ?? "";
          return reply.redirect(
            `${err.webUrl ?? (await resolveEndpoints()).webUrl}/integrations/${slug}?status=error&reason=${err.reason}`,
            302
          );
        }
        throw err;
      }
    }
  );
}
