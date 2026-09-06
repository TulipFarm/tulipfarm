import { randomUUID } from "node:crypto";
import type { AuthEndpoints } from "@tulipfarm/integrations";
import {
  compileOimHttpOperations,
  type EgressHttpPort,
  FetchEgressHttp,
  GuardedEgressHttp,
  OimHttpToolAdapter,
} from "@tulipfarm/integrations";
import type { OimConnection, OimManifest } from "@tulipfarm/schema";
import { OIM_CONNECTION_HEALTH_STATES, TeamIdSchema } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import type { CommitActor, SoulLoader, SoulWriter } from "@tulipfarm/soul";
import { bundledIntegrationsDir } from "@tulipfarm/soul";
import type {
  ConnectionStore,
  IntegrationAuthRequestRepo,
  PersistedConnection,
} from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { AuthorizationCheck } from "../authz/route-gate";
import type { RequestPrincipal } from "../identity/principal";
import { commitActorFromRequest } from "../soul/commit-actor";
import { AuthBrokerError, completeAuthStep, startAuthStep } from "./auth-broker";
import { materializeBundledOimPackage } from "./bundled-oim";
import { discoverIntegrations, IntegrationInstallError } from "./install";
import {
  createOimConnection,
  OimConnectError,
  oimConnectForm,
  oimMajorVersion,
} from "./oim-connect";
import {
  OIM_OAUTH_STEP_INDEX,
  oimCredentialsFromEnv,
  oimOAuthLegacyManifest,
  oimOAuthStep,
  oimSlotEnv,
} from "./oim-oauth";
import { type OimWebhookLifecycle, OimWebhookLifecycleError } from "./oim-webhook-lifecycle";

/**
 * Connecting an installed OIM package.
 *
 * Separate from `/integrations/:name/connect`, which seals env into the Soul for a legacy
 * manifest. An OIM package's credential belongs to a Connection row instead — that is the model
 * the resolver, the personal/organization split and revocation were all built around — so giving
 * it its own routes keeps one credential store per declaration format rather than two half-used.
 */

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface OimConnectionRouteDeps {
  readonly soulLoader: SoulLoader;
  readonly soulWriter: SoulWriter;
  readonly connections: ConnectionStore;
  readonly secrets: SecretsService;
  readonly requireAuth: PreHandler;
  /** Guards shared Connection scopes; a personal Connection spends only its owner's credential. */
  readonly authorizationCheck: AuthorizationCheck;
  /** Re-sync Tools so a new Connection is usable without a restart. */
  readonly declarativeTools?: { sync: () => number };
  readonly audit?: (
    req: FastifyRequest,
    action: string,
    subject: string,
    detail: Record<string, unknown>
  ) => Promise<void>;
  /** Overridable for tests; defaults to the image's bundled integrations directory. */
  readonly bundledRoot?: string;
  /** Overridable for tests; defaults to the same guarded transport Tool dispatch uses. */
  readonly http?: EgressHttpPort;
  /** One-use OAuth state custody. Absent disables the authorize routes rather than faking them. */
  readonly authRequests?: IntegrationAuthRequestRepo;
  readonly endpoints?: AuthEndpoints | (() => Promise<AuthEndpoints>);
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly webhookLifecycle?: OimWebhookLifecycle;
}

/**
 * Runs the operation a manifest nominated as its health check, against one Connection.
 *
 * Deliberately outside the Tool ledger. `healthCheckOperationId` is required to name a `read`
 * operation, so there is no effect to reconcile and no idempotency to preserve — and routing it
 * through the ledger would mint an Effect with no Run, no State and no Agent behind it, which is a
 * row nobody could later explain.
 */
