import { DEFAULT_GUARDRAILS } from "@tulipfarm/agent-runtime";
import { DocumentConversionError, MAX_FILE_BYTES, renderDocument } from "@tulipfarm/files";
import { PPTX_MEDIA_TYPE, XLSX_MEDIA_TYPE } from "@tulipfarm/files/document-preview";
import { externalPdf } from "@tulipfarm/files/test-fixtures/pdf";
import { canonicalHash, textContent } from "@tulipfarm/schema";
import type { PersistedRun, PersistedState } from "@tulipfarm/storage";
import { createChatExecutor, type TurnCompletionStore } from "@tulipfarm/turn-executor";
import { describe, expect, it, vi } from "vitest";
import { InternalApiClient } from "./client";
import { HttpTurnHost } from "./turn-host";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const RUN: PersistedRun = {
  id: "run-1",
  businessId: "business-1",
  source: "chat",
  bundle: { digest: "sha256:bundle", routineId: "chat", routineVersion: "1" },
  identity: {
    initiator: { kind: "user", id: "user-1" },
    effectiveSubject: { kind: "user", id: "user-1" },
    guardrailContextRef: "sha256:guardrail",
  },
  status: "running",
  version: 2,
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:01.000Z",
  finishedAt: null,
  resultArtifactId: null,
  errorEvidenceRef: null,
  leaseOwner: "worker-1",
  leaseExpiresAt: "2026-01-01T00:01:00.000Z",
  leaseGeneration: 1,
};
const STATE: PersistedState = {
  businessId: RUN.businessId,
  runId: RUN.id,
  key: "invoke",
  definitionRef: "published:agent:assistant",
  resolvedInput: { payloadRef: "artifact:run-1:request" },
  status: "claimed",
  version: 1,
  createdAt: RUN.createdAt,
  startedAt: null,
  finishedAt: null,
  resultArtifactId: null,
  errorEvidenceRef: null,
  output: null,
};

function harness(bytes: Uint8Array, name = "report.docx", mediaType = DOCX) {
  const messages: string[] = [];
  const completions: Parameters<TurnCompletionStore["completeTurn"]>[0][] = [];
  const transitions: { from: string; to: string }[] = [];
  const events: { eventType: string; payload: Record<string, unknown> }[] = [];
  const turns = new HttpTurnHost(
    new InternalApiClient({
      baseUrl: "http://control-plane.invalid",
      credential: "tfc_test.secret",
      fetch: async () => {
        throw new Error("Unexpected control-plane fetch");
      },
    })
  );
  const invoke = vi.fn(async () => {
    throw new Error("A refused attachment must not reach a model");
  });
  const inspect = vi.fn(turns.inspect.bind(turns));
  const execute = createChatExecutor({
    host: {
      findTurn: async () => ({ turnId: "turn-1", conversationId: "chat-1", attempt: 1 }),
      findCompletion: async () => undefined,
      appendAssistantMessage: async (input) => {
        messages.push(input.content);
        return { status: "recorded", messageId: "reply-1" };
      },
      completeTurn: async (input) => {
        completions.push(input);
        return { status: "recorded" };
      },
      dispatch: async () => {
        throw new Error("Unexpected Tool dispatch");
      },
    },
    context: {
      resolve: async () => ({
        agentId: "assistant",
        subjectId: "user-1",
        modelProfileId: "primary",
        contextDigest: "sha256:context",
        guardrailDigest: canonicalHash(DEFAULT_GUARDRAILS),
        guardrailPolicy: DEFAULT_GUARDRAILS as unknown as Record<string, unknown>,
        messages: [{ role: "user", content: textContent("Read the attachment.") }],
        attachments: [{ fileId: "docx-1", mediaType, name }],
        tools: [],
        limits: { maxIterations: 4, maxToolCalls: 4, maxRepairAttempts: 2 },
        compacted: false,
      }),
    },
    attachments: {
      read: async () => bytes,
      extract: turns.extract.bind(turns),
      inspect,
    },
    model: { invoke },
    runs: { find: async () => RUN, findState: async () => STATE },
    budgets: {
      open: async () => {},
      consume: async () => ({
        outcome: "unbounded",
        consumed: 0,
        limit: null,
        exhaustionPolicy: null,
      }),
    },
    transitions: {
      transition: async (input) => {
        transitions.push(input);
      },
    },
    waits: { register: async () => ({ waitId: "wait-1" }) },
    events: {
      append: async (input) => {
        events.push(input);
        return { sequence: events.length };
      },
    },
    log: { warn: () => {} },
  });
  return { execute, messages, completions, transitions, events, invoke, inspect };
}

