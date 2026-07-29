import {
  FormSubmissionError,
  type FormSubmissionResult,
  type GovernedForm,
  type SubmitFormInput,
} from "@tulipfarm/surface";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface FormsRoutesDeps {
  resolve(formId: string, principal: string): Promise<GovernedForm | null>;
  submit(form: GovernedForm, input: SubmitFormInput): Promise<FormSubmissionResult>;
  now?: () => string;
}

const FORM_RESULT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["mode", "eventId", "runId", "outcome"],
      properties: {
        mode: { const: "standalone" },
        eventId: { type: "string" },
        runId: { type: "string" },
        outcome: { enum: ["started", "duplicate"] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["mode", "runId", "outcome"],
      properties: {
        mode: { const: "run_wait" },
        runId: { type: "string" },
        outcome: { const: "resumed" },
      },
    },
  ],
} as const;

const SAFE_DENIAL = { error: "form submission denied" };

function denialStatus(error: FormSubmissionError): 403 | 409 | 422 {
  if (error.code === "wrong_user") return 403;
  if (error.code === "invalid_response") return 422;
  return 409;
}

/** Standalone and in-Run forms share one authenticated, schema-described submission boundary. */
export function registerFormRoutes(
  app: FastifyInstance,
  deps: FormsRoutesDeps,
  requireAuth: PreHandler
): void {
  app.post(
    "/api/v1/forms/:formId/submissions",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Submit a governed standalone form to its Trigger, or resume its exact RunWait. " +
          "The server resolves the current form, reauthorizes the caller, validates the response, " +
          "and atomically consumes an in-Run resume token.",
        tags: ["forms"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          additionalProperties: false,
          required: ["formId"],
          properties: { formId: { type: "string", minLength: 1, maxLength: 200 } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["formVersion", "schemaRef", "guardrailRevision", "data", "idempotencyKey"],
          properties: {
            formVersion: { type: "string", minLength: 1 },
            schemaRef: { type: "string", minLength: 1 },
            guardrailRevision: { type: "string", minLength: 1 },
            data: { type: "object", additionalProperties: true },
            idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
            runId: { type: "string", minLength: 1 },
            resumeToken: { type: "string", minLength: 1 },
          },
        },
        response: {
          202: FORM_RESULT_SCHEMA,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { formId } = request.params as { formId: string };
      const user = request.user as UserDoc;
      const principal = `user:${user._id}`;
      const form = await deps.resolve(formId, principal);
      if (!form) return reply.code(404).send({ error: "form not found" });
      const body = request.body as Omit<SubmitFormInput, "formId" | "principal" | "submittedAt">;
      try {
        const result = await deps.submit(form, {
          ...body,
          formId,
          principal,
          submittedAt: (deps.now ?? (() => new Date().toISOString()))(),
        });
        return reply.code(202).send(result);
      } catch (error) {
        if (!(error instanceof FormSubmissionError)) throw error;
        request.log.warn({ formId, code: error.code }, "form submission denied");
        return reply.code(denialStatus(error)).send(SAFE_DENIAL);
      }
    }
  );
}
