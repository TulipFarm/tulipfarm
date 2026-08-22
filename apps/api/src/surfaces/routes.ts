import type { EventEmitter } from "node:events";
import { Value } from "@sinclair/typebox/value";
import type { GuardrailsService } from "@tulipfarm/agent-runtime";
import type { SoulLoader } from "@tulipfarm/soul";
import { DOMAIN_EVENTS } from "@tulipfarm/storage";
import {
  type PresentationContext,
  resolveSoulSurfaceView,
  SurfaceInteractionSchema,
  type SurfaceTarget,
  targetKey,
} from "@tulipfarm/surface";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { evaluateStepUp } from "../identity/step-up";
import type { SurfaceActionStore } from "./action-store";
import type { SurfaceArtifactStore } from "./artifact-store";
import {
  presentationContextFor,
  surfaceCatalogFor,
  surfaceRendererRegistry,
} from "./renderer-registry";

const security: { [key: string]: readonly string[] }[] = [
  { sessionCookie: [] },
  { bearerToken: [] },
];
type RequireAuth = preHandlerHookHandler;

function targetFromQuery(query: Record<string, unknown>): SurfaceTarget | null {
  const channel = query.channel;
  const surface = query.surface;
  if (channel === "web" && surface === "chat") return { channel, surface };
  if (channel === "slack" && (surface === "message" || surface === "modal")) {
    return { channel, surface };
  }
  if (channel === "github" && (surface === "comment" || surface === "check-run")) {
    return { channel, surface };
  }
  return null;
}

export function registerSurfaceRoutes(
  app: FastifyInstance,
  artifacts: SurfaceArtifactStore,
  actions: SurfaceActionStore,
  requireAuth: RequireAuth,
  events?: EventEmitter,
  guardrails?: GuardrailsService,
  soulLoader?: SoulLoader
): void {
  app.get(
    "/api/v1/surfaces/catalog",
    {
      preHandler: requireAuth,
      schema: {
        description: "Return the TSP component catalog for one resolved presentation target.",
        tags: ["surfaces"],
        security,
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["channel", "surface"],
          properties: {
            channel: { enum: ["web", "slack", "github"] },
            surface: { enum: ["chat", "message", "modal", "comment", "check-run"] },
          },
        },
        response: {
          200: { type: "object", additionalProperties: true },
          400: {
            type: "object",
            required: ["error"],
            properties: { error: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const target = targetFromQuery(request.query as Record<string, unknown>);
      if (!target) return reply.code(400).send({ error: "Unsupported presentation target." });
      const context: PresentationContext = presentationContextFor(target, "");
      const components = [...(soulLoader?.surfaceComponents.values() ?? [])];
      return {
        protocol: "tsp",
        protocolVersion: "1.0",
        target: context.target,
        components: surfaceCatalogFor(target, components),
      };
    }
  );

  app.get(
    "/api/v1/surfaces/:artifactId",
    {
      preHandler: requireAuth,
      schema: {
        description: "Read a canonical Surface Artifact revision.",
        tags: ["surfaces"],
        security,
        params: {
          type: "object",
          required: ["artifactId"],
          properties: { artifactId: { type: "string" } },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { revision: { type: "integer", minimum: 1 } },
        },
        response: {
          200: { type: "object", additionalProperties: true },
          404: {
            type: "object",
            required: ["error"],
            properties: { error: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const { artifactId } = request.params as { artifactId: string };
      const { revision } = request.query as { revision?: number };
      const artifact = await artifacts.get(artifactId, revision);
      if (!artifact) return reply.code(404).send({ error: "Surface Artifact not found." });
      const userId = (request.user as { _id: string })._id;
      if (!artifact.audience.includes(userId)) {
        return reply.code(404).send({ error: "Surface Artifact not found." });
      }
      const component = soulLoader?.surfaceComponents.get(artifact.component.name);
      return {
        artifact,
        actionHandles: await actions.listForArtifact(artifact.id, artifact.revision, userId),
        resolvedView:
          component && component.version === artifact.component.version
            ? resolveSoulSurfaceView(
                component,
                artifact.target,
                artifact.props,
                [...(soulLoader?.surfaceComponents.values() ?? [])],
                surfaceRendererRegistry
              )
            : undefined,
      };
    }
  );

  app.post(
    "/api/v1/surfaces/interactions",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Persist and normalize a web or provider Surface interaction before continuation.",
        tags: ["surfaces"],
        security,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["handle", "input"],
          properties: {
            handle: { type: "string", minLength: 1 },
            input: { type: "object" },
          },
        },
        response: {
          200: SurfaceInteractionSchema,
          400: {
            type: "object",
            required: ["error", "code"],
            properties: { error: { type: "string" }, code: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const { handle, input } = request.body as {
        handle: string;
        input: Readonly<Record<string, unknown>>;
      };
      const result = await actions.resolve({
        handle,
        principal: (request.user as { _id: string })._id,
        value: input,
        currentGuardrailRevision: guardrails?.revision ?? "none",
        stepUpSatisfied: evaluateStepUp(
          request.principal,
          { methods: ["totp", "passkey"], maxAgeSeconds: 300 },
          new Date()
        ).satisfied,
      });
      if (!result.ok) {
        return reply.code(400).send({
          error: "Surface interaction was rejected.",
          code: result.code,
        });
      }
      if (!Value.Check(SurfaceInteractionSchema, result.interaction)) {
        return reply.code(400).send({
          error: "Surface interaction was invalid.",
          code: "invalid_input",
        });
      }
      if (guardrails) {
        const guarded = await guardrails.runToolCall(
          {
            toolName: `surface.${result.interaction.event}`,
            tier: "platform",
            args: result.interaction.input,
          },
          {
            userId: result.interaction.principal,
            conversationId: result.handle.conversationId ?? result.interaction.destination,
          }
        );
        if (guarded.blocked) {
          return reply.code(400).send({
            error: "Surface interaction was blocked by current Guardrails.",
            code: "guardrail_blocked",
          });
        }
      }
      const artifact = await artifacts.get(
        result.interaction.artifactId,
        result.interaction.revision
      );
      events?.emit(DOMAIN_EVENTS.SURFACE_INTERACTED, {
        target: targetKey(result.interaction.target),
        component: artifact?.component.name ?? "unknown",
        version: artifact?.component.version ?? "unknown",
        validation: "ok",
        render: "ok",
        interaction: "accepted",
        validationPaths: [],
        surfaceInteraction: result.interaction,
      });
      return result.interaction;
    }
  );
}
