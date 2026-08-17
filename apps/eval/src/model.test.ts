import { ModelInvocationError, type ModelInvocationRequest } from "@tulipfarm/agent-runtime";
import { isSubscriptionProvider } from "@tulipfarm/llm";
import type { ProviderEntry } from "@tulipfarm/schema";
import { APICallError, type LanguageModel } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import type { EvalCase } from "./case.ts";
import { type CreateModelFn, PINNED_MODELS, pinnedBinding, providerEntry } from "./model.ts";

type DoStreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = DoStreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const SONNET = PINNED_MODELS.sonnet;
const LUNA = PINNED_MODELS.luna;

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: { total: input, noCache: input - cacheRead - cacheWrite, cacheRead, cacheWrite },
  outputTokens: { total: output, text: output, reasoning: 0 },
});

const finish = (
  tokens = usage(1000, 200),
  reason: { unified: string; raw: string } = { unified: "stop", raw: "end_turn" }
): StreamPart => ({ type: "finish", finishReason: reason, usage: tokens }) as StreamPart;

const text = (pieces: string[]): StreamPart[] => [
  { type: "text-start", id: "t1" },
  ...pieces.map((delta): StreamPart => ({ type: "text-delta", id: "t1", delta })),
  { type: "text-end", id: "t1" },
];

/** Records how `createModel` was called so the credential contract can be asserted. */
function stubCreateModel(
  parts: StreamPart[],
  overrides: Partial<MockLanguageModelV4> = {}
): { fn: CreateModelFn; seen: { entry: ProviderEntry; options: object }[] } {
  const seen: { entry: ProviderEntry; options: object }[] = [];
  const mock = new MockLanguageModelV4({
    doStream: async () => ({ stream: simulateReadableStream<StreamPart>({ chunks: parts }) }),
    ...overrides,
  });
  return {
    seen,
    fn: async (entry, _secrets, options) => {
      seen.push({ entry, options: options ?? {} });
      return mock as unknown as LanguageModel;
    },
  };
}

const evalCase = (): EvalCase => ({
  id: "c1",
  tier: "l2",
  agent: "triage",
  input: [{ role: "user", content: "hello" }],
  context: { agentId: "eval", memory: [], governancePages: [] },
  expect: [],
});

const request = (overrides: Partial<ModelInvocationRequest> = {}): ModelInvocationRequest => ({
  requestId: "r1",
  modelProfileId: "eval",
  messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: "hello" },
  ],
  tools: [],
  ...overrides,
});

describe("providerEntry", () => {
  it("reads the key from the environment by reference, never from a literal", () => {
    const entry = providerEntry(SONNET);

    expect(entry).toMatchObject({
      provider: "claude-code",
      model: "sonnet",
      api_key_ref: "env://CLAUDE_CODE_OAUTH_TOKEN",
    });
  });

  it("runs both vendors off a subscription seat, never a stored key", () => {
    // A seat is reached through its vendor CLI and metered by the vendor, not billed per call.
    // Declaring that here is what makes the Scorecard report tokens instead of pretending to
    // dollars it cannot know.
    for (const pinned of Object.values(PINNED_MODELS)) {
      expect(providerEntry(pinned).api_key_ref).toBe(`env://${pinned.credentialEnv}`);
      expect(isSubscriptionProvider(pinned.provider)).toBe(true);
    }
  });

  it("admits that a seat's model id is an alias, not a dated pin", () => {
    // Neither vendor publishes a dated id for a seat. Claiming `dated` here would let a Scorecard
    // imply the model could not have moved under it, which is the one confound this framework
    // exists to surface rather than hide.
    expect(SONNET.dated).toBe(false);
    expect(LUNA.dated).toBe(false);
  });
});

