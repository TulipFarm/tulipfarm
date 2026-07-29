import { canonicalHash } from "@tulipfarm/schema/canonicalize";
import Ajv from "ajv";

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

export interface InvokeFormTriggerInput {
  readonly triggerId: string;
  readonly principal: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
}

export interface ResumeFormWaitInput {
  readonly waitId: string;
  readonly runId: string;
  readonly schemaRef: string;
  readonly token: string;
  readonly principal: string;
  readonly correlationKey: string;
  readonly signalDigest: string;
  readonly receivedAt: string;
}

export interface FormSubmissionPorts {
  invokeTrigger(input: InvokeFormTriggerInput): Promise<{
    readonly eventId: string;
    readonly runId: string;
    readonly outcome: "started" | "duplicate";
  }>;
  resumeWait(input: ResumeFormWaitInput): Promise<{
    readonly outcome: "resumed" | "duplicate" | "recorded" | "resolved_without_resume";
  }>;
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

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FormSubmissionError("invalid_response");
  }
  return value as Readonly<Record<string, unknown>>;
}

function validateSubmission(form: GovernedForm, input: SubmitFormInput) {
  if (form.id !== input.formId) throw new FormSubmissionError("form_changed");
  if (form.version !== input.formVersion) throw new FormSubmissionError("version_changed");
  if (form.schemaRef !== input.schemaRef) throw new FormSubmissionError("wrong_schema");
  if (!form.audience.includes(input.principal)) throw new FormSubmissionError("wrong_user");
  if (form.guardrailRevision !== input.guardrailRevision) {
    throw new FormSubmissionError("guardrail_changed");
  }
  const submittedAt = Date.parse(input.submittedAt);
  const expiresAt = Date.parse(form.expiresAt);
  if (!Number.isFinite(submittedAt) || !Number.isFinite(expiresAt) || submittedAt >= expiresAt) {
    throw new FormSubmissionError("expired");
  }
  const data = record(input.data);
  if (Object.keys(data).some((field) => !form.visibleFields.includes(field))) {
    throw new FormSubmissionError("invalid_response");
  }
  const validate = new Ajv({ allErrors: true, strict: false }).compile(form.schema);
  if (!validate(data)) throw new FormSubmissionError("invalid_response");
  return data;
}

export class FormSubmissionService {
  constructor(private readonly ports: FormSubmissionPorts) {}

  async submit(form: GovernedForm, input: SubmitFormInput): Promise<FormSubmissionResult> {
    const data = validateSubmission(form, input);
    if (form.mode === "standalone") {
      const result = await this.ports.invokeTrigger({
        triggerId: form.triggerId,
        principal: input.principal,
        data,
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.submittedAt,
      });
      return { mode: "standalone", ...result };
    }
    if (input.runId !== form.runId) throw new FormSubmissionError("wrong_run");
    if (!input.resumeToken) throw new FormSubmissionError("missing_resume_token");
    const result = await this.ports.resumeWait({
      waitId: form.waitId,
      runId: form.runId,
      schemaRef: form.schemaRef,
      token: input.resumeToken,
      principal: input.principal,
      correlationKey: input.idempotencyKey,
      signalDigest: canonicalHash(data),
      receivedAt: input.submittedAt,
    });
    if (result.outcome === "duplicate") throw new FormSubmissionError("replayed");
    if (result.outcome !== "resumed") throw new FormSubmissionError("wait_not_resumed");
    return { mode: "run_wait", runId: form.runId, outcome: "resumed" };
  }
}