export async function runHealthCheck(
  manifest: OimManifest,
  connection: PersistedConnection,
  deps: { readonly secrets: SecretsService; readonly http: EgressHttpPort }
): Promise<OimConnection["health"]["status"]> {
  const operationId = manifest.auth?.healthCheckOperationId;
  if (operationId === undefined) throw new OimConnectError("unsupported_auth", "no_health_check");

  const configuration: Record<string, string> = {};
  for (const [key, value] of Object.entries(connection.configuration)) {
    configuration[key] = String(value);
  }
  const tool = compileOimHttpOperations(manifest, configuration).find(
    (candidate) => candidate.operation.id === operationId
  );
  // A GraphQL health check compiles through a different path; saying so beats reporting the
  // Connection unhealthy because this route could not describe it.
  if (tool === undefined) throw new OimConnectError("unsupported_auth", "health_check_not_http");

  const credentialSlots = [
    tool.operation.credentialSlot,
    tool.operation.secondaryCredential?.slot,
  ].filter((slot): slot is string => slot !== undefined);
  const credentials: Record<string, string> = {};
  for (const slot of credentialSlots) {
    const reference = connection.secretBindings[slot];
    if (reference === undefined) throw new OimConnectError("missing_field", slot);
    credentials[slot] = await deps.secrets.get(reference.replace(/^secret:\/\//, ""));
  }

  const adapter = new OimHttpToolAdapter({
    binding: tool.binding,
    http: deps.http,
    toolId: tool.toolId,
    ...(tool.projection === undefined ? {} : { projection: tool.projection }),
  });

  try {
    await adapter.dispatch(
      {
        intent: {
          intentId: `health-${connection.id}`,
          businessId: connection.businessId,
          runId: `health-${connection.id}`,
          stateId: `health-${connection.id}`,
          toolId: tool.toolId,
          toolVersion: manifest.metadata.version,
          action: `integration.${manifest.metadata.id}.${tool.operation.name}`,
          targetRefs: [],
          arguments: {},
          idempotencyKey: `health-${connection.id}`,
        },
        idempotencyKey: `health-${connection.id}`,
        attempt: 1,
      },
      tool.operation.credentialSlot === undefined
        ? undefined
        : credentials[tool.operation.credentialSlot],
      credentials
    );
    return "healthy";
  } catch (error) {
    // Only a provider refusal proves the credential is the problem. A timeout or a 5xx says the
    // provider is having a bad minute, and reporting that as `action_required` would send someone
    // to rotate a key that was never wrong.
    const code = (error as { code?: unknown }).code;
    return code === "provider_unauthorized" ? "action_required" : "unknown";
  }
}

const FieldSchema = {
  type: "object",
  required: ["id", "label", "input", "required", "secret"],
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    description: { type: "string" },
    input: { type: "string", enum: ["text", "password", "url"] },
    required: { type: "boolean" },
    secret: { type: "boolean" },
  },
} as const;

const FormSchema = {
  type: "object",
  required: [
    "integrationId",
    "majorVersion",
    "steps",
    "unsupportedStepTypes",
    "requiresAuthorization",
  ],
  properties: {
    integrationId: { type: "string" },
    majorVersion: { type: "number" },
    steps: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "title", "fields"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          fields: { type: "array", items: FieldSchema },
        },
      },
    },
    unsupportedStepTypes: { type: "array", items: { type: "string" } },
    requiresAuthorization: { type: "boolean" },
  },
} as const;

const ConnectionSchema = {
  type: "object",
  required: ["id", "label", "scope", "status", "isDefault", "health"],
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    scope: { type: "string", enum: ["organization", "personal", "team"] },
    teamId: TeamIdSchema,
    status: { type: "string", enum: ["active", "revoked"] },
    isDefault: { type: "boolean" },
    health: { type: "string" },
    expiresAt: { type: ["string", "null"] },
    // Only the fields the package marked Agent-visible. The rest describe where a credential goes,
    // which is the host's business.
    configuration: { type: "object", additionalProperties: true },
  },
} as const;

/** The Agent-safe view of a Connection: never a Secret reference, never a hidden config value. */
function toView(connection: PersistedConnection) {
  const visible: Record<string, string | number | boolean> = {};
  for (const field of connection.agentVisibleConfiguration) {
    const value = connection.configuration[field];
    if (value !== undefined) visible[field] = value;
  }
  return {
    id: connection.id,
    label: connection.label,
    scope: connection.owner.scope,
    ...(connection.owner.scope === "team" ? { teamId: connection.owner.teamId } : {}),
    status: connection.status,
    isDefault: connection.isDefault,
    health: connection.health.status,
    expiresAt: connection.expiresAt,
    configuration: visible,
  };
}