describe("DOCX refusal through real Chat execution", () => {
  it.each([
    ["malformed", "could not be read"],
    ["encrypted", "password-protected"],
  ] as const)("completes a %s PDF without a provider call", async (variant, explanation) => {
    const result = harness(externalPdf(variant), "report.pdf", "application/pdf");
    expect(await result.execute(RUN)).toEqual({ status: "succeeded" });
    expect(result.messages[0]).toContain(explanation);
    expect(result.completions).toEqual([expect.objectContaining({ status: "succeeded" })]);
    expect(result.invoke).not.toHaveBeenCalled();
  });
  it.each([XLSX_MEDIA_TYPE, PPTX_MEDIA_TYPE])(
    "completes malformed Office attachments with an ordinary refusal (%s)",
    async (mediaType) => {
      const result = harness(new Uint8Array([80, 75, 3, 4]), "unreadable-office", mediaType);
      expect(await result.execute(RUN)).toEqual({ status: "succeeded" });
      expect(result.completions).toEqual([expect.objectContaining({ status: "succeeded" })]);
      expect(result.messages[0]).toContain("could not be read");
      expect(result.invoke).not.toHaveBeenCalled();
    }
  );
  it.each([
    { name: "malformed", bytes: () => new Uint8Array([1, 2, 3]), explanation: "could not be read" },
    {
      name: "empty",
      bytes: async () =>
        // A Markdown reference definition produces a valid DOCX with no visible text.
        (await renderDocument({ format: "docx", content: "[reference]: https://example.invalid" }))
          .bytes,
      explanation: "has no readable text",
    },
    {
      name: "over-limit",
      bytes: () => new Uint8Array(MAX_FILE_BYTES + 1),
      explanation: "exceeds the document processing limits",
    },
  ])(
    "finishes a $name DOCX Run and Turn with a participant explanation instead of parking",
    async ({ bytes, explanation }) => {
      const result = harness(await bytes());
      expect(await result.execute(RUN)).toEqual({ status: "succeeded" });
      expect(result.completions).toEqual([
        expect.objectContaining({ status: "succeeded", messageId: "reply-1" }),
      ]);
      expect(result.transitions).toEqual(
        expect.arrayContaining([expect.objectContaining({ from: "running", to: "succeeded" })])
      );
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toContain("report.docx");
      expect(result.messages[0]).toContain(explanation);
      expect(result.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "turn.finished",
            payload: expect.objectContaining({ status: "succeeded", messageId: "reply-1" }),
            audience: "participant",
          }),
          expect.objectContaining({
            eventType: "text.delta",
            payload: expect.objectContaining({ text: result.messages[0] }),
            audience: "participant",
          }),
        ])
      );
      expect(result.events.some((event) => event.payload.reason === "turn_execution_failed")).toBe(
        false
      );
      expect(result.invoke).not.toHaveBeenCalled();
    }
  );

  it("renders a bounded filename as literal text, not document-controlled Markdown", async () => {
    const result = harness(
      new Uint8Array([1]),
      "evil\n![pixel](https://example.invalid/pixel).docx"
    );
    expect(await result.execute(RUN)).toEqual({ status: "succeeded" });
    expect(result.messages[0]).not.toContain("\n");
    expect(result.messages[0]).toContain("\\!\\[pixel\\]\\(https://example.invalid/pixel\\).docx");
    expect(result.messages[0]).not.toContain("![pixel]");
  });

  it.each(["native_load", "crashed", "deadline", "saturated"] as const)(
    "keeps %s infrastructure failures distinct from ordinary participant refusals",
    async (code) => {
      const result = harness(new Uint8Array([1]));
      result.inspect.mockRejectedValueOnce(new DocumentConversionError(code));
      expect(await result.execute(RUN)).toEqual({ status: "needs_reconciliation" });
      expect(result.messages).toEqual([]);
      expect(result.completions).toEqual([]);
      expect(result.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "turn.finished",
            payload: expect.objectContaining({ status: "failed", reason: "turn_execution_failed" }),
          }),
        ])
      );
      expect(result.invoke).not.toHaveBeenCalled();
    }
  );
});
