import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from "@ai-sdk/provider";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LlmProviderError } from "../provider-error";
import { buildCodexPrompt, CodexModel, isCodexAuthError, isCodexAuthFailure } from "./codex";

/** Codex tests fake the subprocess to exercise transport, ordering, and teardown. */

const FAKE_SERVER = join(__dirname, "codex-fake-server.mjs");

const AUTH_BLOB = JSON.stringify({
  OPENAI_API_KEY: null,
  tokens: { access_token: "at-secret-value", refresh_token: "rt-secret-value", account_id: "acc" },
  last_refresh: "2026-01-01T00:00:00Z",
});

interface Step {
  notify?: string;
  request?: string;
  params?: Record<string, unknown>;
  delayMs?: number;
}

interface Scenario {
  rotateAuth?: string;
  responses?: Record<string, unknown>;
  onTurnStart?: Step[];
  exitAfterTurnStart?: number;
  ignoreSigterm?: boolean;
  stderr?: string;
  garbage?: boolean;
}

let workDir: string;
let logPath: string;

const DEFAULT_RESPONSES = {
  initialize: { userAgent: "fake" },
  "thread/start": { thread: { id: "th_1" }, model: "gpt-5.6-terra" },
  "turn/start": { turn: { id: "tn_1" } },
  "thread/inject_items": {},
  "turn/interrupt": {},
};

function scenario(steps: Step[], extra: Partial<Scenario> = {}): void {
  const body: Scenario = {
    responses: { ...DEFAULT_RESPONSES, ...(extra.responses ?? {}) },
    onTurnStart: steps,
    ...extra,
  };
  writeFileSync(join(workDir, "scenario.json"), JSON.stringify(body));
}

function logLines(): Array<Record<string, unknown>> {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** Every JSON-RPC message the fake server received, in order. */
const received = (): Array<Record<string, unknown>> =>
  logLines().filter((entry) => entry.__env === undefined);

/** The environment the child actually got — the jail's output, observed from inside it. */
const childEnv = (): Record<string, string> =>
  (logLines()[0]?.__env ?? {}) as Record<string, string>;

const sentParams = (method: string): Record<string, unknown> =>
  (received().find((m) => m.method === method)?.params ?? {}) as Record<string, unknown>;

const textDelta = (text: string): Step => ({
  notify: "item/agentMessage/delta",
  params: { delta: text },
});

const completed = (): Step => ({
  notify: "turn/completed",
  params: { turn: { id: "tn_1", status: "completed" } },
});

const usage = (input: number, output: number, cached = 0): Step => ({
  notify: "thread/tokenUsage/updated",
  params: {
    tokenUsage: { total: { inputTokens: input, outputTokens: output, cachedInputTokens: cached } },
  },
});

function callOptions(overrides: Partial<LanguageModelV4CallOptions> = {}) {
  return {
    prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    ...overrides,
  } as LanguageModelV4CallOptions;
}

const model = (opts: { auth?: string; persist?: (v: string) => Promise<void> } = {}) =>
  new CodexModel("gpt-5.6-terra", opts.auth ?? AUTH_BLOB, 15_000, opts.persist);

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "tf-codex-test-"));
  logPath = join(workDir, "rpc.log");
  // The wrapper is how the fake learns where its scenario lives: the jail strips the environment,
  // so the paths have to be baked into the script the child is told to run.
  const entry = join(workDir, "server.mjs");
  writeFileSync(
    entry,
    `globalThis.__TF_FAKE = ${JSON.stringify({ scenarioPath: join(workDir, "scenario.json"), logPath })};\n` +
      `await import(${JSON.stringify(pathToFileURL(FAKE_SERVER).href)});\n`
  );
  process.env.TF_CODEX_BIN = entry;
  scenario([textDelta("hi"), completed()]);
});

afterEach(() => {
  process.env.TF_CODEX_BIN = undefined;
  rmSync(workDir, { recursive: true, force: true });
});

describe("CodexModel turn", () => {
  it("streams text deltas and reports usage", async () => {
    scenario([textDelta("Hello, "), textDelta("world"), usage(120, 34), completed()]);

    const result = await model().doGenerate(callOptions());

    expect(result.content).toEqual([{ type: "text", text: "Hello, world" }]);
    expect(result.usage.inputTokens?.total).toBe(120);
    expect(result.usage.outputTokens?.total).toBe(34);
    expect(result.finishReason.unified).toBe("stop");
  });

  it("replaces cumulative usage rather than summing it", async () => {
    // The real server reports a running total per update. Summing them — the bug the Claude adapter
    // shipped with — would report 60/300 here instead of the true 40/200.
    scenario([usage(10, 50), usage(25, 120), usage(40, 200), completed()]);

    const result = await model().doGenerate(callOptions());

    expect(result.usage.inputTokens?.total).toBe(40);
    expect(result.usage.outputTokens?.total).toBe(200);
  });

  it("treats cached input tokens as a breakdown of the input total, not an addend", async () => {
    // Codex input tokens include cache reads; adding non_cached_input_tokens would inflate input.
    scenario([usage(1000, 10, 900), completed()]);

    const result = await model().doGenerate(callOptions());

    expect(result.usage.inputTokens?.total).toBe(1000);
    expect(result.usage.inputTokens?.cacheRead).toBe(900);
    expect(result.usage.inputTokens?.noCache).toBe(100);
  });
});