/** The message a person can act on, for each way a submitted form can be unusable. */
const REFUSALS: Record<OimConnectError["code"], string> = {
  unsupported_auth:
    "This package asks for a sign-in flow this deployment cannot run yet. Connect it once that step type is supported.",
  unknown_field: "That field is not part of this package's setup.",
  missing_field: "Fill in every required field before connecting.",
  invalid_value: "One of the values is not in the form this package expects.",
  origin_not_allowed: "That host is not one this package is allowed to reach.",
};

function principalOf(req: FastifyRequest): RequestPrincipal | undefined {
  return (req as FastifyRequest & { principal?: RequestPrincipal }).principal;
}

export function registerOimConnectionRoutes(
  app: FastifyInstance,
  deps: OimConnectionRouteDeps
): void {
  async function canManageConnection(
    principal: RequestPrincipal,
    connection: PersistedConnection
  ): Promise<boolean> {
    if (connection.owner.scope === "personal") {
      return connection.owner.principalId === principal.id;
    }
    if (connection.owner.scope === "team") {
      return await deps.authorizationCheck(principal, {
        action: "team.write",
        resourceType: "team",
        recordId: connection.owner.teamId,
        fallback: "admin",
      });
    }
    return await deps.authorizationCheck(principal, {
      action: "integration.connect",
      resourceType: "integration",
      fallback: "admin",
    });
  }

  /**
   * The manifest for an installed OIM package, or the bundled one it would install from.
   *
   * Both are answered because the connect screen has to be able to show its form *before* the
   * package is in the Soul: materializing on first view would install a package for anyone who
   * merely looked at it.
   */
  async function manifestFor(slug: string): Promise<OimManifest | undefined> {
    const installed = deps.soulLoader.integrations.get(slug)?.oimManifest;
    if (installed !== undefined) return installed;
    const discovered = await discoverIntegrations(deps.bundledRoot ?? bundledIntegrationsDir());
    return discovered.find((entry) => entry.name === slug)?.oimManifest;
  }

  async function ensureInstalled(slug: string, actor: CommitActor): Promise<void> {
    await materializeBundledOimPackage(slug, {
      soulLoader: deps.soulLoader,
      soulWriter: deps.soulWriter,
      actor,
      ...(deps.bundledRoot === undefined ? {} : { root: deps.bundledRoot }),
    });
  }

  app.get(
    "/api/v1/integrations/:name/connections",
    {
      preHandler: [deps.requireAuth],
      schema: {
        description:
          "The setup form an OIM package declares, and the Connections this caller can already use.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        response: {
          200: {
            type: "object",
            required: ["form", "connections"],
            properties: {
              form: FormSchema,
              connections: { type: "array", items: ConnectionSchema },
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          502: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      if (!NAME_RE.test(name)) {
        return reply.code(404).send({ error: `integration not found: ${name}` });
      }
      const principal = principalOf(req);
      if (principal === undefined || principal.kind !== "user") {
        return reply.code(403).send({ error: "only a signed-in person can read this" });
      }
      const manifest = await manifestFor(name);
      if (manifest === undefined) {
        return reply.code(404).send({ error: `integration not found: ${name}` });
      }
      const integration = { id: manifest.metadata.id, majorVersion: oimMajorVersion(manifest) };
      const [organization, personal, all] = await Promise.all([
        deps.connections.listForOwner(principal.businessId, integration, {
          scope: "organization",
        }),
        deps.connections.listForOwner(principal.businessId, integration, {
          scope: "personal",
          principalKind: "user",
          principalId: principal.id,
        }),
        deps.connections.listForIntegration(principal.businessId, integration),
      ]);
      const teams = (
        await Promise.all(
          all.map(async (connection) => {
            if (connection.owner.scope !== "team") return [];
            const allowed = await deps.authorizationCheck(principal, {
              action: "team.read",
              resourceType: "team",
              recordId: connection.owner.teamId,
              fallback: "authenticated",
            });
            return allowed ? [connection] : [];
          })
        )
      ).flat();
      return {
        form: oimConnectForm(manifest),
        // A person only ever sees organization Connections, Team Connections they can access,
        // and their own. Another person's personal credential is not theirs to know about.
        connections: [...organization, ...personal, ...teams].map(toView),
      };
    }
  );

  app.post(
    "/api/v1/integrations/:name/connections",
    {
      preHandler: [deps.requireAuth],
      schema: {
        description: "Create a Connection for an installed OIM package from its declared form.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        body: {
          type: "object",
          required: ["label", "values"],
          properties: {
            label: { type: "string", minLength: 1, maxLength: 128 },
            scope: { type: "string", enum: ["personal", "organization", "team"] },
            teamId: TeamIdSchema,
            values: { type: "object", additionalProperties: { type: "string" } },
          },
        },
        response: {
          201: {
            type: "object",
            required: ["connectionId", "scope"],
            properties: {
              connectionId: { type: "string" },
              scope: { type: "string" },
              teamId: TeamIdSchema,
              toolsResynced: { type: "number" },
            },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
          429: ErrorSchema,
          502: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      if (!NAME_RE.test(name)) {
        return reply.code(404).send({ error: `integration not found: ${name}` });
      }
      const body = req.body as {
        label: string;
        scope?: "personal" | "organization" | "team";
        teamId?: string;
        values: Record<string, string>;
      };
      const principal = principalOf(req);
      if (principal === undefined || principal.kind !== "user") {
        return reply
          .code(403)
          .send({ error: "only a signed-in person can connect an integration" });
      }
      // Personal is the default because it is the narrower of the two: an operator who meant to
      // share a credential has to say so, and cannot widen it by omission.
      const scope = body.scope ?? "personal";
      let owner: OimConnection["owner"];
      if (scope === "organization") {
        const allowed = await deps.authorizationCheck(principal, {
          action: "integration.connect",
          resourceType: "integration",
          fallback: "admin",
        });
        if (!allowed) {
          return reply
            .code(403)
            .send({ error: "not authorized to create an organization Connection" });
        }
        owner = { scope: "organization" };
      } else if (scope === "team") {
        if (body.teamId === undefined) {
          return reply.code(400).send({ error: "a Team Connection requires teamId" });
        }
        const allowed = await deps.authorizationCheck(principal, {
          action: "team.write",
          resourceType: "team",
          recordId: body.teamId,
          fallback: "admin",
        });
        if (!allowed) {
          return reply.code(403).send({ error: "not authorized to manage this Team" });
        }
        owner = { scope: "team", teamId: body.teamId };
      } else {
        owner = { scope: "personal", principalKind: "user", principalId: principal.id };
      }

      const manifest = await manifestFor(name);
      if (manifest === undefined) {
        return reply.code(404).send({ error: `integration not found: ${name}` });
      }
      const installed = deps.soulLoader.integrations.get(name)?.oimManifest !== undefined;
      if (
        !installed &&
        !(await deps.authorizationCheck(principal, {
          action: "integration.install",
          resourceType: "integration",
          fallback: "admin",
        }))
      ) {
        return reply.code(403).send({ error: "not authorized to install this integration" });
      }

      try {
        // Install before the Connection: a Connection for a package the loader cannot see would
        // resolve to a Tool that does not exist.
        await ensureInstalled(name, commitActorFromRequest(req));
        const created = await createOimConnection(
          { connections: deps.connections, secrets: deps.secrets },
          {
            businessId: principal.businessId,
            manifest,
            label: body.label,
            owner,
            values: body.values,
          }
        );
        const connection = await deps.connections.findById(
          principal.businessId,
          created.connectionId
        );
        const webhookStep = manifest.auth?.steps.find((step) => step.type === "webhook");
        if (
          webhookStep !== undefined &&
          connection !== null &&
          deps.webhookLifecycle !== undefined
        ) {
          const endpoints =
            typeof deps.endpoints === "function"
              ? await deps.endpoints()
              : (deps.endpoints ?? { apiUrl: `http://localhost:${process.env.PORT ?? 4010}` });
          await deps.webhookLifecycle.register(manifest, connection, endpoints.apiUrl, name);
        }
        const toolsResynced = deps.declarativeTools?.sync();
        // Field *names* only. The values are credentials, and recording them would defeat the
        // point of storing them as Secrets.
        await deps.audit?.(req, "connection.create", `connection:${created.connectionId}`, {
          integration: name,
          scope,
          ...(owner.scope === "team" ? { teamId: owner.teamId } : {}),
          fields: Object.keys(body.values),
        });
        return reply.code(201).send({
          ...created,
          scope,
          ...(owner.scope === "team" ? { teamId: owner.teamId } : {}),
          ...(toolsResynced === undefined ? {} : { toolsResynced }),
        });
      } catch (error) {
        if (error instanceof OimConnectError) {
          return reply
            .code(422)
            .send({ error: `${REFUSALS[error.code]}${error.detail ? ` (${error.detail})` : ""}` });
        }
        if (error instanceof IntegrationInstallError) {
          return reply.code(error.status).send({ error: error.message });
        }
        if (error instanceof OimWebhookLifecycleError) {
          return reply.code(502).send({ error: "The provider could not register this webhook." });
        }
        throw error;
      }
    }
  );

  const authRequests = deps.authRequests;
  const endpointsOf = deps.endpoints;
  if (authRequests !== undefined && endpointsOf !== undefined) {
    const resolveEndpoints = async (): Promise<AuthEndpoints> => {
      const base = typeof endpointsOf === "function" ? await endpointsOf() : endpointsOf;
      // The authorize URL and the token exchange must name the same redirect, and OIM keeps its own
      // callback so the legacy flow's `connection.yaml` merge can never see an OIM outcome.
      return { ...base, callbackUrl: `${base.apiUrl}/api/v1/integrations/oim/auth/callback` };
    };

    /** By the time a Connection exists its package is installed, so a Soul lookup is enough. */
    const installedManifest = (slug: string): OimManifest | undefined =>
      deps.soulLoader.integrations.get(slug)?.oimManifest;

    async function clientEnv(
      manifest: OimManifest,
      connection: PersistedConnection
    ): Promise<Record<string, string>> {
      const step = oimOAuthStep(manifest);
      if (step === undefined) throw new OimConnectError("unsupported_auth", "no_oauth_step");
      const env: Record<string, string> = {};
      for (const slot of [step.clientId.slot, step.clientSecret?.slot]) {
        if (slot === undefined) continue;
        const reference = connection.secretBindings[slot];
        if (reference === undefined) throw new OimConnectError("missing_field", slot);
        env[oimSlotEnv(slot)] = await deps.secrets.get(reference.replace(/^secret:\/\//, ""));
      }
      return env;
    }

    app.post(
      "/api/v1/integrations/:name/connections/:id/authorize",
      {
        preHandler: [deps.requireAuth],
        schema: {
          description:
            "Begin the provider consent flow for an OIM Connection, returning where to send the browser.",
          tags: ["integrations"],
          security: [{ sessionCookie: [] }, { bearerToken: [] }],
          params: {
            type: "object",
            required: ["name", "id"],
            properties: { name: { type: "string" }, id: { type: "string" } },
          },
          response: {
            200: {
              type: "object",
              required: ["url"],
              properties: { url: { type: "string" } },
            },
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
        const { name, id } = req.params as { name: string; id: string };
        const principal = principalOf(req);
        if (principal === undefined || principal.kind !== "user") {
          return reply.code(403).send({ error: "only a signed-in person can authorize" });
        }
        const connection = await deps.connections.findById(principal.businessId, id);
        if (connection === null || connection.integration.id !== name) {
          return reply.code(404).send({ error: `connection not found: ${id}` });
        }
        const owner = connection.owner;
        const personal = owner.scope === "personal";
        if (owner.scope === "personal" && owner.principalId !== principal.id) {
          return reply.code(404).send({ error: `connection not found: ${id}` });
        }
        if (!(await canManageConnection(principal, connection))) {
          return reply.code(403).send({ error: "not authorized to manage this Connection" });
        }
        const manifest = installedManifest(name);
        if (manifest === undefined) {
          return reply.code(404).send({ error: `integration not found: ${name}` });
        }
        const legacy = oimOAuthLegacyManifest(manifest, { personal });
        if (legacy === undefined) {
          return reply.code(400).send({ error: "this package declares no oauth2 step" });
        }

        try {
          const action = await startAuthStep({
            slug: name,
            manifest: legacy,
            stepIndex: OIM_OAUTH_STEP_INDEX,
            env: await clientEnv(manifest, connection),
            endpoints: await resolveEndpoints(),
            repo: authRequests,
            connectionId: id,
            ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
            ...(personal ? { principal: { kind: principal.kind, id: principal.id } } : {}),
          });
          if (action.action !== "redirect") {
            return reply.code(400).send({ error: "this step does not use a browser redirect" });
          }
          return reply.code(200).send({ url: action.url });
        } catch (error) {
          if (error instanceof OimConnectError) {
            return reply.code(409).send({ error: error.message });
          }
          if (error instanceof AuthBrokerError) {
            return reply.code(502).send({ error: error.message });
          }
          throw error;
        }
      }
    );

    app.get(
      "/api/v1/integrations/oim/auth/callback",
      {
        // Unauthenticated by necessity: the provider redirects the browser here. The one-use state
        // row is what proves the callback belongs to an authorization this deployment started.
        schema: {
          description: "Provider callback for an OIM Connection's OAuth flow.",
          tags: ["integrations"],
          querystring: { type: "object", properties: { state: { type: "string" } } },
          response: { 302: { type: "null" }, 400: ErrorSchema },
        },
      },
      async (req, reply) => {
        const endpoints = await resolveEndpoints();
        let outcome: Awaited<ReturnType<typeof completeAuthStep>>;
        try {
          outcome = await completeAuthStep({
            query: req.query as Record<string, string>,
            loadManifest: (slug) => {
              const manifest = installedManifest(slug);
              return manifest === undefined ? undefined : oimOAuthLegacyManifest(manifest);
            },
            loadEnv: async (slug, connectionId) => {
              const manifest = installedManifest(slug);
              if (manifest === undefined || !connectionId) return {};
              // The token exchange needs the same client credentials the authorize URL was signed
              // with, and those live on the Connection the state row named.
              const connection = await deps.connections.findByIdAcrossBusinesses(connectionId);
              return connection === null ? {} : clientEnv(manifest, connection);
            },
            endpoints,
            repo: authRequests,
            ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
          });
        } catch (error) {
          const reason = error instanceof AuthBrokerError ? error.reason : "exchange_failed";
          return reply.redirect(
            `${endpoints.webUrl}/business/integrations?status=error&reason=${reason}`,
            302
          );
        }
        const manifest = installedManifest(outcome.slug);
        const connection =
          outcome.connectionId === undefined
            ? null
            : await deps.connections.findByIdAcrossBusinesses(outcome.connectionId);
        if (manifest === undefined || connection === null) {
          return reply.redirect(
            `${endpoints.webUrl}/business/integrations?status=error&reason=invalid_state`,
            302
          );
        }

        const { slots, expiresAt } = oimCredentialsFromEnv(manifest, outcome.env);
        const secretBindings = { ...connection.secretBindings };
        const rotations: Record<string, string> = {};
        for (const [slot, value] of Object.entries(slots)) {
          // Reuse the slot's existing key on a re-authorization, so a person reconnecting does not
          // leave an orphaned secret behind for every consent they ever granted.
          const key =
            secretBindings[slot]?.replace(/^secret:\/\//, "") ??
            `oim-${manifest.metadata.id}-${randomUUID().replace(/-/g, "")}`;
          rotations[key] = value;
          secretBindings[slot] = `secret://${key}`;
        }
        await deps.secrets.setMany(rotations);
        await deps.connections.put(connection.businessId, {
          ...connection,
          secretBindings,
          health: { status: "healthy", checkedAt: new Date().toISOString() },
          expiresAt,
        });
        deps.declarativeTools?.sync();

        return reply.redirect(
          `${endpoints.webUrl}/business/integrations/${outcome.slug}/connections?status=ok`,
          302
        );
      }
    );
  }

  app.post(
    "/api/v1/integrations/:name/connections/:id/test",
    {
      preHandler: [deps.requireAuth],
      schema: {
        description:
          "Call the operation this package nominated as its health check and record the result.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["name", "id"],
          properties: { name: { type: "string" }, id: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["status", "checkedAt"],
            properties: {
              status: { type: "string", enum: [...OIM_CONNECTION_HEALTH_STATES] },
              checkedAt: { type: "string" },
            },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          502: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name, id } = req.params as { name: string; id: string };
      const principal = principalOf(req);
      if (principal === undefined || principal.kind !== "user") {
        return reply.code(403).send({ error: "only a signed-in person can test a Connection" });
      }
      const connection = await deps.connections.findById(principal.businessId, id);
      if (connection === null || connection.integration.id !== name) {
        return reply.code(404).send({ error: `connection not found: ${id}` });
      }
      // Same rule as revoke: confirming that someone else's personal Connection exists is already
      // more than the caller is entitled to know.
      if (connection.owner.scope === "personal" && connection.owner.principalId !== principal.id) {
        return reply.code(404).send({ error: `connection not found: ${id}` });
      }
      if (!(await canManageConnection(principal, connection))) {
        return reply.code(403).send({ error: "not authorized to manage this Connection" });
      }
      const manifest = await manifestFor(name);
      if (manifest === undefined) {
        return reply.code(404).send({ error: `integration not found: ${name}` });
      }

      let status: OimConnection["health"]["status"];
      try {
        status = await runHealthCheck(manifest, connection, {
          secrets: deps.secrets,
          http: deps.http ?? new GuardedEgressHttp(new FetchEgressHttp()),
        });
      } catch (error) {
        if (error instanceof OimConnectError) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }

      const checkedAt = new Date().toISOString();
      await deps.connections.updateHealth(
        principal.businessId,
        id,
        { status, checkedAt },
        connection.expiresAt
      );
      await deps.audit?.(req, "connection.test", `connection:${id}`, {
        integration: name,
        status,
      });
      return reply.code(200).send({ status, checkedAt });
    }
  );

  app.delete(
    "/api/v1/integrations/:name/connections/:id",
    {
      preHandler: [deps.requireAuth],
      schema: {
        description: "Revoke a Connection and delete the Secrets it bound.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["name", "id"],
          properties: { name: { type: "string" }, id: { type: "string" } },
        },
        response: {
          204: { type: "null" },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          502: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name, id } = req.params as { name: string; id: string };
      const principal = principalOf(req);
      if (principal === undefined || principal.kind !== "user") {
        return reply.code(403).send({ error: "only a signed-in person can revoke a Connection" });
      }
      const connection = await deps.connections.findById(principal.businessId, id);
      if (connection === null || connection.integration.id !== name) {
        return reply.code(404).send({ error: `connection not found: ${id}` });
      }
      if (connection.owner.scope === "personal") {
        if (connection.owner.principalId !== principal.id) {
          // Reported as absent rather than forbidden: confirming that someone else's personal
          // Connection exists is already more than the caller is entitled to know.
          return reply.code(404).send({ error: `connection not found: ${id}` });
        }
      } else if (connection.owner.scope === "team") {
        if (!(await canManageConnection(principal, connection))) {
          return reply.code(403).send({ error: "not authorized to manage this Team Connection" });
        }
      } else {
        const allowed = await deps.authorizationCheck(principal, {
          action: "integration.disconnect",
          resourceType: "integration",
          fallback: "admin",
        });
        if (!allowed) {
          return reply.code(403).send({ error: "not authorized to revoke this Connection" });
        }
      }

      const manifest = await manifestFor(name);
      if (manifest === undefined) {
        return reply.code(404).send({ error: `integration not found: ${name}` });
      }
      try {
        await deps.webhookLifecycle?.revoke(manifest, connection);
      } catch (error) {
        if (error instanceof OimWebhookLifecycleError) {
          return reply.code(502).send({
            error:
              "The provider could not remove this webhook. Fix the connection, then try again.",
          });
        }
        throw error;
      }
      // Revoke before deleting the Secrets: a crash between the two leaves a revoked Connection
      // whose Secrets linger, which is inert. The other order would leave a Connection that still
      // presents as active and fails at dispatch.
      await deps.connections.markRevoked(principal.businessId, id);
      for (const reference of Object.values(connection.secretBindings)) {
        const key = reference.replace(/^secret:\/\//, "");
        await deps.secrets.delete(key);
      }
      deps.declarativeTools?.sync();
      await deps.audit?.(req, "connection.revoke", `connection:${id}`, {
        integration: name,
        scope: connection.owner.scope,
      });
      return reply.code(204).send();
    }
  );
}
