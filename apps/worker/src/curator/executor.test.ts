import { CURATOR_REQUEST_SCHEMA_REF } from "@tulipfarm/schema";
import type { PersistedRun } from "@tulipfarm/storage";
import { beforeEach, expect, test, vi } from "vitest";
import { createCuratorExecutor } from "./executor";

const generateText = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({ generateText }));

const RUN = { id: "run-1", businessId: "biz-1" } as unknown as PersistedRun;

function makeArtifacts(content: unknown, schemaRef = CURATOR_REQUEST_SCHEMA_REF) {
  return { read: vi.fn(async () => ({ schemaRef, content })) as never };
}

const JOB_ARTIFACT = makeArtifacts({ jobId: "job-1", scope: "user" });

const USER_CONTEXT = {
  jobId: "job-1",
  scope: "user",
  contextDigest: "digest-1",
  memoryDocument: "# Memory",
  sectionCharsRemaining: { preferences: 100 },
  turns: [{ turnId: "t1", userText: "I like cricket" }],
  subjects: [],
  openProposalKeys: [],
  seeds: [],
};

function makeApi(context: unknown = USER_CONTEXT) {
  const require = vi.fn(async (method: string, path: string, body?: unknown) => {
    if (method === "GET") return context;
    return { recorded: 1, rejected: 0, path, body };
  });
  return { require: require as never, calls: require };
}

const models = { model: vi.fn(async () => ({}) as never) };

beforeEach(() => {
  vi.clearAllMocks();
  generateText.mockResolvedValue({ text: '{"memory":[]}' });
});

test("resolves context, reasons once, and submits under the pinned digest", async () => {
  const api = makeApi();
  const outcome = await createCuratorExecutor({ api, models, artifacts: JOB_ARTIFACT })(RUN);

  expect(outcome).toEqual({ status: "succeeded" });
  expect(api.calls.mock.calls[0]).toEqual(["GET", "/api/v1/internal/curator/jobs/job-1/context"]);
  const [method, path, body] = api.calls.mock.calls[1] ?? [];
  expect(method).toBe("POST");
  expect(path).toBe("/api/v1/internal/curator/jobs/job-1/effects");
  expect(body).toEqual({ contextDigest: "digest-1", output: { memory: [] } });
});

// The request Artifact names a job, never the inputs. Without one there is nothing to point at.
test("fails a Run whose request Artifact names no job rather than guessing", async () => {
  const api = makeApi();
  expect(await createCuratorExecutor({ api, models, artifacts: makeArtifacts({}) })(RUN)).toEqual({
    status: "failed",
    errorEvidenceRef: "curator:missing_job_id",
  });
  expect(api.calls).not.toHaveBeenCalled();
});

// Reusing the source must not be enough to steer another kind of Run into the Curator's gateway.
test("fails a Run whose request Artifact is not a Curator request", async () => {
  const api = makeApi();
  const artifacts = makeArtifacts({ jobId: "job-1" }, "tulip.invocation.manual-request.v1");
  expect(await createCuratorExecutor({ api, models, artifacts })(RUN)).toEqual({
    status: "failed",
    errorEvidenceRef: "curator:missing_job_id",
  });
  expect(api.calls).not.toHaveBeenCalled();
});

test("fails without submitting when the context carries no digest", async () => {
  const api = makeApi({ jobId: "job-1", scope: "user" });
  expect(await createCuratorExecutor({ api, models, artifacts: JOB_ARTIFACT })(RUN)).toEqual({
    status: "failed",
    errorEvidenceRef: "curator:missing_context_digest",
  });
  expect(api.calls).toHaveBeenCalledTimes(1);
});

test("uses the business prompt for a business-scoped job", async () => {
  const api = makeApi({
    jobId: "job-2",
    scope: "business",
    contextDigest: "d2",
    soulSummary: "one agent",
    candidates: [{ id: "c1", statement: "we ship on Fridays" }],
  });
  await createCuratorExecutor({
    api,
    models,
    artifacts: makeArtifacts({ jobId: "job-2", scope: "business" }),
  })(RUN);

  const prompt = generateText.mock.calls[0]?.[0]?.prompt as string;
  expect(prompt).toContain("we ship on Fridays");
  expect(prompt).not.toContain("# Memory");
});

test("recovers a fenced JSON object so a chatty model is not wrongly rejected", async () => {
  generateText.mockResolvedValue({ text: 'Here you go:\n```json\n{"memory":[{"a":1}]}\n```\n' });
  const api = makeApi();
  await createCuratorExecutor({ api, models, artifacts: JOB_ARTIFACT })(RUN);

  expect(api.calls.mock.calls[1]?.[2]).toMatchObject({ output: { memory: [{ a: 1 }] } });
});

// Losing it Worker-side would hide a model that cannot hold the contract from the loop's metrics.
test("submits unparsable output verbatim so the API records the rejection", async () => {
  generateText.mockResolvedValue({ text: "I refuse to answer." });
  const api = makeApi();
  const outcome = await createCuratorExecutor({ api, models, artifacts: JOB_ARTIFACT })(RUN);

  expect(outcome).toEqual({ status: "succeeded" });
  expect(api.calls.mock.calls[1]?.[2]).toEqual({
    contextDigest: "digest-1",
    output: "I refuse to answer.",
  });
});

