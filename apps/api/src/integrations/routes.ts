import { Type } from "@sinclair/typebox";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { SecretsService } from "@tulipfarm/secrets";
import {
  authStepProducesEnv,
  authStepSatisfied,
  type BundledIntegration,
  isPersonalCredentialStep,
  isSoulWriteError,
  resolveAuthSteps,
  type SoulLoader,
  type SoulWrite,
  type SoulWriter,
  soulWriteHttpError,
} from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifySchema } from "fastify";
import { stringify } from "yaml";
import type { AuditService } from "../audit/service";
import { makeSoulAuditWriter } from "../audit/soul-write";
import { ErrorSchema } from "../auth/schemas";
import type { RequireAuthorization } from "../authz/route-gate";
import { commitActorFromRequest } from "../soul/commit-actor";
import { ForeignSecretRefError } from "./connection-env";
import { mergeConnectionEnv } from "./connection-writer";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
const params = Type.Object({
  name: Type.Union([Type.Literal("slack"), Type.Literal("github")]),
});
const security: NonNullable<FastifySchema["security"]> = [
  { sessionCookie: [] },
  { bearerToken: [] },
];
const common = {
  tags: ["Integrations"],
  security,
  params,
};
const errors = {
  400: ErrorSchema,
  401: ErrorSchema,
  403: ErrorSchema,
  404: ErrorSchema,
  409: ErrorSchema,
  422: ErrorSchema,
  500: ErrorSchema,
};

export interface NativeIntegrationRouteDeps {
  readonly soulLoader: SoulLoader;
  readonly soulWriter: SoulWriter;
  readonly secrets: SecretsService;
  readonly bundled: ReadonlyMap<string, BundledIntegration>;
  readonly audit?: AuditService;
  readonly onConnected: (name: string) => Promise<void>;
  readonly onDisconnected: (name: string) => Promise<void>;
}

