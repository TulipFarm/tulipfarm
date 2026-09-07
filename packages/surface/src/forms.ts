import { type Static, Type } from "@sinclair/typebox";

export const SurfaceFormInputSchema = Type.Union([
  Type.Literal("text"),
  Type.Literal("textarea"),
  Type.Literal("email"),
  Type.Literal("number"),
  Type.Literal("url"),
  Type.Literal("date"),
  Type.Literal("time"),
  Type.Literal("datetime"),
  Type.Literal("richtext"),
  Type.Literal("select"),
  Type.Literal("multiselect"),
  Type.Literal("checkbox"),
  Type.Literal("radio"),
  Type.Literal("user"),
  Type.Literal("channel"),
  Type.Literal("conversation"),
]);

export type SurfaceFormInput = Static<typeof SurfaceFormInputSchema>;

export const SurfaceFormFieldSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  label: Type.String({ minLength: 1, maxLength: 200 }),
  input: SurfaceFormInputSchema,
  required: Type.Optional(Type.Boolean()),
  options: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 100 })),
  description: Type.Optional(Type.String({ maxLength: 300 })),
  minLength: Type.Optional(Type.Integer({ minimum: 0, maximum: 3_000, default: 0 })),
  maxLength: Type.Optional(Type.Integer({ minimum: 0, maximum: 3_000, default: 3_000 })),
  minItems: Type.Optional(Type.Integer({ minimum: 0, maximum: 100, default: 0 })),
  maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 100 })),
});

export type SurfaceFormField = Static<typeof SurfaceFormFieldSchema>;

export type SurfaceFormValue =
  | { readonly kind: "text" | "textarea" | "email" | "url" | "richtext"; readonly value: string }
  | { readonly kind: "number"; readonly value: string }
  | { readonly kind: "date"; readonly value: string }
  | { readonly kind: "time"; readonly value: string }
  | { readonly kind: "datetime"; readonly value: string }
  | {
      readonly kind: "select" | "radio" | "user" | "channel" | "conversation";
      readonly value: string;
    }
  | { readonly kind: "multiselect" | "checkbox"; readonly values: readonly string[] };

interface GovernedFormBase {
  readonly id: string;
  readonly version: string;
  readonly schemaRef: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly visibleFields: readonly string[];
  readonly audience: readonly string[];
  readonly guardrailRevision: string;
  readonly expiresAt: string;
}

export type GovernedForm =
  | (GovernedFormBase & {
      readonly mode: "standalone";
      readonly triggerId: string;
    })
  | (GovernedFormBase & {
      readonly mode: "run_wait";
      readonly waitId: string;
      readonly runId: string;
    });

export interface SubmitFormInput {
  readonly formId: string;
  readonly formVersion: string;
  readonly schemaRef: string;
  readonly principal: string;
  readonly guardrailRevision: string;
  readonly data: unknown;
  readonly idempotencyKey: string;
  readonly submittedAt: string;
  readonly runId?: string;
  readonly resumeToken?: string;
}

export type FormSubmissionErrorCode =
  | "expired"
  | "form_changed"
  | "guardrail_changed"
  | "invalid_response"
  | "missing_resume_token"
  | "replayed"
  | "version_changed"
  | "wait_not_resumed"
  | "wrong_run"
  | "wrong_schema"
  | "wrong_user";

export class FormSubmissionError extends Error {
  readonly name = "FormSubmissionError";

  constructor(readonly code: FormSubmissionErrorCode) {
    super(code);
  }
}

export type FormSubmissionResult =
  | {
      readonly mode: "standalone";
      readonly eventId: string;
      readonly runId: string;
      readonly outcome: "started" | "duplicate";
    }
  | {
      readonly mode: "run_wait";
      readonly runId: string;
      readonly outcome: "resumed";
    };