describe("thread/start payload", () => {
  it("disables every built-in Codex capability and sandboxes the turn", async () => {
    await model().doGenerate(callOptions());

    const params = sentParams("thread/start");
    expect(params.approvalPolicy).toBe("never");
    expect(params.sandbox).toBe("read-only");
    expect(params.ephemeral).toBe(true);
    expect(params.model).toBe("gpt-5.6-terra");

    const config = params.config as Record<string, unknown>;
    expect(config.web_search).toBe("disabled");
    const features = config.features as Record<string, boolean>;
    // Every feature this adapter names must be off; none may be silently flipped on.
    expect(Object.values(features).every((value) => value === false)).toBe(true);
    expect(features.shell_tool).toBe(false);
    expect(features.plugins).toBe(false);
    expect(features.multi_agent).toBe(false);
  });

  it("declares tools unnamespaced, unlike the MCP path Claude Code needs", async () => {
    await model().doGenerate(
      callOptions({
        tools: [
          {
            type: "function",
            name: "create_resource",
            description: "Create one",
            inputSchema: { type: "object", properties: { title: { type: "string" } } },
          },
        ],
      })
    );

    const tools = sentParams("thread/start").dynamicTools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ type: "function", name: "create_resource" });
    expect(String(tools[0]?.name)).not.toContain("mcp__");
  });

  it("passes system messages as baseInstructions, not as conversation", async () => {
    await model().doGenerate(
      callOptions({
        prompt: [
          { role: "system", content: "You are TulipFarm." },
          { role: "user", content: [{ type: "text", text: "hi" }] },
        ],
      })
    );

    expect(sentParams("thread/start").baseInstructions).toBe("You are TulipFarm.");
    expect(received().some((m) => m.method === "thread/inject_items")).toBe(false);
  });
});

describe("history injection", () => {
  it("replays prior turns as structured items and sends only the last message as input", async () => {
    await model().doGenerate(
      callOptions({
        prompt: [
          { role: "user", content: [{ type: "text", text: "first" }] },
          { role: "assistant", content: [{ type: "text", text: "answered" }] },
          { role: "user", content: [{ type: "text", text: "second" }] },
        ],
      })
    );

    const items = sentParams("thread/inject_items").items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: "message", role: "user" });
    expect(items[1]).toMatchObject({ type: "message", role: "assistant" });

    const input = sentParams("turn/start").input as Array<{ text: string }>;
    expect(input[0]?.text).toBe("second");
  });

  it("pairs tool calls with their results and asks Codex to continue", async () => {
    // The AgentLoop's second iteration: the prompt ends in tool results, not a user message.
    await model().doGenerate(
      callOptions({
        prompt: [
          { role: "user", content: [{ type: "text", text: "make one" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "create_resource",
                input: { title: "Q3" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call_1",
                toolName: "create_resource",
                output: { type: "json", value: { id: "res_1" } },
              },
            ],
          },
        ],
      })
    );

    const items = sentParams("thread/inject_items").items as Array<Record<string, unknown>>;
    const call = items.find((i) => i.type === "function_call");
    const output = items.find((i) => i.type === "function_call_output");
    expect(call).toMatchObject({ call_id: "call_1", name: "create_resource" });
    expect(output).toMatchObject({ call_id: "call_1", output: '{"id":"res_1"}' });

    const input = sentParams("turn/start").input as Array<{ text: string }>;
    expect(input[0]?.text).toMatch(/continue/i);
  });
});