export function registerNativeIntegrationRoutes(
  app: FastifyInstance,
  deps: NativeIntegrationRouteDeps,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization
): void {
  const audit = makeSoulAuditWriter(deps.audit);
  const requireRead = requireAuthorization({
    action: "integration.read",
    resourceType: "integration",
    fallback: "authenticated",
  });
  app.get<{ Params: { name: "slack" | "github" } }>(
    "/api/v1/integrations/native/:name",
    {
      preHandler: [requireAuth, requireRead],
      schema: {
        ...common,
        description: "Read native Slack/GitHub channel setup. Agent business actions use MCP.",
        response: {
          200: Type.Object({
            name: Type.String(),
            connected: Type.Boolean(),
            auth: Type.Array(Type.Record(Type.String(), Type.Unknown())),
            setupGuide: Type.Optional(Type.String()),
            manifest: Type.Record(Type.String(), Type.Unknown()),
          }),
          ...errors,
        },
      },
    },
    async (request, reply) => {
      const name = request.params.name;
      const bundled = deps.bundled.get(name);
      const soul = deps.soulLoader.integrations.get(name);
      const manifest = bundled?.manifest ?? soul?.manifest;
      if (!manifest) return reply.code(404).send({ error: "Native channel is unavailable." });
      const steps = resolveAuthSteps(manifest);
      return {
        name,
        connected: soul?.connection?.enabled === true,
        setupGuide: bundled?.setupGuide ?? soul?.setupGuide,
        manifest: {
          required_env: steps.flatMap((step) => (step.kind === "fields" ? step.fields : [])),
          install_manifest: manifest.install_manifest
            ? JSON.stringify(manifest.install_manifest)
            : undefined,
        },
        auth: steps.map((step, index) => ({
          index,
          kind: step.kind,
          title: step.title,
          description: step.description,
          satisfied: authStepSatisfied(step, soul?.connection?.env ?? {}),
          producesEnv: authStepProducesEnv(step),
          fields: step.kind === "fields" ? step.fields : undefined,
          supportsOrgTarget: step.kind === "app_manifest" && step.create_url_for_org !== undefined,
          ...(isPersonalCredentialStep(step) ? { personal: true } : {}),
        })),
      };
    }
  );
  app.post<{ Params: { name: "slack" | "github" }; Body: { env: Record<string, string> } }>(
    "/api/v1/integrations/:name/connect",
    {
      preHandler: [
        requireAuth,
        requireAuthorization({
          action: "integration.connect",
          resourceType: "integration",
          fallback: "admin",
        }),
      ],
      schema: {
        ...common,
        description: "Configure native Slack/GitHub channel credentials, not Agent action Tools.",
        body: Type.Object(
          { env: Type.Record(Type.String(), Type.String()) },
          { additionalProperties: false }
        ),
        response: {
          200: Type.Object({ status: Type.String(), toolCount: Type.Literal(0) }),
          ...errors,
        },
      },
    },
    async (request, reply) => {
      const name = request.params.name;
      const bundled = deps.bundled.get(name);
      const soul = deps.soulLoader.integrations.get(name);
      const manifest = bundled?.manifest ?? soul?.manifest;
      if (!manifest) return reply.code(404).send({ error: "Native channel is unavailable." });
      const actor = commitActorFromRequest(request);
      try {
        if (!soul && bundled) {
          const changes: SoulWrite[] = [
            {
              op: "put",
              target: { kind: "Integration", slug: name, definitionMode: "legacy" },
              content: stringify(manifest),
            },
          ];
          for (const companion of [bundled.egressSpecFile, bundled.ingressHandlerFile]) {
            if (companion)
              changes.push({
                op: "put",
                target: { kind: "Integration", slug: name, companion: companion.file },
                content: companion.raw,
              });
          }
          if (bundled.setupGuide)
            changes.push({
              op: "put",
              target: { kind: "Integration", slug: name, companion: "setup-guide.md" },
              content: bundled.setupGuide,
            });
          await deps.soulWriter.apply({
            subject: `soul: configure native ${name} channel`,
            source: "api",
            actor,
            businessId: DEPLOYMENT_BUSINESS_ID,
            changes,
          });
        }
        const { enabled } = await mergeConnectionEnv(
          {
            soulWriter: deps.soulWriter,
            soulLoader: deps.soulLoader,
            secrets: deps.secrets,
          },
          {
            slug: name,
            manifest,
            patch: request.body.env,
            commitMessage: `soul: connect native ${name} channel`,
            actor,
          }
        );
        if (enabled) await deps.onConnected(name);
        await audit(request, "integration.connect", `integration:${name}`, {
          fields: Object.keys(request.body.env),
        });
        return { status: enabled ? "connected" : "pending", toolCount: 0 as const };
      } catch (error) {
        if (error instanceof ForeignSecretRefError)
          return reply.code(400).send({ error: error.message });
        if (isSoulWriteError(error)) {
          const mapped = soulWriteHttpError(error);
          return reply.code(mapped.status).send(mapped.body);
        }
        throw error;
      }
    }
  );
  app.post<{ Params: { name: "slack" | "github" } }>(
    "/api/v1/integrations/:name/disconnect",
    {
      preHandler: [
        requireAuth,
        requireAuthorization({
          action: "integration.disconnect",
          resourceType: "integration",
          fallback: "admin",
        }),
      ],
      schema: {
        ...common,
        description: "Disable native Slack/GitHub admission and revoke channel routing.",
        response: { 200: Type.Object({ status: Type.Literal("disconnected") }), ...errors },
      },
    },
    async (request, reply) => {
      const name = request.params.name;
      const soul = deps.soulLoader.integrations.get(name);
      if (!soul) return reply.code(404).send({ error: "Native channel is not configured." });
      try {
        await deps.soulWriter.apply({
          subject: `soul: disconnect native ${name} channel`,
          source: "api",
          actor: commitActorFromRequest(request),
          businessId: DEPLOYMENT_BUSINESS_ID,
          changes: [
            {
              op: "put",
              target: { kind: "Integration", slug: name, companion: "connection.yaml" },
              content: stringify({ enabled: false, env: soul.connection?.env ?? {} }),
            },
          ],
        });
        await deps.soulLoader.reload();
        await deps.onDisconnected(name);
        await audit(request, "integration.disconnect", `integration:${name}`);
        return { status: "disconnected" as const };
      } catch (error) {
        if (isSoulWriteError(error)) {
          const mapped = soulWriteHttpError(error);
          return reply.code(mapped.status).send(mapped.body);
        }
        throw error;
      }
    }
  );
}
