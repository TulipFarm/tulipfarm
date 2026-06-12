import type { SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import { deriveSuggestions } from "./suggestions";

/*
 * Read-only HTTP surface for the onboarding / Information Architect suggestion layer
 * (ONBOARDING ONB-V1-002/003, AC-V1-002). Suggestions are derived from the current soul state
 * (the SoulLoader's resource set) — a candidate is omitted once the resource it would create
 * already exists. Non-blocking by design: the chat landing surface renders whatever this returns.
 */

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registerOnboardingRoutes(
  app: FastifyInstance,
  soulLoader: SoulLoader,
  requireAuth: PreHandler
): void {
  app.get(
    "/api/v1/onboarding/suggestions",
    {
      preHandler: requireAuth,
      schema: {
        description: "Adaptive onboarding suggestions derived from the current soul state.",
        tags: ["onboarding"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["suggestions"],
            properties: {
              suggestions: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "label", "prompt"],
                  properties: {
                    id: { type: "string" },
                    label: { type: "string" },
                    prompt: { type: "string" },
                  },
                },
              },
            },
          },
          401: ErrorSchema,
        },
      },
    },
    async () => {
      return { suggestions: deriveSuggestions(soulLoader) };
    }
  );
}