describe("tool-call capture", () => {
  const toolCall = (callId: string, tool: string, args: unknown): Step => ({
    request: "item/tool/call",
    params: { threadId: "th_1", turnId: "tn_1", tool, callId, arguments: args },
  });

  it("captures the call, interrupts the turn, and hands dispatch back to the broker", async () => {
    scenario([toolCall("call_9", "create_resource", { title: "Q3" })]);

    const result = await model().doGenerate(callOptions());

    expect(result.content).toEqual([
      {
        type: "tool-call",
        toolCallId: "call_9",
        toolName: "create_resource",
        input: '{"title":"Q3"}',
      },
    ]);
    expect(result.finishReason.unified).toBe("tool-calls");
    // Answering the request is what keeps the app-server from parking on its own timeout, and the
    // interrupt is what stops it generating a turn nobody will read. The reply must reach the
    // server *before* the interrupt, or teardown can truncate it.
    const methods = received().map((m) => (m.method === undefined ? "reply" : String(m.method)));
    expect(methods).toContain("reply");
    expect(methods.indexOf("reply")).toBeLessThan(methods.indexOf("turn/interrupt"));
  });

  it("captures every call of a parallel batch, not just the first", async () => {
    // Two parallel tool calls must both be handed to the broker before finish can settle.
    scenario([
      toolCall("call_1", "create_resource", { title: "first" }),
      toolCall("call_2", "send_message", { body: "second" }),
    ]);

    const result = await model().doGenerate(callOptions());

    expect(result.content).toEqual([
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "create_resource",
        input: '{"title":"first"}',
      },
      {
        type: "tool-call",
        toolCallId: "call_2",
        toolName: "send_message",
        input: '{"body":"second"}',
      },
    ]);
    expect(result.finishReason.unified).toBe("tool-calls");
  });

  it("keeps text emitted before the call", async () => {
    scenario([textDelta("Creating it now. "), toolCall("call_9", "create_resource", {})]);

    const result = await model().doGenerate(callOptions());

    expect(result.content[0]).toEqual({ type: "text", text: "Creating it now. " });
    expect(result.content[1]).toMatchObject({ type: "tool-call", toolCallId: "call_9" });
  });
});

describe("credential handling", () => {
  it("materialises auth.json inside the jail and keeps the token out of the environment", async () => {
    process.env.TF_CODEX_TEST_LEAK = "should-not-cross";
    try {
      await model().doGenerate(callOptions());
    } finally {
      process.env.TF_CODEX_TEST_LEAK = undefined;
    }

    const env = childEnv();
    // HOME is the throwaway jail, and CODEX_HOME sits inside it — so the credential file is deleted
    // with the turn rather than persisting on a shared disk.
    expect(env.HOME).toContain("tf-codex-");
    expect(env.CODEX_HOME?.startsWith(String(env.HOME))).toBe(true);
    expect(sentParams("thread/start").cwd).toBe(env.HOME);

    // Nothing that could reach the datastore, and no ambient model credential, may cross into a
    // subprocess whose whole job is to talk to an external service.
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.ENCRYPTION_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.TF_CODEX_TEST_LEAK).toBeUndefined();

    // The blob is a file, never an env var: no value in the child's environment may contain it.
    expect(Object.values(env).some((value) => String(value).includes("rt-secret-value"))).toBe(
      false
    );
  });

  it("fails hard, and fast, on a 401 hidden behind a retry message", async () => {
    // Verified against the real 0.147.0: the first five error notifications say "Reconnecting…"
    // and nothing about auth. Reading only `message` would miss it and wait out ~40s of backoff.
    scenario([
      {
        notify: "error",
        params: {
          willRetry: true,
          error: {
            message: "Reconnecting... 1/5",
            codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } },
          },
        },
      },
      { notify: "turn/completed", params: { turn: { status: "completed" } }, delayMs: 5_000 },
    ]);

    const started = Date.now();
    await expect(model().doGenerate(callOptions())).rejects.toThrow(LlmProviderError);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("classifies a failed turn's message as an auth problem", async () => {
    scenario([
      {
        notify: "turn/completed",
        params: { turn: { status: "failed", error: { message: "401 Unauthorized" } } },
      },
    ]);

    await expect(model().doGenerate(callOptions())).rejects.toMatchObject({
      reason: "model_authentication_failed",
    });
  });

  it("treats a non-auth turn failure as a soft error, so the fallback chain still runs", async () => {
    scenario([
      {
        notify: "turn/completed",
        params: { turn: { status: "failed", error: { message: "upstream 503" } } },
      },
    ]);

    const error = await model()
      .doGenerate(callOptions())
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(LlmProviderError);
  });

  it("fails hard when no credential is stored at all", async () => {
    await expect(
      new CodexModel("gpt-5.6-terra", undefined, 15_000).doGenerate(callOptions())
    ).rejects.toMatchObject({ reason: "model_authentication_failed" });
  });

  it("never puts the credential in an error message or stack", async () => {
    scenario([
      {
        notify: "turn/completed",
        params: { turn: { status: "failed", error: { message: "boom" } } },
      },
    ]);

    const error = (await model()
      .doGenerate(callOptions())
      .catch((err: unknown) => err)) as Error;
    const text = `${error.message}\n${error.stack ?? ""}`;
    expect(text).not.toContain("rt-secret-value");
    expect(text).not.toContain("at-secret-value");
  });

  it("persists a credential Codex rotated during the turn", async () => {
    const rotated = JSON.stringify({
      tokens: { access_token: "at-new", refresh_token: "rt-new", account_id: "acc" },
      last_refresh: "2026-02-02T00:00:00Z",
    });
    scenario([completed()], { rotateAuth: rotated });

    const saved: string[] = [];
    await model({
      persist: async (value) => {
        saved.push(value);
      },
    }).doGenerate(callOptions());

    // Without write-back the refreshed token would die with the jail and the stored credential
    // would silently revert to the stale copy on the next turn.
    expect(saved).toHaveLength(1);
    expect(JSON.parse(saved[0] ?? "{}")).toMatchObject({ tokens: { refresh_token: "rt-new" } });
  });

  it("does not write back when the credential was untouched", async () => {
    scenario([completed()]);

    const saved: string[] = [];
    await model({
      persist: async (value) => {
        saved.push(value);
      },
    }).doGenerate(callOptions());

    // A needless secret write on every turn is churn the audit log would have to explain.
    expect(saved).toEqual([]);
  });
});