test("rejects a JSON array, which is not an output object", async () => {
  generateText.mockResolvedValue({ text: "[1,2,3]" });
  const api = makeApi();
  await createCuratorExecutor({ api, models, artifacts: JOB_ARTIFACT })(RUN);

  expect(api.calls.mock.calls[1]?.[2]).toEqual({ contextDigest: "digest-1", output: "[1,2,3]" });
});

test("asks for a concrete rung and never routes the router", async () => {
  await createCuratorExecutor({ api: makeApi(), models, artifacts: JOB_ARTIFACT })(RUN);

  const [selector, requirements] = models.model.mock.calls[0] as unknown as [
    string,
    { sensitive: boolean; needsTools: boolean; allowTraining?: boolean },
  ];
  expect(selector).toBe("balanced");
  expect(requirements.sensitive).toBe(true);
  expect(requirements.needsTools).toBe(false);
  expect(requirements.allowTraining).toBe(false);
});

// A stalled provider must not hold the job's reservation for the whole lease.
test("bounds the model call and honours shutdown", async () => {
  const controller = new AbortController();
  await createCuratorExecutor({ api: makeApi(), models, artifacts: JOB_ARTIFACT, timeoutMs: 5 })(
    RUN,
    controller.signal
  );

  const signal = generateText.mock.calls[0]?.[0]?.abortSignal as AbortSignal;
  expect(signal).toBeInstanceOf(AbortSignal);
  controller.abort();
  expect(signal.aborted).toBe(true);
});

// Transient failures fail the Run without throwing, preventing parking in needs_reconciliation.
test("returns failed on transient API failure instead of throwing", async () => {
  const api = {
    require: vi.fn(async () => {
      throw new Error("connection reset");
    }) as never,
  };
  const outcome = await createCuratorExecutor({ api, models, artifacts: JOB_ARTIFACT })(RUN);
  expect(outcome).toEqual({ status: "failed", errorEvidenceRef: "curator:execution_failed" });
});

test("progresses invoke state from pending to succeeded when transitions are provided", async () => {
  const stateTransitions: { from: string; to: string; reason?: string }[] = [];
  const fakeRuns = {
    findState: vi.fn(async () => ({
      businessId: "biz-1",
      runId: "run-1",
      key: "invoke",
      definitionRef: "published:curator:reason",
      resolvedInput: {},
      status: "pending" as const,
      version: 1,
      createdAt: "2026-08-19T01:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      resultArtifactId: null,
      errorEvidenceRef: null,
      output: null,
    })),
  };
  const fakeTransitions = {
    transition: vi.fn(async (input: { from: string; to: string; reason?: string }) => {
      stateTransitions.push({ from: input.from, to: input.to, reason: input.reason });
    }),
  };

  const api = makeApi();
  const outcome = await createCuratorExecutor({
    api,
    models,
    artifacts: JOB_ARTIFACT,
    runs: fakeRuns,
    transitions: fakeTransitions as never,
  })(RUN);

  expect(outcome).toEqual({ status: "succeeded" });
  expect(stateTransitions).toEqual([
    { from: "pending", to: "ready", reason: undefined },
    { from: "ready", to: "claimed", reason: undefined },
    { from: "claimed", to: "running", reason: undefined },
    { from: "running", to: "succeeded", reason: undefined },
  ]);
});

test("progresses invoke state from pending to failed when execution fails", async () => {
  const stateTransitions: { from: string; to: string; reason?: string }[] = [];
  const fakeRuns = {
    findState: vi.fn(async () => ({
      businessId: "biz-1",
      runId: "run-1",
      key: "invoke",
      definitionRef: "published:curator:reason",
      resolvedInput: {},
      status: "pending" as const,
      version: 1,
      createdAt: "2026-08-19T01:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      resultArtifactId: null,
      errorEvidenceRef: null,
      output: null,
    })),
  };
  const fakeTransitions = {
    transition: vi.fn(async (input: { from: string; to: string; reason?: string }) => {
      stateTransitions.push({ from: input.from, to: input.to, reason: input.reason });
    }),
  };

  const api = {
    require: vi.fn(async () => {
      throw new Error("provider timed out");
    }) as never,
  };

  const outcome = await createCuratorExecutor({
    api,
    models,
    artifacts: JOB_ARTIFACT,
    runs: fakeRuns,
    transitions: fakeTransitions as never,
  })(RUN);

  expect(outcome).toEqual({ status: "failed", errorEvidenceRef: "curator:execution_failed" });
  expect(stateTransitions).toEqual([
    { from: "pending", to: "ready", reason: undefined },
    { from: "ready", to: "claimed", reason: undefined },
    { from: "claimed", to: "running", reason: undefined },
    { from: "running", to: "failed", reason: "provider timed out" },
  ]);
});
