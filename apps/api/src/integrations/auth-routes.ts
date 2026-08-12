import type { SecretsService } from "@tulipfarm/secrets";
import type { GitSyncService, IntegrationManifest, SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import { commitActorFromRequest } from "../soul/commit-actor";
import type { BundledIntegration } from "../soul/integrations/bundled";
import {
  AuthBrokerError,
  type AuthEndpoints,
  completeAuthStep,
  type IntegrationAuthRequestRepo,
  startAuthStep,
} from "./auth-broker";
import { mergeConnectionEnv, readConnectionEnv } from "./connection-writer";
import { mergeIntegrations } from "./routes";

/*
 * Routes for the generic auth broker. There are exactly two, and neither names an Integration:
 * `POST /api/v1/integrations/:name/auth/start/:step` prepares a step, and every provider on every
 * Integration comes back to the single `GET /api/v1/integrations/auth/callback`. Adding an
 * Integration adds no route.
 */

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface AuthRoutesDeps {
  soulLoader: SoulLoader;
  gitSync: GitSyncService;
  secrets: SecretsService;
  repo: IntegrationAuthRequestRepo;
  /** Bundled manifests take precedence, matching `routes.ts`'s merge. */
  bundled: ReadonlyMap<string, BundledIntegration>;
  endpoints: AuthEndpoints;
  fetchImpl?: typeof globalThis.fetch;
  /**
   * Post-connect wiring, shared with the connect route. Credentials that arrive through a provider
   * redirect must trigger exactly the same setup as credentials an operator pasted — otherwise an
   * OAuth-connected Slack would silently have no routing.
   */
  onConnected?: (slug: string) => Promise<void>;
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
  requireAuth: PreHandler
): void {
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
        response: {
          200: StartActionSchema,
          400: ErrorSchema,
          401: ErrorSchema,
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

      try {
        const action = await startAuthStep({
          slug: name,
          manifest,
          stepIndex: Number(step),
          env: await readConnectionEnv(deps, name),
          endpoints: deps.endpoints,
          repo: deps.repo,
          fetchImpl: deps.fetchImpl,
        });

        // A server-side step produced credentials rather than a browser instruction. Seal them the
        // same way a provider callback's are, and answer with the action alone — the connection env
        // is never part of a response body.
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
      // No requireAuth, for the same reason as the GitHub install callback: the provider redirects
      // the browser here as a cross-site top-level navigation, which never carries our
      // SameSite=Strict session cookie. The one-use `state` consumed below is the authenticity
      // check, and unlike a stateless signed token it also makes a replayed callback fail.
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
        const outcome = await completeAuthStep({
          query,
          loadManifest: resolveManifest,
          loadEnv: (slug) => readConnectionEnv(deps, slug),
          endpoints: deps.endpoints,
          repo: deps.repo,
          fetchImpl: deps.fetchImpl,
        });

        const manifest = resolveManifest(outcome.slug);
        if (manifest && Object.keys(outcome.env).length > 0) {
          const { connectedNow } = await mergeConnectionEnv(deps, {
            slug: outcome.slug,
            manifest,
            patch: outcome.env,
            commitMessage: `soul: integration ${outcome.slug} auth step ${outcome.stepIndex}`,
          });
          if (connectedNow) await deps.onConnected?.(outcome.slug);
        }
        return reply.redirect(
          `${deps.endpoints.webUrl}/integrations/${outcome.slug}?step=${outcome.stepIndex}&status=ok`,
          302
        );
      } catch (err) {
        if (err instanceof AuthBrokerError) {
          // The operator is mid-flow in a browser, so a failure belongs on an integration page with
          // a reason, not as a raw JSON body they cannot act on. A failed state consume means we
          // never learned the slug, so those land on the list.
          const slug = err.slug ?? "";
          return reply.redirect(
            `${deps.endpoints.webUrl}/integrations/${slug}?status=error&reason=${err.reason}`,
            302
          );
        }
        throw err;
      }
    }
  );
}