describe("subprocess failure", () => {
  it("surfaces a crash immediately instead of waiting out the turn budget", async () => {
    scenario([], { exitAfterTurnStart: 3, stderr: "codex: fatal\n" });

    const started = Date.now();
    await expect(model().doGenerate(callOptions())).rejects.toThrow(/exited/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("tolerates a non-JSON line from the child", async () => {
    scenario([], { garbage: true });

    await expect(model().doGenerate(callOptions())).rejects.toThrow();
  });
});

describe("isCodexAuthFailure", () => {
  // Frozen strings: a Codex release that rewords these must fail here, not in production by
  // silently downgrading a credential problem into a chain-burning soft error.
  it.each([
    "401 Unauthorized",
    "stream error: 403 Forbidden",
    "You are not logged in. Run codex login.",
    "Invalid API key provided",
    "insufficient_quota: exceeded your current quota",
    "Your credit balance is too low",
  ])("matches %s", (text) => {
    expect(isCodexAuthFailure(text)).toBe(true);
  });

  it.each([
    "rate limit exceeded",
    "upstream 503",
    "context length exceeded",
    "socket hang up",
  ])("does not match %s", (text) => {
    expect(isCodexAuthFailure(text)).toBe(false);
  });
});

describe("isCodexAuthError", () => {
  it("reads the structured status code ahead of the prose", () => {
    expect(
      isCodexAuthError({
        message: "Reconnecting... 2/5",
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } },
      })
    ).toBe(true);
  });

  it("does not fire on a retryable status behind the same prose", () => {
    expect(
      isCodexAuthError({
        message: "Reconnecting... 2/5",
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } },
      })
    ).toBe(false);
  });

  it("falls back to the message when no status code is present", () => {
    expect(isCodexAuthError({ message: "401 Unauthorized" })).toBe(true);
    expect(isCodexAuthError({ message: "temporary failure" })).toBe(false);
  });

  it("ignores non-object payloads", () => {
    expect(isCodexAuthError(undefined)).toBe(false);
    expect(isCodexAuthError("401")).toBe(false);
  });
});

describe("buildCodexPrompt", () => {
  it("keeps system text out of the replayed conversation", () => {
    const prompt: LanguageModelV4Prompt = [
      { role: "system", content: "rule one" },
      { role: "system", content: "rule two" },
      { role: "user", content: [{ type: "text", text: "go" }] },
    ];

    const built = buildCodexPrompt(prompt);
    expect(built.instructions).toBe("rule one\n\nrule two");
    expect(built.replay).toEqual([]);
    expect(built.input).toBe("go");
  });

  it("produces usable input for an empty prompt", () => {
    const built = buildCodexPrompt([]);
    expect(built.input.length).toBeGreaterThan(0);
  });

  it("carries images rather than replacing them with a placeholder", () => {
    // Codex vision support requires images on both trailing turns and replayed history.
    const png = Buffer.from("iVBORw0KGgo=", "base64");
    const prompt: LanguageModelV4Prompt = [
      {
        role: "user",
        content: [
          { type: "text", text: "older" },
          { type: "file", mediaType: "image/png", data: { type: "data", data: png } },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "file", mediaType: "image/png", data: { type: "data", data: png } },
        ],
      },
    ];

    const built = buildCodexPrompt(prompt);

    // The trailing turn's image rides on `turn/start`.
    expect(built.images).toEqual(["data:image/png;base64,iVBORw0KGgo="]);
    expect(built.input).toBe("what is this?");

    // The earlier one survives inside the replayed history as an `input_image` part.
    const historical = built.replay.find((item) => item.type === "message" && item.role === "user");
    expect(historical?.content).toContainEqual({
      type: "input_image",
      image_url: "data:image/png;base64,iVBORw0KGgo=",
    });
    expect(JSON.stringify(built.replay)).not.toContain("[image attached]");
  });
});
