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
