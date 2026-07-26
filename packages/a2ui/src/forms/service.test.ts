import { describe, expect, it, vi } from "vitest";
import {
  FormSubmissionError,
  FormSubmissionService,
  type GovernedForm,
  type ResumeFormWaitInput,
  type SubmitFormInput,
} from "./service";

const standalone: GovernedForm = {
  id: "expense-request",
  version: "3",
  mode: "standalone",
  schemaRef: "forms/expense-request@3",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["amount"],
    properties: { amount: { type: "number", minimum: 1 } },
  },
  visibleFields: ["amount"],
  audience: ["user:alice"],
  guardrailRevision: "guardrail-7",
  expiresAt: "2026-07-26T01:00:00.000Z",
  triggerId: "trigger-expense-request",
};

const resumable: GovernedForm = {
  id: "approval-details",
  version: "2",
  mode: "run_wait",
  schemaRef: "forms/approval-details@2",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["reason"],
    properties: { reason: { type: "string", minLength: 1 } },
  },
  visibleFields: ["reason"],
  audience: ["user:alice"],
  guardrailRevision: "guardrail-7",
  expiresAt: "2026-07-26T01:00:00.000Z",
  waitId: "wait-1",
  runId: "run-1",
};

function input(overrides: Partial<SubmitFormInput> = {}): SubmitFormInput {
  return {
    formId: "expense-request",
    formVersion: "3",
    schemaRef: "forms/expense-request@3",
    principal: "user:alice",
    guardrailRevision: "guardrail-7",
    data: { amount: 42 },
    idempotencyKey: "submit-1",
    submittedAt: "2026-07-26T00:30:00.000Z",
    ...overrides,
  };
}

describe("FormSubmissionService", () => {
  it("normalizes a standalone submission into a canonical event and Run", async () => {
    const invokeTrigger = vi.fn(async () => ({
      eventId: "event-1",
      runId: "run-1",
      outcome: "started" as const,
    }));
    const service = new FormSubmissionService({ invokeTrigger, resumeWait: vi.fn() });

    await expect(service.submit(standalone, input())).resolves.toEqual({
      mode: "standalone",
      eventId: "event-1",
      runId: "run-1",
      outcome: "started",
    });
    expect(invokeTrigger).toHaveBeenCalledWith({
      triggerId: "trigger-expense-request",
      principal: "user:alice",
      data: { amount: 42 },
      idempotencyKey: "submit-1",
      occurredAt: "2026-07-26T00:30:00.000Z",
    });
  });

  it("resumes one exact RunWait without forwarding protected input as evidence", async () => {
    const resumeWait = vi.fn(async (_input: ResumeFormWaitInput) => ({
      outcome: "resumed" as const,
    }));
    const service = new FormSubmissionService({ invokeTrigger: vi.fn(), resumeWait });

    await expect(
      service.submit(
        resumable,
        input({
          formId: "approval-details",
          formVersion: "2",
          schemaRef: "forms/approval-details@2",
          runId: "run-1",
          resumeToken: "one-use-token",
          data: { reason: "approved budget" },
        })
      )
    ).resolves.toMatchObject({ mode: "run_wait", runId: "run-1", outcome: "resumed" });
    expect(resumeWait).toHaveBeenCalledWith(
      expect.objectContaining({
        waitId: "wait-1",
        runId: "run-1",
        schemaRef: "forms/approval-details@2",
        token: "one-use-token",
        principal: "user:alice",
        signalDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
    );
    expect(resumeWait.mock.calls[0]?.[0]).not.toHaveProperty("data");
  });

  it.each([
    ["wrong_user", { principal: "user:bob" }],
    ["wrong_run", { runId: "run-2", resumeToken: "token" }],
    ["wrong_schema", { schemaRef: "forms/approval-details@1", resumeToken: "token" }],
    ["version_changed", { formVersion: "1", resumeToken: "token" }],
    ["guardrail_changed", { guardrailRevision: "guardrail-8", resumeToken: "token" }],
    ["expired", { submittedAt: "2026-07-26T01:01:00.000Z", resumeToken: "token" }],
    ["invalid_response", { data: { reason: "ok", hidden: "smuggled" }, resumeToken: "token" }],
  ] as const)("denies %s with a payload-safe error", async (code, overrides) => {
    const service = new FormSubmissionService({
      invokeTrigger: vi.fn(),
      resumeWait: vi.fn(async () => ({ outcome: "resumed" as const })),
    });
    await expect(
      service.submit(
        resumable,
        input({
          formId: "approval-details",
          formVersion: "2",
          schemaRef: "forms/approval-details@2",
          runId: "run-1",
          data: { reason: "approved budget" },
          ...overrides,
        })
      )
    ).rejects.toEqual(expect.objectContaining({ code }));
  });

  it("denies a replay reported by the durable wait boundary", async () => {
    const service = new FormSubmissionService({
      invokeTrigger: vi.fn(),
      resumeWait: vi.fn(async () => ({ outcome: "duplicate" as const })),
    });
    await expect(
      service.submit(
        resumable,
        input({
          formId: "approval-details",
          formVersion: "2",
          schemaRef: "forms/approval-details@2",
          runId: "run-1",
          resumeToken: "already-used",
          data: { reason: "approved budget" },
        })
      )
    ).rejects.toEqual(expect.objectContaining({ code: "replayed" }));
  });

  it("never includes submitted data in an error message", () => {
    const error = new FormSubmissionError("invalid_response");
    expect(error.message).toBe("invalid_response");
  });
});