describe("pinnedBinding", () => {
  it("never offers a principal or a credential resolver to the provider layer", async () => {
    const { fn, seen } = stubCreateModel([...text(["hi"]), finish()]);
    const binding = pinnedBinding(SONNET, { createModel: fn });

    await binding.create(evalCase()).invoke(request());

    expect(seen).toHaveLength(1);
    // The provider layer prefers a principal's own key when both of these are supplied, and
    // reports nothing when it does. A Sweep that silently measured a different account would
    // read as a harness change. Passing neither makes that fallback unreachable.
    expect(seen[0].options).not.toHaveProperty("principal");
    expect(seen[0].options).not.toHaveProperty("credentials");
  });

  it("reports the Effort it pinned rather than inferring one", () => {
    expect(pinnedBinding(SONNET, { createModel: stubCreateModel([]).fn }).effort).toBe("balanced");
    expect(SONNET.effort).toBe("balanced");
  });

  it("returns the model output through the same conversion production uses", async () => {
    const { fn } = stubCreateModel([...text(["Hel", "lo"]), finish()]);

    const result = await pinnedBinding(SONNET, { createModel: fn })
      .create(evalCase())
      .invoke(request());

    expect(result.output).toEqual({ kind: "text", text: "Hello" });
    expect(result.requestId).toBe("r1");
  });

  it("reports a seat as unmetered rather than charging it published API rates", async () => {
    const { fn } = stubCreateModel([...text(["ok"]), finish(usage(1_000_000, 1_000_000))]);

    const result = await pinnedBinding(SONNET, { createModel: fn })
      .create(evalCase())
      .invoke(request());

    // A seat has a genuine zero marginal cost. `subscription` and `unpriced` are deliberately
    // different: charging the seat $18 here would abort a Sweep against a budget it never spent.
    expect(result.usage).toMatchObject({ costBasis: "subscription" });
    expect(result.usage).not.toHaveProperty("costUsd");
  });

  it("treats cached input as a breakdown of the input count, not an addend", async () => {
    const { fn } = stubCreateModel([...text(["ok"]), finish(usage(1000, 200, 800, 0))]);

    const result = await pinnedBinding(SONNET, { createModel: fn })
      .create(evalCase())
      .invoke(request());

    expect(result.usage).toMatchObject({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 800,
    });
  });

  it("records the version the API reported, not the one that was asked for", async () => {
    // Provider-reported metadata, which the SDK surfaces on the response rather than on the
    // stream. This is the only place a rolled-forward alias can be seen.
    const { fn } = stubCreateModel([
      { type: "response-metadata", modelId: `${SONNET.model}-rev2` } as StreamPart,
      ...text(["ok"]),
      finish(),
    ]);
    const binding = pinnedBinding(SONNET, { createModel: fn });

    expect(binding.reportedVersion()).toBeUndefined();
    await binding.create(evalCase()).invoke(request());

    expect(binding.reportedVersion()).toBe(`${SONNET.model}-rev2`);
  });

  it("does not report a version when the response only echoes the id that was asked for", async () => {
    // Neither vendor CLI emits provider metadata, so the SDK seeds the response id from the
    // request. Recording that would print `version=sonnet` beside `model=sonnet` and assert a
    // confirmation the vendor never gave — on exactly the aliased pins where a silent
    // roll-forward is the confound worth catching.
    // What the CLI adapters actually do: they declare the id we asked for, so the SDK reports it
    // straight back on the response.
    const { fn } = stubCreateModel([...text(["ok"]), finish()], { modelId: SONNET.model });
    const binding = pinnedBinding(SONNET, { createModel: fn });

    await binding.create(evalCase()).invoke(request());

    expect(binding.reportedVersion()).toBeUndefined();
  });

  it("refuses to run when the environment could redirect the seat away from the vendor", async () => {
    const { fn, seen } = stubCreateModel([...text(["ok"]), finish()]);
    const binding = pinnedBinding(SONNET, { createModel: fn });
    process.env.ANTHROPIC_BASE_URL = "https://proxy.internal";

    try {
      await expect(binding.create(evalCase()).invoke(request())).rejects.toThrow(
        /ANTHROPIC_BASE_URL is set/
      );
      expect(seen).toHaveLength(0);
    } finally {
      delete process.env.ANTHROPIC_BASE_URL;
    }
  });

  it("prices a seat as a subscription when the stream carried no usage to settle", async () => {
    // The fallback used to hardcode `unpriced`, which reports a seat's known-zero marginal cost
    // as an unknown one and makes the Sweep total look like a floor when it is exact.
    const { fn } = stubCreateModel([...text(["ok"]), finish()]);
    const binding = pinnedBinding(SONNET, { createModel: fn });

    const result = await binding.create(evalCase()).invoke(request());

    expect(result.usage.costBasis).toBe("subscription");
  });

  it("classifies a vendor failure so a transient one can be told from a hard one", async () => {
    const { fn } = stubCreateModel([], {
      doStream: async () => {
        throw new APICallError({
          message: "rate limited",
          url: "https://api.anthropic.com/v1/messages",
          requestBodyValues: {},
          statusCode: 429,
        });
      },
    });

    await expect(
      pinnedBinding(SONNET, { createModel: fn }).create(evalCase()).invoke(request())
    ).rejects.toMatchObject({ reason: "model_rate_limited" });
  });

  it("charges a call that died mid-stream for what the provider already consumed", async () => {
    // The provider reports the step's usage before the failure part; reading only the terminal
    // chunk is what made every mid-stream death look free.
    const { fn } = stubCreateModel([
      ...text(["partial"]),
      finish(usage(500, 20)),
      { type: "error", error: new Error("connection reset") } as StreamPart,
    ]);

    const error = await pinnedBinding(SONNET, { createModel: fn })
      .create(evalCase())
      .invoke(request())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ModelInvocationError);
    expect((error as ModelInvocationError).usage).toMatchObject({
      inputTokens: 500,
      outputTokens: 20,
    });
  });

  it("builds the provider client once and reuses it across Cases", async () => {
    const { fn, seen } = stubCreateModel([...text(["ok"]), finish()]);
    const binding = pinnedBinding(SONNET, { createModel: fn });

    await binding.create(evalCase()).invoke(request());
    await binding.create(evalCase()).invoke(request());

    expect(seen).toHaveLength(1);
  });

  it("fails rather than falling back when the pinned key is absent", async () => {
    delete process.env[SONNET.credentialEnv];
    const binding = pinnedBinding(SONNET);

    await expect(binding.create(evalCase()).invoke(request())).rejects.toThrow(
      new RegExp(SONNET.credentialHint)
    );
  });

  it("refuses a malformed Codex credential before spending a single Trial", async () => {
    const before = process.env.CODEX_AUTH_JSON;
    process.env.CODEX_AUTH_JSON = "not json at all";
    try {
      const binding = pinnedBinding(PINNED_MODELS.luna, {
        createModel: async () => {
          throw new Error("the model must never be built");
        },
      });

      await expect(binding.preflight?.()).rejects.toThrow(
        /CODEX_AUTH_JSON is malformed.*not valid JSON/is
      );
    } finally {
      if (before === undefined) delete process.env.CODEX_AUTH_JSON;
      else process.env.CODEX_AUTH_JSON = before;
    }
  });

  it("refuses a missing credential up front, naming the variable and how to get it", async () => {
    const before = process.env.CODEX_AUTH_JSON;
    delete process.env.CODEX_AUTH_JSON;
    try {
      const binding = pinnedBinding(PINNED_MODELS.luna);

      await expect(binding.preflight?.()).rejects.toThrow(/CODEX_AUTH_JSON.*codex login/s);
    } finally {
      if (before !== undefined) process.env.CODEX_AUTH_JSON = before;
    }
  });

  it("accepts a well-formed Codex sign-in blob", async () => {
    const before = process.env.CODEX_AUTH_JSON;
    process.env.CODEX_AUTH_JSON = JSON.stringify({ tokens: { refresh_token: "rt" } });
    try {
      const binding = pinnedBinding(PINNED_MODELS.luna);

      await expect(binding.preflight?.()).resolves.toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.CODEX_AUTH_JSON;
      else process.env.CODEX_AUTH_JSON = before;
    }
  });
});
