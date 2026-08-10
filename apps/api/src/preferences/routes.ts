import { MAX_CUSTOM_INSTRUCTIONS_CHARS } from "@tulipfarm/agent-runtime";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { KvService } from "../kv/service";
import {
  CUSTOM_INSTRUCTIONS_KEY,
  CUSTOM_INSTRUCTIONS_NAMESPACE,
  readCustomInstructions,
} from "./custom-instructions";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const CustomInstructionsSchema = {
  type: "object",
  properties: {
    instructions: { type: "string" },
    maxChars: { type: "integer" },
  },
  required: ["instructions", "maxChars"],
} as const;

/**
 * Self-service standing instructions. Scope and owner come from the authenticated caller, so these
 * routes have no target parameter and cannot read or write anybody else's.
 *
 * The length cap is enforced here rather than left to the KV store's 256KB byte limit, because the
 * prompt drops an over-budget block whole: a value the store accepts but the prompt silently
 * discards would look saved and do nothing.
 */
export function registerPreferenceRoutes(
  app: FastifyInstance,
  kvService: KvService,
  requireAuth: PreHandler
): void {
  app.get(
    "/api/v1/preferences/custom-instructions",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Read the current user's standing instructions for agents. Returns an empty string " +
          "when none are set, along with the cap the editor should enforce.",
        tags: ["preferences"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: { 200: CustomInstructionsSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: "unauthorized" });
      const instructions = await readCustomInstructions(kvService, req.user._id);
      return reply.send({
        instructions: instructions ?? "",
        maxChars: MAX_CUSTOM_INSTRUCTIONS_CHARS,
      });
    }
  );

  app.put(
    "/api/v1/preferences/custom-instructions",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Replace the current user's standing instructions. Blank clears them. Text longer " +
          "than `maxChars` is rejected rather than truncated: the system prompt drops an " +
          "over-budget block whole, so a saved-but-ignored instruction would be a silent failure.",
        tags: ["preferences"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["instructions"],
          additionalProperties: false,
          properties: { instructions: { type: "string" } },
        },
        response: { 200: CustomInstructionsSchema, 400: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: "unauthorized" });
      const { instructions } = req.body as { instructions: string };
      if (instructions.length > MAX_CUSTOM_INSTRUCTIONS_CHARS) {
        return reply.code(400).send({
          error: `instructions exceed the ${MAX_CUSTOM_INSTRUCTIONS_CHARS}-character cap`,
        });
      }

      const trimmed = instructions.trim();
      if (trimmed.length === 0) {
        await kvService.delete(
          "user",
          req.user._id,
          CUSTOM_INSTRUCTIONS_NAMESPACE,
          CUSTOM_INSTRUCTIONS_KEY
        );
        return reply.send({ instructions: "", maxChars: MAX_CUSTOM_INSTRUCTIONS_CHARS });
      }

      const outcome = await kvService.set(
        "user",
        req.user._id,
        CUSTOM_INSTRUCTIONS_NAMESPACE,
        CUSTOM_INSTRUCTIONS_KEY,
        trimmed
      );
      if (outcome.kind !== "ok") {
        return reply.code(400).send({ error: "instructions could not be stored" });
      }
      return reply.send({ instructions: trimmed, maxChars: MAX_CUSTOM_INSTRUCTIONS_CHARS });
    }
  );
}
